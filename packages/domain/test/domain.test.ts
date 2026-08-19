import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicPayload,
  brandedId,
  canInstallAdmissionHead,
  evaluateRunTransition,
  isAuthorized,
  isSensitivePublicKey,
  redactForPublic,
  type OrganizationId,
  type Brand,
  type PrincipalId,
  type ProjectId,
  type RunId,
  type ThreadAdmissionHead,
  type ThreadId,
} from "../src/index.js";

const id = <T extends Brand<string, string>>(suffix: string) =>
  brandedId<T>(`00000000-0000-4000-8000-${suffix.padStart(12, "0")}`);

test("run transitions enforce terminal states and pre-admission retry", () => {
  assert.deepEqual(
    evaluateRunTransition("queued", "retry_scheduled", {
      admitted: false,
      hasAdmissionHead: false,
    }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateRunTransition("running", "retry_scheduled", {
      admitted: true,
      hasAdmissionHead: true,
    }),
    {
      allowed: false,
      reason: "illegal_transition",
    },
  );
  assert.deepEqual(
    evaluateRunTransition("completed", "running", {
      admitted: true,
      hasAdmissionHead: false,
    }),
    {
      allowed: false,
      reason: "terminal_state",
    },
  );
});

test("queued cancellation is database-only only before admission reservation", () => {
  assert.equal(
    evaluateRunTransition("queued", "cancelled", {
      admitted: false,
      hasAdmissionHead: false,
    }).allowed,
    true,
  );
  assert.deepEqual(
    evaluateRunTransition("queued", "cancelled", {
      admitted: false,
      hasAdmissionHead: true,
    }),
    {
      allowed: false,
      reason: "reserved_cancellation",
    },
  );
});

test("a thread head accepts only replay of the same run", () => {
  const head: ThreadAdmissionHead = {
    organizationId: id<OrganizationId>("1"),
    projectId: id<ProjectId>("2"),
    threadId: id<ThreadId>("3"),
    runId: id<RunId>("4"),
    state: "ambiguous",
    fence: 1n,
  };
  assert.equal(canInstallAdmissionHead(undefined, id<RunId>("5")), true);
  assert.equal(canInstallAdmissionHead(head, head.runId), true);
  assert.equal(canInstallAdmissionHead(head, id<RunId>("5")), false);
});

test("authorization correlates both tenant dimensions", () => {
  const principal = {
    id: id<PrincipalId>("1"),
    organizationId: id<OrganizationId>("2"),
    projectId: id<ProjectId>("3"),
    kind: "human" as const,
    subject: "user_1",
    scopes: new Set(["run:read"] as const),
  };
  assert.equal(isAuthorized(principal, "run:read", principal), true);
  assert.equal(
    isAuthorized(principal, "run:read", {
      ...principal,
      projectId: id<ProjectId>("4"),
    }),
    false,
  );
  assert.equal(isAuthorized(principal, "run:cancel", principal), false);
});

test("redaction is recursive and unsafe payloads are rejected", () => {
  const redacted = redactForPublic({
    ok: true,
    nested: { authorization: "Bearer x", value: "safe" },
    chainOfThought: "hidden",
  });
  assert.deepEqual(redacted, {
    ok: true,
    nested: { authorization: "[REDACTED]", value: "safe" },
    chainOfThought: "[REDACTED]",
  });
  assert.throws(
    () => assertPublicPayload({ raw_payload: "no" }),
    /Unsafe public payload key/u,
  );
});

test("sensitive-key normalization allows usage metadata and blocks credential variants", () => {
  for (const key of [
    "inputTokens",
    "output_tokens",
    "cachedInputTokens",
    "reasoningTokens",
    "tokenCount",
    "token_budget",
  ]) {
    assert.equal(isSensitivePublicKey(key), false, key);
  }
  for (const key of [
    "Authorization",
    "set-cookie",
    "db_password",
    "API_TOKEN",
    "API_KEY",
    "accessToken",
    "refresh-token",
    "session.token",
    "client_secret",
    "databaseSecretValue",
    "rawPrompt",
    "raw_payload",
    "tool-payload",
    "rawToolPayload",
    "reasoning_content",
    "chain-of-thought",
  ]) {
    assert.equal(isSensitivePublicKey(key), true, key);
  }
  const usage = { inputTokens: 12, output_tokens: 4, tokenCount: 16 };
  assert.deepEqual(redactForPublic(usage), usage);
  assert.doesNotThrow(() => assertPublicPayload(usage));
});
