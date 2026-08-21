import { createHash } from "node:crypto";
import {
  ToolResultEnvelopeSchema,
  type ToolResultEnvelope,
} from "@oao/contracts";
import type { PgPool, Queryable, TenantContext } from "@oao/db-postgres";
import { withTenantTransaction } from "@oao/db-postgres";
import type { PrincipalId, PublicValue, RunId } from "@oao/domain";
import { assertPublicPayload } from "@oao/domain";
import * as v from "valibot";

export type ToolFailureCode =
  | "approval_denied"
  | "approval_expired"
  | "run_cancelled"
  | "tool_expired"
  | "tool_failed"
  | "platform_tool_failed"
  | "invalid_tool_arguments"
  | "invalid_tool_result";

export type ToolOutcome = ToolResultEnvelope;

export interface ToolObligationInput extends TenantContext {
  readonly runId: RunId;
  readonly flueToolCallId: string;
  readonly toolName: string;
  readonly safeArguments: Readonly<Record<string, PublicValue>>;
  readonly approval: "never" | "always";
}

interface ToolRow {
  id: string;
  stage:
    | "caller_pending"
    | "caller_claimed"
    | "platform_ready"
    | "platform_executing"
    | "result_submitted"
    | "result_committed"
    | "approval_denied"
    | "approval_expired"
    | "cancelled"
    | "expired"
    | "failed";
  claim_fence: string;
  safe_result: Readonly<Record<string, PublicValue>> | null;
  idempotency_key: string | null;
  approval_status: "pending" | "approved" | "denied" | "expired" | null;
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(input: ToolObligationInput): Uint8Array {
  return createHash("sha256")
    .update(
      canonical({
        runId: input.runId,
        flueToolCallId: input.flueToolCallId,
        toolName: input.toolName,
        safeArguments: input.safeArguments,
        approval: input.approval,
      }),
    )
    .digest();
}

function failure(code: ToolFailureCode, message: string): ToolOutcome {
  return { version: 1, status: "failure", error: { code, message } };
}

function decodeResult(
  value: Readonly<Record<string, PublicValue>>,
): ToolOutcome {
  const parsed = v.safeParse(ToolResultEnvelopeSchema, value);
  if (!parsed.success)
    return failure("invalid_tool_result", "Tool returned an invalid result");
  if (parsed.output.status === "success") return parsed.output;
  const visible = new Set<ToolFailureCode>([
    "approval_denied",
    "approval_expired",
    "run_cancelled",
    "tool_expired",
    "tool_failed",
    "platform_tool_failed",
    "invalid_tool_arguments",
    "invalid_tool_result",
  ]);
  const code = visible.has(parsed.output.error.code)
    ? parsed.output.error.code
    : "tool_failed";
  const messages: Record<ToolFailureCode, string> = {
    approval_denied: "Approval was denied",
    approval_expired: "Approval expired",
    run_cancelled: "Run was cancelled",
    tool_expired: "Tool request expired",
    tool_failed: "Tool execution failed",
    platform_tool_failed: "Platform tool execution failed",
    invalid_tool_arguments: "Tool arguments were invalid",
    invalid_tool_result: "Tool returned an invalid result",
  };
  return failure(code, messages[code]);
}

async function appendEventOnce(
  transaction: Queryable,
  input: TenantContext & {
    readonly eventId: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly kind: string;
    readonly payload: Readonly<Record<string, PublicValue>>;
  },
): Promise<void> {
  const existing = await transaction.query(
    "SELECT 1 FROM oao.product_events WHERE organization_id=$1 AND project_id=$2 AND id=$3",
    [input.organizationId, input.projectId, input.eventId],
  );
  if (existing.rowCount) return;
  await transaction.query(
    "SELECT oao.append_product_event($1,$2,$3,$4,$5,$6,$7,clock_timestamp())",
    [
      input.organizationId,
      input.projectId,
      input.eventId,
      input.aggregateType,
      input.aggregateId,
      input.kind,
      input.payload,
    ],
  );
}

async function transitionRun(
  transaction: Queryable,
  input: ToolObligationInput,
  state: "running" | "waiting_for_tool" | "waiting_for_approval",
  reason: string,
): Promise<void> {
  const changed = await transaction.query(
    `UPDATE oao.runs SET state=$4
     WHERE organization_id=$1 AND project_id=$2 AND id=$3
       AND state IN ('running','waiting_for_tool','waiting_for_approval') AND state <> $4
     RETURNING id`,
    [input.organizationId, input.projectId, input.runId, state],
  );
  if (!changed.rowCount) return;
  await appendEventOnce(transaction, {
    ...input,
    eventId: stableUuid(
      `event:tool:${input.runId}:${input.flueToolCallId}:state:${state}`,
    ),
    aggregateType: "run",
    aggregateId: input.runId,
    kind: "run.state_changed",
    payload: { state, reason, toolName: input.toolName },
  });
}

export class PostgresToolBroker {
  constructor(
    private readonly pool: PgPool,
    private readonly options: {
      readonly servicePrincipalId: PrincipalId;
      readonly pollMilliseconds?: number;
      readonly approvalTtlMilliseconds?: number;
      readonly sleep?: (
        milliseconds: number,
        signal?: AbortSignal,
      ) => Promise<void>;
    },
  ) {}

