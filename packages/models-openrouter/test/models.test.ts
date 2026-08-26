import assert from "node:assert/strict";
import test from "node:test";
import type { OpenAICompletionsCompat, Provider } from "@earendil-works/pi-ai";
import {
  DEFAULT_LOCAL_PRESETS,
  ImmutableModelPresetRegistry,
  ProjectModelPresetRegistry,
  createDeterministicModelProvider,
  createOpenRouterProvider,
  createOpenRouterPresetProviders,
  isApprovedCatalogModel,
  listApprovedModelCatalog,
  listOpenRouterModelCatalog,
  loadModelPresetConfiguration,
  parseApprovedModelPresets,
  toOpenRouterRouting,
  withPlatformTurnLimit,
} from "../src/index.js";

test("test-only deterministic preset remains available to isolated tests", () => {
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

test("runnable deployment configuration exposes no fake presets", () => {
  const local = loadModelPresetConfiguration({});
  assert.deepEqual(
    local.registry.list().map((preset) => preset.key),
    [],
  );
  assert.equal(local.hostedEnabled, false);

  assert.deepEqual(
    loadModelPresetConfiguration({
      OAO_ENABLE_HOSTED_MODELS: "true",
      OPENROUTER_API_KEY: "ignored",
    }).registry.list(),
    local.registry.list(),
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

test("OpenRouter Anthropic presets send cache markers and stable session affinity", async () => {
  const provider = createOpenRouterPresetProviders([
    {
      key: "cached-claude",
      model: "openrouter/anthropic/claude-sonnet-4.6",
      routing: { zdr: true },
    },
  ])[0];
  const model = provider?.getModels()[0];
  assert.ok(provider);
  assert.ok(model);
  assert.equal(model.compat?.cacheControlFormat, "anthropic");
  assert.equal(model.compat?.sendSessionAffinityHeaders, true);
  assert.equal(model.compat?.sessionAffinityFormat, "openrouter");

  let payload: unknown;
  let request: Request | undefined;
  const response = await provider
    .stream(
      model,
      {
        systemPrompt: "Stable extraction instructions and source document.",
        messages: [
          {
            role: "user",
            content: "Extract the shipment references.",
            timestamp: 1,
          },
        ],
      },
      {
        apiKey: "sk-openrouter-test",
        sessionId: "session-cache-affinity",
        maxRetries: 0,
        onPayload: (value) => {
          payload = value;
        },
        fetch: async (input, init) => {
          request = new Request(input, init);
          return new Response(
            JSON.stringify({ error: { message: "expected test stop" } }),
            {
              status: 503,
              headers: { "content-type": "application/json" },
            },
          );
        },
      },
    )
    .result();

  assert.equal(response.stopReason, "error");
  assert.equal(request?.headers.get("x-session-id"), "session-cache-affinity");
  assert.match(
    JSON.stringify(payload),
    /"cache_control":\{"type":"ephemeral"\}/u,
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

test("the pinned catalog is exposed without provider credentials", () => {
  const catalog = listApprovedModelCatalog();
  assert.ok(catalog.length > 0);
  const entry = catalog[0];
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), [
    "catalogId",
    "contextWindow",
    "maxOutputTokens",
    "model",
    "name",
    "providerType",
    "reasoning",
  ]);
  assert.ok(
    catalog.some((model) => model.providerType === "openrouter") &&
      catalog.some((model) => model.providerType === "openai"),
  );
  assert.ok(entry.model.startsWith(`${entry.providerType}/`));
  assert.equal(isApprovedCatalogModel(entry.model), true);
  assert.equal(isApprovedCatalogModel("openrouter/not-a-real/model"), true);
  assert.equal(isApprovedCatalogModel("openrouter/@preset/support"), true);
  assert.equal(isApprovedCatalogModel("fake/deterministic"), false);
  assert.ok(
    listApprovedModelCatalog("openai").every(
      (model) => model.providerType === "openai",
    ),
  );
  assert.equal(
    JSON.stringify(catalog).toLowerCase().includes("apikey") ||
      JSON.stringify(catalog).toLowerCase().includes("authorization"),
    false,
  );
});

test("OpenRouter live catalog combines models and saved presets", async () => {
  const requests: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/models?")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "openai/gpt-5.4",
              name: "GPT-5.4",
              context_length: 1_048_576,
              architecture: { output_modalities: ["text"] },
              top_provider: { max_completion_tokens: 65_536 },
              supported_parameters: ["temperature", "reasoning"],
            },
          ],
          total_count: 1,
          links: { next: null },
        }),
      );
    }
    if (url.includes("/presets?")) {
      return new Response(
        JSON.stringify({
          data: [{ slug: "support-agent", name: "Support agent" }],
          total_count: 1,
        }),
      );
    }
    throw new Error(`unexpected request ${url}`);
  };
  const catalog = await listOpenRouterModelCatalog({
    apiKey: "sk-openrouter-test",
    search: "support",
    fetcher: fetcher as typeof fetch,
  });
  assert.deepEqual(
    catalog.map((entry) => entry.model),
    ["openrouter/@preset/support-agent"],
  );
  const all = await listOpenRouterModelCatalog({
    apiKey: "sk-openrouter-test",
    fetcher: fetcher as typeof fetch,
  });
  assert.deepEqual(all.map((entry) => entry.model).sort(), [
    "openrouter/@preset/support-agent",
    "openrouter/openai/gpt-5.4",
  ]);
  assert.ok(requests.every((url) => !url.includes("sk-openrouter-test")));
});

