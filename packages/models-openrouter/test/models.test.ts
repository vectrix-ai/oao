import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_PRESETS,
  ImmutableModelPresetRegistry,
  createDeterministicModelProvider,
  createOpenRouterProvider,
  createOpenRouterPresetProviders,
  loadModelPresetConfiguration,
  parseApprovedModelPresets,
  withPlatformTurnLimit,
} from "../src/index.js";

test("local preset is immutable and resolves without hosted opt-in", () => {
  const registry = new ImmutableModelPresetRegistry(DEFAULT_LOCAL_PRESETS, {
    hostedEnabled: false,
  });
  assert.equal(registry.resolve("local-default").model, "fake/deterministic");
  assert.throws(() =>
    new ImmutableModelPresetRegistry(
      [{ key: "hosted", model: "openrouter/anthropic/claude-sonnet-4.6" }],
      { hostedEnabled: false },
    ).resolve("hosted"),
  );
});

test("publication and runtime load the same opt-in preset catalog", () => {
  const local = loadModelPresetConfiguration({});
  assert.deepEqual(
    local.registry.list().map((preset) => preset.key),
    ["local-default"],
  );
  assert.equal(local.hostedEnabled, false);

  assert.throws(
    () => loadModelPresetConfiguration({ OAO_ENABLE_HOSTED_MODELS: "true" }),
    /OAO_OPENROUTER_PRESETS_JSON/u,
  );
  assert.throws(
    () =>
      loadModelPresetConfiguration({
        OAO_ENABLE_HOSTED_MODELS: "true",
        OAO_OPENROUTER_PRESETS_JSON: JSON.stringify([
          { key: "missing", model: "openrouter/not-a-real/model" },
        ]),
      }),
    /pinned OpenRouter catalog/u,
  );
});

test("fake and OpenRouter adapters use Pi providers", () => {
  assert.equal(createDeterministicModelProvider().provider.id, "fake");
  const openrouter = createOpenRouterProvider({
    data_collection: "deny",
    allow_fallbacks: false,
  });
  assert.equal(openrouter.id, "openrouter");
  assert.ok(openrouter.getModels().length > 0);
  assert.equal(
    openrouter.getModels()[0]?.compat?.openRouterRouting?.data_collection,
    "deny",
  );
});

test("default deterministic provider remains available across turns", async () => {
  const faux = createDeterministicModelProvider();
  const model = faux.provider.getModels()[0];
  assert.ok(model);
  const context = {
    messages: [{ role: "user" as const, content: "first", timestamp: 1 }],
  };
  const first = await faux.provider.stream(model, context).result();
  const second = await faux.provider.stream(model, context).result();
  assert.equal(first.stopReason, "stop");
  assert.equal(second.stopReason, "stop");
  assert.equal(faux.getPendingResponseCount(), 1);
});

test("hosted presets must exist in the pinned Pi OpenRouter catalog", () => {
  assert.throws(
    () =>
      new ImmutableModelPresetRegistry(
        [{ key: "unknown", model: "openrouter/not-a-real/model" }],
        { hostedEnabled: true },
      ),
    /pinned OpenRouter catalog/u,
  );
});

test("each immutable preset owns its routing variant even for the same model", () => {
  const presets = parseApprovedModelPresets([
    {
      key: "zdr",
      model: "openrouter/anthropic/claude-sonnet-4.6",
      routing: { zdr: true, only: ["anthropic"] },
    },
    {
      key: "fallback",
      model: "openrouter/anthropic/claude-sonnet-4.6",
      routing: { allow_fallbacks: true },
    },
  ]);
  const providers = createOpenRouterPresetProviders(presets);
  assert.equal(providers.length, 2);
  assert.notEqual(providers[0]?.id, providers[1]?.id);
  assert.equal(
    providers[0]?.getModels()[0]?.compat?.openRouterRouting?.zdr,
    true,
  );
  assert.equal(
    providers[1]?.getModels()[0]?.compat?.openRouterRouting?.allow_fallbacks,
    true,
  );
  const registry = new ImmutableModelPresetRegistry(presets, {
    hostedEnabled: true,
  });
  assert.notEqual(
    registry.resolve("zdr").model,
    registry.resolve("fallback").model,
  );
});

test("hosted preset JSON is validated and the platform guard runs pre-provider", () => {
  assert.throws(() =>
    parseApprovedModelPresets([
      {
        key: "bad",
        model: "openrouter/anthropic/claude-sonnet-4.6",
        routing: { allow_fallbacks: "yes" },
      },
    ]),
  );
  const faux = createDeterministicModelProvider();
  const guarded = withPlatformTurnLimit(faux.provider, 1);
  const model = guarded.getModels()[0];
  assert.ok(model);
  assert.throws(() =>
    guarded.stream(model, {
      messages: [
        { role: "user", content: "hello", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          api: "fake",
          provider: "fake",
          model: "deterministic",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      ],
    }),
  );
});
