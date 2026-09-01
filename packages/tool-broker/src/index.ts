import { createHash } from "node:crypto";
import {
  RETRYABLE_TOOL_FAILURE_CODES,
  TOOL_RETRY_POLICY,
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
  | "invalid_tool_result"
  | "tool_retry_exhausted";

export type ToolOutcome = ToolResultEnvelope;

export interface ToolResultValueValidation {
  readonly valid: boolean;
  readonly message?: string;
}

export type ToolResultValueValidator = (
  value: Readonly<Record<string, unknown>>,
) => ToolResultValueValidation;

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

/**
 * PostgreSQL raises class 55000 for every fencing conflict (stale execution
 * fence, non-executable call, commit fence mismatch): another claim epoch owns
 * the tool call, so the losing executor must stand down without submitting.
 */
function isFenceSupersession(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "55000" ||
    (typeof candidate.message === "string" &&
      candidate.message.includes("stale tool execution fence"))
  );
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
    "tool_retry_exhausted",
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
    tool_retry_exhausted: "Automatic tool retry limit reached",
  };
  return failure(code, messages[code]);
}

const retryableFailureCodes = new Set<ToolFailureCode>(
  RETRYABLE_TOOL_FAILURE_CODES,
);

interface ToolRetryState {
  readonly consecutiveFailures: number;
  readonly blockedBy?: ToolFailureCode;
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
      /** Platform execution lease duration; renewed while execute runs. */
      readonly platformLeaseMilliseconds?: number;
      /** Heartbeat cadence for lease renewal; defaults to a third of the lease. */
      readonly platformLeaseRenewMilliseconds?: number;
      readonly sleep?: (
        milliseconds: number,
        signal?: AbortSignal,
      ) => Promise<void>;
      /** Receives the redacted-away cause whenever a platform tool fails. */
      readonly onPlatformToolError?: (
        error: unknown,
        context: {
          readonly toolName: string;
          readonly runId: string;
          readonly toolCallId?: string;
        },
      ) => void;
    },
  ) {}

  async publishCaller(input: ToolObligationInput): Promise<string> {
    return this.publish(input, "caller");
  }

  async retryAdmission(
    input: ToolObligationInput,
  ): Promise<ToolOutcome | undefined> {
    return this.retryAdmissionFailure(input);
  }

  async publishPlatform(input: ToolObligationInput): Promise<string> {
    return this.publish(input, "platform");
  }

  private async publish(
    input: ToolObligationInput,
    owner: "caller" | "platform",
  ): Promise<string> {
    assertPublicPayload(input.safeArguments);
    const retryState = await this.retryState(input);
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
        payload: {
          toolCallId,
          toolName: input.toolName,
          owner,
          attempt: retryState.consecutiveFailures + 1,
          maximumAttempts: TOOL_RETRY_POLICY.maximumAttempts,
        },
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
    validateResult?: ToolResultValueValidator,
  ): Promise<ToolOutcome> {
    const blocked = await this.retryAdmissionFailure(input);
    if (blocked) return blocked;
    const toolCallId = await this.publishCaller(input);
    const outcome = await this.waitForResult(
      input,
      toolCallId,
      signal,
      validateResult,
    );
    return this.withRetryGuidance(input, outcome);
  }

  async executePlatform(
    input: ToolObligationInput,
    execute: (signal?: AbortSignal) => Promise<PublicValue>,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    try {
      const blocked = await this.retryAdmissionFailure(input);
      if (blocked) return blocked;
      return await this.withRetryGuidance(
        input,
        await this.executePlatformSafely(input, execute, signal),
      );
    } catch (error) {
      this.options.onPlatformToolError?.(error, {
        toolName: input.toolName,
        runId: input.runId,
      });
      const outcome = signal?.aborted
        ? failure("run_cancelled", "Run was cancelled")
        : failure("platform_tool_failed", "Platform tool execution failed");
      return this.withRetryGuidance(input, outcome);
    }
  }

  private async executePlatformSafely(
    input: ToolObligationInput,
    execute: (signal?: AbortSignal) => Promise<PublicValue>,
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
    return this.claimExecuteCommit(input, toolCallId, execute, signal);
  }

  private async waitUntilApprovedThenExecute(
    input: ToolObligationInput,
    toolCallId: string,
    execute: (signal?: AbortSignal) => Promise<PublicValue>,
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
        return this.claimExecuteCommit(input, toolCallId, execute, signal);
      }
      await this.pause(signal);
    }
  }

  private async claimExecuteCommit(
    input: ToolObligationInput,
    toolCallId: string,
    execute: (signal?: AbortSignal) => Promise<PublicValue>,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    const leaseMilliseconds = this.options.platformLeaseMilliseconds ?? 30_000;
    const renewMilliseconds =
      this.options.platformLeaseRenewMilliseconds ??
      Math.max(1, Math.floor(leaseMilliseconds / 3));
    const { fence, principalId } = await withTenantTransaction(
      this.pool,
      input,
      async (transaction) => {
        const resolved = await this.resolveServicePrincipal(transaction, input);
        const fenceResult = await transaction.query(
          `SELECT oao.begin_platform_tool_execution($1,$2,$3,$4,($5 || ' milliseconds')::interval) AS fence`,
          [
            input.organizationId,
            input.projectId,
            toolCallId,
            resolved,
            leaseMilliseconds,
          ],
        );
        return {
          fence: (fenceResult.rows[0] as { fence: string }).fence,
          principalId: resolved,
        };
      },
    );
    // Long-running executions (delegations, remote MCP calls) outlive the
    // bounded claim, so the lease is renewed on a heartbeat while execute is
    // in flight. A fencing conflict on renewal means another claim epoch owns
    // this call; the losing executor aborts and must not submit.
    const supersession = new AbortController();
    const executeSignal = signal
      ? AbortSignal.any([signal, supersession.signal])
      : supersession.signal;
    let renewals: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewals = renewals.then(async () => {
        if (supersession.signal.aborted) return;
        try {
          await withTenantTransaction(this.pool, input, (transaction) =>
            transaction.query(
              `SELECT oao.renew_tool_call_claim($1,$2,$3,$4,$5,($6 || ' milliseconds')::interval)`,
              [
                input.organizationId,
                input.projectId,
                toolCallId,
                principalId,
                fence,
                leaseMilliseconds,
              ],
            ),
          );
        } catch (error) {
          this.options.onPlatformToolError?.(error, {
            toolName: input.toolName,
            runId: input.runId,
            toolCallId,
          });
          // A transient renewal error keeps the current lease until the next
          // heartbeat; only a fencing conflict proves the claim is lost.
          if (isFenceSupersession(error))
            supersession.abort(
              new Error("Platform tool execution lease was superseded"),
            );
        }
      });
    }, renewMilliseconds);
    let safeResult: Readonly<Record<string, PublicValue>>;
    try {
      const value = await execute(executeSignal);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("Platform tool output must be an object");
      safeResult = { version: 1, status: "success", value };
      assertPublicPayload(safeResult);
    } catch (error) {
      this.options.onPlatformToolError?.(error, {
        toolName: input.toolName,
        runId: input.runId,
        toolCallId,
      });
      safeResult = {
        version: 1,
        status: "failure",
        error: {
          code: "platform_tool_failed",
          message: "Platform tool execution failed",
        },
      };
    } finally {
      clearInterval(heartbeat);
      await renewals;
    }
    if (supersession.signal.aborted)
      return failure("run_cancelled", "Platform tool execution was superseded");
    const idempotencyKey = `platform-result:${input.runId}:${input.flueToolCallId}`;
    const hash = createHash("sha256")
      .update(JSON.stringify(safeResult))
      .digest();
    try {
      await withTenantTransaction(this.pool, input, async (transaction) => {
        await transaction.query(
          "SELECT oao.submit_tool_result($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            input.organizationId,
            input.projectId,
            toolCallId,
            principalId,
            fence,
            idempotencyKey,
            hash,
            safeResult,
          ],
        );
        await transaction.query(
          "SELECT oao.commit_tool_result($1,$2,$3,$4,$5)",
          [
            input.organizationId,
            input.projectId,
            toolCallId,
            fence,
            idempotencyKey,
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
          payload: { toolCallId, owner: "platform" },
        });
      });
    } catch (error) {
      // A fenced-out submit means another epoch took the call over after the
      // last successful renewal; stand down instead of reporting a failure
      // envelope the surviving executor would have to compete with.
      if (isFenceSupersession(error)) {
        this.options.onPlatformToolError?.(error, {
          toolName: input.toolName,
          runId: input.runId,
          toolCallId,
        });
        return failure(
          "run_cancelled",
          "Platform tool execution was superseded",
        );
      }
      throw error;
    }
    await this.resumeRun(input, await this.read(input, toolCallId));
    return decodeResult(safeResult);
  }

  /**
   * Resolves the worker's service principal inside the acting project.
   * Principals carry a UNIQUE (organization_id, id) key, so the configured
   * principal id can exist in only one project per organization; every other
   * project materialises a deterministic per-project principal that shares
   * the worker's subject.
   */
  private async resolveServicePrincipal(
    transaction: Queryable,
    input: TenantContext,
  ): Promise<string> {
    const subject = `oao-runtime-worker:${this.options.servicePrincipalId}`;
    await transaction.query(
      `INSERT INTO oao.principals (
         organization_id,project_id,id,kind,subject,scopes
       ) VALUES ($1,$2,$3,'service',$4,ARRAY[]::text[])
       ON CONFLICT (organization_id,project_id,kind,subject) DO NOTHING`,
      [
        input.organizationId,
        input.projectId,
        this.projectServicePrincipalId(input),
        subject,
      ],
    );
    const principal = await transaction.query(
      `SELECT id,kind::text,subject FROM oao.principals
       WHERE organization_id=$1 AND project_id=$2
         AND kind='service' AND subject=$3`,
      [input.organizationId, input.projectId, subject],
    );
    const row = principal.rows[0] as
      | { readonly id: string; readonly kind: string; readonly subject: string }
      | undefined;
    if (!row || row.kind !== "service" || row.subject !== subject)
      throw new Error("Runtime service principal identity conflict");
    return row.id;
  }

  private projectServicePrincipalId(input: TenantContext): string {
    const bytes = createHash("sha256")
      .update(
        `oao-runtime-worker:${this.options.servicePrincipalId}:${input.organizationId}:${input.projectId}`,
      )
      .digest()
      .subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private async waitForResult(
    input: ToolObligationInput,
    toolCallId: string,
    signal?: AbortSignal,
    validateResult?: ToolResultValueValidator,
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
        const outcome = decodeResult(row.safe_result);
        if (outcome.status === "success" && validateResult) {
          const validation = validateResult(outcome.value);
          if (!validation.valid) {
            await this.resumeRun(input, row);
            return failure(
              "invalid_tool_result",
              validation.message ?? "Tool returned an invalid result",
            );
          }
        }
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
        return outcome;
      }
      await this.pause(signal);
    }
  }

  private async retryState(
    input: ToolObligationInput,
  ): Promise<ToolRetryState> {
    return withTenantTransaction(this.pool, input, async (transaction) => {
      const result = await transaction.query<{
        flue_tool_call_ref: string;
        stage: ToolRow["stage"];
        safe_result: Readonly<Record<string, PublicValue>> | null;
        committed_at: Date | null;
        approval_status: ToolRow["approval_status"];
      }>(
        `SELECT call.flue_tool_call_ref,call.stage,result.safe_result,result.committed_at,
                approval.status AS approval_status
         FROM oao.tool_calls call
         LEFT JOIN oao.tool_call_results result
           ON result.organization_id=call.organization_id
          AND result.project_id=call.project_id AND result.tool_call_id=call.id
         LEFT JOIN oao.approvals approval
           ON approval.organization_id=call.organization_id
          AND approval.project_id=call.project_id AND approval.tool_call_id=call.id
         WHERE call.organization_id=$1 AND call.project_id=$2
           AND call.run_id=$3 AND call.tool_name=$4
         ORDER BY call.created_at DESC,call.id DESC
         LIMIT $5`,
        [
          input.organizationId,
          input.projectId,
          input.runId,
          input.toolName,
          TOOL_RETRY_POLICY.maximumAttempts,
        ],
      );
      let consecutiveFailures = 0;
      for (const row of result.rows) {
        if (
          row.flue_tool_call_ref === input.flueToolCallId &&
          !row.safe_result &&
          [
            "caller_pending",
            "caller_claimed",
            "platform_ready",
            "platform_executing",
          ].includes(row.stage)
        )
          continue;
        if (row.approval_status === "denied")
          return { consecutiveFailures, blockedBy: "approval_denied" };
        if (row.approval_status === "expired")
          return { consecutiveFailures, blockedBy: "approval_expired" };
        if (row.stage === "cancelled")
          return { consecutiveFailures, blockedBy: "run_cancelled" };
        if (row.safe_result) {
          const outcome = decodeResult(row.safe_result);
          if (outcome.status === "success" && row.committed_at) break;
          const code =
            outcome.status === "failure"
              ? (outcome.error.code as ToolFailureCode)
              : "invalid_tool_result";
          if (!retryableFailureCodes.has(code))
            return { consecutiveFailures, blockedBy: code };
          consecutiveFailures += 1;
          continue;
        }
        if (row.stage === "expired" || row.stage === "failed") {
          consecutiveFailures += 1;
          continue;
        }
        break;
      }
      return { consecutiveFailures };
    });
  }

  private async retryAdmissionFailure(
    input: ToolObligationInput,
  ): Promise<ToolOutcome | undefined> {
    const state = await this.retryState(input);
    if (state.blockedBy)
      return failure(
        "tool_retry_exhausted",
        `Previous ${state.blockedBy} failure is not retryable`,
      );
    if (state.consecutiveFailures >= TOOL_RETRY_POLICY.maximumAttempts)
      return failure(
        "tool_retry_exhausted",
        `Automatic retry limit reached after ${TOOL_RETRY_POLICY.maximumAttempts} attempts`,
      );
    return undefined;
  }

  private async withRetryGuidance(
    input: ToolObligationInput,
    outcome: ToolOutcome,
  ): Promise<ToolOutcome> {
    if (
      outcome.status === "success" ||
      !retryableFailureCodes.has(outcome.error.code as ToolFailureCode)
    )
      return outcome;
    const state = await this.retryState(input);
    const retriesRemaining = Math.max(
      0,
      TOOL_RETRY_POLICY.maximumAttempts - state.consecutiveFailures,
    );
    if (retriesRemaining === 0)
      return failure(
        "tool_retry_exhausted",
        `Automatic retry limit reached after ${TOOL_RETRY_POLICY.maximumAttempts} attempts`,
      );
    return failure(
      outcome.error.code as ToolFailureCode,
      `${outcome.error.message}. Retry the tool automatically; ${retriesRemaining} ${
        retriesRemaining === 1 ? "retry remains" : "retries remain"
      }`,
    );
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
