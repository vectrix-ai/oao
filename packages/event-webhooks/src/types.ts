import type { OrganizationId, ProjectId } from "@oao/domain";

/** A product event as delivered to webhooks; identical to the SSE event body. */
export interface WebhookProductEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly projectPosition: string;
  readonly kind: string;
  readonly publicPayload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  /** Present only on `message.created` when the webhook opted into message content. */
  readonly message?: WebhookMessage;
}

export interface WebhookMessage {
  readonly id: string;
  readonly runId: string;
  readonly role: string;
  readonly content: string;
}

export interface ClaimedEventWebhook {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly webhookId: string;
  readonly leaseFence: bigint;
}

export interface EncryptedSigningKey {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly keyVersion: number;
}

export interface PendingBatch {
  readonly id: string;
  readonly throughPosition: bigint;
}

/** Everything the dispatcher needs for one delivery attempt, read in one tenant transaction. */
export interface EventWebhookWork {
  readonly endpointUrl: string;
  readonly eventKinds: readonly string[] | null;
  readonly includeMessageContent: boolean;
  /** Current key first, then the previous key while its rotation window is open. */
  readonly signingKeys: readonly EncryptedSigningKey[];
  readonly deliveredPosition: bigint;
  readonly consecutiveFailures: number;
  readonly batch: PendingBatch | null;
  /** Events after the cursor: exactly the pending batch, or the next page. */
  readonly events: readonly WebhookProductEvent[];
}

export type DeliveryOutcome =
  | {
      readonly kind: "delivered";
      readonly batchId: string;
      readonly responseStatus: number;
    }
  | {
      readonly kind: "failed";
      readonly errorCode: DeliveryErrorCode;
      readonly responseStatus?: number;
      readonly retryAfterMs: number;
      /** The receiver answered 410 Gone: stop delivering until re-enabled. */
      readonly disable: boolean;
    };

export type DeliveryErrorCode =
  | "http_status"
  | "timeout"
  | "connection_failed"
  | "destination_blocked"
  | "endpoint_gone"
  | "signing_key_unavailable";

export interface EventWebhookStore {
  claim(input: {
    readonly workerId: string;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly ClaimedEventWebhook[]>;
  /** Returns undefined when the lease was lost or the webhook was disabled or deleted. */
  load(
    claim: ClaimedEventWebhook,
    workerId: string,
    maxEvents: number,
  ): Promise<EventWebhookWork | undefined>;
  /** Records a new batch so retries resend the same range under the same id. */
  startBatch(
    claim: ClaimedEventWebhook,
    workerId: string,
    batch: PendingBatch,
    expectedDeliveredPosition: bigint,
  ): Promise<boolean>;
  /** Advances past events that the webhook filters out and releases the lease. */
  skip(
    claim: ClaimedEventWebhook,
    workerId: string,
    throughPosition: bigint,
    expectedDeliveredPosition: bigint,
  ): Promise<boolean>;
  finish(
    claim: ClaimedEventWebhook,
    workerId: string,
    outcome: DeliveryOutcome,
  ): Promise<boolean>;
}

export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface WebhookResponse {
  readonly status: number;
  /** Parsed Retry-After in milliseconds, when the receiver sent one. */
  readonly retryAfterMs?: number;
}

export type WebhookTransport = (
  request: WebhookRequest,
) => Promise<WebhookResponse>;

/** Thrown by transports so the dispatcher can record a precise, secret-free error code. */
export class WebhookTransportError extends Error {
  constructor(
    readonly code: Extract<
      DeliveryErrorCode,
      "timeout" | "connection_failed" | "destination_blocked"
    >,
    message: string,
  ) {
    super(message);
    this.name = "WebhookTransportError";
  }
}