  async publishCaller(input: ToolObligationInput): Promise<string> {
    return this.publish(input, "caller");
  }

  async publishPlatform(input: ToolObligationInput): Promise<string> {
    return this.publish(input, "platform");
  }

  private async publish(
    input: ToolObligationInput,
    owner: "caller" | "platform",
  ): Promise<string> {
    assertPublicPayload(input.safeArguments);
    const requestKey = `tool:${input.runId}:${input.flueToolCallId}`;
    const toolCallId = stableUuid(requestKey);
    const approvalId = stableUuid(`approval:${requestKey}`);
    const hash = requestHash(input);
    await withTenantTransaction(this.pool, input, async (transaction) => {
      await transaction.query(
        "SELECT oao.publish_runtime_tool_call($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          input.organizationId,
          input.projectId,
          toolCallId,
          input.runId,
          input.flueToolCallId,
          requestKey,
          hash,
          input.toolName,
          owner,
          input.safeArguments,
        ],
      );
      await appendEventOnce(transaction, {
        ...input,
        eventId: stableUuid(`event:${requestKey}:requested`),
        aggregateType: "run",
        aggregateId: input.runId,
        kind: "tool_call.requested",
        payload: { toolCallId, toolName: input.toolName, owner },
      });
      if (input.approval === "always") {
        await transaction.query(
          `INSERT INTO oao.approvals (
            organization_id,project_id,id,run_id,tool_call_id,summary,expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+($7 || ' milliseconds')::interval)
          ON CONFLICT (organization_id,project_id,id) DO NOTHING`,
          [
            input.organizationId,
            input.projectId,
            approvalId,
            input.runId,
            toolCallId,
            `Approve ${input.toolName}`,
            this.options.approvalTtlMilliseconds ?? 3_600_000,
          ],
        );
        await appendEventOnce(transaction, {
          ...input,
          eventId: stableUuid(`event:${requestKey}:approval`),
          aggregateType: "run",
          aggregateId: input.runId,
          kind: "approval.requested",
          payload: { approvalId, toolCallId, toolName: input.toolName },
        });
      }
      await transitionRun(
        transaction,
        input,
        input.approval === "always"
          ? "waiting_for_approval"
          : "waiting_for_tool",
        input.approval === "always" ? "approval_required" : "tool_pending",
      );
    });
    return toolCallId;
  }

  async waitForCaller(
    input: ToolObligationInput,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    const toolCallId = await this.publishCaller(input);
    return this.waitForResult(input, toolCallId, signal);
  }

  async executePlatform(
    input: ToolObligationInput,
    execute: () => Promise<PublicValue>,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    try {
      return await this.executePlatformSafely(input, execute, signal);
    } catch {
      return signal?.aborted
        ? failure("run_cancelled", "Run was cancelled")
        : failure("platform_tool_failed", "Platform tool execution failed");
    }
  }

