import type { OrganizationId, ProjectId } from "@oao/domain";
import {
  withTenantTransaction,
  type PgClient,
  type PgPool,
} from "@oao/db-postgres";
import type {
  ClaimedEventWebhook,
  DeliveryOutcome,
  EncryptedSigningKey,
  EventWebhookStore,
  EventWebhookWork,
  PendingBatch,
  WebhookProductEvent,
} from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const LEASED = `organization_id=$1 AND project_id=$2 AND id=$3
  AND lease_owner=$4 AND lease_fence=$5`;

// Expired rotation keys are erased whenever the worker releases a lease.
const ERASE_EXPIRED_PREVIOUS_KEY = [
  "previous_encrypted_signing_key",
  "previous_encryption_nonce",
  "previous_encryption_tag",
  "previous_encryption_key_version",
  "previous_credential_expires_at",
]
  .map(
    (column) =>
      `${column}=CASE WHEN previous_credential_expires_at<=clock_timestamp() THEN NULL ELSE ${column} END`,
  )
  .join(",");

const RELEASE = "lease_owner=NULL,lease_expires_at=NULL";

function leaseValues(claim: ClaimedEventWebhook, workerId: string) {
  return [
    claim.organizationId,
    claim.projectId,
    claim.webhookId,
    workerId,
    claim.leaseFence.toString(),
  ];
}

interface WebhookRow {
  endpoint_url: string;
  event_kinds: string[] | null;
  include_message_content: boolean;
  encrypted_signing_key: Buffer;
  encryption_nonce: Buffer;
  encryption_tag: Buffer;
  encryption_key_version: number;
  previous_encrypted_signing_key: Buffer | null;
  previous_encryption_nonce: Buffer | null;
  previous_encryption_tag: Buffer | null;
  previous_encryption_key_version: number | null;
  previous_active: boolean;
  delivered_position: string;
  batch_id: string | null;
  batch_through_position: string | null;
  consecutive_failures: number;
}

interface EventRow {
  id: string;
  organization_id: string;
  project_id: string;
  project_position: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_sequence: string;
  event_kind: string;
  public_payload: Record<string, unknown>;
  occurred_at: Date;
}

function toEvent(row: EventRow): WebhookProductEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateSequence: Number(row.aggregate_sequence),
    projectPosition: row.project_position,
    kind: row.event_kind,
    publicPayload: row.public_payload,
    occurredAt: row.occurred_at.toISOString(),
  };
}

/**
 * Attaches message text to `message.created` events. User messages carry
 * their id in the payload; the assistant reply is the run's single assistant
 * message, and its event is keyed by the run.
 */
async function attachMessages(
  transaction: PgClient,
  claim: ClaimedEventWebhook,
  events: WebhookProductEvent[],
): Promise<WebhookProductEvent[]> {
  const messageIds = new Set<string>();
  const runIds = new Set<string>();
  for (const event of events) {
    if (event.kind !== "message.created") continue;
    const messageId = event.publicPayload.messageId;
    if (typeof messageId === "string" && UUID.test(messageId))
      messageIds.add(messageId);
    else if (event.aggregateType === "run" && UUID.test(event.aggregateId))
      runIds.add(event.aggregateId);
  }
  if (messageIds.size === 0 && runIds.size === 0) return events;
  const result = await transaction.query(
    `SELECT id,run_id,role,redacted_content FROM oao.messages
      WHERE organization_id=$1 AND project_id=$2
        AND (id=ANY($3::uuid[]) OR (role='assistant' AND run_id=ANY($4::uuid[])))`,
    [claim.organizationId, claim.projectId, [...messageIds], [...runIds]],
  );
  const byId = new Map<string, Record<string, string>>();
  const assistantByRun = new Map<string, Record<string, string>>();
  for (const row of result.rows as Record<string, string>[]) {
    byId.set(row.id ?? "", row);
    if (row.role === "assistant") assistantByRun.set(row.run_id ?? "", row);
  }
  return events.map((event) => {
    if (event.kind !== "message.created") return event;
    const messageId = event.publicPayload.messageId;
    const row =
      typeof messageId === "string"
        ? byId.get(messageId)
        : event.aggregateType === "run"
          ? assistantByRun.get(event.aggregateId)
          : undefined;
    if (!row) return event;
    return {
      ...event,
      message: {
        id: row.id ?? "",
        runId: row.run_id ?? "",
        role: row.role ?? "",
        content: row.redacted_content ?? "",
      },
    };
  });
}

