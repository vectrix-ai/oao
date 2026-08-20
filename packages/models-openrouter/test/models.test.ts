import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_PRESETS,
  ImmutableModelPresetRegistry,
  createDeterministicModelProvider,
  createOpenRouterProvider,
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
