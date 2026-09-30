/**
 * Verifies an OAO event webhook delivery with the Web Crypto API, so it runs in
 * Node.js 20+, browsers, edge runtimes, and Convex HTTP actions.
 *
 * Deliveries follow Standard Webhooks: the signed content is
 * `${webhook-id}.${webhook-timestamp}.${body}` and `webhook-signature` holds one
 * or more space-separated `v1,<base64 HMAC-SHA256>` values.
 */
export interface VerifyEventWebhookInput {
  /** The exact raw request body. Verify before parsing it as JSON. */
  readonly body: string;
  readonly webhookId: string | null;
  readonly webhookTimestamp: string | null;
  readonly webhookSignature: string | null;
  /** The `whsec_` secret configured on the webhook. */
  readonly secret: string;
  readonly toleranceSeconds?: number;
  /** Unix time in seconds; defaults to now. */
  readonly now?: number;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export async function verifyEventWebhookSignature(
  input: VerifyEventWebhookInput,
): Promise<boolean> {
  const { webhookId, webhookTimestamp, webhookSignature } = input;
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;
  if (!/^\d{1,12}$/u.test(webhookTimestamp)) return false;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (
    Math.abs(now - Number(webhookTimestamp)) > (input.toleranceSeconds ?? 300)
  )
    return false;
  if (!input.secret.startsWith("whsec_")) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      decodeBase64(input.secret.slice("whsec_".length)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return false;
  }
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        `${webhookId}.${webhookTimestamp}.${input.body}`,
      ),
    ),
  );
  return webhookSignature.split(" ").some((candidate) => {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) return false;
    try {
      return constantTimeEqual(decodeBase64(value), expected);
    } catch {
      return false;
    }
  });
}
