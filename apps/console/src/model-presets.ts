import type {
  ModelPreset,
  ModelPresetPrice,
  ModelPriceRates,
  ModelRoutingPolicy,
} from "./api/types";

/** Mirrors the server contract for stable, versioned model preset keys. */
export const MODEL_PRESET_KEY_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]{0,4}$/u;

/** Renders the provider-neutral routing policy as one readable sentence. */
export function describeRouting(routing: ModelRoutingPolicy): string {
  const parts: string[] = [];
  if (routing.dataCollection)
    parts.push(`data collection ${routing.dataCollection}`);
  if (routing.zeroDataRetention) parts.push("zero data retention");
  if (routing.allowFallbacks === false) parts.push("no fallbacks");
  if (routing.requireParameters) parts.push("require parameters");
  if (routing.providerAllowlist)
    parts.push(`only ${routing.providerAllowlist.join(", ")}`);
  if (routing.providerDenylist)
    parts.push(`never ${routing.providerDenylist.join(", ")}`);
  if (routing.providerOrder)
    parts.push(`order ${routing.providerOrder.join(" › ")}`);
  if (routing.sort) parts.push(`prefer ${routing.sort}`);
  if (routing.maxPromptPriceUsdPerMillion !== undefined)
    parts.push(`prompt ≤ $${routing.maxPromptPriceUsdPerMillion}/M`);
  if (routing.maxCompletionPriceUsdPerMillion !== undefined)
    parts.push(`completion ≤ $${routing.maxCompletionPriceUsdPerMillion}/M`);
  return parts.length === 0 ? "Provider defaults" : parts.join(" · ");
}

/** Deployment routing remains operator-managed and is not fully public. */
export function describePresetRouting(preset: ModelPreset): string {
  if (preset.origin === "deployment" && preset.hosted)
    return "Deployment-managed routing";
  if (preset.settings && "thinking" in preset.settings)
    return `${preset.settings.thinking} thinking · ${preset.settings.effort} effort · ${preset.settings.maxTokens.toLocaleString()} max tokens`;
  if (preset.settings && "mode" in preset.settings)
    return `${preset.settings.mode} · ${preset.settings.effort} reasoning · ${preset.settings.verbosity} verbosity · ${preset.settings.summary} summary · ${preset.settings.textFormat}`;
  if (preset.settings)
    return `${preset.settings.effort} reasoning · ${preset.settings.textFormat} response`;
  return describeRouting(preset.routing);
}

/**
 * Suggests a preset key from a catalog model name.
 *
 * Preset rows are append-only, so the suffix walks forward to the first
 * version that is still free instead of proposing a key that already exists.
 */
export function suggestPresetKey(
  modelName: string,
  existingKeys: readonly string[],
): string {
  const slug = modelName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100)
    .replace(/-+$/gu, "");
  const base = /^[a-z]/u.test(slug) ? slug : `model${slug ? `-${slug}` : ""}`;
  for (let version = 1; version <= 99; version += 1) {
    const candidate = `${base}-v${version}`;
    if (!existingKeys.includes(candidate)) return candidate;
  }
  return "";
}

/** The price section of a preset form: text as typed, parsed when it is sent. */
export interface PriceForm {
  readonly input: string;
  readonly cachedInput: string;
  readonly cacheWrite: string;
  readonly output: string;
  readonly longContext: boolean;
  readonly longAbove: string;
  readonly longInput: string;
  readonly longCachedInput: string;
  readonly longCacheWrite: string;
  readonly longOutput: string;
}

const rateText = (value: number | undefined): string =>
  value === undefined ? "" : String(value);

export function priceFormFromRates(
  rates?: Omit<ModelPriceRates, "longContext"> & {
    readonly longContext?: ModelPriceRates["longContext"];
  },
): PriceForm {
  const long = rates?.longContext ?? undefined;
  return {
    input: rateText(rates?.inputUsdPerMillion),
    cachedInput: rateText(rates?.cachedInputUsdPerMillion),
    cacheWrite: rateText(rates?.cacheWriteUsdPerMillion),
    output: rateText(rates?.outputUsdPerMillion),
    longContext: long !== undefined,
    longAbove: rateText(long?.aboveInputTokens),
    longInput: rateText(long?.inputUsdPerMillion),
    longCachedInput: rateText(long?.cachedInputUsdPerMillion),
    longCacheWrite: rateText(long?.cacheWriteUsdPerMillion),
    longOutput: rateText(long?.outputUsdPerMillion),
  };
}

function parseRate(value: string): number | null {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : null;
}

