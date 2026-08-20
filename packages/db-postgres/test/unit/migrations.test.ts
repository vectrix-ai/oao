import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("foundation migration encodes tenant, cursor, admission, and safety boundaries", async () => {
  const sql = await readFile(
    new URL("../../migrations/0001_foundation.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
  assert.match(sql, /PRIMARY KEY \(organization_id, project_id, thread_id\)/u);
  assert.match(sql, /committed_position = committed_position \+ 1/u);
  assert.match(sql, /jsonb_has_forbidden_public_key/u);
  assert.match(sql, /sandbox\.started/u);
  assert.doesNotMatch(sql, /CREATE (?:SEQUENCE|DATABASE)/u);
});

test("follow-up migration correlates parents and separates caller from platform tools", async () => {
  const sql = await readFile(
    new URL("../../migrations/0002_foundation_followup.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /thread_admission_heads_run_thread_fkey/u);
  assert.match(sql, /runs_session_thread_version_fkey/u);
  assert.match(sql, /messages_run_thread_fkey/u);
  assert.match(sql, /approvals_tool_call_run_fkey/u);
  assert.match(sql, /owner = 'caller'/u);
  assert.match(sql, /owner = 'platform'/u);
  assert.match(sql, /begin_platform_tool_execution/u);
  assert.match(sql, /approval_denied/u);
  assert.match(sql, /is_sensitive_public_key/u);
});

test("API/auth migration keeps secrets hashed and scopes every mutable boundary", async () => {
  const sql = await readFile(
    new URL("../../migrations/0003_api_auth.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.organization_members/u);
  assert.match(sql, /CREATE TABLE oao\.project_members/u);
  assert.match(sql, /key_hash bytea NOT NULL/u);
  assert.doesNotMatch(sql, /(?:raw_key|secret_value|plaintext_key)/u);
  assert.match(
    sql,
    /SECURITY DEFINER[\s\S]+SET search_path = pg_catalog, oao/u,
  );
  assert.match(sql, /authenticate_api_key/u);
  assert.match(sql, /claim_workos_webhook_event/u);
  assert.match(sql, /release_workos_webhook_event/u);
  assert.match(sql, /api_request_idempotency/u);
  assert.match(sql, /principal_id, http_method, route_key, idempotency_key/u);
  assert.match(sql, /renew_tool_call_claim/u);
  assert.match(sql, /release_tool_call_claim/u);
  assert.match(sql, /latest_version_id/u);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
});

test("runtime migration encodes durable wakes, dispatch reconciliation, and sandbox fences", async () => {
  const sql = await readFile(
    new URL("../../migrations/0003_runtime.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /FOR UPDATE SKIP LOCKED/u);
  assert.match(sql, /lease_fence = jobs\.lease_fence \+ 1/u);
  assert.match(sql, /UNIQUE \(organization_id, project_id, admission_key\)/u);
  assert.match(sql, /tool_calls_runtime_correlation_check/u);
  assert.match(sql, /creation_fence bigint NOT NULL/u);
  assert.match(sql, /target_preference text NOT NULL DEFAULT 'eu'/u);
  assert.match(sql, /session\.summary_changed/u);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
});
