/** What a model preset charges, per one million tokens in USD. */
export interface ModelPriceTier {
  readonly inputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number;
  readonly cacheWriteUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export interface ModelPriceRates extends ModelPriceTier {
  /** Applies to a whole model call once its input is above `aboveInputTokens`. */
  readonly longContext?:
    (ModelPriceTier & { readonly aboveInputTokens: number }) | null;
}

/** A model call's tokens. `input` excludes the tokens read from or written to the cache. */
export interface ModelUsageCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** The part of `cacheWrite` with one-hour retention, which providers bill at twice the input rate. */
  readonly cacheWrite1h?: number | undefined;
}

/** A cost split by the kind of token, in millionths of a USD. */
export interface ModelCostByKind {
  readonly inputMicrounits: number;
  readonly cacheReadMicrounits: number;
  readonly cacheWriteMicrounits: number;
  readonly outputMicrounits: number;
}

export interface ModelCallCost {
  /** Millionths of a USD. */
  readonly costMicrounits: number;
  readonly costByKind: ModelCostByKind;
  readonly tier: ModelPriceTier;
  readonly longContext: boolean;
}

/**
 * Prices one model call. A rate per million tokens is also the cost in
 * microunits per token, so no conversion is involved.
 */
export function priceModelCall(
  rates: ModelPriceRates,
  usage: ModelUsageCounts,
): ModelCallCost {
  const inputSize = usage.input + usage.cacheRead + usage.cacheWrite;
  const longContext =
    rates.longContext != null && inputSize > rates.longContext.aboveInputTokens;
  const tier: ModelPriceTier = longContext ? rates.longContext! : rates;
  const longWrite = usage.cacheWrite1h ?? 0;
  const shortWrite = usage.cacheWrite - longWrite;
  const input = usage.input * tier.inputUsdPerMillion;
  const output = usage.output * tier.outputUsdPerMillion;
  const cacheRead = usage.cacheRead * tier.cachedInputUsdPerMillion;
  const cacheWrite =
    shortWrite * tier.cacheWriteUsdPerMillion +
    longWrite * tier.inputUsdPerMillion * 2;
  return {
    costMicrounits: Math.round(input + output + cacheRead + cacheWrite),
    costByKind: {
      inputMicrounits: Math.round(input),
      cacheReadMicrounits: Math.round(cacheRead),
      cacheWriteMicrounits: Math.round(cacheWrite),
      outputMicrounits: Math.round(output),
    },
    tier,
    longContext,
  };
}
