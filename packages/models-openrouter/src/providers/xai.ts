import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { ModelCatalogEntry } from "@oao/contracts";
import {
  catalogMatches,
  credentialAuth,
  deepFreeze,
  positiveInteger,
  record,
  staticCatalogEntry,
  stringArray,
  stringValue,
  type CreateProjectProviderInput,
  type Fetcher,
} from "./shared.js";

export const XAI_PREFIX = "xai/";
const XAI_CATALOG_URL = "https://api.x.ai/v1";

interface XAIModelResponse {
  readonly models?: readonly unknown[];
}

type XAIModelSettings = {
  readonly textFormat: "text";
  readonly effort: "low" | "medium" | "high" | "xhigh";
};

const XAI_STANDARD_EFFORTS = ["low", "medium", "high"] as const;
const XAI_EXTENDED_EFFORTS = [...XAI_STANDARD_EFFORTS, "xhigh"] as const;

/** Effort levels explicitly documented by xAI for current reasoning models. */
function xaiReasoningEffortLevels(
  catalogId: string,
  model?: Model<"openai-completions" | "openai-responses">,
): readonly ("low" | "medium" | "high" | "xhigh")[] {
  if (
    /^grok-4\.6(?:-|$)/u.test(catalogId) ||
    /^grok-4\.20-multi-agent(?:-|$)/u.test(catalogId)
  )
    return XAI_EXTENDED_EFFORTS;
  if (/^grok-4\.5(?:-|$)/u.test(catalogId)) return XAI_STANDARD_EFFORTS;
  if (!model?.reasoning) return [];
  return XAI_EXTENDED_EFFORTS.filter(
    (effort) => model.thinkingLevelMap?.[effort] != null,
  );
}

/** Account-aware projection of xAI's live Grok language-model catalog. */
export async function listXAIModelCatalog(input: {
  readonly apiKey: string;
  readonly search?: string;
  readonly limit?: number;
  readonly fetcher?: Fetcher;
}): Promise<readonly ModelCatalogEntry[]> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(`${XAI_CATALOG_URL}/language-models`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
  });
  if (!response.ok)
    throw new Error(`xAI catalog request failed with ${response.status}`);
  const json = record(await response.json());
  if (!json || !Array.isArray(json.models))
    throw new Error("xAI catalog response was not a language-model list");

  const supported = new Map(
    xaiProvider()
      .getModels()
      .map((model) => [model.id, model] as const),
  );
  const entries = ((json as XAIModelResponse).models ?? [])
    .flatMap((item) => {
      const live = record(item);
      const catalogId = stringValue(live?.id);
      const outputModalities = stringArray(live?.output_modalities);
      if (
        !catalogId ||
        (outputModalities.length > 0 && !outputModalities.includes("text"))
      )
        return [];
      const model = supported.get(catalogId);
      const effortLevels = xaiReasoningEffortLevels(catalogId, model);
      return [
        {
          providerType: "xai" as const,
          model: `${XAI_PREFIX}${catalogId}`,
          catalogId,
          name: model?.name ?? catalogId,
          contextWindow:
            positiveInteger(live?.context_length) ??
            positiveInteger(model?.contextWindow),
          maxOutputTokens: positiveInteger(model?.maxTokens),
          reasoning: effortLevels.length > 0,
          adaptiveThinking: false,
          thinkingCanBeDisabled: false,
          effortLevels: [...effortLevels],
        },
      ];
    })
    .filter((entry) => catalogMatches(entry, input.search))
    .sort((left, right) => left.catalogId.localeCompare(right.catalogId));
  return [
    ...new Map(entries.map((entry) => [entry.model, entry])).values(),
  ].slice(0, input.limit ?? entries.length);
}

export function listXAIStaticCatalog(): readonly ModelCatalogEntry[] {
  return xaiProvider()
    .getModels()
    .map((model) =>
      staticCatalogEntry({
        providerType: "xai",
        prefix: XAI_PREFIX,
        model,
        thinkingCanBeDisabled: false,
        effortLevels: xaiReasoningEffortLevels(model.id, model),
      }),
    );
}

export function isApprovedXAIModel(model: string): boolean {
  const catalogId = model.startsWith(XAI_PREFIX)
    ? model.slice(XAI_PREFIX.length)
    : undefined;
  return (
    catalogId !== undefined && /^(?:[a-z0-9~][a-z0-9._:~-]*)$/u.test(catalogId)
  );
}

function dynamicXAIModel(input: {
  readonly providerId: string;
  readonly catalogId: string;
}): Model<"openai-completions" | "openai-responses"> {
  const native = xaiProvider();
  const staticModel = native
    .getModels()
    .find((model) => model.id === input.catalogId);
  if (staticModel) {
    const effortLevels = xaiReasoningEffortLevels(input.catalogId, staticModel);
    return deepFreeze({
      ...staticModel,
      provider: input.providerId,
      compat: {
        ...staticModel.compat,
        ...(effortLevels.length > 0 ? { supportsReasoningEffort: true } : {}),
      },
    });
  }
  const effortLevels = xaiReasoningEffortLevels(input.catalogId);
  const reasoning = effortLevels.length > 0;
  return deepFreeze({
    id: input.catalogId,
    name: input.catalogId,
    api: reasoning
      ? ("openai-responses" as const)
      : ("openai-completions" as const),
    provider: input.providerId,
    baseUrl: native.baseUrl ?? XAI_CATALOG_URL,
    reasoning,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
    },
    ...(reasoning
      ? {
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: effortLevels.includes("xhigh") ? "xhigh" : null,
            max: null,
          },
        }
      : {}),
  });
}

function withXAIModelGenerationSettings<T extends Provider>(
  provider: T,
  settings: XAIModelSettings,
): T {
  const withSettings = (options: Record<string, unknown> | undefined) => {
    const existing = options?.onPayload as
      | ((payload: unknown, model: Model<Api>) => unknown | Promise<unknown>)
      | undefined;
    return {
      ...options,
      onPayload: async (payload: unknown, model: Model<Api>) => {
        const transformed = (await existing?.(payload, model)) ?? payload;
        const payloadRecord = record(transformed);
        if (!payloadRecord) return transformed;
        return {
          ...payloadRecord,
          reasoning: {
            ...(record(payloadRecord.reasoning) ?? {}),
            effort: settings.effort,
          },
          text: {
            ...(record(payloadRecord.text) ?? {}),
            format: { type: settings.textFormat },
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

export function createXAIProjectProvider(
  input: CreateProjectProviderInput,
): Provider<"openai-completions" | "openai-responses"> {
  const native = xaiProvider();
  const model = dynamicXAIModel(input);
  const provider = createProvider({
    id: input.providerId,
    name: `${native.name} (${input.label})`,
    ...(native.baseUrl ? { baseUrl: native.baseUrl } : {}),
    ...(native.headers ? { headers: native.headers } : {}),
    auth: credentialAuth("xai", input.apiKey),
    models: [model],
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  });
  if (!input.settings) return provider;
  if ("thinking" in input.settings || "mode" in input.settings)
    throw new TypeError("xAI model presets require xAI settings");
  if (!model.reasoning)
    throw new TypeError(
      "Selected xAI model does not support reasoning settings",
    );
  return withXAIModelGenerationSettings(provider, input.settings);
}
