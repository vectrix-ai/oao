import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai";
import type { OpenRouterRouting, Provider } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

const OPENROUTER_MODEL_IDS = new Set(
  openrouterProvider()
    .getModels()
    .map((model) => model.id),
);

export interface ApprovedModelPreset {
  readonly key: string;
  readonly model: string;
  readonly routing?: Readonly<OpenRouterRouting>;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>))
      deepFreeze(nested);
  }
  return value;
}

export class ImmutableModelPresetRegistry {
  readonly #presets: ReadonlyMap<string, Readonly<ApprovedModelPreset>>;

  constructor(
    presets: readonly ApprovedModelPreset[],
    private readonly options: { readonly hostedEnabled: boolean },
  ) {
    const entries = presets.map((preset) => {
      if (!preset.key || !preset.model)
        throw new TypeError("Invalid model preset");
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
      return [preset.key, deepFreeze(structuredClone(preset))] as const;
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      throw new TypeError("Duplicate model preset key");
    this.#presets = new Map(entries);
    Object.freeze(this);
  }

  resolve(key: string): Readonly<ApprovedModelPreset> {
    const preset = this.#presets.get(key);
    if (!preset) throw new Error(`Model preset is not approved: ${key}`);
    if (preset.model.startsWith("openrouter/") && !this.options.hostedEnabled)
      throw new Error("Hosted model calls are disabled");
    return preset;
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
      compat: {
        ...model.compat,
        ...(routing ? { openRouterRouting: structuredClone(routing) } : {}),
      },
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

export function createDeterministicModelProvider(
  responses: readonly FauxResponseStep[] = [
    fauxAssistantMessage("deterministic response", {
      responseId: "oao-fake-response-1",
      timestamp: 1,
    }),
  ],
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
  handle.setResponses([...responses]);
  return handle;
}

export const DEFAULT_LOCAL_PRESETS = deepFreeze([
  { key: "local-default", model: "fake/deterministic" },
]);
