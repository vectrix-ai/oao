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
  requireModel,
  staticCatalogEntry,
  stringValue,
  type CreateProjectProviderInput,
  type Fetcher,
} from "./shared.js";

export const OPENAI_PREFIX = "openai/";
const OPENAI_CATALOG_URL = "https://api.openai.com/v1";

type OpenAIModelSettings = Extract<
  ModelGenerationSettings,
  { readonly textFormat: "text" }
>;

const OPENAI_MODEL_IDS = new Set(
  openaiProvider()
    .getModels()
    .map((model) => model.id),
);

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

  const supported = new Map(
    openaiProvider()
      .getModels()
      .map((model) => [model.id, model] as const),
  );
  const entries = ((json as OpenAIModelResponse).data ?? [])
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
          adaptiveThinking: false,
          thinkingCanBeDisabled: true,
          effortLevels: [],
        },
      ];
    })
    .filter((entry) => catalogMatches(entry, input.search))
    .sort((left, right) => left.catalogId.localeCompare(right.catalogId));
  return [
    ...new Map(entries.map((entry) => [entry.model, entry])).values(),
  ].slice(0, input.limit ?? entries.length);
}

export function listOpenAIStaticCatalog(): readonly ModelCatalogEntry[] {
  return openaiProvider()
    .getModels()
    .map((model) =>
      staticCatalogEntry({
        providerType: "openai",
        prefix: OPENAI_PREFIX,
        model,
      }),
    );
}

export function isApprovedOpenAIModel(model: string): boolean {
  const catalogId = model.startsWith(OPENAI_PREFIX)
    ? model.slice(OPENAI_PREFIX.length)
    : undefined;
  return catalogId !== undefined && OPENAI_MODEL_IDS.has(catalogId);
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
  const nativeModel = requireModel(native, input.catalogId, "openai");
  if (nativeModel.api !== "openai-responses")
    throw new TypeError(
      `Model is not a Responses model in the pinned OpenAI catalog: ${input.catalogId}`,
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
  if (!input.settings || "thinking" in input.settings)
    throw new TypeError("OpenAI model presets require OpenAI settings");
  return withOpenAIModelGenerationSettings(provider, input.settings);
}