test("provider-neutral policy maps onto the OpenRouter routing contract", () => {
  assert.equal(toOpenRouterRouting({}), undefined);
  assert.deepEqual(
    toOpenRouterRouting({
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: "deny",
      zeroDataRetention: true,
      providerOrder: ["anthropic", "google"],
      providerAllowlist: ["anthropic"],
      providerDenylist: ["novita"],
      sort: "latency",
      maxPromptPriceUsdPerMillion: 12.5,
      maxCompletionPriceUsdPerMillion: 40,
    }),
    {
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
      order: ["anthropic", "google"],
      only: ["anthropic"],
      ignore: ["novita"],
      sort: "latency",
      max_price: { prompt: 12.5, completion: 40 },
    },
  );
});

function projectRegistry() {
  const registered: string[] = [];
  const providers: Provider[] = [];
  const registry = new ProjectModelPresetRegistry({
    deployment: new ImmutableModelPresetRegistry(DEFAULT_LOCAL_PRESETS, {
      hostedEnabled: false,
    }),
    registerProvider: (provider) => {
      registered.push(provider.id);
      providers.push(provider);
    },
  });
  return { providers, registered, registry };
}

const tenantA = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  providerId: "00000000-0000-4000-8000-000000000003",
  providerType: "openrouter" as const,
  apiKey: "sk-openrouter-tenant-a",
  credentialVersion: 1,
};
const tenantB = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000012",
  providerId: "00000000-0000-4000-8000-000000000013",
  providerType: "openrouter" as const,
  apiKey: "sk-openrouter-tenant-b",
  credentialVersion: 1,
};

