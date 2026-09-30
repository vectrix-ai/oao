import { encodeEventCursor } from "@oao/events";
import { signWebhook } from "./signing.js";
import type {
  PendingBatch,
  WebhookProductEvent,
  WebhookRequest,
} from "./types.js";

export const WEBHOOK_PAYLOAD_TYPE = "oao.events";
const USER_AGENT = "OAO-Webhooks/1";

export interface WebhookBatchInput {
  readonly endpointUrl: string;
  readonly webhookId: string;
  readonly organizationId: string;
  readonly projectId: string;
  /** Cursor before this batch (exclusive). */
  readonly fromPosition: bigint;
  readonly batch: PendingBatch;
  readonly events: readonly WebhookProductEvent[];
  readonly signingSecrets: readonly string[];
  readonly now: Date;
}

/**
 * Builds one signed Standard Webhooks request. `webhook-id` is the batch id,
 * which stays the same when a failed batch is retried.
 */
export function buildWebhookRequest(input: WebhookBatchInput): WebhookRequest {
  const body = JSON.stringify({
    type: WEBHOOK_PAYLOAD_TYPE,
    timestamp: input.now.toISOString(),
    data: {
      webhookId: input.webhookId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      batchId: input.batch.id,
      fromPosition: input.fromPosition.toString(),
      throughPosition: input.batch.throughPosition.toString(),
      cursor: encodeEventCursor(input.batch.throughPosition),
      events: input.events,
    },
  });
  const timestamp = Math.floor(input.now.getTime() / 1000);
  return {
    url: input.endpointUrl,
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "webhook-id": input.batch.id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signWebhook(
        { webhookId: input.batch.id, timestamp, body },
        input.signingSecrets,
      ),
    },
  };
}
