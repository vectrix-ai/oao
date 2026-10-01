import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks (https://www.standardwebhooks.com) symmetric signing.
 * The signed content is `${webhookId}.${timestamp}.${body}` and each signature
 * is `v1,<base64 HMAC-SHA256>`. Several signatures are space-separated so a
 * receiver keeps verifying during a secret rotation.
 */
export const WEBHOOK_SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 32;
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookSignatureInput {
  readonly webhookId: string;
  /** Unix time in seconds. */
  readonly timestamp: number;
  readonly body: string;
}

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64")}`;
}

export function parseWebhookSecret(secret: string): Buffer {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX))
    throw new TypeError("Webhook secrets must start with whsec_");
  const encoded = secret.slice(WEBHOOK_SECRET_PREFIX.length);
  const key = Buffer.from(encoded, "base64");
  if (
    key.length < MIN_SECRET_BYTES ||
    key.length > MAX_SECRET_BYTES ||
    key.toString("base64") !== encoded
  )
    throw new TypeError(
      "Webhook secrets must be canonical base64 encoding 24 to 64 bytes",
    );
  return key;
}

function signature(secret: string, input: WebhookSignatureInput): string {
  return createHmac("sha256", parseWebhookSecret(secret))
    .update(`${input.webhookId}.${input.timestamp}.${input.body}`)
    .digest("base64");
}

/** Builds the `webhook-signature` header value, one `v1,` entry per secret. */
export function signWebhook(
  input: WebhookSignatureInput,
  secrets: readonly string[],
): string {
  if (secrets.length === 0)
    throw new TypeError("At least one webhook secret is required");
  return secrets.map((secret) => `v1,${signature(secret, input)}`).join(" ");
}

export interface WebhookVerificationInput extends WebhookSignatureInput {
  readonly signatureHeader: string;
  readonly secret: string;
  /** Unix time in seconds; defaults to the current time. */
  readonly now?: number;
  readonly toleranceSeconds?: number;
}

/** Verifies a Standard Webhooks signature header in constant time per candidate. */
export function verifyWebhookSignature(
  input: WebhookVerificationInput,
): boolean {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (
    !Number.isSafeInteger(input.timestamp) ||
    Math.abs(now - input.timestamp) > tolerance
  )
    return false;
  const expected = Buffer.from(signature(input.secret, input), "base64");
  return input.signatureHeader.split(" ").some((candidate) => {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) return false;
    const actual = Buffer.from(value, "base64");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  });
}
