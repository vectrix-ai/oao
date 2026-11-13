import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeContext,
  type Api,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import {
  DEFAULT_LOCAL_PRESETS,
  ImmutableModelPresetRegistry,
  ProjectModelPresetRegistry,
  anthropicCallMaxTokens,
  effectiveModelLimits,
  type ModelPresetLimitsInput,
} from "../src/index.js";

const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
};

const solPreset = {
  ...tenant,
  providerId: "00000000-0000-4000-8000-000000000003",
  providerType: "openrouter" as const,
  apiKey: "sk-or-limits-test",
  credentialVersion: 1,
  key: "azure-sol-61-v1",
  model: "openrouter/@preset/azure-sol-61",
  routing: {},
};

const solLimits: ModelPresetLimitsInput = {
  id: "00000000-0000-4000-8000-000000000071",
  contextWindow: 250_000,
  maxOutputTokens: 128_000,
};

function registry() {
  const providers: Provider[] = [];
  return {
    providers,
    registry: new ProjectModelPresetRegistry({
      deployment: new ImmutableModelPresetRegistry(DEFAULT_LOCAL_PRESETS, {
        hostedEnabled: false,
      }),
      registerProvider: (provider) => providers.push(provider),
    }),
  };
}

/** The model a run of the preset resolves, as Flue finds it in the registry. */
function runtimeModel(provider: Provider | undefined): Model<Api> {
  const model = provider?.getModels()[0];
  assert.ok(model);
  return model as Model<Api>;
}

/** The output limit the request asks for, whichever API the provider uses. */
function requestedOutput(payload: Record<string, unknown> | undefined) {
  return (
    payload?.max_output_tokens ??
    payload?.max_completion_tokens ??
    payload?.max_tokens
  );
}

async function sentPayload(
  provider: Provider,
  model: Model<Api>,
  content: string,
): Promise<Record<string, unknown> | undefined> {
  let payload: Record<string, unknown> | undefined;
  await provider
    .streamSimple(
      model,
      normalizeContext({
        messages: [{ role: "user", content, timestamp: 1 }],
      }),
      {
        apiKey: "sk-limits-test",
        maxRetries: 0,
        fetch: async (_input, init) => {
          payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ error: { message: "expected test stop" } }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        },
      },
    )
    .result();
  return payload;
}

test("a preset with limits asks each call for its output limit, fitted into its window", async () => {
  const { registry: presets, providers } = registry();
  const resolved = presets.activate({ ...solPreset, limits: solLimits });
  const model = runtimeModel(providers[0]);
  assert.equal(model.contextWindow, 250_000);
  assert.equal(model.maxTokens, 128_000);
  assert.deepEqual(resolved.limits, {
    contextWindow: 250_000,
    contextWindowSource: "preset",
    maxOutputTokens: 128_000,
    maxOutputTokensSource: "preset",
    presetLimitsId: solLimits.id,
  });

  // A short conversation asks for the whole output limit.
  const short = await sentPayload(providers[0]!, model, "Write a long answer.");
  assert.equal(requestedOutput(short), 128_000);

  // A long one asks for what the window leaves, as pi fits it.
  const longText = "word ".repeat(600_000);
  const long = await sentPayload(providers[0]!, model, longText);
  const fitted = clampMaxTokensToContext(
    model,
    normalizeContext({
      messages: [{ role: "user", content: longText, timestamp: 1 }],
    }),
    128_000,
  );
  assert.ok(fitted > 0 && fitted < 128_000, String(fitted));
  assert.equal(requestedOutput(long), fitted);

  // Flue compacts once a call passes the window minus an output reserve of
  // min(20,000, maxTokens), read from this model: about 230,000 tokens here.
  assert.equal(
    model.contextWindow - Math.min(20_000, model.maxTokens),
    230_000,
  );
});

