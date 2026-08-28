import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createProvider } from "@earendil-works/pi-ai";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type {
  ModelCatalogEntry,
  ModelGenerationSettings,
} from "@oao/contracts";
import {
  booleanValue,
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

export const ANTHROPIC_PREFIX = "anthropic/";
const ANTHROPIC_CATALOG_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_API_VERSION = "2023-06-01";

type AnthropicModelSettings = Extract<
  ModelGenerationSettings,
  { readonly thinking: "disabled" | "adaptive" }
>;

const ANTHROPIC_MODEL_IDS = new Set(
  anthropicProvider()
    .getModels()
    .map((model) => model.id),
);

interface AnthropicModelResponse {
  readonly data?: readonly unknown[];
  readonly has_more?: unknown;
  readonly last_id?: unknown;
}

/** Account-aware projection of Anthropic's paginated live Models API. */
export async function listAnthropicModelCatalog(input: {
  readonly apiKey: string;
  readonly search?: string;
  readonly limit?: number;
  readonly fetcher?: Fetcher;
}): Promise<readonly ModelCatalogEntry[]> {
  const fetcher = input.fetcher ?? fetch;
  const data: unknown[] = [];
  let afterId: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ limit: "1000" });
    if (afterId) query.set("after_id", afterId);
    const response = await fetcher(
      `${ANTHROPIC_CATALOG_URL}/models?${query.toString()}`,
      {
        headers: {
          accept: "application/json",
          "anthropic-version": ANTHROPIC_API_VERSION,
          "x-api-key": input.apiKey,
        },
      },
    );
    if (!response.ok)
      throw new Error(
        `Anthropic catalog request failed with ${response.status}`,
      );
    const json = record(await response.json());
    if (!json || !Array.isArray(json.data))
      throw new Error("Anthropic catalog response was not a list");
    const page = json as AnthropicModelResponse;
    data.push(...(page.data ?? []));
    const lastId = stringValue(page.last_id);
    if (
      booleanValue(page.has_more) !== true ||
      !lastId ||
      lastId === afterId ||
      data.length >= 10_000
    )
      break;
    afterId = lastId;
  }

  const supported = new Map(
    anthropicProvider()
      .getModels()
      .map((model) => [model.id, model] as const),
  );
  const effortOrder = ["low", "medium", "high", "xhigh", "max"] as const;
  const entries = data
    .flatMap((item) => {
      const live = record(item);
      const catalogId = stringValue(live?.id);
      const model = catalogId ? supported.get(catalogId) : undefined;
      if (!catalogId || !model) return [];
      const capabilities = record(live?.capabilities);
      const thinking = record(capabilities?.thinking);
      const thinkingTypes = record(thinking?.types);
      const effort = record(capabilities?.effort);
      const adaptiveThinking =
        booleanValue(record(thinkingTypes?.adaptive)?.supported) ??
        model.compat?.forceAdaptiveThinking === true;
      const effortLevels = effortOrder.filter(
        (level) =>
          booleanValue(record(effort?.[level])?.supported) === true ||
          (effort === undefined &&
            adaptiveThinking &&
            (["low", "medium", "high"].includes(level) ||
              model.thinkingLevelMap?.[level] === level)),
      );
      if (effortLevels.length === 0) return [];
      return [
        {
          providerType: "anthropic" as const,
          model: `${ANTHROPIC_PREFIX}${catalogId}`,
          catalogId,
          name: stringValue(live?.display_name) ?? model.name,
          contextWindow:
            positiveInteger(live?.max_input_tokens) ??
            positiveInteger(model.contextWindow),
          maxOutputTokens:
            positiveInteger(live?.max_tokens) ??
            positiveInteger(model.maxTokens),
          reasoning: model.reasoning === true,
          adaptiveThinking,
          thinkingCanBeDisabled: model.thinkingLevelMap?.off !== null,
          effortLevels,
        },
      ];
    })
    .filter((entry) => catalogMatches(entry, input.search))
    .sort((left, right) => left.catalogId.localeCompare(right.catalogId));
  return [
    ...new Map(entries.map((entry) => [entry.model, entry])).values(),
  ].slice(0, input.limit ?? entries.length);
}

export function listAnthropicStaticCatalog(): readonly ModelCatalogEntry[] {
  return anthropicProvider()
    .getModels()
    .map((model) => {
      const adaptiveThinking =
        model.api === "anthropic-messages" &&
        model.compat?.forceAdaptiveThinking === true;
      const effortLevels = adaptiveThinking
        ? (["low", "medium", "high", "xhigh", "max"] as const).filter(
            (level) =>
              ["low", "medium", "high"].includes(level) ||
              model.thinkingLevelMap?.[level] === level,
          )
        : [];
      return staticCatalogEntry({
        providerType: "anthropic",
        prefix: ANTHROPIC_PREFIX,
        model,
        adaptiveThinking,
        thinkingCanBeDisabled: model.thinkingLevelMap?.off !== null,
        effortLevels,
      });
    });
}

export function isApprovedAnthropicModel(model: string): boolean {
  const catalogId = model.startsWith(ANTHROPIC_PREFIX)
    ? model.slice(ANTHROPIC_PREFIX.length)
    : undefined;
  return catalogId !== undefined && ANTHROPIC_MODEL_IDS.has(catalogId);
}

function withAnthropicModelGenerationSettings<T extends Provider>(
  provider: T,
  settings: AnthropicModelSettings,
): T {
  const withSettings = (options: Record<string, unknown> | undefined) => {
    const existing = options?.onPayload as
      | ((payload: unknown, model: Model<Api>) => unknown | Promise<unknown>)
      | undefined;
    return {
      ...options,
      maxTokens: settings.maxTokens,
      onPayload: async (payload: unknown, model: Model<Api>) => {
        const transformed = (await existing?.(payload, model)) ?? payload;
        if (
          !transformed ||
          typeof transformed !== "object" ||
          Array.isArray(transformed)
        )
          return transformed;
        const payloadRecord = transformed as Record<string, unknown>;
        return {
          ...payloadRecord,
          max_tokens: settings.maxTokens,
          thinking: { type: settings.thinking },
          output_config: {
            ...(record(payloadRecord.output_config) ?? {}),
            effort: settings.effort,
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
        withSettings(options as Record<string, unknown>) as never,
      );
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(
        model,
        context,
        withSettings(options as Record<string, unknown>) as never,
      );
    },
  } as T;
}

export function createAnthropicProjectProvider(
  input: CreateProjectProviderInput,
): Provider {
  const native = anthropicProvider();
  const nativeModel = requireModel(native, input.catalogId, "anthropic");
  if (nativeModel.api !== "anthropic-messages")
    throw new TypeError(
      `Model is not a Messages model in the pinned Anthropic catalog: ${input.catalogId}`,
    );
  const model = deepFreeze({ ...nativeModel, provider: input.providerId });
  const provider = createProvider({
    id: input.providerId,
    name: `${native.name} (${input.label})`,
    ...(native.baseUrl ? { baseUrl: native.baseUrl } : {}),
    ...(native.headers ? { headers: native.headers } : {}),
    auth: credentialAuth("anthropic", input.apiKey),
    models: [model],
    api: anthropicMessagesApi(),
  });
  if (!input.settings || !("thinking" in input.settings))
    throw new TypeError("Anthropic model presets require Anthropic settings");
  return withAnthropicModelGenerationSettings(provider, input.settings);
}
