import { createHash } from "node:crypto";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai";
import type { Model, OpenRouterRouting, Provider } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelCatalogEntry, ModelRoutingPolicy } from "@oao/contracts";
import * as v from "valibot";
import {
  catalogMatches,
  credentialAuth,
  deepFreeze,
  numberValue,
  positiveInteger,
  record,
  staticCatalogEntry,
  stringArray,
  stringValue,
  type CreateProjectProviderInput,
  type Fetcher,
} from "./shared.js";

export const OPENROUTER_PREFIX = "openrouter/";
const OPENROUTER_PRESET_PREFIX = "openrouter/@preset/";
const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_PAGE_SIZE = 1_000;

const OPENROUTER_MODEL_IDS = new Set(
  openrouterProvider()
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

export function presetProviderId(key: string): string {
  return `openrouter-preset-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
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
    if (!preset.model.startsWith(OPENROUTER_PREFIX))
      throw new TypeError(
        "OpenRouter provider presets require an OpenRouter model",
      );
    const modelId = preset.model.slice(OPENROUTER_PREFIX.length);
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

interface OpenRouterModelResponse {
  readonly data?: readonly unknown[];
  readonly total_count?: unknown;
  readonly links?: { readonly next?: unknown };
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
    adaptiveThinking: false,
    thinkingCanBeDisabled: true,
    effortLevels: [],
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
    adaptiveThinking: false,
    thinkingCanBeDisabled: true,
    effortLevels: [],
  };
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

export function listOpenRouterStaticCatalog(): readonly ModelCatalogEntry[] {
  return openrouterProvider()
    .getModels()
    .map((model) =>
      staticCatalogEntry({
        providerType: "openrouter",
        prefix: OPENROUTER_PREFIX,
        model,
      }),
    );
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

export function isPinnedOpenRouterModel(model: string): boolean {
  const catalogId = openRouterCatalogId(model);
  return catalogId !== undefined && OPENROUTER_MODEL_IDS.has(catalogId);
}

export function isApprovedOpenRouterModel(model: string): boolean {
  const catalogId = openRouterCatalogId(model);
  return (
    catalogId !== undefined &&
    (OPENROUTER_MODEL_IDS.has(catalogId) ||
      isValidOpenRouterCatalogId(catalogId))
  );
}

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

export function createOpenRouterProjectProvider(
  input: CreateProjectProviderInput & {
    readonly routing: OpenRouterRouting | undefined;
  },
): Provider<"openai-completions"> {
  const native = openrouterProvider();
  const model = dynamicOpenRouterModel(input);
  return createProvider({
    id: input.providerId,
    name: `${native.name} (${input.label})`,
    ...(native.baseUrl ? { baseUrl: native.baseUrl } : {}),
    ...(native.headers ? { headers: native.headers } : {}),
    auth: credentialAuth("openrouter", input.apiKey),
    models: [model],
    api: openAICompletionsApi(),
  });
}
