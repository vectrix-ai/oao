import { createHash } from "node:crypto";
import type { Provider } from "@earendil-works/pi-ai";
import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry";
import { postgres } from "@flue/postgres";
import {
  AgentInstanceExistsError,
  AgentRunError,
  dispatch,
  getAgentInstance,
  init,
  instrument,
  observe,
  useDelivery,
  useInitialData,
  useModel,
  useSandbox,
  useTool,
} from "@flue/runtime";
import type {
  DispatchReceipt,
  DeliveredMessage,
  FlueObservation,
  SandboxFactory,
  ToolInputSchema,
  ToolOutputSchema,
} from "@flue/runtime";
import { start } from "@flue/runtime/node";
import type { Flue } from "@flue/runtime/node";
import {
  ManagedAgentInstanceDataSchema,
  ManagedRunDeliverySchema,
  ManagedRunInputV1Schema,
  ToolResultFailureCodeSchema,
  type ManagedAgentSnapshot,
  type ManagedAgentInstanceData,
  type ManagedRunDelivery,
} from "@oao/contracts";
import type { PgPool, Queryable, TenantContext } from "@oao/db-postgres";
import { withTenantTransaction } from "@oao/db-postgres";
import type {
  OrganizationId,
  ProjectId,
  PublicValue,
  RunId,
  ThreadId,
} from "@oao/domain";
import { redactForPublic } from "@oao/domain";
import type { ImmutableModelPresetRegistry } from "@oao/models-openrouter";
import type { PostgresWakeQueue, RuntimeWakeJob } from "@oao/queue-postgres";
import type { PostgresToolBroker, ToolObligationInput } from "@oao/tool-broker";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as v from "valibot";

export const FLUE_PACKAGE_VERSIONS = Object.freeze({
  runtime: "2.0.3",
  postgres: "2.0.3",
  opentelemetry: "2.0.3",
  piAi: "0.83.0",
});

export type PlatformToolHandler = (
  arguments_: Readonly<Record<string, PublicValue>>,
  context: {
    readonly runId: RunId;
    readonly toolCallId: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  },
) => Promise<PublicValue>;

interface ManagedAgentRuntimeConfig {
  readonly presets: ImmutableModelPresetRegistry;
  readonly broker: PostgresToolBroker;
  readonly platformTools: ReadonlyMap<string, PlatformToolHandler>;
  readonly sandboxFactory?: (
    initial: ManagedAgentInstanceData,
    delivery: ManagedRunDelivery,
  ) => SandboxFactory;
}

let managedRuntime: ManagedAgentRuntimeConfig | undefined;

export function configureManagedAgentRuntime(
  config: ManagedAgentRuntimeConfig,
): void {
  if (managedRuntime)
    throw new Error("ManagedAgent runtime is already configured");
  managedRuntime = Object.freeze({
    ...config,
    platformTools: new Map(config.platformTools),
  });
}

export function resetManagedAgentRuntime(): void {
  managedRuntime = undefined;
}

function runtimeConfig(): ManagedAgentRuntimeConfig {
  if (!managedRuntime)
    throw new Error("ManagedAgent runtime is not configured");
  return managedRuntime;
}

type PublishedObjectSchema =
  ManagedAgentSnapshot["tools"][number]["inputSchema"];

function compilePropertySchema(
  schema: Record<string, unknown>,
): v.GenericSchema {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum;
    return v.custom((value) => values.some((entry) => Object.is(entry, value)));
  }
  switch (schema.type) {
    case "string":
      return v.string();
    case "number":
      return v.number();
    case "integer":
      return v.pipe(v.number(), v.integer());
    case "boolean":
      return v.boolean();
    case "null":
      return v.null();
    case "array": {
      if (!schema.items || typeof schema.items !== "object")
        throw new TypeError("Published array schemas require items");
      return v.array(
        compilePropertySchema(schema.items as Record<string, unknown>),
      );
    }
    case "object":
      return compileObjectSchema(schema as PublishedObjectSchema);
    default:
      throw new TypeError("Unsupported published JSON schema type");
  }
}

function compileObjectSchema(schema: PublishedObjectSchema): ToolInputSchema {
  if (schema.type !== "object" || schema.additionalProperties !== false)
    throw new TypeError("Tool schemas must be closed objects");
  const required = new Set(schema.required);
  const entries: Record<string, v.GenericSchema> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const compiled = compilePropertySchema(property);
    entries[key] = required.has(key) ? compiled : v.optional(compiled);
  }
  for (const key of required) {
    if (!(key in entries))
      throw new TypeError(`Required tool schema property is missing: ${key}`);
  }
  return v.strictObject(entries);
}

function compileToolOutputSchema(
  schema: PublishedObjectSchema,
): ToolOutputSchema {
  return v.variant("status", [
    v.object({
      version: v.literal(1),
      status: v.literal("success"),
      value: compileObjectSchema(schema),
    }),
    v.object({
      version: v.literal(1),
      status: v.literal("failure"),
      error: v.object({
        code: ToolResultFailureCodeSchema,
        message: v.string(),
      }),
    }),
  ]);
}

function safeArguments(value: unknown): Readonly<Record<string, PublicValue>> {
  const redacted = redactForPublic(value);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted))
    return {};
  return redacted as Readonly<Record<string, PublicValue>>;
}

