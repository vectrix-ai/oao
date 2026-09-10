import { createHash, randomUUID } from "node:crypto";
import type { RunId } from "@oao/domain";
import type { Queryable, TenantContext } from "./index.js";

export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Lock in one order when a child gate can pause multiple ancestor deadlines. */
export async function lockApprovalDeadlines(
  tx: Queryable,
  input: TenantContext & { runId: RunId },
) {
  await tx.query(
    `WITH RECURSIVE ancestors(run_id) AS (
       SELECT $3::uuid
       UNION
       SELECT link.requested_by_run_id FROM oao.delegation_runs link
       JOIN ancestors ON ancestors.run_id=link.child_run_id
       WHERE link.organization_id=$1 AND link.project_id=$2
     )
     SELECT dispatch.run_id FROM oao.runtime_dispatches dispatch
     JOIN ancestors USING (run_id)
     WHERE dispatch.organization_id=$1 AND dispatch.project_id=$2
     ORDER BY dispatch.run_id FOR UPDATE OF dispatch`,
    [input.organizationId, input.projectId, input.runId],
  );
}

export interface ApprovalWait {
  createdAt: Date;
  resolvedAt: Date | null;
  expiresAt: Date | null;
  status: string;
}

/** Count the union of approval waits, so concurrent gates never multiply time. */
export function approvalAwareDeadline(
  base: Date,
  now: Date,
  approvals: readonly ApprovalWait[],
) {
  const intervals = approvals
    .map((approval) => {
      const expires = approval.expiresAt?.getTime() ?? Infinity;
      return {
        start: approval.createdAt.getTime(),
        end: Math.min(
          now.getTime(),
          expires,
          approval.resolvedAt?.getTime() ?? now.getTime(),
        ),
        pendingUntil:
          approval.status === "pending" && expires > now.getTime()
            ? expires
            : null,
      };
    })
    .sort((left, right) => left.start - right.start);
  let deadline = base.getTime();
  let countedUntil = -Infinity;
  let pendingUntil = Infinity;
  for (const interval of intervals) {
    // A gate opened after the execution budget was consumed cannot revive it.
    if (interval.start > deadline) break;
    const start = Math.max(interval.start, countedUntil);
    if (interval.end > start) deadline += interval.end - start;
    countedUntil = Math.max(countedUntil, interval.end);
    if (interval.pendingUntil !== null)
      pendingUntil = Math.min(pendingUntil, interval.pendingUntil);
  }
  const expired = deadline <= now.getTime();
  return {
    expired,
    deadlineAt: new Date(deadline),
    checkAt: new Date(
      !expired && Number.isFinite(pendingUntil) ? pendingUntil : deadline,
    ),
  };
}

/** Call in a tenant transaction. The immutable base deadline survives recovery. */
export async function readApprovalAwareDeadline(
  tx: Queryable,
  input: TenantContext & { runId: RunId },
) {
  const dispatch = await tx.query(
    `SELECT deadline_at FROM oao.runtime_dispatches
     WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND state <> 'settled'
     FOR UPDATE`,
    [input.organizationId, input.projectId, input.runId],
  );
  const row = dispatch.rows[0] as { deadline_at: Date } | undefined;
  if (!row) return undefined;
  const result = await tx.query(
    `WITH RECURSIVE descendants(run_id) AS (
       SELECT $3::uuid
       UNION
       SELECT link.child_run_id FROM oao.delegation_runs link
       JOIN descendants ON descendants.run_id=link.requested_by_run_id
       WHERE link.organization_id=$1 AND link.project_id=$2
     )
     SELECT approval.created_at,approval.resolved_at,approval.expires_at,approval.status
     FROM oao.approvals approval JOIN descendants USING (run_id)
     WHERE approval.organization_id=$1 AND approval.project_id=$2`,
    [input.organizationId, input.projectId, input.runId],
  );
  // Read time after acquiring the lock, which may have waited on publication.
  const clock = await tx.query("SELECT clock_timestamp() AS now");
  return approvalAwareDeadline(
    row.deadline_at,
    clock.rows[0]!.now as Date,
    result.rows.map((approval) => ({
      createdAt: approval.created_at as Date,
      resolvedAt: approval.resolved_at as Date | null,
      expiresAt: approval.expires_at as Date | null,
      status: approval.status as string,
    })),
  );
}

export async function scheduleApprovalDeadline(
  tx: Queryable,
  input: TenantContext & { runId: RunId },
  checkAt?: Date,
) {
  const at = checkAt ?? (await readApprovalAwareDeadline(tx, input))?.checkAt;
  if (!at) return;
  const key = `approval-deadline:${input.runId}:${at.toISOString()}`;
  const payload = { reason: "approval_wait_adjusted" };
  await tx.query(
    "SELECT oao.enqueue_runtime_wake($1,$2,$3,$4,$5,$6,'deadline',$7,$8)",
    [
      input.organizationId,
      input.projectId,
      randomUUID(),
      input.runId,
      key,
      createHash("sha256").update(key).digest(),
      payload,
      at,
    ],
  );
}
