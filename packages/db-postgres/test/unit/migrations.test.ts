import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    new URL("../../migrations/0004_runtime.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /FOR UPDATE SKIP LOCKED/u);
  assert.match(sql, /lease_fence = jobs\.lease_fence \+ 1/u);
  assert.match(sql, /UNIQUE \(organization_id, project_id, admission_key\)/u);
  assert.match(sql, /tool_calls_runtime_correlation_check/u);
  assert.match(sql, /creation_fence bigint NOT NULL/u);
  assert.match(
    sql,
    /CREATE TABLE oao\.sandbox_instances \([\s\S]*run_id uuid NOT NULL,\s+thread_id uuid NOT NULL,\s+session_id uuid NOT NULL,\s+provider text NOT NULL/u,
  );
  assert.match(
    sql,
    /runs \(organization_id, project_id, id, thread_id, session_id\)/u,
  );
  assert.match(sql, /sessions \(organization_id, project_id, id, thread_id\)/u);
  assert.match(
    sql,
    /target_preference text NOT NULL DEFAULT 'provider-default'/u,
  );
  assert.doesNotMatch(sql, /DEFAULT 'eu'/u);
  assert.match(sql, /session\.summary_changed/u);
  assert.match(
    sql,
    /runtime_has_active_dispatches\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, oao/u,
  );
  assert.match(
    sql,
    /Ownership remains with the privileged migration role, which must have BYPASSRLS/u,
  );
  assert.doesNotMatch(sql, /OWNER TO postgres/u);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION oao\.runtime_has_active_dispatches\(\) TO oao_app/u,
  );
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
});

test("Cloud SQL recovery role is non-login and limited to two RLS-protected reads", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0032_cloud_sql_recovery_role.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    sql,
    /CREATE ROLE oao_recovery NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT/u,
  );
  assert.match(
    sql,
    /rolcanlogin[\s\S]*rolsuper[\s\S]*rolcreatedb[\s\S]*rolcreaterole[\s\S]*rolinherit[\s\S]*rolreplication[\s\S]*rolbypassrls/u,
  );
  assert.doesNotMatch(sql, /ALTER ROLE oao_recovery/u);
  assert.match(
    sql,
    /GRANT oao_app TO CURRENT_USER WITH SET TRUE, INHERIT FALSE/u,
  );
  assert.match(
    sql,
    /GRANT SELECT ON oao\.thread_admission_heads, oao\.runtime_dispatches TO oao_recovery/u,
  );
  assert.equal(
    (
      sql.match(
        /CREATE POLICY recovery_visibility ON oao\.(?:thread_admission_heads|runtime_dispatches)/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.match(
    sql,
    /ALTER FUNCTION oao\.list_runtime_recovery_heads\(\) OWNER TO oao_recovery/u,
  );
  assert.match(
    sql,
    /ALTER FUNCTION oao\.runtime_has_active_dispatches\(\) OWNER TO oao_recovery/u,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION oao\.list_runtime_recovery_heads\(\) FROM PUBLIC, oao_app/u,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION oao\.runtime_has_active_dispatches\(\) TO oao_app/u,
  );
  assert.match(sql, /GRANT oao_recovery TO %I WITH SET TRUE, INHERIT TRUE/u);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION oao\.runtime_has_active_dispatches\(\) TO %I/u,
  );
  assert.match(
    sql,
    /migration\/runtime login lacks recovery function execution/u,
  );
});