export class PostgresEventWebhookStore implements EventWebhookStore {
  constructor(private readonly pool: PgPool) {}

  async claim(input: {
    readonly workerId: string;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly ClaimedEventWebhook[]> {
    const result = await this.pool.query(
      `SELECT organization_id,project_id,webhook_id,lease_fence::text
         FROM oao.claim_event_webhook_deliveries($1,$2,make_interval(secs => $3))`,
      [input.workerId, input.limit, input.leaseMs / 1000],
    );
    return (result.rows as Record<string, string>[]).map((row) => ({
      organizationId: row.organization_id as OrganizationId,
      projectId: row.project_id as ProjectId,
      webhookId: row.webhook_id ?? "",
      leaseFence: BigInt(row.lease_fence ?? "0"),
    }));
  }

  load(
    claim: ClaimedEventWebhook,
    workerId: string,
    maxEvents: number,
  ): Promise<EventWebhookWork | undefined> {
    return withTenantTransaction(this.pool, claim, async (transaction) => {
      const found = await transaction.query(
        `SELECT endpoint_url,event_kinds,include_message_content,
                encrypted_signing_key,encryption_nonce,encryption_tag,encryption_key_version,
                previous_encrypted_signing_key,previous_encryption_nonce,previous_encryption_tag,
                previous_encryption_key_version,
                COALESCE(previous_credential_expires_at>clock_timestamp(),false) AS previous_active,
                delivered_position::text,batch_id,batch_through_position::text,consecutive_failures
           FROM oao.event_webhooks
          WHERE ${LEASED} AND enabled AND lease_expires_at>clock_timestamp()`,
        leaseValues(claim, workerId),
      );
      const row = found.rows[0] as WebhookRow | undefined;
      if (!row) return undefined;
      const delivered = BigInt(row.delivered_position);
      const batch: PendingBatch | null =
        row.batch_id && row.batch_through_position
          ? {
              id: row.batch_id,
              throughPosition: BigInt(row.batch_through_position),
            }
          : null;
      const limit = batch
        ? Number(batch.throughPosition - delivered)
        : maxEvents;
      const events = await transaction.query(
        `SELECT id,organization_id,project_id,project_position::text,aggregate_type,aggregate_id,
                aggregate_sequence::text,event_kind,public_payload,occurred_at
           FROM oao.product_events
          WHERE organization_id=$1 AND project_id=$2 AND project_position>$3
            AND ($4::bigint IS NULL OR project_position<=$4)
          ORDER BY project_position
          LIMIT $5`,
        [
          claim.organizationId,
          claim.projectId,
          delivered.toString(),
          batch ? batch.throughPosition.toString() : null,
          limit,
        ],
      );
      let loaded = (events.rows as EventRow[]).map(toEvent);
      if (row.include_message_content)
        loaded = await attachMessages(transaction, claim, loaded);
      const signingKeys: EncryptedSigningKey[] = [
        {
          ciphertext: row.encrypted_signing_key,
          nonce: row.encryption_nonce,
          tag: row.encryption_tag,
          keyVersion: row.encryption_key_version,
        },
      ];
      if (
        row.previous_active &&
        row.previous_encrypted_signing_key &&
        row.previous_encryption_nonce &&
        row.previous_encryption_tag &&
        row.previous_encryption_key_version
      )
        signingKeys.push({
          ciphertext: row.previous_encrypted_signing_key,
          nonce: row.previous_encryption_nonce,
          tag: row.previous_encryption_tag,
          keyVersion: row.previous_encryption_key_version,
        });
      return {
        endpointUrl: row.endpoint_url,
        eventKinds: row.event_kinds,
        includeMessageContent: row.include_message_content,
        signingKeys,
        deliveredPosition: delivered,
        consecutiveFailures: row.consecutive_failures,
        batch,
        events: loaded,
      };
    });
  }

  async startBatch(
    claim: ClaimedEventWebhook,
    workerId: string,
    batch: PendingBatch,
    expectedDeliveredPosition: bigint,
  ): Promise<boolean> {
    const result = await withTenantTransaction(
      this.pool,
      claim,
      (transaction) =>
        transaction.query(
          `UPDATE oao.event_webhooks
            SET batch_id=$6,batch_through_position=$7
          WHERE ${LEASED} AND enabled AND batch_id IS NULL AND delivered_position=$8`,
          [
            ...leaseValues(claim, workerId),
            batch.id,
            batch.throughPosition.toString(),
            expectedDeliveredPosition.toString(),
          ],
        ),
    );
    return result.rowCount === 1;
  }

  async skip(
    claim: ClaimedEventWebhook,
    workerId: string,
    throughPosition: bigint,
    expectedDeliveredPosition: bigint,
  ): Promise<boolean> {
    const result = await withTenantTransaction(
      this.pool,
      claim,
      (transaction) =>
        transaction.query(
          `UPDATE oao.event_webhooks
            SET delivered_position=$6,next_attempt_at=clock_timestamp(),${RELEASE},
                ${ERASE_EXPIRED_PREVIOUS_KEY}
          WHERE ${LEASED} AND batch_id IS NULL AND delivered_position=$7`,
          [
            ...leaseValues(claim, workerId),
            throughPosition.toString(),
            expectedDeliveredPosition.toString(),
          ],
        ),
    );
    return result.rowCount === 1;
  }

  async finish(
    claim: ClaimedEventWebhook,
    workerId: string,
    outcome: DeliveryOutcome,
  ): Promise<boolean> {
    const result = await withTenantTransaction(
      this.pool,
      claim,
      (transaction) =>
        outcome.kind === "delivered"
          ? transaction.query(
              `UPDATE oao.event_webhooks
                SET delivered_position=batch_through_position,
                    batch_id=NULL,batch_through_position=NULL,
                    consecutive_failures=0,next_attempt_at=clock_timestamp(),
                    last_attempt_at=clock_timestamp(),last_success_at=clock_timestamp(),
                    last_response_status=$6,last_error_code=NULL,${RELEASE},
                    ${ERASE_EXPIRED_PREVIOUS_KEY}
              WHERE ${LEASED} AND batch_id=$7`,
              [
                ...leaseValues(claim, workerId),
                outcome.responseStatus,
                outcome.batchId,
              ],
            )
          : transaction.query(
              `UPDATE oao.event_webhooks
                SET consecutive_failures=consecutive_failures+1,
                    next_attempt_at=clock_timestamp()+make_interval(secs => $6),
                    last_attempt_at=clock_timestamp(),last_failure_at=clock_timestamp(),
                    last_response_status=$7,last_error_code=$8,
                    enabled=CASE WHEN $9 THEN false ELSE enabled END,
                    disabled_reason=CASE WHEN $9 THEN 'endpoint_gone' ELSE disabled_reason END,
                    ${RELEASE},${ERASE_EXPIRED_PREVIOUS_KEY}
              WHERE ${LEASED}`,
              [
                ...leaseValues(claim, workerId),
                outcome.retryAfterMs / 1000,
                outcome.responseStatus ?? null,
                outcome.errorCode,
                outcome.disable,
              ],
            ),
    );
    return result.rowCount === 1;
  }
}
