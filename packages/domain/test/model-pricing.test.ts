import assert from "node:assert/strict";
import test from "node:test";
import { priceModelCall, type ModelPriceRates } from "../src/index.js";

// gpt-6.1-sol, OpenAI's price list on 4 November 2026.
const rates: ModelPriceRates = {
  inputUsdPerMillion: 2,
  cachedInputUsdPerMillion: 0.1,
  cacheWriteUsdPerMillion: 2.5,
  outputUsdPerMillion: 10,
  longContext: {
    aboveInputTokens: 272_000,
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.2,
    cacheWriteUsdPerMillion: 5,
    outputUsdPerMillion: 15,
  },
};

test("prices each kind of token at its own rate", () => {
  const cost = priceModelCall(rates, {
    input: 14,
    output: 1_052,
    cacheRead: 85_753,
    cacheWrite: 26_232,
  });
  // 14 x 2 + 1,052 x 10 + 85,753 x 0.1 + 26,232 x 2.5
  assert.equal(cost.costMicrounits, 84_703);
  assert.deepEqual(cost.costByKind, {
    inputMicrounits: 28,
    cacheReadMicrounits: 8_575,
    cacheWriteMicrounits: 65_580,
    outputMicrounits: 10_520,
  });
  assert.equal(cost.longContext, false);
});

test("applies the long-context rates to the whole call only above the threshold", () => {
  const usage = { input: 0, output: 1_000, cacheWrite: 0 };
  const at = priceModelCall(rates, { ...usage, cacheRead: 272_000 });
  assert.equal(at.longContext, false);
  assert.equal(at.costMicrounits, 272_000 * 0.1 + 1_000 * 10);

  const above = priceModelCall(rates, { ...usage, cacheRead: 272_001 });
  assert.equal(above.longContext, true);
  assert.equal(above.costMicrounits, Math.round(272_001 * 0.2 + 1_000 * 15));
});

test("counts cached and newly cached input towards the long-context threshold", () => {
  const cost = priceModelCall(rates, {
    input: 100_000,
    output: 0,
    cacheRead: 100_000,
    cacheWrite: 100_000,
  });
  assert.equal(cost.longContext, true);
});

test("uses the standard rates when the price has no long-context tier", () => {
  const cost = priceModelCall(
    { ...rates, longContext: null },
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  assert.equal(cost.longContext, false);
  assert.equal(cost.costMicrounits, 2_000_000);
});

test("bills one-hour cache writes at twice the input rate", () => {
  const cost = priceModelCall(rates, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 1_000,
    cacheWrite1h: 400,
  });
  assert.equal(cost.costMicrounits, 600 * 2.5 + 400 * 2 * 2);
});

test("a free preset costs nothing", () => {
  const cost = priceModelCall(
    {
      inputUsdPerMillion: 0,
      cachedInputUsdPerMillion: 0,
      cacheWriteUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    },
    { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 },
  );
  assert.equal(cost.costMicrounits, 0);
});
