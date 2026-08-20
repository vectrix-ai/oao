import { createHash } from "node:crypto";
import type { Provider } from "@earendil-works/pi-ai";
import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry";
import { postgres } from "@flue/postgres";
import {
  AgentRunError,
  dispatch,
  init,
  instrument,
  observe,
  useInitialData,
  useModel,
  useSandbox,
  useTool,
} from "@flue/runtime";
import type {
  DispatchReceipt,
  FlueObservation,
  SandboxFactory,
} from "@flue/runtime";
import { start } from "@flue/runtime/node";
import type { Flue } from "@flue/runtime/node";
import {
  ManagedRunInitialDataSchema,
  type ManagedAgentSnapshot,
  type ManagedRunInitialData,
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
  readonly sandboxFactory?: SandboxFactory;
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

function runtimeConfig(): ManagedAgentRuntimeConfig {
  if (!managedRuntime)
    throw new Error("ManagedAgent runtime is not configured");
  return managedRuntime;
}

const ToolInputSchema = v.looseObject({});
const ToolOutputSchema = v.looseObject({ ok: v.boolean() });

function safeArguments(
  value: Record<string, unknown>,
): Readonly<Record<string, PublicValue>> {
  const redacted = redactForPublic(value);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted))
    return {};
  return redacted as Readonly<Record<string, PublicValue>>;
}