export function ManagedAgent(): string {
  const initial = useInitialData<ManagedAgentInstanceData>();
  const delivered = useDelivery();
  if (delivered.kind !== "signal" || delivered.type !== "oao.run.v1")
    throw new Error("ManagedAgent received an invalid delivery envelope");
  const delivery = v.parse(ManagedRunDeliverySchema, delivered.attributes);
  if (delivery.snapshotHash !== digestHex(initial.snapshot))
    throw new Error(
      "ManagedAgent delivery snapshot does not match its instance",
    );
  const config = runtimeConfig();
  const preset = config.presets.resolve(initial.snapshot.modelPreset);
  useModel(preset.model);
  if (initial.snapshot.sandbox.enabled && config.sandboxFactory)
    useSandbox(config.sandboxFactory(initial, delivery));

  for (const tool of initial.snapshot.tools) {
    useTool({
      name: tool.name,
      description: tool.description,
      input: compileObjectSchema(tool.inputSchema),
      output: compileToolOutputSchema(tool.outputSchema),
      durable: true,
      async run({ data, signal, step, toolCallId }) {
        const obligation: ToolObligationInput = {
          organizationId: initial.organizationId as OrganizationId,
          projectId: initial.projectId as ProjectId,
          runId: delivery.runId as RunId,
          flueToolCallId: toolCallId,
          toolName: tool.name,
          safeArguments: safeArguments(data),
          approval: tool.approval,
        };
        if (tool.owner === "caller") {
          await step.do("publish-caller-obligation", () =>
            config.broker.publishCaller(obligation),
          );
          const outcome = await step.do("commit-caller-result", () =>
            config.broker.waitForCaller(obligation, signal),
          );
          return { output: outcome };
        }
        const handler = config.platformTools.get(tool.name);
        const outcome = await step.do("execute-platform-obligation", () =>
          config.broker.executePlatform(
            obligation,
            async () => {
              if (!handler)
                throw new Error("Platform tool handler unavailable");
              const result = await handler(obligation.safeArguments, {
                runId: obligation.runId,
                toolCallId,
                idempotencyKey: `platform:${obligation.runId}:${toolCallId}`,
                ...(signal ? { signal } : {}),
              });
              return v.parse(
                compileObjectSchema(tool.outputSchema),
                result,
              ) as PublicValue;
            },
            signal,
          ),
        );
        return { output: outcome };
      },
    });
  }
  return initial.snapshot.systemPrompt;
}

ManagedAgent.agentName = "ManagedAgent";
ManagedAgent.initialData = ManagedAgentInstanceDataSchema;
ManagedAgent.durability = { maxAttempts: 10, timeoutMs: 3_600_000 };

