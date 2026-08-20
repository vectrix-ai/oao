import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai";
import type { OpenRouterRouting, Provider } from "@earendil-works/pi-ai";
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
import * as v from "valibot";

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
      compat: {
        ...nativeModel.compat,
        ...(routing ? { openRouterRouting: structuredClone(routing) } : {}),
      },
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

export const DEFAULT_LOCAL_PRESETS = deepFreeze([
  { key: "local-default", model: "fake/deterministic" },
]);

export interface ModelPresetConfiguration {
  readonly hostedEnabled: boolean;
  readonly hostedPresets: readonly ApprovedModelPreset[];
  readonly presets: readonly ApprovedModelPreset[];
  readonly registry: ImmutableModelPresetRegistry;
}

/**
 * Loads the one model-preset catalog shared by publication and execution.
 * Hosted presets are deliberately unavailable unless the operator opts in;
 * constructing the registry also verifies every OpenRouter model against the
 * catalog pinned by the runtime's Pi dependency.
 */
export function loadModelPresetConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ModelPresetConfiguration {
  const hostedEnabled = environment.OAO_ENABLE_HOSTED_MODELS === "true";
  if (hostedEnabled && !environment.OAO_OPENROUTER_PRESETS_JSON)
    throw new Error(
      "OAO_OPENROUTER_PRESETS_JSON is required when hosted models are enabled",
    );
  const hostedPresets = hostedEnabled
    ? parseApprovedModelPresets(
        JSON.parse(environment.OAO_OPENROUTER_PRESETS_JSON ?? "[]") as unknown,
      )
    : [];
  const presets = [
    ...(DEFAULT_LOCAL_PRESETS as readonly ApprovedModelPreset[]),
    ...hostedPresets,
  ];
  return {
    hostedEnabled,
    hostedPresets,
    presets,
    registry: new ImmutableModelPresetRegistry(presets, { hostedEnabled }),
  };
}
import { createHash } from "node:crypto";
