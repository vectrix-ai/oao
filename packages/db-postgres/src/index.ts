import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  EventId,
  OrganizationId,
  PrincipalId,
  ProjectId,
  PublicValue,
  RunId,
  RunState,
  ThreadId,
  ToolCallId,
} from "@oao/domain";
import { assertPublicPayload } from "@oao/domain";
import type {
  AppendedProductEvent,
  AtomicEventAppender,
  ProductEventInput,
  WakeOnlyNotifier,
} from "@oao/events";
import pg from "pg";

const { Pool } = pg;
export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

export interface TenantContext {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
}

export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<pg.QueryResult>;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export function createPool(connectionString: string): PgPool {
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 10_000 });
}

export async function migrate(
  pool: PgPool,
  directory = fileURLToPath(new URL("../migrations", import.meta.url)),
): Promise<MigrationResult> {
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [1_849_665_221]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.oao_schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const names = (await readdir(directory))
      .filter((name) => /^\d+_.+\.sql$/u.test(name))
      .sort();
    for (const name of names) {
      const sql = await readFile(`${directory}/${name}`, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM public.oao_schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum)
          throw new Error(`Applied migration was modified: ${name}`);
        alreadyApplied.push(name);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO public.oao_schema_migrations (name, checksum) VALUES ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { applied, alreadyApplied };
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [1_849_665_221])
      .catch(() => undefined);
    client.release();
  }
}