export function createFluePostgresAdapter(pool: PgPool) {
  return postgres({
    query: async (text, params) => (await pool.query(text, params)).rows,
    transaction: async (callback) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await callback({
          query: async (text, params) =>
            (await client.query(text, params)).rows,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => undefined,
  });
}

interface RunContext extends TenantContext {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly agentVersionId: string;
  readonly state: string;
  readonly cancellationRequested: boolean;
  readonly inputPublic: Readonly<Record<string, PublicValue>>;
  readonly snapshot: ManagedAgentSnapshot;
}

interface DispatchRow {
  organization_id: OrganizationId;
  project_id: ProjectId;
  run_id: RunId;
  thread_id: ThreadId;
  admission_key: string;
  request_hash: Uint8Array;
  snapshot_hash: Uint8Array;
  state: string;
  fence: string;
  flue_conversation_id: string;
  flue_submission_id: string | null;
  flue_instance_uid: string | null;
  flue_accepted_at: Date | null;
  deadline_at: Date;
  timeout_requested_at: Date | null;
}

interface ThreadInstanceRow {
  organization_id: OrganizationId;
  project_id: ProjectId;
  thread_id: ThreadId;
  session_id: string;
  agent_version_id: string;
  snapshot_hash: Buffer;
  flue_instance_id: string;
  flue_instance_uid: string | null;
  state: "ready" | "corrupt";
}

class FlueIncarnationCorruptionError extends Error {}

function threadInstanceId(
  input: TenantContext & { readonly threadId: ThreadId },
): string {
  return `oao:v1:${input.organizationId}:${input.projectId}:${input.threadId}`;
}

function digestJson(value: unknown): Uint8Array {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function digestHex(value: unknown): string {
  return Buffer.from(digestJson(value)).toString("hex");
}

function eventUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function appendEventOnce(
  transaction: Queryable,
  input: TenantContext & {
    readonly id: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly kind: string;
    readonly payload: Readonly<Record<string, PublicValue>>;
  },
): Promise<void> {
  const exists = await transaction.query(
    "SELECT 1 FROM oao.product_events WHERE organization_id=$1 AND project_id=$2 AND id=$3",
    [input.organizationId, input.projectId, input.id],
  );
  if (exists.rowCount) return;
  await transaction.query(
    "SELECT oao.append_product_event($1,$2,$3,$4,$5,$6,$7,clock_timestamp())",
    [
      input.organizationId,
      input.projectId,
      input.id,
      input.aggregateType,
      input.aggregateId,
      input.kind,
      input.payload,
    ],
  );
}

async function closeRunObligations(
  transaction: Queryable,
  input: TenantContext & { readonly runId: RunId },
  state: "completed" | "failed" | "cancelled" | "timed_out",
): Promise<void> {
  await transaction.query(
    `UPDATE oao.approvals SET status='expired',resolved_at=clock_timestamp(),
       resolution_note=$4
     WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND status='pending'`,
    [input.organizationId, input.projectId, input.runId, `run_${state}`],
  );
  await transaction.query(
    `UPDATE oao.tool_calls SET stage='cancelled',claim_fence=claim_fence+1,
       lease_holder_principal_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
     WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
       AND stage IN ('caller_pending','caller_claimed','platform_ready','platform_executing','result_submitted')`,
    [input.organizationId, input.projectId, input.runId],
  );
}

export class ManagedRuntimeOrchestrator {
  constructor(
    private readonly pool: PgPool,
    private readonly queue: PostgresWakeQueue,
    private readonly trackAdmission?: (
      input: TenantContext & { readonly runId: RunId },
    ) => void,
  ) {}

  async handleWake(job: RuntimeWakeJob): Promise<void> {
    if (job.kind === "cancel") {
      await this.cancel(job);
      return;
    }
    if (job.kind === "deadline") {
      await this.deadline(job);
      return;
    }
    await this.admit(job);
  }

  async enqueueRecovery(): Promise<number> {
    const heads = await this.pool.query<{
      organization_id: OrganizationId;
      project_id: ProjectId;
      run_id: RunId;
    }>("SELECT * FROM oao.list_runtime_recovery_heads()");
    for (const head of heads.rows) {
      await withTenantTransaction(
        this.pool,
        {
          organizationId: head.organization_id,
          projectId: head.project_id,
        },
        (transaction) =>
          this.queue.enqueue(transaction, {
            organizationId: head.organization_id,
            projectId: head.project_id,
            id: eventUuid(`recovery:${head.run_id}`),
            runId: head.run_id,
            dispatchKey: `reconcile:${head.run_id}`,
            kind: "reconcile",
            payload: { reason: "startup_recovery" },
          }),
      );
    }
    return heads.rowCount ?? 0;
  }

  async admit(job: RuntimeWakeJob): Promise<void> {
    const run = await this.loadRun(job);
    const admissionKey = `run:${run.runId}`;
    const snapshotHash = digestJson(run.snapshot);
    const deliveredMessage = this.deliveredMessage(run);
    const requestHash = digestJson({
      runId: run.runId,
      snapshotHash: Buffer.from(snapshotHash).toString("hex"),
      deliveredMessage,
    });
    const flueInstanceId = threadInstanceId(run);
    let runtimeDispatch: DispatchRow;
    try {
      runtimeDispatch = await withTenantTransaction(
        this.pool,
        run,
        async (transaction) => {
          await transaction.query(
            `INSERT INTO oao.runtime_thread_instances (
              organization_id,project_id,thread_id,session_id,agent_version_id,
              snapshot_hash,flue_instance_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (organization_id,project_id,thread_id) DO NOTHING`,
            [
              run.organizationId,
              run.projectId,
              run.threadId,
              run.sessionId,
              run.agentVersionId,
              snapshotHash,
              flueInstanceId,
            ],
          );
          const instanceResult = await transaction.query<ThreadInstanceRow>(
            `SELECT * FROM oao.runtime_thread_instances
             WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3 FOR UPDATE`,
            [run.organizationId, run.projectId, run.threadId],
          );
          const instance = instanceResult.rows[0];
          if (
            !instance ||
            instance.state !== "ready" ||
            instance.session_id !== run.sessionId ||
            instance.agent_version_id !== run.agentVersionId ||
            instance.flue_instance_id !== flueInstanceId ||
            !Buffer.from(instance.snapshot_hash).equals(
              Buffer.from(snapshotHash),
            )
          )
            throw new FlueIncarnationCorruptionError(
              "Thread runtime identity or immutable snapshot mismatch",
            );
          const existingResult = await transaction.query<DispatchRow>(
            `SELECT * FROM oao.runtime_dispatches
             WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 FOR UPDATE`,
            [run.organizationId, run.projectId, run.runId],
          );
          const existing = existingResult.rows[0];
          if (existing) {
            const headResult = await transaction.query<{
              run_id: RunId;
              admission_key: string;
              request_hash: Uint8Array;
              fence: string;
            }>(
              `SELECT run_id,admission_key,request_hash,fence
               FROM oao.thread_admission_heads
               WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3 FOR UPDATE`,
              [run.organizationId, run.projectId, run.threadId],
            );
            const head = headResult.rows[0];
            if (
              !head ||
              head.run_id !== run.runId ||
              head.admission_key !== admissionKey ||
              !Buffer.from(head.request_hash).equals(
                Buffer.from(requestHash),
              ) ||
              existing.thread_id !== run.threadId ||
              existing.admission_key !== admissionKey ||
              !Buffer.from(existing.request_hash).equals(
                Buffer.from(requestHash),
              ) ||
              !Buffer.from(existing.snapshot_hash).equals(
                Buffer.from(snapshotHash),
              ) ||
              existing.fence !== head.fence ||
              existing.flue_conversation_id !== flueInstanceId ||
              (existing.flue_instance_uid !== null &&
                existing.flue_instance_uid !== instance.flue_instance_uid)
            )
              throw new FlueIncarnationCorruptionError(
                "Existing admission recovery correlation mismatch",
              );
          } else {
            const headResult = await transaction.query<{ fence: string }>(
              "SELECT (oao.reserve_thread_admission($1,$2,$3,$4,$5,$6)).*",
              [
                run.organizationId,
                run.projectId,
                run.threadId,
                run.runId,
                admissionKey,
                requestHash,
              ],
            );
            const head = headResult.rows[0];
            if (!head)
              throw new Error("Admission reservation did not return a head");
            await transaction.query(
              `INSERT INTO oao.runtime_dispatches (
          organization_id,project_id,run_id,thread_id,admission_key,request_hash,
          snapshot_hash,state,fence,flue_conversation_id,deadline_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,
          clock_timestamp()+($10 || ' milliseconds')::interval)
        ON CONFLICT (organization_id,project_id,run_id) DO NOTHING`,
              [
                run.organizationId,
                run.projectId,
                run.runId,
                run.threadId,
                admissionKey,
                requestHash,
                snapshotHash,
                head.fence,
                flueInstanceId,
                run.snapshot.limits.timeoutMs,
              ],
            );
          }
          const result = await transaction.query(
            `UPDATE oao.runtime_dispatches SET state=CASE WHEN flue_submission_id IS NULL
          THEN 'dispatching'::oao.runtime_dispatch_state ELSE state END,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 RETURNING *`,
            [run.organizationId, run.projectId, run.runId],
          );
          await transaction.query(
            `UPDATE oao.thread_admission_heads SET state=CASE WHEN state='reserved'
          THEN 'ambiguous'::oao.admission_state ELSE state END,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
            [run.organizationId, run.projectId, run.runId],
          );
          await appendEventOnce(transaction, {
            ...run,
            id: eventUuid(`event:${run.runId}:dispatch-reserved`),
            aggregateType: "run",
            aggregateId: run.runId,
            kind: "runtime.dispatch_reserved",
            payload: { admissionKey },
          });
          return result.rows[0] as DispatchRow;
        },
      );
    } catch (error) {
      if (error instanceof FlueIncarnationCorruptionError) {
        await this.terminalizeCorruption(run);
        return;
      }
      throw error;
    }

    if (!runtimeDispatch.flue_submission_id) {
      try {
        const receipt = await this.dispatchFenced(run, runtimeDispatch);
        runtimeDispatch = await this.commitAdmission(run, receipt);
      } catch (error) {
        if (error instanceof FlueIncarnationCorruptionError) {
          await this.terminalizeCorruption(run);
          return;
        }
        throw error;
      }
    }
    this.trackAdmission?.(run);
    if (run.cancellationRequested) {
      try {
        await this.abortAdmitted(run, runtimeDispatch);
      } catch (error) {
        if (error instanceof FlueIncarnationCorruptionError) {
          await this.terminalizeCorruption(run);
          return;
        }
        throw error;
      }
    }
  }

  private async dispatchFenced(
    run: RunContext,
    runtimeDispatch: DispatchRow,
  ): Promise<DispatchReceipt> {
    let instance = await this.loadThreadInstance(run);
    const message = this.deliveredMessage(run);
    if (!instance.flue_instance_uid) {
      try {
        const receipt = await dispatch(ManagedAgent, {
          id: instance.flue_instance_id,
          uid: null,
          idempotencyKey: runtimeDispatch.admission_key,
          message,
          initialData: {
            organizationId: run.organizationId,
            projectId: run.projectId,
            threadId: run.threadId,
            sessionId: run.sessionId,
            snapshot: run.snapshot,
          } satisfies ManagedAgentInstanceData,
        });
        await this.bindThreadUid(run, receipt.uid);
        return receipt;
      } catch (error) {
        if (!(error instanceof AgentInstanceExistsError)) throw error;
        await this.bindThreadUid(run, error.uid);
        instance = await this.loadThreadInstance(run);
      }
    }
    const uid = instance.flue_instance_uid;
    if (!uid)
      throw new FlueIncarnationCorruptionError(
        "Flue incarnation UID was not durably bound",
      );
    await this.assertFlueIncarnation(instance.flue_instance_id, uid);
    const receipt = await dispatch(ManagedAgent, {
      id: instance.flue_instance_id,
      uid,
      idempotencyKey: runtimeDispatch.admission_key,
      message,
    });
    if (receipt.uid !== uid)
      throw new FlueIncarnationCorruptionError(
        "Flue dispatch receipt UID does not match the thread binding",
      );
    return receipt;
  }

  private async loadThreadInstance(
    run: RunContext,
  ): Promise<ThreadInstanceRow> {
    const result = await withTenantTransaction(this.pool, run, (transaction) =>
      transaction.query<ThreadInstanceRow>(
        `SELECT * FROM oao.runtime_thread_instances
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3`,
        [run.organizationId, run.projectId, run.threadId],
      ),
    );
    const instance = result.rows[0];
    if (!instance || instance.state !== "ready")
      throw new FlueIncarnationCorruptionError(
        "Thread runtime identity is unavailable",
      );
    return instance;
  }

  private async bindThreadUid(run: RunContext, uid: string): Promise<void> {
    const result = await withTenantTransaction(this.pool, run, (transaction) =>
      transaction.query(
        `UPDATE oao.runtime_thread_instances SET flue_instance_uid=$4,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3
           AND state='ready' AND (flue_instance_uid IS NULL OR flue_instance_uid=$4)
         RETURNING thread_id`,
        [run.organizationId, run.projectId, run.threadId, uid],
      ),
    );
    if (!result.rowCount)
      throw new FlueIncarnationCorruptionError(
        "Flue incarnation UID compare-and-set failed",
      );
  }

  private async assertFlueIncarnation(id: string, uid: string): Promise<void> {
    const current = await getAgentInstance(ManagedAgent, id);
    if (!current || current.uid !== uid)
      throw new FlueIncarnationCorruptionError(
        "Stored Flue incarnation UID does not match the durable instance",
      );
  }

  private async cancel(job: RuntimeWakeJob): Promise<void> {
    const outcome = await withTenantTransaction(
      this.pool,
      job,
      async (transaction) => {
        const result = await transaction.query(
          "SELECT oao.request_run_cancellation($1,$2,$3) AS outcome",
          [job.organizationId, job.projectId, job.runId],
        );
        return (result.rows[0] as { outcome: string }).outcome;
      },
    );
    if (outcome !== "reconcile_and_abort") return;
    await this.admit(job);
  }

  private async deadline(job: RuntimeWakeJob): Promise<void> {
    const run = await this.loadRun(job);
    const dispatchResult = await withTenantTransaction(
      this.pool,
      run,
      async (transaction) => {
        const result = await transaction.query<DispatchRow>(
          `UPDATE oao.runtime_dispatches SET timeout_requested_at=COALESCE(timeout_requested_at,clock_timestamp()),
             state=CASE WHEN state='settled' THEN state ELSE 'aborting'::oao.runtime_dispatch_state END,
             updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
             AND state <> 'settled' AND deadline_at <= clock_timestamp()
           RETURNING *`,
          [run.organizationId, run.projectId, run.runId],
        );
        if (result.rowCount) {
          await transaction.query(
            `UPDATE oao.thread_admission_heads
             SET draining_at=COALESCE(draining_at,clock_timestamp()),updated_at=clock_timestamp()
             WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
            [run.organizationId, run.projectId, run.runId],
          );
          await appendEventOnce(transaction, {
            ...run,
            id: eventUuid(`event:${run.runId}:deadline-draining`),
            aggregateType: "run",
            aggregateId: run.runId,
            kind: "runtime.cancellation_draining",
            payload: { reason: "deadline_exceeded" },
          });
        }
        return result;
      },
    );
    const runtimeDispatch = dispatchResult.rows[0];
    if (!runtimeDispatch) return;
    await this.abortFlueIncarnation(runtimeDispatch);
    this.trackAdmission?.(run);
  }

  private async abortAdmitted(
    run: RunContext,
    runtimeDispatch: DispatchRow,
  ): Promise<void> {
    await withTenantTransaction(this.pool, run, async (transaction) => {
      await transaction.query(
        `UPDATE oao.thread_admission_heads SET draining_at=COALESCE(draining_at,clock_timestamp())
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [run.organizationId, run.projectId, run.runId],
      );
      await appendEventOnce(transaction, {
        ...run,
        id: eventUuid(`event:${run.runId}:cancellation-draining`),
        aggregateType: "run",
        aggregateId: run.runId,
        kind: "runtime.cancellation_draining",
        payload: {
          submissionId: runtimeDispatch.flue_submission_id ?? "pending",
        },
      });
      await transaction.query(
        `UPDATE oao.runtime_dispatches SET state='aborting',updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [run.organizationId, run.projectId, run.runId],
      );
    });
    await this.abortFlueIncarnation(runtimeDispatch);
  }

  private async abortFlueIncarnation(
    runtimeDispatch: DispatchRow,
  ): Promise<void> {
    const uid = runtimeDispatch.flue_instance_uid;
    if (!uid)
      throw new FlueIncarnationCorruptionError(
        "Cannot abort an admitted run without a bound Flue UID",
      );
    await this.assertFlueIncarnation(runtimeDispatch.flue_conversation_id, uid);
    await init(ManagedAgent, {
      id: runtimeDispatch.flue_conversation_id,
      uid,
    }).abort();
  }

  private async terminalizeCorruption(run: RunContext): Promise<void> {
    await withTenantTransaction(this.pool, run, async (transaction) => {
      const safeError = {
        code: "flue_incarnation_mismatch",
        message: "The durable conversation identity could not be verified",
      } as const;
      const headResult = await transaction.query<{ run_id: RunId }>(
        `SELECT run_id FROM oao.thread_admission_heads
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3 FOR UPDATE`,
        [run.organizationId, run.projectId, run.threadId],
      );
      const affectedRunId = headResult.rows[0]?.run_id ?? run.runId;
      await transaction.query(
        `UPDATE oao.runtime_thread_instances SET state='corrupt',safe_error=$4,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3`,
        [run.organizationId, run.projectId, run.threadId, safeError],
      );
      await transaction.query(
        `UPDATE oao.runtime_dispatches SET state='aborting',safe_error=$4,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND state <> 'settled'`,
        [run.organizationId, run.projectId, affectedRunId, safeError],
      );
      await transaction.query(
        `UPDATE oao.runs SET state='failed',settled_at=COALESCE(settled_at,clock_timestamp()),
           updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND id=$3
           AND state NOT IN ('completed','failed','cancelled','timed_out')`,
        [run.organizationId, run.projectId, affectedRunId],
      );
      const affectedRun = { ...run, runId: affectedRunId };
      await closeRunObligations(transaction, affectedRun, "failed");
      await transaction.query(
        `UPDATE oao.thread_admission_heads SET state='ambiguous',
           draining_at=COALESCE(draining_at,clock_timestamp()),updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [run.organizationId, run.projectId, affectedRunId],
      );
      await appendEventOnce(transaction, {
        ...affectedRun,
        id: eventUuid(`event:${affectedRunId}:incarnation-corrupt`),
        aggregateType: "run",
        aggregateId: affectedRunId,
        kind: "runtime.recovery_completed",
        payload: { outcome: "failed", code: safeError.code },
      });
    });
  }

  private async commitAdmission(
    run: RunContext,
    receipt: DispatchReceipt,
  ): Promise<DispatchRow> {
    return withTenantTransaction(this.pool, run, async (transaction) => {
      const bound = await transaction.query(
        `UPDATE oao.runtime_thread_instances SET updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3
           AND state='ready' AND flue_instance_uid=$4 RETURNING thread_id`,
        [run.organizationId, run.projectId, run.threadId, receipt.uid],
      );
      if (!bound.rowCount)
        throw new FlueIncarnationCorruptionError(
          "Flue receipt UID did not match the thread control record",
        );
      const result = await transaction.query(
        `UPDATE oao.runtime_dispatches SET state=CASE WHEN state='settled' THEN state
          ELSE 'admitted'::oao.runtime_dispatch_state END,flue_submission_id=$4,
          flue_instance_uid=$5,flue_accepted_at=$6,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 RETURNING *`,
        [
          run.organizationId,
          run.projectId,
          run.runId,
          receipt.submissionId,
          receipt.uid,
          new Date(receipt.acceptedAt),
        ],
      );
      await appendEventOnce(transaction, {
        ...run,
        id: eventUuid(`event:${run.runId}:dispatch-admitted`),
        aggregateType: "run",
        aggregateId: run.runId,
        kind: "runtime.dispatch_admitted",
        payload: { submissionId: receipt.submissionId },
      });
      await transaction.query(
        `UPDATE oao.thread_admission_heads SET state='admitted',canonical_run_ref=$4,
          updated_at=clock_timestamp() WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [run.organizationId, run.projectId, run.runId, receipt.submissionId],
      );
      if (run.state === "queued" || run.state === "retry_scheduled") {
        await transaction.query(
          "UPDATE oao.runs SET state='running' WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND state IN ('queued','retry_scheduled')",
          [run.organizationId, run.projectId, run.runId],
        );
      }
      await appendEventOnce(transaction, {
        ...run,
        id: eventUuid(`event:${run.runId}:running`),
        aggregateType: "run",
        aggregateId: run.runId,
        kind: "run.state_changed",
        payload: { state: "running", reason: "dispatch_admitted" },
      });
      await transaction.query(
        `INSERT INTO oao.messages (
          organization_id,project_id,id,thread_id,run_id,role,redacted_content,flue_message_ref
        ) SELECT $1,$2,$3,$4,$5,'user',$6,$7
          WHERE NOT EXISTS (
            SELECT 1 FROM oao.messages
            WHERE organization_id=$1 AND project_id=$2 AND run_id=$5 AND role='user'
          )
        ON CONFLICT DO NOTHING`,
        [
          run.organizationId,
          run.projectId,
          eventUuid(`message:${run.runId}:user`),
          run.threadId,
          run.runId,
          this.inputText(run.inputPublic),
          `input:${receipt.submissionId}`,
        ],
      );
      await transaction.query(
        `INSERT INTO oao.timeline_entries (
          organization_id,project_id,run_id,entry_sequence,entry_type,started_at,safe_detail
        ) VALUES ($1,$2,$3,1,'run',clock_timestamp(),$4) ON CONFLICT DO NOTHING`,
        [run.organizationId, run.projectId, run.runId, { status: "admitted" }],
      );
      const admitted = result.rows[0] as DispatchRow;
      await this.queue.enqueue(transaction, {
        organizationId: run.organizationId,
        projectId: run.projectId,
        id: eventUuid(`wake:deadline:${run.runId}`),
        runId: run.runId,
        dispatchKey: `deadline:${run.runId}`,
        kind: "deadline",
        payload: { reason: "product_deadline" },
        availableAt: new Date(admitted.deadline_at),
      });
      return admitted;
    });
  }

  private async loadRun(
    tenant: TenantContext & { readonly runId: RunId },
  ): Promise<RunContext> {
    return withTenantTransaction(this.pool, tenant, async (transaction) => {
      const result = await transaction.query(
        `SELECT r.id,r.thread_id,r.session_id,r.state,r.input_public,r.cancellation_requested_at,
          v.id AS agent_version_id,v.config,encode(v.content_hash,'hex') AS content_hash
         FROM oao.runs r JOIN oao.agent_versions v
           ON v.organization_id=r.organization_id AND v.project_id=r.project_id AND v.id=r.agent_version_id
         WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=$3`,
        [tenant.organizationId, tenant.projectId, tenant.runId],
      );
      if (!result.rowCount) throw new Error("Run not found");
      const row = result.rows[0] as Record<string, unknown>;
      const runInput = v.parse(ManagedRunInputV1Schema, row.input_public);
      const parsed = v.parse(ManagedAgentInstanceDataSchema.entries.snapshot, {
        ...(row.config as Record<string, unknown>),
        agentVersionId: row.agent_version_id,
        contentHash: row.content_hash,
      });
      return {
        ...tenant,
        runId: row.id as RunId,
        threadId: row.thread_id as ThreadId,
        sessionId: row.session_id as string,
        agentVersionId: row.agent_version_id as string,
        state: row.state as string,
        cancellationRequested: row.cancellation_requested_at !== null,
        inputPublic: runInput,
        snapshot: parsed,
      };
    });
  }

  private inputText(input: Readonly<Record<string, PublicValue>>): string {
    return v.parse(ManagedRunInputV1Schema, input).message;
  }

  private deliveredMessage(run: RunContext): DeliveredMessage {
    return {
      kind: "signal",
      type: "oao.run.v1",
      tagName: "oao-run",
      body: this.inputText(run.inputPublic),
      attributes: {
        version: "1",
        runId: run.runId,
        sessionId: run.sessionId,
        snapshotHash: digestHex(run.snapshot),
      },
    };
  }
}

export class RuntimeProjection {
  #pending = Promise.resolve();
  #unsubscribe: (() => void) | undefined;
  readonly #watching = new Map<string, Promise<void>>();
  readonly #lastTurns = new Map<
    RunId,
    {
      readonly dispatch: DispatchRow;
      readonly event: Extract<FlueObservation, { type: "turn" }>;
    }
  >();
  readonly #abort = new AbortController();

  constructor(
    private readonly pool: PgPool,
    private readonly queue: PostgresWakeQueue,
  ) {}

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = observe((event) => {
      if (!event.conversationId) return;
      this.#pending = this.#pending
        .then(() => this.project(event))
        .catch(() => undefined);
    });
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#abort.abort(new Error("Runtime projection stopped"));
    await this.#pending;
    await Promise.all(this.#watching.values());
  }

  trackAdmission(input: TenantContext & { readonly runId: RunId }): void {
    const key = `${input.organizationId}/${input.projectId}/${input.runId}`;
    if (this.#watching.has(key)) return;
    const watching = this.watchAdmission(input).finally(() => {
      this.#watching.delete(key);
    });
    this.#watching.set(key, watching);
  }

  async replayLastTurn(runId: RunId): Promise<boolean> {
    const observed = this.#lastTurns.get(runId);
    if (!observed) return false;
    await this.projectTurn(observed.dispatch, observed.event);
    return true;
  }

  private async project(event: FlueObservation): Promise<void> {
    const dispatchResult = await this.pool.query<DispatchRow>(
      `SELECT * FROM oao.runtime_dispatches
       WHERE flue_submission_id=$1 OR
         ($1='' AND flue_conversation_id=$2 AND state <> 'settled')
       ORDER BY CASE WHEN flue_submission_id=$1 THEN 0 ELSE 1 END,created_at DESC
       LIMIT 1`,
      [event.submissionId ?? "", event.conversationId ?? ""],
    );
    const runtimeDispatch = dispatchResult.rows[0];
    if (!runtimeDispatch) return;
    if (event.type === "turn") {
      this.#lastTurns.set(runtimeDispatch.run_id, {
        dispatch: runtimeDispatch,
        event,
      });
      await this.projectTurn(runtimeDispatch, event);
      return;
    }
    if (event.type === "submission_recovery") {
      await this.appendPublicEvent(
        runtimeDispatch,
        event,
        "runtime.recovery_started",
        {
          outcome: event.outcome,
          operation: event.operation,
        },
      );
      return;
    }
    if (event.type === "submission_settled")
      await this.settle(runtimeDispatch, event.outcome, event.submissionId);
  }

  private async watchAdmission(
    input: TenantContext & { readonly runId: RunId },
  ): Promise<void> {
    const result = await withTenantTransaction(
      this.pool,
      input,
      (transaction) =>
        transaction.query<DispatchRow>(
          `SELECT * FROM oao.runtime_dispatches WHERE organization_id=$1
           AND project_id=$2 AND run_id=$3 AND flue_submission_id IS NOT NULL`,
          [input.organizationId, input.projectId, input.runId],
        ),
    );
    const runtimeDispatch = result.rows[0];
    if (
      !runtimeDispatch?.flue_submission_id ||
      runtimeDispatch.state === "settled"
    )
      return;
    try {
      const receipt = await this.receiptFor(runtimeDispatch);
      const reply = await init(ManagedAgent, {
        id: runtimeDispatch.flue_conversation_id,
        uid: receipt.uid,
      }).read(receipt, { signal: this.#abort.signal });
      await this.settle(
        runtimeDispatch,
        "completed",
        runtimeDispatch.flue_submission_id,
        reply.text,
      );
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      const outcome = error instanceof AgentRunError ? error.outcome : "failed";
      if (error instanceof FlueIncarnationCorruptionError) {
        await this.recordCorruption(runtimeDispatch);
        return;
      }
      await this.settle(
        runtimeDispatch,
        outcome,
        runtimeDispatch.flue_submission_id,
      );
    }
  }

  private async receiptFor(
    runtimeDispatch: DispatchRow,
  ): Promise<DispatchReceipt> {
    const uid = runtimeDispatch.flue_instance_uid;
    const submissionId = runtimeDispatch.flue_submission_id;
    const acceptedAt = runtimeDispatch.flue_accepted_at;
    if (!uid || !submissionId || !acceptedAt)
      throw new FlueIncarnationCorruptionError(
        "Persisted Flue receipt is incomplete",
      );
    const current = await getAgentInstance(
      ManagedAgent,
      runtimeDispatch.flue_conversation_id,
    );
    if (!current || current.uid !== uid)
      throw new FlueIncarnationCorruptionError(
        "Persisted Flue receipt UID does not match the instance",
      );
    return {
      submissionId,
      uid,
      acceptedAt: new Date(acceptedAt).toISOString(),
    };
  }

  private async recordCorruption(runtimeDispatch: DispatchRow): Promise<void> {
    await withTenantTransaction(
      this.pool,
      {
        organizationId: runtimeDispatch.organization_id,
        projectId: runtimeDispatch.project_id,
      },
      async (transaction) => {
        const safeError = {
          code: "flue_incarnation_mismatch",
          message: "The durable conversation identity could not be verified",
        } as const;
        await transaction.query(
          `UPDATE oao.runtime_thread_instances SET state='corrupt',safe_error=$4,
             updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.thread_id,
            safeError,
          ],
        );
        await transaction.query(
          `UPDATE oao.runtime_dispatches SET state='aborting',safe_error=$4,
             updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND state <> 'settled'`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
            safeError,
          ],
        );
        await transaction.query(
          `UPDATE oao.runs SET state='failed',
             settled_at=COALESCE(settled_at,clock_timestamp()),updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND id=$3
             AND state NOT IN ('completed','failed','cancelled','timed_out')`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
          ],
        );
        await closeRunObligations(
          transaction,
          {
            organizationId: runtimeDispatch.organization_id,
            projectId: runtimeDispatch.project_id,
            runId: runtimeDispatch.run_id,
          },
          "failed",
        );
        await transaction.query(
          `UPDATE oao.thread_admission_heads SET state='ambiguous',
             draining_at=COALESCE(draining_at,clock_timestamp()),updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
          ],
        );
      },
    );
  }

  private async projectTurn(
    runtimeDispatch: DispatchRow,
    event: Extract<FlueObservation, { type: "turn" }>,
  ): Promise<void> {
    const usage = event.response.usage;
    const invocationId = eventUuid(
      `turn:${runtimeDispatch.run_id}:${event.turnId}`,
    );
    await withTenantTransaction(
      this.pool,
      {
        organizationId: runtimeDispatch.organization_id,
        projectId: runtimeDispatch.project_id,
      },
      async (transaction) => {
        const attemptResult = await transaction.query(
          "SELECT COALESCE(MAX(attempt),0)+1 AS attempt FROM oao.model_invocations WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
          ],
        );
        const attempt = Number(
          (attemptResult.rows[0] as { attempt: string }).attempt,
        );
        const inserted = await transaction.query<{ attempt: string }>(
          `INSERT INTO oao.model_invocations (
          organization_id,project_id,id,run_id,attempt,provider_key,model_key,status,
          input_tokens,output_tokens,cost_microunits,safe_request,safe_response,
          started_at,completed_at,usage_source,pricing_snapshot,provider_route
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17)
        ON CONFLICT (organization_id,project_id,id) DO NOTHING
        RETURNING attempt`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            invocationId,
            runtimeDispatch.run_id,
            attempt,
            event.request.providerId,
            event.request.requestedModel,
            event.isError ? "failed" : "completed",
            usage?.input ?? 0,
            usage?.output ?? 0,
            Math.round((usage?.cost.total ?? 0) * 1_000_000),
            { purpose: event.purpose },
            { finishReason: event.response.finishReason ?? "unknown" },
            new Date(event.timestamp),
            usage ? "estimated" : "unavailable",
            { model: event.request.requestedModel },
            { provider: event.request.providerId },
          ],
        );
        if (!inserted.rowCount) return;
        const stableAttempt = Number(inserted.rows[0]?.attempt ?? attempt);
        await transaction.query(
          `INSERT INTO oao.timeline_entries (
            organization_id,project_id,run_id,entry_sequence,entry_type,
            started_at,completed_at,safe_detail
          ) VALUES ($1,$2,$3,$4,'model_invocation',$5,$5,$6)
          ON CONFLICT DO NOTHING`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
            stableAttempt + 1,
            new Date(event.timestamp),
            {
              status: event.isError ? "failed" : "completed",
              model: event.request.requestedModel,
              provider: event.request.providerId,
            },
          ],
        );
        await transaction.query(
          `INSERT INTO oao.session_summaries (
          organization_id,project_id,session_id,input_tokens,output_tokens,cost_microunits
        ) SELECT organization_id,project_id,session_id,$4,$5,$6 FROM oao.runs
          WHERE organization_id=$1 AND project_id=$2 AND id=$3
        ON CONFLICT (organization_id,project_id,session_id) DO UPDATE SET
          summary_version=oao.session_summaries.summary_version+1,
          input_tokens=oao.session_summaries.input_tokens+EXCLUDED.input_tokens,
          output_tokens=oao.session_summaries.output_tokens+EXCLUDED.output_tokens,
          cost_microunits=oao.session_summaries.cost_microunits+EXCLUDED.cost_microunits,
          updated_at=clock_timestamp()`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
            usage?.input ?? 0,
            usage?.output ?? 0,
            Math.round((usage?.cost.total ?? 0) * 1_000_000),
          ],
        );
      },
    );
    await this.appendPublicEvent(
      runtimeDispatch,
      event,
      event.isError ? "model.invocation_failed" : "model.invocation_completed",
      {
        model: event.request.requestedModel,
        provider: event.request.providerId,
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        costMicrounits: Math.round((usage?.cost.total ?? 0) * 1_000_000),
      },
    );
  }

  private async settle(
    runtimeDispatch: DispatchRow,
    outcome: "completed" | "failed" | "aborted",
    submissionId: string,
    projectedReply?: string,
  ): Promise<void> {
    const tenant = {
      organizationId: runtimeDispatch.organization_id,
      projectId: runtimeDispatch.project_id,
    };
    const runResult = await withTenantTransaction(
      this.pool,
      tenant,
      (transaction) =>
        transaction.query<{
          cancellation_requested_at: Date | null;
          timeout_requested_at: Date | null;
          session_id: string;
          thread_id: ThreadId;
          thread_instance_state: "ready" | "corrupt";
        }>(
          `SELECT r.cancellation_requested_at,r.session_id,r.thread_id,d.timeout_requested_at,
             i.state AS thread_instance_state
           FROM oao.runs r JOIN oao.runtime_dispatches d
             ON d.organization_id=r.organization_id AND d.project_id=r.project_id AND d.run_id=r.id
           JOIN oao.runtime_thread_instances i
             ON i.organization_id=r.organization_id AND i.project_id=r.project_id
            AND i.thread_id=r.thread_id
           WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=$3`,
          [tenant.organizationId, tenant.projectId, runtimeDispatch.run_id],
        ),
    );
    const run = runResult.rows[0];
    if (!run) return;
    const state =
      outcome === "completed"
        ? "completed"
        : outcome === "aborted" && run.timeout_requested_at
          ? "timed_out"
          : outcome === "aborted" && run.cancellation_requested_at
            ? "cancelled"
            : "failed";
    const productState =
      run.thread_instance_state === "corrupt" ? "failed" : state;
    let redactedReply =
      run.thread_instance_state === "corrupt" ? "" : (projectedReply ?? "");
    if (
      run.thread_instance_state !== "corrupt" &&
      outcome === "completed" &&
      projectedReply === undefined
    ) {
      const receipt = await this.receiptFor(runtimeDispatch);
      const reply = await init(ManagedAgent, {
        id: runtimeDispatch.flue_conversation_id,
        uid: receipt.uid,
      }).read(receipt);
      redactedReply = reply.text;
    }
    await withTenantTransaction(this.pool, tenant, async (transaction) => {
      const fence = await transaction.query(
        `UPDATE oao.runtime_dispatches SET state='settled',updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND state <> 'settled'
         RETURNING run_id`,
        [tenant.organizationId, tenant.projectId, runtimeDispatch.run_id],
      );
      if (!fence.rowCount) return;
      await transaction.query(
        "UPDATE oao.runs SET state=$4 WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND state NOT IN ('completed','failed','cancelled','timed_out')",
        [
          tenant.organizationId,
          tenant.projectId,
          runtimeDispatch.run_id,
          productState,
        ],
      );
      await transaction.query(
        `UPDATE oao.timeline_entries SET completed_at=clock_timestamp(),safe_detail=$4
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND entry_sequence=1`,
        [
          tenant.organizationId,
          tenant.projectId,
          runtimeDispatch.run_id,
          { status: productState },
        ],
      );
      if (redactedReply) {
        await transaction.query(
          `INSERT INTO oao.messages (
            organization_id,project_id,id,thread_id,run_id,role,redacted_content,flue_message_ref
          ) VALUES ($1,$2,$3,$4,$5,'assistant',$6,$7) ON CONFLICT DO NOTHING`,
          [
            tenant.organizationId,
            tenant.projectId,
            eventUuid(`message:${runtimeDispatch.run_id}:assistant`),
            run.thread_id,
            runtimeDispatch.run_id,
            redactedReply,
            submissionId,
          ],
        );
        await appendEventOnce(transaction, {
          ...tenant,
          id: eventUuid(`event:${runtimeDispatch.run_id}:assistant-message`),
          aggregateType: "run",
          aggregateId: runtimeDispatch.run_id,
          kind: "message.created",
          payload: { role: "assistant" },
        });
      }
      await transaction.query(
        `INSERT INTO oao.session_summaries (
          organization_id,project_id,session_id,run_count
        ) VALUES ($1,$2,$3,1)
        ON CONFLICT (organization_id,project_id,session_id) DO UPDATE SET
          summary_version=oao.session_summaries.summary_version+1,
          run_count=oao.session_summaries.run_count+1,updated_at=clock_timestamp()`,
        [tenant.organizationId, tenant.projectId, run.session_id],
      );
      await appendEventOnce(transaction, {
        ...tenant,
        id: eventUuid(`event:${runtimeDispatch.run_id}:run-settled`),
        aggregateType: "run",
        aggregateId: runtimeDispatch.run_id,
        kind: "run.state_changed",
        payload: { state: productState },
      });
      await appendEventOnce(transaction, {
        ...tenant,
        id: eventUuid(`event:${runtimeDispatch.run_id}:session-summary`),
        aggregateType: "session",
        aggregateId: run.session_id,
        kind: "session.summary_changed",
        payload: { runId: runtimeDispatch.run_id, state: productState },
      });
      await closeRunObligations(
        transaction,
        {
          ...tenant,
          runId: runtimeDispatch.run_id,
        },
        productState,
      );
      if (run.thread_instance_state === "corrupt") {
        await transaction.query(
          `UPDATE oao.thread_admission_heads SET state='ambiguous',
             draining_at=COALESCE(draining_at,clock_timestamp()),updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
          [tenant.organizationId, tenant.projectId, runtimeDispatch.run_id],
        );
        return;
      }
      await transaction.query(
        "DELETE FROM oao.thread_admission_heads WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
        [tenant.organizationId, tenant.projectId, runtimeDispatch.run_id],
      );
      const successor = await transaction.query<{ id: RunId }>(
        `SELECT id FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3
          AND state IN ('queued','retry_scheduled') AND cancellation_requested_at IS NULL
          ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [tenant.organizationId, tenant.projectId, run.thread_id],
      );
      const next = successor.rows[0];
      if (next) {
        await this.queue.enqueue(transaction, {
          ...tenant,
          id: eventUuid(`wake:admit:${next.id}`),
          runId: next.id,
          dispatchKey: `admit:${next.id}`,
          kind: "admit",
          payload: { reason: "predecessor_settled" },
        });
      }
    });
  }

  private async appendPublicEvent(
    runtimeDispatch: DispatchRow,
    event: FlueObservation,
    kind: string,
    payload: Readonly<Record<string, PublicValue>>,
  ): Promise<void> {
    const eventId = eventUuid(
      `flue:${runtimeDispatch.run_id}:${event.eventIndex}:${kind}`,
    );
    await withTenantTransaction(
      this.pool,
      {
        organizationId: runtimeDispatch.organization_id,
        projectId: runtimeDispatch.project_id,
      },
      async (transaction) => {
        const exists = await transaction.query(
          "SELECT 1 FROM oao.product_events WHERE organization_id=$1 AND project_id=$2 AND id=$3",
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            eventId,
          ],
        );
        if (exists.rowCount) return;
        await transaction.query(
          "SELECT oao.append_product_event($1,$2,$3,'run',$4,$5,$6,$7)",
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            eventId,
            runtimeDispatch.run_id,
            kind,
            payload,
            new Date(event.timestamp),
          ],
        );
      },
    );
  }
}