export function ManagedAgent(): string {
  const initial = useInitialData<ManagedRunInitialData>();
  const config = runtimeConfig();
  const preset = config.presets.resolve(initial.snapshot.modelPreset);
  useModel(preset.model);
  if (initial.snapshot.sandbox.enabled && config.sandboxFactory)
    useSandbox(config.sandboxFactory);

  for (const tool of initial.snapshot.tools) {
    useTool({
      name: tool.name,
      description: tool.description,
      input: ToolInputSchema,
      output: ToolOutputSchema,
      durable: true,
      async run({ data, signal, step, toolCallId }) {
        const obligation: ToolObligationInput = {
          organizationId: initial.organizationId as OrganizationId,
          projectId: initial.projectId as ProjectId,
          runId: initial.runId as RunId,
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
            () => {
              if (!handler)
                throw new Error("Platform tool handler unavailable");
              return handler(obligation.safeArguments, {
                runId: obligation.runId,
                toolCallId,
                idempotencyKey: `platform:${obligation.runId}:${toolCallId}`,
                ...(signal ? { signal } : {}),
              });
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
ManagedAgent.initialData = ManagedRunInitialDataSchema;
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
  state: string;
  fence: string;
  flue_conversation_id: string;
  flue_submission_id: string | null;
  flue_instance_uid: string | null;
}

function digestJson(value: unknown): Uint8Array {
  return createHash("sha256").update(JSON.stringify(value)).digest();
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
    await this.admit(job);
  }

  async enqueueRecovery(): Promise<number> {
    const heads = await this.pool.query<{
      organization_id: OrganizationId;
      project_id: ProjectId;
      run_id: RunId;
    }>(
      `SELECT organization_id,project_id,run_id FROM oao.thread_admission_heads
       ORDER BY updated_at`,
    );
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
    const requestHash = digestJson({
      runId: run.runId,
      snapshotHash: Buffer.from(snapshotHash).toString("hex"),
    });
    let runtimeDispatch = await withTenantTransaction(
      this.pool,
      run,
      async (transaction) => {
        const headResult = await transaction.query(
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
        const head = headResult.rows[0] as { fence: string };
        await transaction.query(
          `INSERT INTO oao.runtime_dispatches (
          organization_id,project_id,run_id,thread_id,admission_key,request_hash,
          snapshot_hash,state,fence,flue_conversation_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9)
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
            run.runId,
          ],
        );
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

    if (!runtimeDispatch.flue_submission_id) {
      const receipt = await dispatch(ManagedAgent, {
        id: run.runId,
        idempotencyKey: admissionKey,
        message: this.deliveredMessage(run.inputPublic),
        initialData: {
          organizationId: run.organizationId,
          projectId: run.projectId,
          threadId: run.threadId,
          sessionId: run.sessionId,
          runId: run.runId,
          snapshot: run.snapshot,
        } satisfies ManagedRunInitialData,
      });
      runtimeDispatch = await this.commitAdmission(run, receipt);
    }
    this.trackAdmission?.(run);
    if (run.cancellationRequested)
      await this.abortAdmitted(run, runtimeDispatch);
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
    await init(ManagedAgent, {
      id: runtimeDispatch.flue_conversation_id,
    }).abort();
  }

  private async commitAdmission(
    run: RunContext,
    receipt: DispatchReceipt,
  ): Promise<DispatchRow> {
    return withTenantTransaction(this.pool, run, async (transaction) => {
      const result = await transaction.query(
        `UPDATE oao.runtime_dispatches SET state=CASE WHEN state='settled' THEN state
          ELSE 'admitted'::oao.runtime_dispatch_state END,flue_submission_id=$4,
          flue_instance_uid=$5,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 RETURNING *`,
        [
          run.organizationId,
          run.projectId,
          run.runId,
          receipt.submissionId,
          receipt.uid,
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
      await appendEventOnce(transaction, {
        ...run,
        id: eventUuid(`event:${run.runId}:user-message`),
        aggregateType: "run",
        aggregateId: run.runId,
        kind: "message.created",
        payload: { role: "user" },
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
      await transaction.query(
        `INSERT INTO oao.messages (
          organization_id,project_id,id,thread_id,run_id,role,redacted_content,flue_message_ref
        ) VALUES ($1,$2,$3,$4,$5,'user',$6,$7) ON CONFLICT DO NOTHING`,
        [
          run.organizationId,
          run.projectId,
          eventUuid(`message:${run.runId}:user`),
          run.threadId,
          run.runId,
          this.deliveredMessage(run.inputPublic),
          `input:${receipt.submissionId}`,
        ],
      );
      await transaction.query(
        `INSERT INTO oao.timeline_entries (
          organization_id,project_id,run_id,entry_sequence,entry_type,started_at,safe_detail
        ) VALUES ($1,$2,$3,1,'run',clock_timestamp(),$4) ON CONFLICT DO NOTHING`,
        [run.organizationId, run.projectId, run.runId, { status: "admitted" }],
      );
      return result.rows[0] as DispatchRow;
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
      const parsed = v.parse(ManagedRunInitialDataSchema.entries.snapshot, {
        ...(row.config as Record<string, unknown>),
        agentVersionId: row.agent_version_id,
        contentHash: row.content_hash,
      });
      return {
        ...tenant,
        runId: row.id as RunId,
        threadId: row.thread_id as ThreadId,
        sessionId: row.session_id as string,
        state: row.state as string,
        cancellationRequested: row.cancellation_requested_at !== null,
        inputPublic: row.input_public as Readonly<Record<string, PublicValue>>,
        snapshot: parsed,
      };
    });
  }

  private deliveredMessage(
    input: Readonly<Record<string, PublicValue>>,
  ): string {
    return typeof input.message === "string"
      ? input.message
      : "Continue this managed run.";
  }
}

export class RuntimeProjection {
  #pending = Promise.resolve();
  #unsubscribe: (() => void) | undefined;
  readonly #watching = new Map<string, Promise<void>>();

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

  private async project(event: FlueObservation): Promise<void> {
    const dispatchResult = await this.pool.query<DispatchRow>(
      `SELECT * FROM oao.runtime_dispatches
       WHERE flue_submission_id=$1 OR flue_conversation_id=$2 OR run_id::text=$3`,
      [
        event.submissionId ?? "",
        event.conversationId ?? "",
        event.instanceId ?? "",
      ],
    );
    const runtimeDispatch = dispatchResult.rows[0];
    if (!runtimeDispatch) return;
    if (event.type === "turn") {
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
      const reply = await init(ManagedAgent, {
        id: runtimeDispatch.flue_conversation_id,
      }).read(runtimeDispatch.flue_submission_id);
      await this.settle(
        runtimeDispatch,
        "completed",
        runtimeDispatch.flue_submission_id,
        reply.text,
      );
    } catch (error) {
      const outcome = error instanceof AgentRunError ? error.outcome : "failed";
      await this.settle(
        runtimeDispatch,
        outcome,
        runtimeDispatch.flue_submission_id,
      );
    }
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
        await transaction.query(
          `INSERT INTO oao.model_invocations (
          organization_id,project_id,id,run_id,attempt,provider_key,model_key,status,
          input_tokens,output_tokens,cost_microunits,safe_request,safe_response,
          started_at,completed_at,usage_source,pricing_snapshot,provider_route
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17)
        ON CONFLICT (organization_id,project_id,id) DO NOTHING`,
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
            usage ? "provider_reported" : "unavailable",
            { model: event.request.requestedModel },
            { provider: event.request.providerId },
          ],
        );
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
            attempt + 1,
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
          session_id: string;
          thread_id: ThreadId;
        }>(
          "SELECT cancellation_requested_at,session_id,thread_id FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND id=$3",
          [tenant.organizationId, tenant.projectId, runtimeDispatch.run_id],
        ),
    );
    const run = runResult.rows[0];
    if (!run) return;
    const state =
      outcome === "completed"
        ? "completed"
        : outcome === "aborted" && run.cancellation_requested_at
          ? "cancelled"
          : "failed";
    let redactedReply = projectedReply ?? "";
    if (outcome === "completed" && projectedReply === undefined) {
      const reply = await init(ManagedAgent, {
        id: runtimeDispatch.flue_conversation_id,
      }).read(submissionId);
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
          state,
        ],
      );
      await transaction.query(
        `UPDATE oao.timeline_entries SET completed_at=clock_timestamp(),safe_detail=$4
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND entry_sequence=1`,
        [
          tenant.organizationId,
          tenant.projectId,
          runtimeDispatch.run_id,
          { status: state },
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
        payload: { state },
      });
      await appendEventOnce(transaction, {
        ...tenant,
        id: eventUuid(`event:${runtimeDispatch.run_id}:session-summary`),
        aggregateType: "session",
        aggregateId: run.session_id,
        kind: "session.summary_changed",
        payload: { runId: runtimeDispatch.run_id, state },
      });
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
  instrument(createOpenTelemetryInstrumentation({ content: false }));
  return async () => {
    await sdk?.shutdown();
  };
}

export async function startManagedFlueRuntime(input: {
  readonly pool: PgPool;
  readonly providers: readonly Provider[];
  readonly presets: ImmutableModelPresetRegistry;
  readonly broker: PostgresToolBroker;
  readonly platformTools?: ReadonlyMap<string, PlatformToolHandler>;
  readonly sandboxFactory?: SandboxFactory;
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

export const runtimeTesting = { eventUuid, safeArguments };