test("project presets resolve only inside their own project", () => {
  const { providers, registered, registry } = projectRegistry();
  registry.activate({
    ...tenantA,
    key: "claude-sonnet-4-6-zdr-v1",
    model: "openrouter/anthropic/claude-sonnet-4.6",
    routing: { zeroDataRetention: true, providerAllowlist: ["anthropic"] },
  });
  const resolved = registry.resolve("claude-sonnet-4-6-zdr-v1", tenantA);
  assert.equal(resolved.origin, "project");
  assert.equal(
    resolved.approvedModel,
    "openrouter/anthropic/claude-sonnet-4.6",
  );
  assert.match(resolved.model, /^project-model-[0-9a-f]{24}\//u);
  assert.equal(registered.length, 1);
  const projectModel = providers[0]?.getModels()[0];
  assert.ok(projectModel);
  if (projectModel.api !== "openai-completions")
    throw new Error("Expected an OpenRouter completions model");
  const compat = projectModel.compat as OpenAICompletionsCompat | undefined;
  assert.equal(compat?.cacheControlFormat, "anthropic");
  assert.equal(compat?.sendSessionAffinityHeaders, true);
  assert.throws(
    () => registry.resolve("claude-sonnet-4-6-zdr-v1", tenantB),
    /not approved/u,
  );
  assert.equal(
    registry.resolve("local-default", tenantB).model,
    "fake/deterministic",
  );
});

test("two projects sharing a preset key keep separate provider identities", () => {
  const { registered, registry } = projectRegistry();
  const a = registry.activate({
    ...tenantA,
    key: "shared-key-v1",
    model: "openrouter/anthropic/claude-sonnet-4.6",
    routing: { zeroDataRetention: true },
  });
  const b = registry.activate({
    ...tenantB,
    key: "shared-key-v1",
    model: "openrouter/anthropic/claude-sonnet-4.6",
    routing: {},
  });
  assert.notEqual(a.model, b.model);
  assert.equal(new Set(registered).size, 2);
});

test("activation is idempotent and append only", () => {
  const { registered, registry } = projectRegistry();
  const preset = {
    ...tenantA,
    key: "stable-v1",
    model: "openrouter/anthropic/claude-sonnet-4.6",
    routing: { zeroDataRetention: true },
  };
  assert.equal(
    registry.activate(preset).model,
    registry.activate({ ...preset, routing: { zeroDataRetention: true } })
      .model,
  );
  assert.equal(registered.length, 1);
  assert.throws(
    () =>
      registry.activate({ ...preset, routing: { zeroDataRetention: false } }),
    /changed after activation/u,
  );
  assert.throws(
    () => registry.activate({ ...preset, model: "openrouter/openai/gpt-5.1" }),
    /changed after activation/u,
  );
});

test("activation refuses mismatched provider models", () => {
  const { registry } = projectRegistry();
  assert.throws(
    () =>
      registry.activate({
        ...tenantA,
        key: "arbitrary-v1",
        model: "some-provider/whatever",
        routing: {},
      }),
    /pinned openrouter catalog/u,
  );
});

test("OpenRouter project presets can use live model ids and saved preset references", () => {
  const providers: Provider[] = [];
  const registry = new ProjectModelPresetRegistry({
    deployment: new ImmutableModelPresetRegistry(DEFAULT_LOCAL_PRESETS, {
      hostedEnabled: false,
    }),
    registerProvider: (provider) => providers.push(provider),
  });
  const liveModel = registry.activate({
    ...tenantA,
    key: "live-openrouter-v1",
    model: "openrouter/new-provider/new-model",
    routing: {},
  });
  const savedPreset = registry.activate({
    ...tenantA,
    key: "openrouter-preset-v1",
    model: "openrouter/@preset/support-agent",
    routing: { allowFallbacks: false },
  });
  assert.equal(liveModel.approvedModel, "openrouter/new-provider/new-model");
  assert.equal(savedPreset.approvedModel, "openrouter/@preset/support-agent");
  assert.equal(providers.at(0)?.getModels()[0]?.id, "new-provider/new-model");
  assert.equal(providers.at(1)?.getModels()[0]?.id, "@preset/support-agent");
});

test("an existing project preset wins over a later deployment key collision", () => {
  const registered: string[] = [];
  const registry = new ProjectModelPresetRegistry({
    deployment: new ImmutableModelPresetRegistry(
      [
        ...DEFAULT_LOCAL_PRESETS,
        {
          key: "stable-v1",
          model: "openrouter/openai/gpt-5.1",
        },
      ],
      { hostedEnabled: true },
    ),
    registerProvider: (provider) => registered.push(provider.id),
  });
  const project = registry.activate({
    ...tenantA,
    key: "stable-v1",
    model: "openrouter/anthropic/claude-sonnet-4.6",
    routing: { zeroDataRetention: true },
  });
  assert.equal(registry.resolve("stable-v1", tenantA), project);
  assert.equal(project.origin, "project");
  assert.equal(project.approvedModel, "openrouter/anthropic/claude-sonnet-4.6");
  assert.equal(registered.length, 1);
  assert.equal(registry.resolve("stable-v1", tenantB).origin, "deployment");
});

test("OpenAI project presets use direct routing and credentials can rotate", async () => {
  const providers: Provider[] = [];
  const registry = new ProjectModelPresetRegistry({
    deployment: new ImmutableModelPresetRegistry(DEFAULT_LOCAL_PRESETS, {
      hostedEnabled: false,
    }),
    registerProvider: (provider) => providers.push(provider),
  });
  const input = {
    ...tenantA,
    providerType: "openai" as const,
    apiKey: "sk-openai-first-key",
    key: "gpt-direct-v1",
    model: "openai/gpt-5.1",
    routing: {},
  };
  const first = registry.activate(input);
  const rotated = registry.activate({
    ...input,
    apiKey: "sk-openai-rotated-key",
    credentialVersion: 2,
  });
  assert.equal(first.model, rotated.model);
  assert.equal(providers.length, 2);
  const auth = await providers.at(-1)?.auth.apiKey?.resolve({
    ctx: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });
  assert.equal(auth?.auth.apiKey, "sk-openai-rotated-key");
  assert.throws(
    () => registry.activate({ ...input, routing: { allowFallbacks: false } }),
    /do not support routing policy/u,
  );
});
