import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai";
import type { Model, Provider } from "@earendil-works/pi-ai";
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
          reasoning: model?.reasoning === true,
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

export function listXAIStaticCatalog(): readonly ModelCatalogEntry[] {
  return xaiProvider()
    .getModels()
    .map((model) =>
      staticCatalogEntry({
        providerType: "xai",
        prefix: XAI_PREFIX,
        model,
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
  if (staticModel)
    return deepFreeze({ ...staticModel, provider: input.providerId });
  return deepFreeze({
    id: input.catalogId,
    name: input.catalogId,
    api: "openai-completions" as const,
    provider: input.providerId,
    baseUrl: native.baseUrl ?? XAI_CATALOG_URL,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  });
}

export function createXAIProjectProvider(
  input: CreateProjectProviderInput,
): Provider<"openai-completions" | "openai-responses"> {
  const native = xaiProvider();
  const model = dynamicXAIModel(input);
  return createProvider({
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
}