  private async executePlatformSafely(
    input: ToolObligationInput,
    execute: () => Promise<PublicValue>,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    const toolCallId = await this.publishPlatform(input);
    const terminal = await this.read(input, toolCallId);
    const gate = this.stageFailure(terminal);
    if (gate) {
      await this.resumeRun(input, terminal);
      return gate;
    }
    if (
      terminal.stage === "result_submitted" ||
      terminal.stage === "result_committed"
    )
      return this.waitForResult(input, toolCallId, signal);
    if (
      input.approval === "always" &&
      terminal.approval_status !== "approved"
    ) {
      return this.waitUntilApprovedThenExecute(
        input,
        toolCallId,
        execute,
        signal,
      );
    }
    await this.resumeRun(input, terminal);
    return this.claimExecuteCommit(input, toolCallId, execute);
  }

  private async waitUntilApprovedThenExecute(
    input: ToolObligationInput,
    toolCallId: string,
    execute: () => Promise<PublicValue>,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    for (;;) {
      const row = await this.read(input, toolCallId);
      const failed = this.stageFailure(row);
      if (failed) {
        await this.resumeRun(input, row);
        return failed;
      }
      if (row.approval_status === "approved") {
        await this.resumeRun(input, row);
        return this.claimExecuteCommit(input, toolCallId, execute);
      }
      await this.pause(signal);
    }
  }