export async function withTenantTransaction<T>(
  pool: PgPool,
  tenant: TenantContext,
  callback: (transaction: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE oao_app");
    await client.query("SELECT oao.set_tenant_context($1, $2)", [
      tenant.organizationId,
      tenant.projectId,
    ]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface CreateRunInput extends TenantContext {
  readonly id: RunId;
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly agentVersionId: string;
  readonly createdByPrincipalId: PrincipalId;
  readonly idempotencyKey: string;
  readonly inputPublic: Readonly<Record<string, PublicValue>>;
}

export interface RunRecord extends TenantContext {
  readonly id: RunId;
  readonly threadId: ThreadId;
  readonly state: RunState;
  readonly admittedAt?: Date;
  readonly cancellationRequestedAt?: Date;
}

export interface RunRepository {
  create(transaction: Queryable, input: CreateRunInput): Promise<RunRecord>;
  transition(
    transaction: Queryable,
    tenant: TenantContext,
    runId: RunId,
    state: RunState,
  ): Promise<RunRecord>;
  requestCancellation(
    transaction: Queryable,
    tenant: TenantContext,
    runId: RunId,
  ): Promise<
    "cancelled_pre_admission" | "reconcile_and_abort" | "already_settled"
  >;
}

export interface AdmissionRepository {
  reserve(
    transaction: Queryable,
    input: TenantContext & {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly admissionKey: string;
      readonly requestHash: Uint8Array;
    },
  ): Promise<{
    readonly runId: RunId;
    readonly state: "reserved" | "ambiguous" | "admitted";
    readonly fence: bigint;
  }>;
}

export interface IdempotencyRepository {
  claimIdempotency(
    transaction: Queryable,
    input: TenantContext & {
      readonly scope: string;
      readonly key: string;
      readonly requestHash: Uint8Array;
      readonly expiresAt: Date;
    },
  ): Promise<"claimed" | "replayed">;
}

export interface ToolClaimRepository {
  claimToolCall(
    transaction: Queryable,
    input: TenantContext & {
      readonly toolCallId: ToolCallId;
      readonly principalId: PrincipalId;
      readonly leaseMilliseconds: number;
    },
  ): Promise<bigint>;
  beginPlatformExecution(
    transaction: Queryable,
    input: TenantContext & {
      readonly toolCallId: ToolCallId;
      readonly servicePrincipalId: PrincipalId;
      readonly leaseMilliseconds: number;
    },
  ): Promise<bigint>;
  submitResult(
    transaction: Queryable,
    input: TenantContext & {
      readonly toolCallId: ToolCallId;
      readonly principalId: PrincipalId;
      readonly fence: bigint;
      readonly idempotencyKey: string;
      readonly requestHash: Uint8Array;
      readonly safeResult: Readonly<Record<string, PublicValue>>;
    },
  ): Promise<"submitted" | "replayed">;
}

interface RunRow {
  organization_id: OrganizationId;
  project_id: ProjectId;
  id: RunId;
  thread_id: ThreadId;
  state: RunState;
  admitted_at: Date | null;
  cancellation_requested_at: Date | null;
}

function mapRun(row: RunRow): RunRecord {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    id: row.id,
    threadId: row.thread_id,
    state: row.state,
    ...(row.admitted_at ? { admittedAt: row.admitted_at } : {}),
    ...(row.cancellation_requested_at
      ? { cancellationRequestedAt: row.cancellation_requested_at }
      : {}),
  };
}

export class PostgresFoundationRepository
  implements
    RunRepository,
    AdmissionRepository,
    IdempotencyRepository,
    ToolClaimRepository
{
  async create(
    transaction: Queryable,
    input: CreateRunInput,
  ): Promise<RunRecord> {
    assertPublicPayload(input.inputPublic);
    const result = await transaction.query(
      `INSERT INTO oao.runs (
        organization_id, project_id, id, thread_id, session_id, agent_version_id,
        created_by_principal_id, idempotency_key, input_public
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        input.organizationId,
        input.projectId,
        input.id,
        input.threadId,
        input.sessionId,
        input.agentVersionId,
        input.createdByPrincipalId,
        input.idempotencyKey,
        input.inputPublic,
      ],
    );
    return mapRun(result.rows[0] as RunRow);
  }

  async transition(
    transaction: Queryable,
    tenant: TenantContext,
    runId: RunId,
    state: RunState,
  ): Promise<RunRecord> {
    const result = await transaction.query(
      "UPDATE oao.runs SET state = $4 WHERE organization_id = $1 AND project_id = $2 AND id = $3 RETURNING *",
      [tenant.organizationId, tenant.projectId, runId, state],
    );
    if (!result.rowCount) throw new Error("Run not found");
    return mapRun(result.rows[0] as RunRow);
  }

  async requestCancellation(
    transaction: Queryable,
    tenant: TenantContext,
    runId: RunId,
  ): Promise<
    "cancelled_pre_admission" | "reconcile_and_abort" | "already_settled"
  > {
    const result = await transaction.query(
      "SELECT oao.request_run_cancellation($1,$2,$3) AS outcome",
      [tenant.organizationId, tenant.projectId, runId],
    );
    return (
      result.rows[0] as {
        outcome:
          "cancelled_pre_admission" | "reconcile_and_abort" | "already_settled";
      }
    ).outcome;
  }

  async reserve(
    transaction: Queryable,
    input: TenantContext & {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly admissionKey: string;
      readonly requestHash: Uint8Array;
    },
  ): Promise<{
    readonly runId: RunId;
    readonly state: "reserved" | "ambiguous" | "admitted";
    readonly fence: bigint;
  }> {
    const result = await transaction.query(
      "SELECT (h).run_id AS run_id, (h).state AS state, (h).fence AS fence FROM (SELECT oao.reserve_thread_admission($1,$2,$3,$4,$5,$6) AS h) q",
      [
        input.organizationId,
        input.projectId,
        input.threadId,
        input.runId,
        input.admissionKey,
        input.requestHash,
      ],
    );
    const row = result.rows[0] as {
      run_id: RunId;
      state: "reserved" | "ambiguous" | "admitted";
      fence: string;
    };
    return { runId: row.run_id, state: row.state, fence: BigInt(row.fence) };
  }

  async claimIdempotency(
    transaction: Queryable,
    input: TenantContext & {
      readonly scope: string;
      readonly key: string;
      readonly requestHash: Uint8Array;
      readonly expiresAt: Date;
    },
  ): Promise<"claimed" | "replayed"> {
    const result = await transaction.query(
      "SELECT oao.claim_idempotency($1,$2,$3,$4,$5,$6) AS outcome",
      [
        input.organizationId,
        input.projectId,
        input.scope,
        input.key,
        input.requestHash,
        input.expiresAt,
      ],
    );
    return (result.rows[0] as { outcome: "claimed" | "replayed" }).outcome;
  }

  async claimToolCall(
    transaction: Queryable,
    input: TenantContext & {
      readonly toolCallId: ToolCallId;
      readonly principalId: PrincipalId;
      readonly leaseMilliseconds: number;
    },
  ): Promise<bigint> {
    const result = await transaction.query(
      "SELECT oao.claim_tool_call($1,$2,$3,$4,($5 || ' milliseconds')::interval) AS fence",
      [
        input.organizationId,
        input.projectId,
        input.toolCallId,
        input.principalId,
        input.leaseMilliseconds,
      ],
    );
    return BigInt((result.rows[0] as { fence: string }).fence);
  }

  async beginPlatformExecution(
    transaction: Queryable,
    input: TenantContext & {
      readonly toolCallId: ToolCallId;
      readonly servicePrincipalId: PrincipalId;
      readonly leaseMilliseconds: number;
    },
  ): Promise<bigint> {
    const result = await transaction.query(
      "SELECT oao.begin_platform_tool_execution($1,$2,$3,$4,($5 || ' milliseconds')::interval) AS fence",
      [
        input.organizationId,
        input.projectId,
        input.toolCallId,
        input.servicePrincipalId,
        input.leaseMilliseconds,
      ],
    );
    return BigInt((result.rows[0] as { fence: string }).fence);
  }

  async submitResult(
    transaction: Queryable,
    input: TenantContext & {
      readonly toolCallId: ToolCallId;
      readonly principalId: PrincipalId;
      readonly fence: bigint;
      readonly idempotencyKey: string;
      readonly requestHash: Uint8Array;
      readonly safeResult: Readonly<Record<string, PublicValue>>;
    },
  ): Promise<"submitted" | "replayed"> {
    assertPublicPayload(input.safeResult);
    const result = await transaction.query(
      "SELECT oao.submit_tool_result($1,$2,$3,$4,$5,$6,$7,$8) AS outcome",
      [
        input.organizationId,
        input.projectId,
        input.toolCallId,
        input.principalId,
        input.fence.toString(),
        input.idempotencyKey,
        input.requestHash,
        input.safeResult,
      ],
    );
    return (result.rows[0] as { outcome: "submitted" | "replayed" }).outcome;
  }
}

interface EventRow {
  organization_id: OrganizationId;
  project_id: ProjectId;
  project_position: string;
  id: EventId;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_sequence: string;
  event_kind: string;
  public_payload: Readonly<Record<string, PublicValue>>;
  occurred_at: Date;
}

export class PostgresEventAppender implements AtomicEventAppender<Queryable> {
  async append(
    transaction: Queryable,
    input: ProductEventInput,
  ): Promise<AppendedProductEvent> {
    assertPublicPayload(input.publicPayload);
    const result = await transaction.query(
      "SELECT (event).* FROM (SELECT oao.append_product_event($1,$2,$3,$4,$5,$6,$7,$8) AS event) q",
      [
        input.organizationId,
        input.projectId,
        input.id,
        input.aggregateType,
        input.aggregateId,
        input.kind,
        input.publicPayload,
        input.occurredAt,
      ],
    );
    const row = result.rows[0] as EventRow;
    return {
      ...input,
      aggregateSequence: BigInt(row.aggregate_sequence),
      projectPosition: BigInt(row.project_position),
    };
  }
}

export class PostgresWakeNotifier implements WakeOnlyNotifier {
  constructor(private readonly pool: PgPool) {}
  async notifyProject(
    organizationId: OrganizationId,
    projectId: ProjectId,
  ): Promise<void> {
    await this.pool.query("SELECT pg_notify('oao_product_events', $1)", [
      `${organizationId}/${projectId}`,
    ]);
  }
  async subscribe(onWake: () => void): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    const listener = () => onWake();
    client.on("notification", listener);
    await client.query("LISTEN oao_product_events");
    return async () => {
      await client.query("UNLISTEN oao_product_events");
      client.off("notification", listener);
      client.release();
    };
  }
}