/** Null rates mean "no price"; a partly filled form is an error, not a guess. */
export function ratesFromPriceForm(form: PriceForm): {
  readonly rates: ModelPriceRates | null;
  readonly errors: readonly string[];
} {
  const texts = [form.input, form.cachedInput, form.cacheWrite, form.output];
  if (texts.every((text) => text.trim() === "") && !form.longContext)
    return { rates: null, errors: [] };
  const [input, cachedInput, cacheWrite, output] = texts.map(parseRate);
  if (
    input == null ||
    cachedInput == null ||
    cacheWrite == null ||
    output == null
  )
    return {
      rates: null,
      errors: [
        "Enter all four prices as numbers of 0 or more, or leave them all empty.",
      ],
    };
  const standard = {
    inputUsdPerMillion: input,
    cachedInputUsdPerMillion: cachedInput,
    cacheWriteUsdPerMillion: cacheWrite,
    outputUsdPerMillion: output,
  };
  if (!form.longContext)
    return { rates: { ...standard, longContext: null }, errors: [] };
  const above = Number(form.longAbove);
  const [longInput, longCached, longWrite, longOutput] = [
    form.longInput,
    form.longCachedInput,
    form.longCacheWrite,
    form.longOutput,
  ].map(parseRate);
  if (
    !Number.isInteger(above) ||
    above < 1 ||
    longInput == null ||
    longCached == null ||
    longWrite == null ||
    longOutput == null
  )
    return {
      rates: null,
      errors: [
        "Enter the long-input threshold and all four long-input prices, or switch them off.",
      ],
    };
  return {
    rates: {
      ...standard,
      longContext: {
        aboveInputTokens: above,
        inputUsdPerMillion: longInput,
        cachedInputUsdPerMillion: longCached,
        cacheWriteUsdPerMillion: longWrite,
        outputUsdPerMillion: longOutput,
      },
    },
    errors: [],
  };
}

/** "$2.00", and as many decimals as a smaller rate needs: "$0.125". */
export function formatUsdRate(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

export function describePrice(
  price: Pick<
    ModelPresetPrice,
    | "inputUsdPerMillion"
    | "cachedInputUsdPerMillion"
    | "cacheWriteUsdPerMillion"
    | "outputUsdPerMillion"
  >,
): string {
  return [
    `${formatUsdRate(price.inputUsdPerMillion)} input`,
    `${formatUsdRate(price.cachedInputUsdPerMillion)} cached`,
    `${formatUsdRate(price.cacheWriteUsdPerMillion)} cache write`,
    `${formatUsdRate(price.outputUsdPerMillion)} output`,
  ].join(" · ");
}

/** OAO's placeholder limits for a model its catalog does not know. */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 4_096;

/** The context window and output limit as typed, in tokens. Empty means none. */
export interface LimitsForm {
  readonly contextWindow: string;
  readonly maxOutputTokens: string;
}

export function limitsFormFromValues(
  values?: {
    readonly contextWindow: number | null;
    readonly maxOutputTokens: number | null;
  } | null,
): LimitsForm {
  return {
    contextWindow:
      values?.contextWindow == null ? "" : String(values.contextWindow),
    maxOutputTokens:
      values?.maxOutputTokens == null ? "" : String(values.maxOutputTokens),
  };
}

function tokenCount(value: string): number | null {
  const trimmed = value.replace(/[\s,_]/gu, "");
  if (!trimmed) return null;
  return /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * The limits a form holds, or what is wrong with them. Both empty is no
 * limits, so the model's catalog value, or OAO's default, applies.
 */
export function limitsFromForm(form: LimitsForm): {
  readonly limits: {
    readonly contextWindow: number | null;
    readonly maxOutputTokens: number | null;
  } | null;
  readonly errors: readonly string[];
} {
  const contextWindow = tokenCount(form.contextWindow);
  const maxOutputTokens = tokenCount(form.maxOutputTokens);
  const errors: string[] = [];
  if (
    contextWindow !== null &&
    (Number.isNaN(contextWindow) ||
      contextWindow < 1_024 ||
      contextWindow > 10_000_000)
  )
    errors.push(
      "The context window must be a whole number from 1,024 to 10,000,000 tokens.",
    );
  if (
    maxOutputTokens !== null &&
    (Number.isNaN(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 1_000_000)
  )
    errors.push(
      "The output limit must be a whole number from 1 to 1,000,000 tokens.",
    );
  if (
    errors.length === 0 &&
    contextWindow !== null &&
    maxOutputTokens !== null &&
    maxOutputTokens > contextWindow
  )
    errors.push("The output limit cannot be larger than the context window.");
  if (errors.length > 0) return { limits: null, errors };
  return { limits: { contextWindow, maxOutputTokens }, errors };
}

/** One line for a preset's limits, naming what applies when one is not set. */
export function describeLimits(
  limits:
    | {
        readonly contextWindow: number | null;
        readonly maxOutputTokens: number | null;
      }
    | null
    | undefined,
): string {
  const window =
    limits?.contextWindow == null
      ? "model's context window"
      : `${limits.contextWindow.toLocaleString("en-US")} context window`;
  const output =
    limits?.maxOutputTokens == null
      ? "model's output limit"
      : `${limits.maxOutputTokens.toLocaleString("en-US")} output limit`;
  return `${window} · ${output}`;
}