  private async claimExecuteCommit(
    input: ToolObligationInput,
    toolCallId: string,
    execute: () => Promise<PublicValue>,
  ): Promise<ToolOutcome> {
    const fence = await withTenantTransaction(
      this.pool,
      input,
      async (transaction) => {
        await this.ensureServicePrincipal(transaction, input);
        const fenceResult = await transaction.query(
          "SELECT oao.begin_platform_tool_execution($1,$2,$3,$4,interval '30 seconds') AS fence",
          [
            input.organizationId,
            input.projectId,
            toolCallId,
            this.options.servicePrincipalId,
          ],
        );
        return (fenceResult.rows[0] as { fence: string }).fence;
      },
    );
    let safeResult: Readonly<Record<string, PublicValue>>;
    try {
      const value = await execute();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("Platform tool output must be an object");
      safeResult = { version: 1, status: "success", value };
      assertPublicPayload(safeResult);
    } catch {
      safeResult = {
        version: 1,
        status: "failure",
        error: {
          code: "platform_tool_failed",
          message: "Platform tool execution failed",
        },
      };
    }
    const idempotencyKey = `platform-result:${input.runId}:${input.flueToolCallId}`;
    const hash = createHash("sha256")
      .update(JSON.stringify(safeResult))
      .digest();
    await withTenantTransaction(this.pool, input, async (transaction) => {
      await transaction.query(
        "SELECT oao.submit_tool_result($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          input.organizationId,
          input.projectId,
          toolCallId,
          this.options.servicePrincipalId,
          fence,
          idempotencyKey,
          hash,
          safeResult,
        ],
      );
      await transaction.query("SELECT oao.commit_tool_result($1,$2,$3,$4,$5)", [
        input.organizationId,
        input.projectId,
        toolCallId,
        fence,
        idempotencyKey,
      ]);
      await appendEventOnce(transaction, {
        ...input,
        eventId: stableUuid(
          `event:tool:${input.runId}:${input.flueToolCallId}:result`,
        ),
        aggregateType: "run",
        aggregateId: input.runId,
        kind: "tool_call.result_committed",
        payload: { toolCallId, owner: "platform" },
      });
    });
    await this.resumeRun(input, await this.read(input, toolCallId));
    return decodeResult(safeResult);
  }

  private async ensureServicePrincipal(
    transaction: Queryable,
    input: TenantContext,
  ): Promise<void> {
    const subject = `oao-runtime-worker:${this.options.servicePrincipalId}`;
    await transaction.query(
      `INSERT INTO oao.principals (
         organization_id,project_id,id,kind,subject,scopes
       ) VALUES ($1,$2,$3,'service',$4,ARRAY[]::text[])
       ON CONFLICT (organization_id,project_id,id) DO NOTHING`,
      [
        input.organizationId,
        input.projectId,
        this.options.servicePrincipalId,
        subject,
      ],
    );
    const principal = await transaction.query(
      `SELECT kind::text,subject FROM oao.principals
       WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
      [input.organizationId, input.projectId, this.options.servicePrincipalId],
    );
    const row = principal.rows[0] as
      { readonly kind: string; readonly subject: string } | undefined;
    if (row?.kind !== "service" || row.subject !== subject)
      throw new Error("Runtime service principal identity conflict");
  }

  private async waitForResult(
    input: ToolObligationInput,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    for (;;) {
      const row = await this.read(input, toolCallId);
      const failed = this.stageFailure(row);
      if (failed) {
        await this.resumeRun(input, row);
        return failed;
      }
      if (
        (row.stage === "result_submitted" ||
          row.stage === "result_committed") &&
        row.safe_result &&
        row.idempotency_key
      ) {
        if (row.stage === "result_submitted") {
          await withTenantTransaction(this.pool, input, async (transaction) => {
            await transaction.query(
              "SELECT oao.commit_tool_result($1,$2,$3,$4,$5)",
              [
                input.organizationId,
                input.projectId,
                toolCallId,
                row.claim_fence,
                row.idempotency_key,
              ],
            );
            await appendEventOnce(transaction, {
              ...input,
              eventId: stableUuid(
                `event:tool:${input.runId}:${input.flueToolCallId}:result`,
              ),
              aggregateType: "run",
              aggregateId: input.runId,
              kind: "tool_call.result_committed",
              payload: { toolCallId, owner: "caller" },
            });
          });
        }
        await this.resumeRun(input, row);
        return decodeResult(row.safe_result);
      }
      await this.pause(signal);
    }
  }

  private stageFailure(row: ToolRow): ToolOutcome | undefined {
    if (row.approval_status === "denied" || row.stage === "approval_denied")
      return failure("approval_denied", "Approval was denied");
    if (row.approval_status === "expired" || row.stage === "approval_expired")
      return failure("approval_expired", "Approval expired");
    if (row.stage === "cancelled")
      return failure("run_cancelled", "Run was cancelled");
    if (row.stage === "expired")
      return failure("tool_expired", "Tool request expired");
    if (row.stage === "failed")
      return failure("tool_failed", "Tool execution failed");
    return undefined;
  }

  private async resumeRun(
    input: ToolObligationInput,
    row: ToolRow,
  ): Promise<void> {
    await withTenantTransaction(this.pool, input, async (transaction) => {
      if (row.approval_status && row.approval_status !== "pending") {
        await appendEventOnce(transaction, {
          ...input,
          eventId: stableUuid(
            `event:tool:${input.runId}:${input.flueToolCallId}:approval:${row.approval_status}`,
          ),
          aggregateType: "run",
          aggregateId: input.runId,
          kind: "approval.resolved",
          payload: { status: row.approval_status, toolName: input.toolName },
        });
      }
      await transitionRun(
        transaction,
        input,
        "running",
        this.stageFailure(row) ? "tool_gate_failed" : "tool_gate_resolved",
      );
    });
  }

  private async read(
    input: TenantContext,
    toolCallId: string,
  ): Promise<ToolRow> {
    return withTenantTransaction(this.pool, input, async (transaction) => {
      await transaction.query("SELECT oao.expire_approvals(clock_timestamp())");
      const result = await transaction.query(
        `SELECT c.id,c.stage,c.claim_fence,r.safe_result,r.idempotency_key,a.status AS approval_status
         FROM oao.tool_calls c
         LEFT JOIN oao.tool_call_results r
           ON r.organization_id=c.organization_id AND r.project_id=c.project_id AND r.tool_call_id=c.id
         LEFT JOIN oao.approvals a
           ON a.organization_id=c.organization_id AND a.project_id=c.project_id AND a.tool_call_id=c.id
         WHERE c.organization_id=$1 AND c.project_id=$2 AND c.id=$3`,
        [input.organizationId, input.projectId, toolCallId],
      );
      if (!result.rowCount) throw new Error("Tool obligation not found");
      return result.rows[0] as ToolRow;
    });
  }

  private async pause(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (this.options.sleep) {
      await this.options.sleep(this.options.pollMilliseconds ?? 250, signal);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, this.options.pollMilliseconds ?? 250);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export const toolBrokerTesting = { stableUuid, decodeResult };
