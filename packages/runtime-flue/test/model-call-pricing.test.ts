import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "@oao/db-postgres";
import { modelCallPricing } from "../src/index.js";

const dispatch = {
  organization_id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  run_id: "33333333-3333-4333-8333-333333333333",
} as Parameters<typeof modelCallPricing>[1];
const usage = {
  input: 14,
  output: 1_052,
  cacheRead: 85_753,
  cacheWrite: 26_232,
  cost: {
    input: 0.1,
    output: 0.2,
    cacheRead: 0.05,
    cacheWrite: 0.15,
    total: 0.5,
  },
};

function database(rows: readonly unknown[]): Queryable {
  return {
    query: () => Promise.resolve({ rows }) as ReturnType<Queryable["query"]>,
  };
}

const presetPrice = {
  id: "44444444-4444-4444-8444-444444444444",
  input_usd_per_million: 2,
  cached_input_usd_per_million: 0.1,
  cache_write_usd_per_million: 2.5,
  output_usd_per_million: 10,
  long_context_above_input_tokens: null,
  long_context_input_usd_per_million: null,
  long_context_cached_input_usd_per_million: null,
  long_context_cache_write_usd_per_million: null,
  long_context_output_usd_per_million: null,
};

test("the preset's price wins over the catalog, and its rates are recorded", async () => {
  const pricing = await modelCallPricing(
    database([presetPrice]),
    dispatch,
    usage,
    new Date(),
    "gpt-6.1-sol",
  );
  assert.equal(pricing.costMicrounits, 84_703);
  assert.deepEqual(pricing.snapshot, {
    model: "gpt-6.1-sol",
    source: "preset_price",
    costByKind: {
      inputMicrounits: 28,
      cacheReadMicrounits: 8_575,
      cacheWriteMicrounits: 65_580,
      outputMicrounits: 10_520,
    },
    priceId: presetPrice.id,
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteUsdPerMillion: 2.5,
    outputUsdPerMillion: 10,
    longContext: false,
  });
  // The column's safety check refuses any key that names tokens.
  assert.doesNotMatch(JSON.stringify(Object.keys(pricing.snapshot)), /token/iu);
});

test("records the long-context rates when a call is above the threshold", async () => {
  const pricing = await modelCallPricing(
    database([
      {
        ...presetPrice,
        long_context_above_input_tokens: "100000",
        long_context_input_usd_per_million: 4,
        long_context_cached_input_usd_per_million: 0.2,
        long_context_cache_write_usd_per_million: 5,
        long_context_output_usd_per_million: 15,
      },
    ]),
    dispatch,
    usage,
    new Date(),
    "gpt-6.1-sol",
  );
  assert.equal(pricing.snapshot.longContext, true);
  assert.equal(pricing.snapshot.outputUsdPerMillion, 15);
});

test("falls back to the catalog's cost without a preset price", async () => {
  const pricing = await modelCallPricing(
    database([]),
    dispatch,
    usage,
    new Date(),
    "gpt-6.1-sol",
  );
  assert.equal(pricing.costMicrounits, 500_000);
  assert.deepEqual(pricing.snapshot, {
    model: "gpt-6.1-sol",
    source: "catalog",
    costByKind: {
      inputMicrounits: 100_000,
      cacheReadMicrounits: 50_000,
      cacheWriteMicrounits: 150_000,
      outputMicrounits: 200_000,
    },
  });
});

test("says so when nothing can price the call", async () => {
  const pricing = await modelCallPricing(
    database([]),
    dispatch,
    {
      ...usage,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    new Date(),
    "@preset/example-preset",
  );
  assert.equal(pricing.costMicrounits, 0);
  assert.equal(pricing.snapshot.source, "none");
});
