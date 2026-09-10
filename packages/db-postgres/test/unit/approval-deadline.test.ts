import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalAwareDeadline,
  DEFAULT_APPROVAL_TTL_MS,
  type ApprovalWait,
} from "../../src/approval-deadline.js";
const hour = 60 * 60 * 1000;
const date = (hours: number) => new Date(Date.UTC(2026, 0, 1) + hours * hour);
const gate = (
  start: number,
  end: number | null,
  expires = start + 24,
): ApprovalWait => ({
  createdAt: date(start),
  resolvedAt: end === null ? null : date(end),
  expiresAt: date(expires),
  status: end === null ? "pending" : "approved",
});

test("approvals default to 24 hours", () =>
  assert.equal(DEFAULT_APPROVAL_TTL_MS, 24 * hour));
test("23 hours of human waiting preserves the remaining execution budget", () => {
  const pending = approvalAwareDeadline(date(1), date(23.25), [
    gate(0.25, null),
  ]);
  assert.equal(pending.expired, false);
  assert.equal(pending.deadlineAt.getTime(), date(24).getTime());
  assert.equal(pending.checkAt.getTime(), date(24.25).getTime());
  const accepted = approvalAwareDeadline(date(1), date(23.5), [
    gate(0.25, 23.25),
  ]);
  assert.equal(accepted.deadlineAt.getTime(), date(24).getTime());
  assert.equal(accepted.checkAt.getTime(), date(24).getTime());
  assert.equal(
    approvalAwareDeadline(date(1), date(24), [gate(0.25, 23.25)]).expired,
    true,
  );
});
test("overlapping approvals count their union once across recovery", () => {
  const waits = [gate(0.25, 4), gate(1, 3), gate(3, 5)];
  assert.equal(
    approvalAwareDeadline(date(1), date(5.5), waits).deadlineAt.getTime(),
    date(5.75).getTime(),
  );
  assert.deepEqual(
    approvalAwareDeadline(date(1), date(5.5), waits),
    approvalAwareDeadline(date(1), date(5.5), [...waits].reverse()),
  );
});
test("expired approvals stop extending time even if a worker resumes late", () => {
  const expired = { ...gate(0.25, 30), status: "expired" };
  assert.equal(
    approvalAwareDeadline(date(1), date(30), [expired]).deadlineAt.getTime(),
    date(25).getTime(),
  );
  assert.equal(
    approvalAwareDeadline(date(1), date(30), [gate(0.25, null)]).expired,
    true,
  );
});
test("execution deadlines and gates opened too late remain bounded", () => {
  assert.equal(approvalAwareDeadline(date(1), date(2), []).expired, true);
  assert.equal(
    approvalAwareDeadline(date(1), date(3), [gate(2, null)]).expired,
    true,
  );
});

test("legacy gates retain their stored expiry, including no expiry", () => {
  const shortGate = gate(0.25, null, 1.25);
  assert.equal(
    approvalAwareDeadline(date(1), date(3), [shortGate]).deadlineAt.getTime(),
    date(2).getTime(),
  );
  const unbounded = { ...gate(0.25, null), expiresAt: null };
  assert.equal(
    approvalAwareDeadline(date(1), date(30), [unbounded]).expired,
    false,
  );
});