test("model preset migration is additive, append-only, and tenant scoped", async () => {
  const sql = await readFile(
    new URL("../../migrations/0006_model_presets.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.project_model_presets/u);
  assert.match(sql, /PRIMARY KEY \(organization_id, project_id, id\)/u);
  assert.match(sql, /UNIQUE \(organization_id, project_id, preset_key\)/u);
  assert.match(
    sql,
    /FOREIGN KEY \(organization_id, project_id\) REFERENCES oao\.projects\(organization_id, id\)/u,
  );
  assert.match(
    sql,
    /CREATE TRIGGER project_model_presets_immutable\nBEFORE UPDATE OR DELETE ON oao\.project_model_presets/u,
  );
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
  assert.match(
    sql,
    /CREATE POLICY tenant_isolation ON oao\.project_model_presets/u,
  );
  assert.match(sql, /is_valid_model_routing_policy/u);
  assert.match(sql, /jsonb_has_forbidden_public_key/u);
  assert.match(sql, /\^openrouter\//u);
  // Provider credentials never reach the database.
  assert.doesNotMatch(sql, /api_key|apikey|secret|authorization/iu);
  // Additive only: no existing relation is altered or dropped.
  assert.doesNotMatch(sql, /DROP TABLE|ALTER TABLE oao\.agent_versions/u);
});

test("already applied migrations are untouched by the model preset change", async () => {
  const applied = await Promise.all(
    [
      "0001_foundation.sql",
      "0002_foundation_followup.sql",
      "0003_api_auth.sql",
      "0004_runtime.sql",
      "0005_mvp_integration.sql",
    ].map(async (name) =>
      (
        await readFile(
          new URL(`../../migrations/${name}`, import.meta.url),
          "utf8",
        )
      ).includes("project_model_presets"),
    ),
  );
  assert.deepEqual(applied, [false, false, false, false, false]);
});

test("provider credential migration encrypts tenant-scoped OpenRouter and OpenAI connections", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0007_project_model_providers.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.project_model_providers/u);
  assert.match(sql, /provider_type IN \('openrouter', 'openai'\)/u);
  assert.match(sql, /encrypted_api_key bytea NOT NULL/u);
  assert.match(sql, /octet_length\(encryption_nonce\) = 12/u);
  assert.match(sql, /octet_length\(encryption_tag\) = 16/u);
  assert.match(sql, /credential_fingerprint/u);
  assert.match(
    sql,
    /FOREIGN KEY \(organization_id, project_id, provider_id\)[\s\S]*REFERENCES oao\.project_model_providers\(organization_id, project_id, id\)/u,
  );
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
  assert.match(sql, /credential version must increase/u);
  assert.doesNotMatch(sql, /OPENROUTER_API_KEY|OPENAI_API_KEY/u);
});

test("OpenRouter preset migration allows saved preset model references", async () => {
  const sql = await readFile(
    new URL("../../migrations/0008_openrouter_presets.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /DROP CONSTRAINT project_model_presets_model_check/u);
  assert.match(sql, /openrouter\/\(\?:@preset\/\)\?/u);
  assert.match(sql, /openai\//u);
});

test("model generation settings migrations are additive and validate safe immutable settings", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0028_model_generation_settings.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /ADD COLUMN settings jsonb/u);
  assert.match(sql, /is_valid_model_generation_settings/u);
  assert.match(sql, /'standard', 'pro'/u);
  assert.match(sql, /'none', 'low', 'medium', 'high', 'xhigh', 'max'/u);
  assert.match(sql, /jsonb_has_forbidden_public_key/u);
  assert.doesNotMatch(sql, /UPDATE oao\.project_model_presets/u);

  const providerNeutralSql = await readFile(
    new URL(
      "../../migrations/0029_provider_neutral_model_generation_settings.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(providerNeutralSql, /CREATE OR REPLACE FUNCTION/u);
  assert.match(
    providerNeutralSql,
    /ARRAY\['effort','mode','summary','textFormat','verbosity'\]/u,
  );
  assert.doesNotMatch(
    providerNeutralSql,
    /ALTER TABLE|DROP TABLE|DELETE FROM|UPDATE /u,
  );

  const anthropicSql = await readFile(
    new URL(
      "../../migrations/0030_anthropic_model_provider.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    anthropicSql,
    /provider_type IN \('openrouter', 'openai', 'anthropic'\)/u,
  );
  assert.match(anthropicSql, /anthropic\//u);
  assert.match(anthropicSql, /ARRAY\['effort','maxTokens','thinking'\]/u);
  assert.match(anthropicSql, /'disabled', 'adaptive'/u);
  assert.match(anthropicSql, /BETWEEN 1 AND 300000/u);
  assert.doesNotMatch(anthropicSql, /UPDATE |DELETE FROM/u);

  const xaiSql = await readFile(
    new URL("../../migrations/0031_xai_model_provider.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    xaiSql,
    /provider_type IN \('openrouter', 'openai', 'anthropic', 'xai'\)/u,
  );
  assert.match(xaiSql, /xai\//u);
  assert.doesNotMatch(xaiSql, /UPDATE |DELETE FROM/u);

  const xaiSettingsSql = await readFile(
    new URL(
      "../../migrations/0033_xai_model_generation_settings.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(xaiSettingsSql, /CREATE OR REPLACE FUNCTION/u);
  assert.match(xaiSettingsSql, /ARRAY\['effort','textFormat'\]/u);
  assert.match(xaiSettingsSql, /'low', 'medium', 'high', 'xhigh'/u);
  assert.match(xaiSettingsSql, /jsonb_has_forbidden_public_key/u);
  assert.doesNotMatch(xaiSettingsSql, /UPDATE |DELETE FROM/u);
});

test("sandbox provider migration encrypts Daytona credentials and versions capabilities", async () => {
  const sql = await readFile(
    new URL("../../migrations/0009_sandbox_providers.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.project_sandbox_providers/u);
  assert.match(
    sql,
    /provider_type text NOT NULL CHECK \(provider_type = 'daytona'\)/u,
  );
  assert.match(sql, /encrypted_api_key bytea NOT NULL/u);
  assert.match(sql, /restricted_egress jsonb NOT NULL/u);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
  assert.match(sql, /project sandbox provider identity is immutable/u);
  assert.match(sql, /filesystem_read/u);
  assert.match(sql, /filesystem_write/u);
  assert.match(sql, /shell/u);
  assert.match(sql, /browser/u);
  assert.doesNotMatch(sql, /DAYTONA_API_KEY/u);
});

test("real-provider migration rejects fake sandbox publication without rewriting history", async () => {
  const sql = await readFile(
    new URL("../../migrations/0010_real_providers_only.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE FUNCTION oao\.is_valid_agent_publication_config/u);
  assert.match(sql, /provider','network','capabilities/u);
  assert.match(sql, /provider' = 'local-fake'/u);
  assert.doesNotMatch(sql, /UPDATE oao\.agent_versions|DELETE FROM/u);
});

test("publication rebind preserves hash and serialization guards", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0012_preserve_publication_guards.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /CREATE OR REPLACE FUNCTION oao\.publish_agent_version/u);
  assert.match(sql, /octet_length\(p_content_hash\) <> 32/u);
  assert.match(sql, /FOR UPDATE/u);
  assert.match(sql, /COALESCE\(max\(version\), 0\) \+ 1/u);
});

test("sandbox placement keeps requested and effective targets separate", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0013_sandbox_provider_target.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    sql,
    /ALTER TABLE oao\.sandbox_instances\s+ADD COLUMN provider_target text/u,
  );
  assert.doesNotMatch(sql, /DROP|DELETE|UPDATE/u);
});

test("agent sandbox snapshot migration preserves validation guards", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0014_agent_sandbox_snapshot.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /is_valid_legacy_agent_publication_config/u);
  assert.match(sql, /sandbox_without_snapshot/u);
  assert.match(sql, /sandbox_key_count NOT IN \(4,5\)/u);
  assert.match(sql, /snapshotId/u);
  assert.doesNotMatch(sql, /DROP|DELETE|UPDATE/u);
});

test("sandbox-enabled agent versions require an explicit snapshot", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0020_agent_sandbox_snapshot_required.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /sandbox_key_count <> 5/u);
  assert.match(sql, /snapshotId/u);
  assert.doesNotMatch(sql, /DROP|DELETE|UPDATE/u);
});

test("rich tool schemas expand schema version 1 without rewriting history", async () => {
  const sql = await readFile(
    new URL("../../migrations/0021_rich_tool_schemas.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION oao\.is_valid_published_json_schema/u,
  );
  assert.match(sql, /description/u);
  assert.match(sql, /additionalProperties/u);
  assert.match(sql, /exclusiveMinimum/u);
  assert.match(sql, /maximum_depth <= 12/u);
  assert.doesNotMatch(sql, /ALTER TABLE|DROP|DELETE|UPDATE/u);
});

test("workspace storage migration keeps backups tenant-correlated and credentials encrypted", async () => {
  const sql = await readFile(
    new URL("../../migrations/0015_workspace_storage.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.project_storage_providers/u);
  assert.match(sql, /encrypted_credential bytea NOT NULL/u);
  assert.match(sql, /CREATE TABLE oao\.thread_workspace_backups/u);
  assert.match(
    sql,
    /FOREIGN KEY \(organization_id, project_id, last_run_id, thread_id, session_id\)/u,
  );
  assert.match(sql, /project_storage_providers_one_default_idx/u);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/gmu);
  assert.doesNotMatch(sql, /DROP|DELETE/u);
});

test("skill migration keeps packages immutable and copies exact version bindings", async () => {
  const sql = await readFile(
    new URL("../../migrations/0017_skills.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.skills/u);
  assert.match(sql, /CREATE TABLE oao\.skill_versions/u);
  assert.match(sql, /CREATE TABLE oao\.skill_version_files/u);
  assert.match(sql, /CREATE TABLE oao\.agent_version_skill_bindings/u);
  assert.match(sql, /CREATE TABLE oao\.session_skill_bindings/u);
  assert.match(sql, /skill_versions_immutable/u);
  assert.match(sql, /session_skill_bindings_immutable/u);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/gmu);
  assert.match(sql, /skillVersionIds/u);
  assert.match(sql, /lifecycle\.status='active'/u);
  assert.match(sql, /enforce_skill_version_lifecycle_transition/u);
  assert.match(sql, /skill\.activated/u);
  assert.match(sql, /skill\.resource_read/u);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/u);
});

test("Skill package drafts are mutable, tenant-isolated staging resources", async () => {
  const sql = await readFile(
    new URL("../../migrations/0019_skill_package_drafts.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.skill_package_drafts/u);
  assert.match(sql, /CREATE TABLE oao\.skill_package_draft_entries/u);
  assert.match(sql, /entry_kind IN \('directory', 'file'\)/u);
  assert.match(sql, /source_skill_version_id/u);
  assert.match(sql, /published_skill_version_id/u);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/gmu);
  assert.match(sql, /ON DELETE CASCADE/u);
  assert.match(sql, /skill\.draft_created/u);
  assert.doesNotMatch(sql, /DROP TABLE/u);
});

test("multi-agent migration pins delegates and isolates child threads in one workspace", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0018_multi_agent_orchestration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.agent_version_delegates/u);
  assert.match(sql, /CREATE TABLE oao\.agent_workspaces/u);
  assert.match(sql, /CREATE TABLE oao\.thread_workspace_bindings/u);
  assert.match(sql, /CREATE TABLE oao\.agent_delegations/u);
  assert.match(sql, /CREATE TABLE oao\.delegation_runs/u);
  assert.match(sql, /child_agent_version_id uuid NOT NULL/u);
  assert.match(sql, /child_thread_id uuid NOT NULL/u);
  assert.match(sql, /workspace_id uuid NOT NULL/u);
  assert.match(sql, /request_hash bytea NOT NULL/u);
  assert.match(sql, /max_parallel integer NOT NULL/u);
  assert.match(sql, /agent_delegation_update_guard/u);
  assert.match(sql, /agent_workspace_owner_update_guard/u);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/gmu);
  assert.match(sql, /delegate_agent/u);
  assert.match(sql, /message_agent/u);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/u);
});

test("MCP migration keeps versioned resources tenant scoped and credentials encrypted", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0022_mcp_toolsets_credentials.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.mcp_server_versions/u);
  assert.match(sql, /CREATE TABLE oao\.mcp_toolset_versions/u);
  assert.match(sql, /CREATE TABLE oao\.mcp_credential_versions/u);
  assert.match(sql, /encrypted_secret bytea NOT NULL/u);
  assert.match(sql, /CREATE TABLE oao\.agent_version_mcp_bindings/u);
  assert.match(sql, /CREATE TABLE oao\.session_mcp_bindings/u);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/gmu);
  assert.match(sql, /mcp_endpoint_matches_policy/u);
  assert.match(sql, /mcp_server_versions_immutable/u);
  assert.doesNotMatch(sql, /plaintext|raw_secret|authorization_header/iu);
  assert.equal(
    createHash("sha256").update(sql).digest("hex"),
    "1c344743792fbd3aedd9c41b985f261cdc97d98c406f31402c9d9bb69abb5030",
  );
});

test("MCP runtime hardening remains additive after the immutable base migration", async () => {
  const sql = await readFile(
    new URL("../../migrations/0023_mcp_runtime_hardening.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /ADD COLUMN credential_version_id uuid/u);
  assert.match(sql, /mcp_call_attempts_credential_version_fkey/u);
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION oao\.enforce_mcp_lifecycle_transition/u,
  );
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION oao\.mcp_endpoint_matches_policy/u,
  );
  assert.match(sql, /CREATE FUNCTION oao\.mcp_tool_name/u);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/u);
});

test("cached token usage migration is additive and rejects negative counts", async () => {
  const sql = await readFile(
    new URL("../../migrations/0024_cached_token_usage.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /ALTER TABLE oao\.model_invocations/u);
  assert.match(sql, /ALTER TABLE oao\.session_summaries/u);
  assert.match(
    sql,
    /ADD COLUMN cache_read_tokens bigint NOT NULL DEFAULT 0/gmu,
  );
  assert.match(
    sql,
    /ADD COLUMN cache_write_tokens bigint NOT NULL DEFAULT 0/gmu,
  );
  assert.match(sql, /CHECK \(cache_read_tokens >= 0\)/gmu);
  assert.match(sql, /CHECK \(cache_write_tokens >= 0\)/gmu);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM/u);
});

test("Harness Operations are immutable version-scoped rows with tenant isolation", async () => {
  const sql = await readFile(
    new URL("../../migrations/0025_harness_operations.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.agent_version_harness_operations/u);
  assert.match(
    sql,
    /PRIMARY KEY \(organization_id, project_id, agent_version_id, operation_key\)/u,
  );
  assert.match(sql, /result_schema jsonb NOT NULL/u);
  assert.match(sql, /timeout_ms BETWEEN 1000 AND 300000/u);
  assert.match(sql, /agent_version_harness_operations_immutable/u);
  assert.match(sql, /capture_agent_version_harness_operations/u);
  assert.match(sql, /oao\.mcp_tool_name/u);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
  assert.match(
    sql,
    /GRANT SELECT, INSERT ON oao\.agent_version_harness_operations TO oao_app/u,
  );
  assert.doesNotMatch(sql, /skill_version_id|DROP TABLE|DELETE FROM/u);
  assert.equal(
    createHash("sha256").update(sql).digest("hex"),
    "6f96b804fc8b4e54e6733ab665272d42b1c721d6fc6c6fce9e9e9f84f1b60ef3",
    "0025 is already applied locally and must remain byte-for-byte immutable",
  );
});

test("Harness Operation events are added without rewriting their schema migration", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0026_harness_operation_events.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /harness\.operation_started/u);
  assert.match(sql, /harness\.operation_completed/u);
  assert.match(sql, /harness\.operation_failed/u);
  assert.match(sql, /harness\.operation_cancelled/u);
  assert.match(sql, /harness\.operation_timed_out/u);
  assert.doesNotMatch(
    sql,
    /agent_version_harness_operations|DROP TABLE|DELETE FROM/u,
  );
});

test("Harness inner-step events extend the immutable lifecycle vocabulary additively", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0027_harness_operation_steps.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /harness\.operation_step/u);
  assert.match(sql, /ALTER TABLE oao\.product_events/u);
  assert.doesNotMatch(
    sql,
    /agent_version_harness_operations|DROP TABLE|DELETE FROM|UPDATE /u,
  );
});
