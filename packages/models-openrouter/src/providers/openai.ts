import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type {
  ModelCatalogEntry,
  ModelGenerationSettings,
} from "@oao/contracts";
import {
  catalogMatches,
  credentialAuth,
  deepFreeze,
  positiveInteger,
  record,
  staticCatalogEntry,
  stringValue,
  type CreateProjectProviderInput,
  type Fetcher,
} from "./shared.js";

export const OPENAI_PREFIX = "openai/";
const OPENAI_CATALOG_URL = "https://api.openai.com/v1";

type OpenAIModelSettings = Extract<
  ModelGenerationSettings,
  { readonly mode: "standard" | "pro" }
>;

const PINNED_OPENAI_MODELS = new Map(
  openaiProvider()
    .getModels()
    .map((model) => [model.id, model] as const),
);

// /models reports account access, not endpoint or capability metadata. Restrict
// fallbacks to modern text/reasoning families and exclude specialized variants.
function isLiveResponsesModelId(id: string): boolean {
  if (
    !/^(?:gpt-(?:[5-9]|[1-9][0-9]+)(?:\.[0-9]+)?|gpt-4\.1|o(?:[3-9]|[1-9][0-9]+))(?:-[a-z0-9]+)*$/u.test(
      id,
    )
  )
    return false;
  return true;
}

function isSpecializedModel(id: string): boolean {
  return /(?:^|-)(?:audio|realtime|transcribe|tts|search|image|embedding|moderation|diarize)(?:-|$)|-deep-research(?:-|$)/u.test(
    id,
  );
}

function isAstra(id: string): boolean {
  return /^gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/u.test(id);
}

function openAIModel(id: string): Model<"openai-responses"> | undefined {
  if (isSpecializedModel(id)) return undefined;
  const pinned = PINNED_OPENAI_MODELS.get(id);
  if (pinned)
    return pinned.api === "openai-responses"
      ? (pinned as Model<"openai-responses">)
      : undefined;
  if (!isLiveResponsesModelId(id)) return undefined;
  const astra = isAstra(id);
  return {
    id,
    name: astra ? `GPT-6 Astra${id.slice("gpt-6-astra".length)}` : id,
    api: "openai-responses",
    provider: "openai",
    baseUrl: OPENAI_CATALOG_URL,
    reasoning: !id.startsWith("gpt-4.1"),
    input: astra ? ["text", "image"] : ["text"],
    // Astra metadata: https://developers.openai.com/api/docs/models/gpt-6-astra
    // Unknown metadata stays null in the public catalog. These are runtime
    // budgets, not claims about the provider's context limits or free usage.
    contextWindow: astra ? 1_050_000 : 32_768,
    maxTokens: astra ? 128_000 : 4_096,
    cost: astra
      ? {
          input: 10,
          output: 50,
          cacheRead: 1,
          cacheWrite: 12.5,
          tiers: [
            {
              inputTokensAbove: 272_000,
              input: 20,
              output: 75,
              cacheRead: 2,
              cacheWrite: 25,
            },
          ],
        }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(astra
      ? {
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        }
      : {}),
  };
}

function openAICatalogEntry(
  model: Model<"openai-responses">,
): ModelCatalogEntry {
  const hasMetadata = PINNED_OPENAI_MODELS.has(model.id) || isAstra(model.id);
  return {
    ...staticCatalogEntry({
      providerType: "openai",
      prefix: OPENAI_PREFIX,
      model,
    }),
    contextWindow: hasMetadata ? positiveInteger(model.contextWindow) : null,
    maxOutputTokens: hasMetadata ? positiveInteger(model.maxTokens) : null,
    thinkingCanBeDisabled: model.thinkingLevelMap?.off !== null,
    effortLevels: isAstra(model.id)
      ? ["low", "medium", "high", "xhigh", "max"]
      : [],
  };
}

interface OpenAIModelResponse {
  readonly data?: readonly unknown[];
}

/** Account-aware projection of OpenAI's live Responses model catalog. */
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

  const entries = ((json as OpenAIModelResponse).data ?? [])
    .flatMap((item) => {
      const catalogId = stringValue(record(item)?.id);
      const model = catalogId ? openAIModel(catalogId) : undefined;
      return model ? [openAICatalogEntry(model)] : [];
    })
    .filter((entry) => catalogMatches(entry, input.search))
    .sort((left, right) => left.catalogId.localeCompare(right.catalogId));
  return [
    ...new Map(entries.map((entry) => [entry.model, entry])).values(),
  ].slice(0, input.limit ?? entries.length);
}

export function listOpenAIStaticCatalog(): readonly ModelCatalogEntry[] {
  return [...new Set([...PINNED_OPENAI_MODELS.keys(), "gpt-6-astra"])].flatMap(
    (id) => {
      const model = openAIModel(id);
      return model ? [openAICatalogEntry(model)] : [];
    },
  );
}

export function isApprovedOpenAIModel(model: string): boolean {
  const catalogId = model.startsWith(OPENAI_PREFIX)
    ? model.slice(OPENAI_PREFIX.length)
    : undefined;
  return catalogId !== undefined && openAIModel(catalogId) !== undefined;
}

function withOpenAIModelGenerationSettings<T extends Provider>(
  provider: T,
  settings: OpenAIModelSettings,
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
        const payloadRecord = transformed as Record<string, unknown>;
        const text =
          payloadRecord.text &&
          typeof payloadRecord.text === "object" &&
          !Array.isArray(payloadRecord.text)
            ? (payloadRecord.text as Record<string, unknown>)
            : {};
        const reasoning =
          payloadRecord.reasoning &&
          typeof payloadRecord.reasoning === "object" &&
          !Array.isArray(payloadRecord.reasoning)
            ? (payloadRecord.reasoning as Record<string, unknown>)
            : {};
        return {
          ...payloadRecord,
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

export function createOpenAIProjectProvider(
  input: CreateProjectProviderInput,
): Provider {
  const native = openaiProvider();
  const nativeModel = openAIModel(input.catalogId);
  if (!nativeModel)
    throw new TypeError(
      `Model is not supported by the OpenAI Responses runtime: ${input.catalogId}`,
    );
  const model = deepFreeze({ ...nativeModel, provider: input.providerId });
  const provider = createProvider({
    id: input.providerId,
    name: `${native.name} (${input.label})`,
    ...(native.baseUrl ? { baseUrl: native.baseUrl } : {}),
    ...(native.headers ? { headers: native.headers } : {}),
    auth: credentialAuth("openai", input.apiKey),
    models: [model],
    api: openAIResponsesApi(),
  });
  if (!input.settings || !("mode" in input.settings))
    throw new TypeError("OpenAI model presets require OpenAI settings");
  if (isAstra(input.catalogId) && input.settings.effort === "none")
    throw new TypeError("GPT-6 Astra requires reasoning effort low or higher");
  return withOpenAIModelGenerationSettings(provider, input.settings);
}
