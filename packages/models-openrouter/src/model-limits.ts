import type { Api, Model, Provider } from "@earendil-works/pi-ai";

/**
 * A model preset's own limits, in tokens. A null one leaves the model's value:
 * its catalog's, or OAO's placeholder when the catalog does not know it.
 */
export interface ModelPresetLimitsInput {
  /** The limits row in effect, when the preset has one. */
  readonly id: string | null;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  /**
   * When the row was saved. Rows of a preset get strictly later times, so an
   * activation can tell that it read older limits than another one.
   */
  readonly createdAt?: string | null;
}

/**
 * Where a preset's limits stand in its history: the row's save time, or -1
 * without a row. Rows are only ever added, so a lower number is older.
 */
export function modelLimitsOrder(
  limits: ModelPresetLimitsInput | null | undefined,
): number {
  if (!limits) return -1;
  const savedAt = limits.createdAt ? Date.parse(limits.createdAt) : Number.NaN;
  return Number.isFinite(savedAt) ? savedAt : 0;
}

/** Where a limit in effect on a model call came from. */
export type ModelLimitSource =
  /** The preset's own limit. */
  | "preset"
  /** The model's catalog value, or OAO's placeholder for an unknown model. */
  | "model"
  /** An Anthropic preset's `maxTokens` generation setting. */
  | "settings";

/** The limits a model call runs with, and where each came from. */
export interface EffectiveModelLimits {
  readonly contextWindow: number;
  readonly contextWindowSource: ModelLimitSource;
  /** The most output a call asks for, before pi fits it into the context. */
  readonly maxOutputTokens: number;
  readonly maxOutputTokensSource: ModelLimitSource;
  readonly presetLimitsId: string | null;
}

/** The stable form of a preset's limits, to tell when they changed. */
export function modelLimitsKey(
  limits: ModelPresetLimitsInput | null | undefined,
): string {
  return JSON.stringify([
    limits?.id ?? null,
    limits?.contextWindow ?? null,
    limits?.maxOutputTokens ?? null,
  ]);
}

function limitedModel<M>(
  model: M,
  limits: ModelPresetLimitsInput | null | undefined,
): M {
  const chat = model as Partial<
    Pick<Model<Api>, "contextWindow" | "maxTokens">
  >;
  // Only chat models have a context window and an output limit.
  if (
    typeof chat.contextWindow !== "number" ||
    typeof chat.maxTokens !== "number"
  )
    return model;
  return Object.freeze({
    ...model,
    contextWindow: limits?.contextWindow ?? chat.contextWindow,
    maxTokens: limits?.maxOutputTokens ?? chat.maxTokens,
  });
}

/**
 * The provider with a preset's limits on its models. pi asks a call for the
 * model's `maxTokens` as its output limit, fitted into what the context window
 * leaves, and Flue compacts a conversation once a call passes the context
 * window minus an output reserve of `min(20,000, maxTokens)`. A preset without
 * limits gets the provider back unchanged.
 */
export function withModelLimits<T extends Provider>(
  provider: T,
  limits: ModelPresetLimitsInput | null | undefined,
): T {
  if (
    (limits?.contextWindow ?? null) === null &&
    (limits?.maxOutputTokens ?? null) === null
  )
    return provider;
  const getAllModels = provider.getAllModels?.bind(provider);
  return {
    ...provider,
    getModels: () =>
      provider.getModels().map((model) => limitedModel(model, limits)),
    ...(getAllModels
      ? {
          getAllModels: () =>
            getAllModels().map((model) => limitedModel(model, limits)),
        }
      : {}),
  } as T;
}

/**
 * What a model call of the preset runs with. An Anthropic preset asks each
 * call for its `maxTokens` setting, or for its output limit when that is
 * smaller.
 */
export function effectiveModelLimits(input: {
  readonly model: Pick<Model<Api>, "contextWindow" | "maxTokens">;
  readonly limits: ModelPresetLimitsInput | null | undefined;
  readonly settingsMaxTokens?: number | undefined;
}): EffectiveModelLimits {
  const contextWindow = input.limits?.contextWindow ?? null;
  const maxOutputTokens = input.limits?.maxOutputTokens ?? null;
  const output =
    input.settingsMaxTokens !== undefined
      ? maxOutputTokens !== null && maxOutputTokens < input.settingsMaxTokens
        ? { value: maxOutputTokens, source: "preset" as const }
        : { value: input.settingsMaxTokens, source: "settings" as const }
      : maxOutputTokens !== null
        ? { value: maxOutputTokens, source: "preset" as const }
        : { value: input.model.maxTokens, source: "model" as const };
  return {
    contextWindow: contextWindow ?? input.model.contextWindow,
    contextWindowSource: contextWindow !== null ? "preset" : "model",
    maxOutputTokens: output.value,
    maxOutputTokensSource: output.source,
    presetLimitsId: input.limits?.id ?? null,
  };
}
