// A symbol key travels with the request options through every provider
// wrapper without becoming a field a provider could send upstream.
const OUTPUT_TOKEN_LIMIT = Symbol("oao.outputTokenLimit");

/**
 * Request options that cap the output of one model call at `limit` tokens,
 * also for a provider whose preset sets its own output limit.
 */
export function withOutputTokenLimit<T extends object>(
  options: T | undefined,
  limit: number,
): T & { readonly maxTokens: number } {
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new RangeError("Output token limit must be a positive integer");
  return {
    ...(options as T),
    maxTokens: limit,
    [OUTPUT_TOKEN_LIMIT]: limit,
  };
}

/**
 * The output limit a provider with a preset limit sends: the preset's, or the
 * lower cap the caller set with `withOutputTokenLimit`. A plain `maxTokens`
 * option does not lower a preset limit.
 */
export function boundedOutputTokens(
  options: object | undefined,
  presetLimit: number,
): number {
  const limit = (options as { [OUTPUT_TOKEN_LIMIT]?: unknown } | undefined)?.[
    OUTPUT_TOKEN_LIMIT
  ];
  return typeof limit === "number" ? Math.min(limit, presetLimit) : presetLimit;
}