test("a preset without limits keeps OAO's placeholder for an unknown model", async () => {
  const { registry: presets, providers } = registry();
  const resolved = presets.activate(solPreset);
  const model = runtimeModel(providers[0]);
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.maxTokens, 4_096);
  assert.deepEqual(resolved.limits, {
    contextWindow: 128_000,
    contextWindowSource: "model",
    maxOutputTokens: 4_096,
    maxOutputTokensSource: "model",
    presetLimitsId: null,
  });
  const payload = await sentPayload(providers[0]!, model, "Say hello.");
  assert.equal(requestedOutput(payload), 4_096);
  // Limits with both values empty change nothing either.
  const cleared = registry();
  cleared.registry.activate({
    ...solPreset,
    limits: { id: "cleared", contextWindow: null, maxOutputTokens: null },
  });
  assert.equal(runtimeModel(cleared.providers[0]).maxTokens, 4_096);
  assert.equal(runtimeModel(cleared.providers[0]).contextWindow, 128_000);
});

test("new limits register the preset again for its next run, and one limit can stay the model's", () => {
  const { registry: presets, providers } = registry();
  presets.activate({ ...solPreset, limits: solLimits });
  presets.activate({ ...solPreset, limits: solLimits });
  assert.equal(providers.length, 1);

  const smaller = presets.activate({
    ...solPreset,
    limits: {
      id: "00000000-0000-4000-8000-000000000073",
      contextWindow: 200_000,
      maxOutputTokens: null,
    },
  });
  assert.equal(providers.length, 2);
  // The earlier model object a run already holds keeps its limits.
  assert.equal(runtimeModel(providers[0]).contextWindow, 250_000);
  assert.equal(runtimeModel(providers[1]).contextWindow, 200_000);
  assert.equal(runtimeModel(providers[1]).maxTokens, 4_096);
  assert.equal(smaller.limits?.maxOutputTokensSource, "model");

  presets.activate(solPreset);
  assert.equal(providers.length, 3);
  assert.equal(runtimeModel(providers[2]).contextWindow, 128_000);
  // Limits are not part of the definition, so changing them is not refused.
  assert.equal(
    presets.resolve(solPreset.key, tenant).limits?.contextWindow,
    128_000,
  );
});

test("an Anthropic call asks for the smaller of its maxTokens setting and its output limit", async () => {
  assert.equal(anthropicCallMaxTokens(20_000, null), 20_000);
  assert.equal(anthropicCallMaxTokens(20_000, 8_000), 8_000);
  assert.equal(anthropicCallMaxTokens(20_000, 64_000), 20_000);

  const anthropic = {
    ...tenant,
    providerId: "00000000-0000-4000-8000-000000000004",
    providerType: "anthropic" as const,
    apiKey: "sk-ant-limits-test",
    credentialVersion: 1,
    key: "claude-sonnet-5-v1",
    model: "anthropic/claude-sonnet-5",
    routing: {},
    settings: {
      thinking: "adaptive" as const,
      maxTokens: 20_000,
      effort: "high" as const,
    },
  };
  for (const [maxOutputTokens, asked, source] of [
    [8_000, 8_000, "preset"],
    [64_000, 20_000, "settings"],
  ] as const) {
    const { registry: presets, providers } = registry();
    const resolved = presets.activate({
      ...anthropic,
      limits: { id: "limits", contextWindow: null, maxOutputTokens },
    });
    const model = runtimeModel(providers[0]);
    assert.equal(model.maxTokens, maxOutputTokens);
    const payload = await sentPayload(providers[0]!, model, "Say hello.");
    assert.equal(payload?.max_tokens, asked);
    assert.equal(resolved.limits?.maxOutputTokens, asked);
    assert.equal(resolved.limits?.maxOutputTokensSource, source);
  }
});

test("the limits in effect name where each came from", () => {
  const model = { contextWindow: 400_000, maxTokens: 128_000 };
  assert.deepEqual(effectiveModelLimits({ model, limits: null }), {
    contextWindow: 400_000,
    contextWindowSource: "model",
    maxOutputTokens: 128_000,
    maxOutputTokensSource: "model",
    presetLimitsId: null,
  });
  assert.deepEqual(
    effectiveModelLimits({
      model,
      limits: { id: "l", contextWindow: 250_000, maxOutputTokens: null },
      settingsMaxTokens: 20_000,
    }),
    {
      contextWindow: 250_000,
      contextWindowSource: "preset",
      maxOutputTokens: 20_000,
      maxOutputTokensSource: "settings",
      presetLimitsId: "l",
    },
  );
});
