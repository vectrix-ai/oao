import type { DeliveryOutcome, WebhookResponse } from "./types.js";

export interface RetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Returns a value in [0, 1). */
  readonly random: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  baseDelayMs: 2_000,
  maxDelayMs: 5 * 60_000,
  random: Math.random,
});

/** Exponential backoff with ±20% jitter, capped so an outage never stalls delivery for long. */
export function retryDelayMs(
  consecutiveFailures: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  const exponent = Math.min(Math.max(consecutiveFailures, 0), 20);
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const jitter = 0.8 + policy.random() * 0.4;
  return Math.round(Math.min(policy.maxDelayMs, base * jitter));
}

export function classifyResponse(
  response: WebhookResponse,
  batchId: string,
  consecutiveFailures: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): DeliveryOutcome {
  if (response.status >= 200 && response.status <= 299)
    return { kind: "delivered", batchId, responseStatus: response.status };
  if (response.status === 410)
    return {
      kind: "failed",
      errorCode: "endpoint_gone",
      responseStatus: 410,
      retryAfterMs: 0,
      disable: true,
    };
  const backoff = retryDelayMs(consecutiveFailures, policy);
  const retryAfterMs =
    response.retryAfterMs === undefined
      ? backoff
      : Math.min(policy.maxDelayMs, Math.max(1_000, response.retryAfterMs));
  return {
    kind: "failed",
    errorCode: "http_status",
    responseStatus: response.status,
    retryAfterMs,
    disable: false,
  };
}

/** Parses a Retry-After header given in seconds or as an HTTP date. */
export function parseRetryAfter(
  value: string | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d{1,9}$/u.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
