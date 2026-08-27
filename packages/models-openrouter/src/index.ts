import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai";
import type {
  Api,
  ApiKeyAuth,
  Model,
  OpenRouterRouting,
  Provider,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
export type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
export {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type {
  ModelGenerationSettings,
  ModelCatalogEntry,
  ModelProviderType,
  ModelRoutingPolicy,
} from "@oao/contracts";
import { DEFAULT_OPENAI_MODEL_GENERATION_SETTINGS } from "@oao/contracts";
import * as v from "valibot";

const OPENROUTER_MODEL_IDS = new Set(
  openrouterProvider()
    .getModels()
    .map((model) => model.id),
);
const OPENAI_MODEL_IDS = new Set(
  openaiProvider()
    .getModels()
    .map((model) => model.id),
);

const StringListSchema = v.array(v.pipe(v.string(), v.minLength(1)));
const PercentilesSchema = v.strictObject({
  p50: v.optional(v.number()),
  p75: v.optional(v.number()),
  p90: v.optional(v.number()),
  p99: v.optional(v.number()),
});

export const OpenRouterRoutingSchema = v.strictObject({
  allow_fallbacks: v.optional(v.boolean()),
  require_parameters: v.optional(v.boolean()),
  data_collection: v.optional(v.picklist(["deny", "allow"])),
  zdr: v.optional(v.boolean()),
  enforce_distillable_text: v.optional(v.boolean()),
  order: v.optional(StringListSchema),
  only: v.optional(StringListSchema),
  ignore: v.optional(StringListSchema),
  quantizations: v.optional(StringListSchema),
  sort: v.optional(
    v.union([
      v.string(),
      v.strictObject({
        by: v.optional(v.string()),
        partition: v.optional(v.nullable(v.string())),
      }),
    ]),
  ),
  max_price: v.optional(
    v.strictObject({
      prompt: v.optional(v.union([v.number(), v.string()])),
      completion: v.optional(v.union([v.number(), v.string()])),
      image: v.optional(v.union([v.number(), v.string()])),
      audio: v.optional(v.union([v.number(), v.string()])),
      request: v.optional(v.union([v.number(), v.string()])),
    }),
  ),
  preferred_min_throughput: v.optional(
    v.union([v.number(), PercentilesSchema]),
  ),
  preferred_max_latency: v.optional(v.union([v.number(), PercentilesSchema])),
});

export const ApprovedModelPresetSchema = v.strictObject({
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  routing: v.optional(OpenRouterRoutingSchema),
});

export type ApprovedModelPreset = v.InferOutput<
  typeof ApprovedModelPresetSchema
>;

export function parseApprovedModelPresets(
  value: unknown,
): ApprovedModelPreset[] {
  return v.parse(v.array(ApprovedModelPresetSchema), value);
}

function presetProviderId(key: string): string {
  return `openrouter-preset-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>))
      deepFreeze(nested);
  }
  return value;
}

function openRouterModelCompat(
  model: Model<"openai-completions">,
  routing?: Readonly<OpenRouterRouting>,
) {
  return {
    ...model.compat,
    ...(model.id.startsWith("anthropic/")
      ? { cacheControlFormat: "anthropic" as const }
      : {}),
    sendSessionAffinityHeaders: true,
    sessionAffinityFormat: "openrouter" as const,
    ...(routing ? { openRouterRouting: structuredClone(routing) } : {}),
  };
}

export class ImmutableModelPresetRegistry {
  readonly #presets: ReadonlyMap<
    string,
    Readonly<ApprovedModelPreset> & { readonly runtimeModel: string }
  >;

  constructor(
    presets: readonly ApprovedModelPreset[],
    private readonly options: { readonly hostedEnabled: boolean },
  ) {
    const entries = presets.map((input) => {
      const preset = v.parse(ApprovedModelPresetSchema, input);
      if (
        preset.model !== "fake/deterministic" &&
        !preset.model.startsWith("openrouter/")
      )
        throw new TypeError(
          `Model is not allowlisted through OpenRouter: ${preset.model}`,
        );
      if (
        preset.model.startsWith("openrouter/") &&
        !OPENROUTER_MODEL_IDS.has(preset.model.slice("openrouter/".length))
      )
        throw new TypeError(
          `Model is not present in the pinned OpenRouter catalog: ${preset.model}`,
        );
      const runtimeModel = preset.model.startsWith("openrouter/")
        ? `${presetProviderId(preset.key)}/${preset.model.slice("openrouter/".length)}`
        : preset.model;
      return [
        preset.key,
        deepFreeze({ ...structuredClone(preset), runtimeModel }),
      ] as const;
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      throw new TypeError("Duplicate model preset key");
    this.#presets = new Map(entries);
    Object.freeze(this);
  }

  resolve(key: string): Readonly<ApprovedModelPreset> & {
    readonly model: string;
    readonly approvedModel: string;
  } {
    const preset = this.#presets.get(key);
    if (!preset) throw new Error(`Model preset is not approved: ${key}`);
    if (preset.model.startsWith("openrouter/") && !this.options.hostedEnabled)
      throw new Error("Hosted model calls are disabled");
    return {
      ...preset,
      approvedModel: preset.model,
      model: preset.runtimeModel,
    };
  }

  list(): readonly Readonly<ApprovedModelPreset>[] {
    return [...this.#presets.values()];
  }
}

export function createOpenRouterProvider(
  routing?: Readonly<OpenRouterRouting>,
): Provider<"openai-completions"> {
  const native = openrouterProvider();
  const models = native.getModels().map((model) =>
    deepFreeze({
      ...model,
      compat: openRouterModelCompat(model, routing),
    }),
  );
  return createProvider({
    id: native.id,
    name: native.name,
    ...(native.baseUrl ? { baseUrl: native.baseUrl } : {}),
    ...(native.headers ? { headers: native.headers } : {}),
    auth: native.auth,
    models,
    api: openAICompletionsApi(),
  });
}

export function createOpenRouterPresetProviders(
  presets: readonly ApprovedModelPreset[],
): readonly Provider<"openai-completions">[] {
  const native = openrouterProvider();
  return presets.map((input) => {
    const preset = v.parse(ApprovedModelPresetSchema, input);
    if (!preset.model.startsWith("openrouter/"))
      throw new TypeError(
        "OpenRouter provider presets require an OpenRouter model",
      );
    const modelId = preset.model.slice("openrouter/".length);
    const nativeModel = native
      .getModels()
      .find((model) => model.id === modelId);
    if (!nativeModel)
      throw new TypeError(
        `Model is not present in the pinned OpenRouter catalog: ${preset.model}`,
      );
    const id = presetProviderId(preset.key);
    const routing = preset.routing as OpenRouterRouting | undefined;
    const model = deepFreeze({
      ...nativeModel,
      provider: id,
      compat: openRouterModelCompat(nativeModel, routing),
    });
    return createProvider({
      id,
      name: `${native.name} (${preset.key})`,
      ...(native.baseUrl ? { baseUrl: native.baseUrl } : {}),
      ...(native.headers ? { headers: native.headers } : {}),
      auth: native.auth,
      models: [model],
      api: openAICompletionsApi(),
    });
  });
}

export function withPlatformTurnLimit<T extends Provider>(
  provider: T,
  maxTurns = 32,
): T {
  const assertTurnLimit = (messages: readonly { readonly role: string }[]) => {
    let boundary = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        boundary = index;
        break;
      }
    }
    const turns = messages
      .slice(boundary + 1)
      .filter((message) => message.role === "assistant").length;
    if (turns >= maxTurns)
      throw new Error(`Platform model turn limit exceeded (${maxTurns})`);
  };
  return {
    ...provider,
    stream(model, context, options) {
      assertTurnLimit(context.messages);
      return provider.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      assertTurnLimit(context.messages);
      return provider.streamSimple(model, context, options);
    },
  } as T;
}

export function createDeterministicModelProvider(
  responses?: readonly FauxResponseStep[],
): FauxProviderHandle {
  const handle = fauxProvider({
    provider: "fake",
    api: "fake",
    models: [
      {
        id: "deterministic",
        name: "OAO deterministic fake",
        reasoning: false,
        input: ["text"],
        contextWindow: 32_000,
        maxTokens: 4_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    tokensPerSecond: 0,
  });
  if (responses) {
    handle.setResponses([...responses]);
  } else {
    const repeat: FauxResponseStep = (_context, _options, state) => {
      handle.appendResponses([repeat]);
      return fauxAssistantMessage("deterministic response", {
        responseId: `oao-fake-response-${state.callCount}`,
      });
    };
    handle.setResponses([repeat]);
  }
  return handle;
}

/** Test-only deterministic preset. Runnable OAO processes do not load it. */
export const DEFAULT_LOCAL_PRESETS = deepFreeze([
  { key: "local-default", model: "fake/deterministic" },
]);

const OPENROUTER_PREFIX = "openrouter/";
const OPENROUTER_PRESET_PREFIX = "openrouter/@preset/";
const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_PAGE_SIZE = 1_000;
const OPENAI_PREFIX = "openai/";
const OPENAI_CATALOG_URL = "https://api.openai.com/v1";

type Fetcher = typeof fetch;

interface OpenRouterModelResponse {
  readonly data?: readonly unknown[];
  readonly total_count?: unknown;
  readonly links?: { readonly next?: unknown };
}

interface OpenAIModelResponse {
  readonly data?: readonly unknown[];
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function openRouterJson(
  path: string,
  apiKey: string,
  fetcher: Fetcher,
): Promise<OpenRouterModelResponse> {
  const response = await fetcher(`${OPENROUTER_CATALOG_URL}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok)
    throw new Error(
      `OpenRouter catalog request failed with ${response.status}`,
    );
  const json = record(await response.json());
  if (!json || !Array.isArray(json.data))
    throw new Error("OpenRouter catalog response was not a list");
  return json as OpenRouterModelResponse;
}

async function openRouterPages(
  path: string,
  apiKey: string,
  fetcher: Fetcher,
  pageSize: number,
): Promise<readonly unknown[]> {
  const data: unknown[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const separator = path.includes("?") ? "&" : "?";
    const page = await openRouterJson(
      `${path}${separator}offset=${offset}&limit=${pageSize}`,
      apiKey,
      fetcher,
    );
    data.push(...(page.data ?? []));
    const next = record(page.links)?.next;
    const total = numberValue(page.total_count);
    if (typeof next !== "string" || next.length === 0) {
      if (total === undefined || data.length >= total) break;
    }
    if ((page.data ?? []).length === 0 || data.length >= 10_000) break;
  }
  return data;
}

function openRouterModelEntry(input: unknown): ModelCatalogEntry | undefined {
  const model = record(input);
  if (!model) return undefined;
  const catalogId = stringValue(model.id);
  const name = stringValue(model.name);
  if (!catalogId || !name) return undefined;
  const architecture = record(model.architecture);
  const topProvider = record(model.top_provider);
  const output = stringArray(architecture?.output_modalities);
  if (output.length > 0 && !output.includes("text")) return undefined;
  return {
    providerType: "openrouter",
    model: `${OPENROUTER_PREFIX}${catalogId}`,
    catalogId,
    name,
    contextWindow:
      positiveInteger(model.context_length) ??
      positiveInteger(topProvider?.context_length),
    maxOutputTokens: positiveInteger(topProvider?.max_completion_tokens),
    reasoning: stringArray(model.supported_parameters).includes("reasoning"),
  };
}

function openRouterPresetEntry(input: unknown): ModelCatalogEntry | undefined {
  const preset = record(input);
  if (!preset) return undefined;
  const slug = stringValue(preset.slug);
  const name = stringValue(preset.name) ?? slug;
  if (!slug) return undefined;
  return {
    providerType: "openrouter",
    model: `${OPENROUTER_PRESET_PREFIX}${slug}`,
    catalogId: `@preset/${slug}`,
    name: `Preset: ${name}`,
    contextWindow: null,
    maxOutputTokens: null,
    reasoning: false,
  };
}

function catalogMatches(
  entry: ModelCatalogEntry,
  search: string | undefined,
): boolean {
  const term = search?.trim().toLowerCase();
  if (!term) return true;
  return (
    entry.catalogId.toLowerCase().includes(term) ||
    entry.name.toLowerCase().includes(term) ||
    entry.model.toLowerCase().includes(term)
  );
}

export async function listOpenRouterModelCatalog(input: {
  readonly apiKey: string;
  readonly search?: string;
  readonly limit?: number;
  readonly fetcher?: Fetcher;
}): Promise<readonly ModelCatalogEntry[]> {
  const fetcher = input.fetcher ?? fetch;
  const [models, presets] = await Promise.all([
    openRouterPages(
      "/models?output_modalities=text",
      input.apiKey,
      fetcher,
      OPENROUTER_PAGE_SIZE,
    ),
    openRouterPages("/presets", input.apiKey, fetcher, 100).catch(() => []),
  ]);
  const entries = [
    ...models.flatMap((item) => {
      const entry = openRouterModelEntry(item);
      return entry ? [entry] : [];
    }),
    ...presets.flatMap((item) => {
      const entry = openRouterPresetEntry(item);
      return entry ? [entry] : [];
    }),
  ]
    .filter((entry) => catalogMatches(entry, input.search))
    .sort((left, right) => left.catalogId.localeCompare(right.catalogId));
  return entries.slice(0, input.limit ?? entries.length);
}

/**
 * Account-aware projection of OpenAI's live model catalog.
 *
 * `GET /v1/models` also returns embeddings, image, audio, fine-tuned, and
 * other model types. OAO exposes only entries supported by its pinned
 * Responses provider so every selectable model can be activated safely by the
 * runtime.
 */
export async function listOpenAIModelCatalog(input: {
  readonly apiKey: string;
  readonly search?: string;
  readonly limit?: number;
  readonly fetcher?: Fetcher;
}): Promise<readonly ModelCatalogEntry[]> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(`${OPENAI_CATALOG_URL}/models`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
  });
  if (!response.ok)
    throw new Error(`OpenAI catalog request failed with ${response.status}`);
  const json = record(await response.json());
  if (!json || !Array.isArray(json.data))
    throw new Error("OpenAI catalog response was not a list");

  const supported = new Map(
    openaiProvider()
      .getModels()
      .map((model) => [model.id, model] as const),
  );
  const data = (json as OpenAIModelResponse).data ?? [];
  const entries = data
    .flatMap((item) => {
      const catalogId = stringValue(record(item)?.id);
      const model = catalogId ? supported.get(catalogId) : undefined;
      if (!catalogId || !model) return [];
      return [
        {
          providerType: "openai" as const,
          model: `${OPENAI_PREFIX}${catalogId}`,
          catalogId,
          name: model.name,
          contextWindow: positiveInteger(model.contextWindow),
          maxOutputTokens: positiveInteger(model.maxTokens),
          reasoning: model.reasoning === true,
        },
      ];
    })
    .filter((entry) => catalogMatches(entry, input.search))
    .sort((left, right) => left.catalogId.localeCompare(right.catalogId));
  return [
    ...new Map(entries.map((entry) => [entry.model, entry])).values(),
  ].slice(0, input.limit ?? entries.length);
}