export async function configureVendorNeutralTelemetry(
  input: {
    readonly endpoint?: string;
    readonly serviceName?: string;
  } = {},
): Promise<() => Promise<void>> {
  let sdk: NodeSDK | undefined;
  if (input.endpoint) {
    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        "service.name": input.serviceName ?? "oao-runtime-worker",
      }),
      traceExporter: new OTLPTraceExporter({ url: input.endpoint }),
    });
    sdk.start();
  }
  const disposeInstrumentation = instrument(
    createOpenTelemetryInstrumentation({ content: false }),
  );
  return async () => {
    await disposeInstrumentation();
    await sdk?.shutdown();
  };
}

export async function startManagedFlueRuntime(input: {
  readonly pool: PgPool;
  readonly providers: readonly Provider[];
  readonly presets: ImmutableModelPresetRegistry;
  readonly broker: PostgresToolBroker;
  readonly platformTools?: ReadonlyMap<string, PlatformToolHandler>;
  readonly sandboxFactory?: (
    initial: ManagedAgentInstanceData,
    delivery: ManagedRunDelivery,
  ) => SandboxFactory;
}): Promise<Flue> {
  configureManagedAgentRuntime({
    presets: input.presets,
    broker: input.broker,
    platformTools: input.platformTools ?? new Map(),
    ...(input.sandboxFactory ? { sandboxFactory: input.sandboxFactory } : {}),
  });
  return start({
    agents: [ManagedAgent],
    db: createFluePostgresAdapter(input.pool),
    providers: input.providers,
  });
}

export const runtimeTesting = {
  eventUuid,
  safeArguments,
  threadInstanceId,
  compileObjectSchema,
};