function openRouterCatalogId(model: string): string | undefined {
  return model.startsWith(OPENROUTER_PREFIX)
    ? model.slice(OPENROUTER_PREFIX.length)
    : undefined;
}

function isValidOpenRouterCatalogId(value: string | undefined): boolean {
  return (
    value !== undefined &&
    /^(?:@preset\/)?[A-Za-z0-9~][A-Za-z0-9._:~/-]*$/u.test(value)
  );
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Safe, credential-free projection of the deployment OpenRouter/OpenAI catalog.
 * Project connections use the provider-specific live catalog functions.
 */
export function listApprovedModelCatalog(
  providerType?: ModelProviderType,
): readonly ModelCatalogEntry[] {
  const providers = [
    ...(providerType === undefined || providerType === "openrouter"
      ? [
          {
            type: "openrouter" as const,
            prefix: "openrouter/",
            provider: openrouterProvider(),
          },
        ]
      : []),
    ...(providerType === undefined || providerType === "openai"
      ? [
          {
            type: "openai" as const,
            prefix: OPENAI_PREFIX,
            provider: openaiProvider(),
          },
        ]
      : []),
  ];
  return providers
    .flatMap(({ type, prefix, provider }) =>
      provider.getModels().map((model) => ({
        providerType: type,
        model: `${prefix}${model.id}`,
        catalogId: model.id,
        name: model.name,
        contextWindow: positiveInteger(model.contextWindow),
        maxOutputTokens: positiveInteger(model.maxTokens),
        reasoning: model.reasoning === true,
      })),
    )
    .sort((left, right) => left.catalogId.localeCompare(right.catalogId));
}

/** True when `model` is an entry of the matching pinned provider catalog. */
export function isApprovedCatalogModel(
  model: string,
  providerType?: ModelProviderType,
): boolean {
  const catalogId = openRouterCatalogId(model);
  if (
    (providerType === undefined || providerType === "openrouter") &&
    catalogId !== undefined &&
    (OPENROUTER_MODEL_IDS.has(catalogId) ||
      isValidOpenRouterCatalogId(catalogId))
  )
    return true;
  const openAiId = model.startsWith(OPENAI_PREFIX)
    ? model.slice(OPENAI_PREFIX.length)
    : undefined;
  return (
    (providerType === undefined || providerType === "openai") &&
    openAiId !== undefined &&
    OPENAI_MODEL_IDS.has(openAiId)
  );
}

/**
 * Translates the provider-neutral public policy into OpenRouter's wire shape.
 * Keeping the mapping here is what lets the API, SDK, and console stay free of
 * provider-specific routing names.
 */
export function toOpenRouterRouting(
  policy: ModelRoutingPolicy,
): OpenRouterRouting | undefined {
  const routing: Record<string, unknown> = {};
  if (policy.allowFallbacks !== undefined)
    routing.allow_fallbacks = policy.allowFallbacks;
  if (policy.requireParameters !== undefined)
    routing.require_parameters = policy.requireParameters;
  if (policy.dataCollection !== undefined)
    routing.data_collection = policy.dataCollection;
  if (policy.zeroDataRetention !== undefined)
    routing.zdr = policy.zeroDataRetention;
  if (policy.providerOrder) routing.order = [...policy.providerOrder];
  if (policy.providerAllowlist) routing.only = [...policy.providerAllowlist];
  if (policy.providerDenylist) routing.ignore = [...policy.providerDenylist];
  if (policy.sort) routing.sort = policy.sort;
  const maxPrice: Record<string, number> = {};
  if (policy.maxPromptPriceUsdPerMillion !== undefined)
    maxPrice.prompt = policy.maxPromptPriceUsdPerMillion;
  if (policy.maxCompletionPriceUsdPerMillion !== undefined)
    maxPrice.completion = policy.maxCompletionPriceUsdPerMillion;
  if (Object.keys(maxPrice).length > 0) routing.max_price = maxPrice;
  if (Object.keys(routing).length === 0) return undefined;
  return v.parse(OpenRouterRoutingSchema, routing) as OpenRouterRouting;
}

export interface ModelPresetTenant {
  readonly organizationId: string;
  readonly projectId: string;
}

export interface ProjectModelPresetInput extends ModelPresetTenant {
  readonly key: string;
  readonly providerId: string;
  readonly providerType: ModelProviderType;
  readonly apiKey: string;
  readonly credentialVersion: number;
  readonly model: string;
  readonly routing: ModelRoutingPolicy;
  readonly settings?: ModelGenerationSettings | null;
}

export interface ResolvedModelPreset {
  readonly key: string;
  /** Runtime model identifier, namespaced by the preset's provider identity. */
  readonly model: string;
  /** Approved catalog identifier the preset was created from. */
  readonly approvedModel: string;
  readonly origin: "deployment" | "project";
  readonly settings?: ModelGenerationSettings | null;
}

function projectPresetProviderId(input: ProjectModelPresetInput): string {
  return `project-model-${createHash("sha256")
    .update(
      [input.organizationId, input.projectId, input.providerId, input.key]
        .map((part) => `${part.length}:${part}`)
        .join("|"),
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function presetFingerprint(input: ProjectModelPresetInput): string {
  return JSON.stringify({
    providerId: input.providerId,
    providerType: input.providerType,
    model: input.model,
    routing: Object.fromEntries(
      Object.entries(input.routing).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    settings: input.settings,
  });
}

/**
 * Bounded, tenant-scoped approved catalog for the runtime process.
 *
 * Flue resolves `useModel(...)` synchronously against providers registered in
 * the process, while durable project presets live in PostgreSQL. The
 * orchestrator therefore activates the preset a run needs *before* dispatch:
 * activation re-validates the model against the provider catalog, registers one
 * provider identity per (organization, project, key), and caches the mapping.
 *
 * Activation is append-only in memory. Re-activating a key whose stored model
 * or routing differs from the already active definition throws instead of
 * silently changing what an older immutable agent version means.
 */
export class ProjectModelPresetRegistry {
  readonly #deployment: ImmutableModelPresetRegistry;
  readonly #registerProvider: (provider: Provider) => void;
  readonly #active = new Map<
    string,
    {
      readonly resolved: ResolvedModelPreset;
      readonly fingerprint: string;
      readonly credentialVersion: number;
    }
  >();

  constructor(options: {
    readonly deployment: ImmutableModelPresetRegistry;
    readonly registerProvider: (provider: Provider) => void;
  }) {
    this.#deployment = options.deployment;
    this.#registerProvider = options.registerProvider;
  }

  static #cacheKey(tenant: ModelPresetTenant, key: string): string {
    return `${tenant.organizationId}/${tenant.projectId}/${key}`;
  }

  #isDeploymentKey(key: string): boolean {
    return this.#deployment.list().some((preset) => preset.key === key);
  }

  /** Registers a durable project preset so a synchronous resolve can find it. */
  activate(input: ProjectModelPresetInput): ResolvedModelPreset {
    if (!isApprovedCatalogModel(input.model, input.providerType))
      throw new Error(
        `Model is not present in the pinned ${input.providerType} catalog: ${input.model}`,
      );
    if (
      input.providerType === "openai" &&
      Object.keys(input.routing).length > 0
    )
      throw new Error("OpenAI model presets do not support routing policy");
    if (input.providerType === "openrouter" && input.settings != null)
      throw new Error(
        "OpenRouter model presets do not support direct generation settings",
      );
    const settings =
      input.providerType === "openai"
        ? (input.settings ?? DEFAULT_OPENAI_MODEL_GENERATION_SETTINGS)
        : null;
    const cacheKey = ProjectModelPresetRegistry.#cacheKey(input, input.key);
    const fingerprint = presetFingerprint({ ...input, settings });
    const existing = this.#active.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error(
          `Model preset definition changed after activation: ${input.key}`,
        );
      if (existing.credentialVersion >= input.credentialVersion)
        return existing.resolved;
    }
    const providerId = projectPresetProviderId(input);
    const catalogId = input.model.slice(input.providerType.length + 1);
    this.#registerProvider(
      createProjectPresetProvider({
        providerId,
        providerType: input.providerType,
        catalogId,
        label: input.key,
        apiKey: input.apiKey,
        routing: toOpenRouterRouting(input.routing),
        settings,
      }),
    );
    const resolved: ResolvedModelPreset = deepFreeze({
      key: input.key,
      model: `${providerId}/${catalogId}`,
      approvedModel: input.model,
      origin: "project",
      settings,
    });
    this.#active.set(cacheKey, {
      resolved,
      fingerprint,
      credentialVersion: input.credentialVersion,
    });
    return resolved;
  }

  /** Synchronous resolution used by the agent render. */
  resolve(key: string, tenant: ModelPresetTenant): ResolvedModelPreset {
    // A durable project preset wins if a deployment later introduces the same
    // key. New collisions are rejected by the API, but preserving an existing
    // row here prevents a configuration change from silently repointing an
    // already-published agent version after a restart.
    const active = this.#active.get(
      ProjectModelPresetRegistry.#cacheKey(tenant, key),
    );
    if (active) return active.resolved;
    if (this.#isDeploymentKey(key)) {
      const preset = this.#deployment.resolve(key);
      return {
        key: preset.key,
        model: preset.model,
        approvedModel: preset.approvedModel,
        origin: "deployment",
        settings: null,
      };
    }
    throw new Error(`Model preset is not approved: ${key}`);
  }
}

function credentialAuth(
  providerType: ModelProviderType,
  apiKey: string,
): { readonly apiKey: ApiKeyAuth } {
  return {
    apiKey: {
      name: `${providerType} project API key`,
      check: async () => ({
        type: "api_key",
        source: "encrypted project credential",
      }),
      resolve: async () => ({
        auth: { apiKey },
        source: "encrypted project credential",
      }),
    },
  };
}

function dynamicOpenRouterModel(input: {
  readonly providerId: string;
  readonly catalogId: string;
  readonly routing: OpenRouterRouting | undefined;
}): Model<"openai-completions"> {
  const native = openrouterProvider();
  const staticModel = native
    .getModels()
    .find((model) => model.id === input.catalogId);
  const model: Model<"openai-completions"> = staticModel
    ? { ...staticModel, provider: input.providerId }
    : {
        id: input.catalogId,
        name: input.catalogId.startsWith("@preset/")
          ? `OpenRouter ${input.catalogId}`
          : input.catalogId,
        api: "openai-completions",
        provider: input.providerId,
        baseUrl: native.baseUrl ?? OPENROUTER_CATALOG_URL,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
        compat: {
          supportsDeveloperRole: false,
          thinkingFormat: "openrouter",
        },
      };
  return deepFreeze({
    ...model,
    compat: openRouterModelCompat(model, input.routing),
  });
}

function createProjectPresetProvider(input: {
  readonly providerId: string;
  readonly providerType: ModelProviderType;
  readonly catalogId: string;
  readonly label: string;
  readonly apiKey: string;
  readonly routing: OpenRouterRouting | undefined;
  readonly settings: ModelGenerationSettings | null;
}): Provider {
  const native =
    input.providerType === "openrouter"
      ? openrouterProvider()
      : openaiProvider();
  const nativeModel =
    input.providerType === "openrouter"
      ? dynamicOpenRouterModel({
          providerId: input.providerId,
          catalogId: input.catalogId,
          routing: input.routing,
        })
      : native.getModels().find((model) => model.id === input.catalogId);
  if (!nativeModel)
    throw new TypeError(
      `Model is not present in the pinned ${input.providerType} catalog: ${input.catalogId}`,
    );
  const model =
    input.providerType === "openrouter"
      ? nativeModel
      : deepFreeze({ ...nativeModel, provider: input.providerId });
  const provider = createProvider({
    id: input.providerId,
    name: `${native.name} (${input.label})`,
    ...(native.baseUrl ? { baseUrl: native.baseUrl } : {}),
    ...(native.headers ? { headers: native.headers } : {}),
    auth: credentialAuth(input.providerType, input.apiKey),
    models: [model],
    api:
      input.providerType === "openrouter"
        ? openAICompletionsApi()
        : openAIResponsesApi(),
  });
  return input.providerType === "openai" && input.settings
    ? withOpenAIModelGenerationSettings(provider, input.settings)
    : provider;
}

function withOpenAIModelGenerationSettings<T extends Provider>(
  provider: T,
  settings: ModelGenerationSettings,
): T {
  const withSettings = (options: Record<string, unknown> | undefined) => {
    const existing = options?.onPayload as
      | ((payload: unknown, model: Model<Api>) => unknown | Promise<unknown>)
      | undefined;
    return {
      ...options,
      onPayload: async (payload: unknown, model: Model<Api>) => {
        const transformed = (await existing?.(payload, model)) ?? payload;
        if (
          !transformed ||
          typeof transformed !== "object" ||
          Array.isArray(transformed)
        )
          return transformed;
        const record = transformed as Record<string, unknown>;
        const text =
          record.text &&
          typeof record.text === "object" &&
          !Array.isArray(record.text)
            ? (record.text as Record<string, unknown>)
            : {};
        const reasoning =
          record.reasoning &&
          typeof record.reasoning === "object" &&
          !Array.isArray(record.reasoning)
            ? (record.reasoning as Record<string, unknown>)
            : {};
        return {
          ...record,
          text: {
            ...text,
            format: { type: settings.textFormat },
            verbosity: settings.verbosity,
          },
          reasoning: {
            ...reasoning,
            mode: settings.mode,
            summary: settings.summary,
          },
        };
      },
    };
  };
  return {
    ...provider,
    stream(model, context, options) {
      return provider.stream(
        model,
        context,
        withSettings(options as Record<string, unknown> | undefined) as never,
      );
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(
        model,
        context,
        withSettings(options as Record<string, unknown> | undefined) as never,
      );
    },
  } as T;
}

export interface ModelPresetConfiguration {
  readonly hostedEnabled: boolean;
  readonly hostedPresets: readonly ApprovedModelPreset[];
  readonly presets: readonly ApprovedModelPreset[];
  readonly registry: ImmutableModelPresetRegistry;
}

/**
 * Runnable processes have no deployment-local model. Provider-backed project
 * presets are activated from PostgreSQL before dispatch.
 */
export function loadModelPresetConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ModelPresetConfiguration {
  void environment;
  const hostedEnabled = false;
  const hostedPresets: readonly ApprovedModelPreset[] = [];
  const presets: readonly ApprovedModelPreset[] = [];
  return {
    hostedEnabled,
    hostedPresets,
    presets,
    registry: new ImmutableModelPresetRegistry(presets, { hostedEnabled }),
  };
}
import { createHash } from "node:crypto";
