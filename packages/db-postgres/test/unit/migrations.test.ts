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

test("Cloud SQL recovery role is non-login with bounded RLS-protected access", async () => {
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
        /CREATE POLICY recovery_visibility ON oao\.(?:thread_admission_heads|runtime_dispatches|runtime_wake_jobs)/gu,
      ) ?? []
    ).length,
    3,
  );
  assert.match(
    sql,
    /GRANT SELECT, UPDATE ON oao\.runtime_wake_jobs TO oao_recovery/u,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION oao\.jsonb_has_forbidden_public_key\(jsonb\) TO oao_recovery/u,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION oao\.is_sensitive_public_key\(text\) TO oao_recovery/u,
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
    /CREATE FUNCTION oao\.find_runtime_dispatch\([\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, oao/u,
  );
  assert.match(
    sql,
    /ALTER FUNCTION oao\.find_runtime_dispatch\(text,text\) OWNER TO oao_recovery/u,
  );
  assert.match(
    sql,
    /ALTER FUNCTION oao\.claim_runtime_wakes\(text,integer,interval\) OWNER TO oao_recovery/u,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION oao\.retry_runtime_wake\(uuid,uuid,uuid,text,bigint,interval,jsonb,boolean\) FROM PUBLIC, oao_app/u,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION oao\.find_runtime_dispatch\(text,text\) FROM PUBLIC, oao_app/u,
  );
  assert.match(
    sql,
    /ORDER BY CASE WHEN d\.state <> 'settled' THEN 0 ELSE 1 END,d\.created_at DESC/u,
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
    /GRANT EXECUTE ON FUNCTION oao\.find_runtime_dispatch\(text,text\) TO %I/u,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION oao\.complete_runtime_wake\(uuid,uuid,uuid,text,bigint\) TO %I/u,
  );
  assert.match(
    sql,
    /migration\/runtime login lacks recovery function execution/u,
  );
});

test("Cloud SQL auth role is non-login and owns only pre-authentication boundaries", async () => {
  const sql = await readFile(
    new URL("../../migrations/0039_cloud_sql_auth_role.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    sql,
    /CREATE ROLE oao_auth NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT/u,
  );
  assert.match(
    sql,
    /rolcanlogin[\s\S]*rolsuper[\s\S]*rolcreatedb[\s\S]*rolcreaterole[\s\S]*rolinherit[\s\S]*rolreplication[\s\S]*rolbypassrls/u,
  );
  assert.doesNotMatch(sql, /ALTER ROLE oao_auth/u);
  assert.match(
    sql,
    /CREATE POLICY cloud_sql_auth_access ON oao\.organizations/u,
  );
  assert.match(
    sql,
    /ALTER FUNCTION oao\.bootstrap_project\(uuid,text,text,uuid,text,text,uuid,text,text\)[\s\S]*OWNER TO oao_auth/u,
  );
  assert.match(
    sql,
    /ALTER FUNCTION oao\.resolve_workos_principal\(text,text,uuid\)[\s\S]*OWNER TO oao_auth/u,
  );
  assert.match(
    sql,
    /ALTER FUNCTION oao\.authenticate_api_key\(text,bytea,uuid,timestamptz\)[\s\S]*OWNER TO oao_auth/u,
  );
  assert.match(sql, /GRANT oao_auth TO %I WITH SET TRUE, INHERIT TRUE/u);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION oao\.jsonb_has_forbidden_public_key\(jsonb\) TO oao_auth/u,
  );
});

test("IAP migration resolves only explicitly provisioned identities", async () => {
  const sql = await readFile(
    new URL("../../migrations/0040_iap_auth.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /provider IN \('development', 'iap', 'workos'\)/u);
  assert.match(
    sql,
    /CREATE FUNCTION oao\.resolve_iap_principal\([\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, oao/u,
  );
  assert.match(sql, /tenant\.provider_tenant_id = p_expected_audience/u);
  assert.match(sql, /identity\.provider_subject = p_provider_subject/u);
  assert.match(
    sql,
    /identity\.provider_subject = 'pending-email:' \|\| p_email/u,
  );
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(/u);
  assert.match(
    sql,
    /GRANT CREATE ON SCHEMA oao TO oao_auth;[\s\S]*ALTER FUNCTION oao\.resolve_iap_principal\(text,text,text,uuid,uuid\)[\s\S]*OWNER TO oao_auth;[\s\S]*REVOKE CREATE ON SCHEMA oao FROM oao_auth;/u,
  );
  assert.doesNotMatch(sql, /INSERT INTO oao\.(?:principals|project_members)/u);
  assert.doesNotMatch(sql, /bootstrap_owner|p_bootstrap/u);
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

  const bedrockSql = await readFile(
    new URL(
      "../../migrations/0053_bedrock_model_provider.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    bedrockSql,
    /provider_type IN \('openrouter', 'openai', 'anthropic', 'xai', 'bedrock'\)/u,
  );
  assert.match(bedrockSql, /bedrock\//u);
  assert.doesNotMatch(bedrockSql, /UPDATE |DELETE FROM/u);

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

test("event webhooks keep cross-tenant claims to scheduling columns", async () => {
  const sql = await readFile(
    new URL("../../migrations/0052_event_webhooks.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.event_webhooks/u);
  assert.match(sql, /PRIMARY KEY \(organization_id, project_id, id\)/u);
  assert.match(
    sql,
    /REFERENCES oao\.projects\(organization_id, id\) ON DELETE CASCADE/u,
  );
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON oao\.event_webhooks TO oao_app/u,
  );
  // The recovery role must never read endpoint URLs, filters, or key material.
  const recoveryGrants = [
    ...sql.matchAll(
      /GRANT (SELECT|UPDATE) \(([^)]*)\)\s+ON oao\.event_webhooks TO oao_recovery/gu,
    ),
  ]
    .map((match) => match[2] ?? "")
    .join(",");
  assert.ok(recoveryGrants.includes("lease_fence"));
  assert.doesNotMatch(
    recoveryGrants,
    /endpoint_url|event_kinds|signing_key|nonce|tag|fingerprint/u,
  );
  assert.doesNotMatch(
    sql,
    /GRANT [A-Z, ]+ ON oao\.event_webhooks TO oao_recovery/u,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION oao\.claim_event_webhook_deliveries\(text,integer,interval\) FROM PUBLIC, oao_app/u,
  );
  assert.match(
    sql,
    /ALTER FUNCTION oao\.claim_event_webhook_deliveries\(text,integer,interval\) OWNER TO oao_recovery/u,
  );
  assert.match(sql, /FOR UPDATE OF w SKIP LOCKED/u);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|BYPASSRLS/u);
});

test("MCP credential destinations are additive and restore forced row security", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0054_mcp_credential_destination.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /ADD COLUMN destination_origin text/u);
  assert.match(sql, /ADD COLUMN destination_path_prefix text/u);
  assert.match(sql, /CREATE FUNCTION oao\.mcp_canonical_origin/u);
  assert.match(sql, /CREATE FUNCTION oao\.mcp_path_within/u);
  assert.match(sql, /CREATE FUNCTION oao\.mcp_policy_within_destination/u);
  // Every relaxation for the backfill is undone in the same migration.
  for (const table of [
    "mcp_credential_versions",
    "mcp_credential_policy_versions",
    "mcp_server_versions",
  ]) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE oao\\.${table} NO FORCE ROW LEVEL SECURITY`, "u"),
    );
    assert.match(
      sql,
      new RegExp(`ALTER TABLE oao\\.${table} FORCE ROW LEVEL SECURITY`, "u"),
    );
  }
  assert.match(sql, /ENABLE TRIGGER mcp_credential_versions_immutable/u);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|BYPASSRLS/u);
});

test("OAuth client-credentials MCP credentials pin their configuration on the version", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0055_mcp_oauth_client_credentials.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /'oauth_client_credentials'/u);
  for (const column of [
    "oauth_issuer",
    "oauth_token_endpoint",
    "oauth_client_id",
    "oauth_token_endpoint_auth_method",
    "oauth_scope",
    "oauth_resource",
    "oauth_resource_metadata_url",
    "oauth_send_resource",
  ])
    assert.match(sql, new RegExp(`ADD COLUMN ${column} `, "u"));
  assert.match(sql, /mcp_credential_versions_kind_fkey/u);
  assert.match(sql, /mcp_credential_versions_oauth_check/u);
  // The client secret stays in encrypted_secret; no plaintext secret column.
  assert.doesNotMatch(sql, /client_secret text|oauth_client_secret/u);
  assert.match(
    sql,
    /ALTER TABLE oao\.mcp_credentials FORCE ROW LEVEL SECURITY/u,
  );
  assert.match(
    sql,
    /ALTER TABLE oao\.mcp_credential_versions FORCE ROW LEVEL SECURITY/u,
  );
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|BYPASSRLS/u);
});

test("MCP call context is opt-in per policy version and reserves x-oao-* headers", async () => {
  const sql = await readFile(
    new URL("../../migrations/0056_mcp_call_context.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    sql,
    /ADD COLUMN forward_call_context boolean NOT NULL DEFAULT false/u,
  );
  assert.match(sql, /NOT LIKE 'x-oao-%'/u);
  assert.match(sql, /NOT VALID/u);
  assert.doesNotMatch(sql, /UPDATE |DROP TABLE|DROP COLUMN|DELETE FROM/u);
});

test("removed MCP resources free their keys and restore forced row security", async () => {
  const sql = await readFile(
    new URL("../../migrations/0057_mcp_reusable_keys.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "mcp_servers",
    "mcp_credentials",
    "mcp_credential_policies",
    "mcp_toolsets",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `ALTER TABLE oao\\.${table} ADD COLUMN revoked_at timestamptz`,
        "u",
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `CREATE UNIQUE INDEX ${table}_live_key_idx[\\s\\S]*?WHERE revoked_at IS NULL`,
        "u",
      ),
    );
    assert.match(
      sql,
      new RegExp(`ALTER TABLE oao\\.${table} FORCE ROW LEVEL SECURITY`, "u"),
    );
  }
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|BYPASSRLS/u);
});

test("a project API key authenticates only in its project and is revoked with it", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0058_api_key_project_restriction.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /ALTER TABLE oao\.api_keys ADD COLUMN project_id uuid;/u);
  // Hard-deleted projects must neither block the purge nor widen their keys.
  assert.doesNotMatch(sql, /REFERENCES oao\.projects/u);
  assert.match(sql, /AFTER DELETE ON oao\.projects/u);
  assert.match(
    sql,
    /IF key\.project_id IS NOT NULL THEN[\s\S]*?project\.id = key\.project_id/u,
  );
  // The function keeps its dedicated owner and grants.
  assert.match(
    sql,
    /SET ROLE oao_auth;[\s\S]*CREATE FUNCTION oao\.authenticate_api_key/u,
  );
  assert.match(sql, /RESET ROLE;/u);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION oao\.authenticate_api_key\(text, bytea, uuid, timestamptz\) TO oao_app;/u,
  );
});

test("run tokens act as the run's creator, narrowed, and only while the run is unsettled", async () => {
  const sql = await readFile(
    new URL("../../migrations/0059_agent_oao_tools.sql", import.meta.url),
    "utf8",
  );
  // Only a hash is stored, and tokens go with their run in a project purge.
  assert.match(sql, /token_hash bytea NOT NULL UNIQUE/u);
  assert.doesNotMatch(sql, /token text/u);
  assert.match(
    sql,
    /REFERENCES oao\.runs\(organization_id, project_id, id\) ON DELETE CASCADE/u,
  );
  assert.match(sql, /run\.settled_at IS NULL/u);
  assert.match(sql, /scope = ANY\(creator\.scopes\)/u);
  assert.match(
    sql,
    /creator\.kind <> 'human' OR member\.principal_id IS NOT NULL/u,
  );
  assert.match(sql, /api_key\.revoked_at IS NULL/u);
  // A run another agent started reads only.
  assert.match(
    sql,
    /requested_by_run_id IS NULL[\s\S]*?ARRAY\['run:create','session:write','delegation:message'\]/u,
  );
  // Agents can never be granted approvals or project administration.
  const grantable =
    /scope #>> '\{\}' NOT IN \(([\s\S]*?)\)/u.exec(sql)?.[1] ?? "";
  assert.doesNotMatch(grantable, /approval:resolve|project:admin|\*/u);
  assert.match(
    sql,
    /SET ROLE oao_auth;[\s\S]*CREATE FUNCTION oao\.authenticate_run_token/u,
  );
});

test("a run another agent started keeps only the read scopes of its grant", async () => {
  const sql = await readFile(
    new URL("../../migrations/0060_agent_run_reads_only.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE OR REPLACE FUNCTION oao\.authenticate_run_token/u);
  const reads = /OR scope IN \(([\s\S]*?)\)/u.exec(sql)?.[1] ?? "";
  for (const scope of reads.match(/'[^']+'/gu) ?? [])
    assert.match(scope, /:read'|:read_metadata'/u);
  assert.match(sql, /run\.requested_by_run_id IS NULL/u);
  assert.match(sql, /SET ROLE oao_auth;[\s\S]*RESET ROLE;/u);
});

test("followed delegates and Skills keep pinned links and freeze per session", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0061_follow_latest_versions.sql",
      import.meta.url,
    ),
    "utf8",
  );
  // A delegate names exactly one target, and the edge records which.
  assert.match(
    sql,
    /\(delegate \? 'agentVersionId'\) = \(delegate \? 'agentId'\)/u,
  );
  assert.match(
    sql,
    /num_nonnulls\(child_agent_version_id, child_agent_definition_id\) = 1/u,
  );
  // Cycles are walked through followed agents' latest versions.
  assert.match(
    sql,
    /COALESCE\(edge\.child_agent_version_id, followed\.latest_version_id\)/u,
  );
  // Followed Skills need an enabled Skill with an active latest version.
  assert.match(
    sql,
    /latest\.id=skill\.latest_version_id[\s\S]*?lifecycle\.status='active'[\s\S]*?skill\.disabled_at IS NULL[\s\S]*?skill\.archived_at IS NULL/u,
  );
  assert.match(sql, /a Skill is either pinned or followed, not both/u);
  // A followed agent must be live and published to be linked.
  assert.match(
    sql,
    /followed\.archived_at IS NOT NULL\s+OR followed\.latest_version_id IS NULL/u,
  );
  // The per-session record is append-only, tenant-scoped, and goes with
  // its session in a project purge.
  assert.match(sql, /CREATE TABLE oao\.session_version_resolutions/u);
  assert.match(
    sql,
    /REFERENCES oao\.sessions \(organization_id, project_id, id\) ON DELETE CASCADE/u,
  );
  assert.match(
    sql,
    /ALTER TABLE oao\.session_version_resolutions FORCE ROW LEVEL SECURITY/u,
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT ON oao\.session_version_resolutions TO oao_app;/u,
  );
  assert.doesNotMatch(sql, /DROP TABLE|DROP FUNCTION/u);
});

test("publishing text before tool calls is an optional boolean on agent versions", async () => {
  const sql = await readFile(
    new URL(
      "../../migrations/0062_publish_text_before_tool_calls.sql",
      import.meta.url,
    ),
    "utf8",
  );
  // The new validator wraps the previous one, which never sees the new key.
  assert.match(
    sql,
    /RENAME TO is_valid_agent_publication_config_without_text_publication/u,
  );
  assert.match(
    sql,
    /jsonb_typeof\(p_config->'publishTextBeforeToolCalls'\) IS DISTINCT FROM 'boolean'/u,
  );
  assert.match(sql, /p_config - 'publishTextBeforeToolCalls'/u);
  assert.doesNotMatch(sql, /DROP TABLE|DROP FUNCTION|UPDATE oao\./u);
});

test("model preset prices are append-only, tenant-scoped rows that leave only with their preset", async () => {
  const sql = await readFile(
    new URL("../../migrations/0063_model_preset_prices.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.model_preset_prices/u);
  assert.match(
    sql,
    /REFERENCES oao\.project_model_presets[^;]*ON DELETE CASCADE/su,
  );
  assert.match(
    sql,
    /BEFORE UPDATE ON oao\.model_preset_prices\nFOR EACH ROW EXECUTE FUNCTION oao\.reject_mutation/u,
  );
  assert.match(sql, /pg_trigger_depth\(\) <= 1/u);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
  assert.match(
    sql,
    /CREATE POLICY tenant_isolation ON oao\.model_preset_prices/u,
  );
  assert.doesNotMatch(sql, /GRANT[^;]*UPDATE[^;]*model_preset_prices/su);
});

test("a preset's limits are append-only, tenant-scoped rows that leave with their preset", async () => {
  const sql = await readFile(
    new URL("../../migrations/0066_model_preset_limits.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.model_preset_limits/u);
  assert.match(sql, /CHECK \(context_window BETWEEN 1024 AND 10000000\)/u);
  assert.match(sql, /CHECK \(max_output_tokens BETWEEN 1 AND 1000000\)/u);
  assert.match(sql, /OR max_output_tokens <= context_window/u);
  // The newest row applies, so a preset's rows never share a time.
  assert.match(
    sql,
    /UNIQUE \(organization_id, project_id, preset_id, created_at\)/u,
  );
  assert.match(
    sql,
    /REFERENCES oao\.project_model_presets[^;]*ON DELETE CASCADE/su,
  );
  assert.match(
    sql,
    /BEFORE UPDATE ON oao\.model_preset_limits\nFOR EACH ROW EXECUTE FUNCTION oao\.reject_mutation/u,
  );
  assert.match(
    sql,
    /BEFORE DELETE ON oao\.model_preset_limits\nFOR EACH ROW EXECUTE FUNCTION oao\.reject_direct_model_preset_price_delete/u,
  );
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
  assert.match(
    sql,
    /CREATE POLICY tenant_isolation ON oao\.model_preset_limits/u,
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT ON oao\.model_preset_limits TO oao_app/u,
  );
  assert.doesNotMatch(sql, /GRANT[^;]*UPDATE[^;]*model_preset_limits/su);
});

test("prompt suggestions are an optional boolean on agent versions and bounded text on completed runs", async () => {
  const sql = await readFile(
    new URL("../../migrations/0064_prompt_suggestions.sql", import.meta.url),
    "utf8",
  );
  // The new validator wraps the previous one, which never sees the new key.
  assert.match(
    sql,
    /RENAME TO is_valid_agent_publication_config_without_prompt_suggestions/u,
  );
  assert.match(
    sql,
    /jsonb_typeof\(p_config->'promptSuggestions'\) IS DISTINCT FROM 'boolean'/u,
  );
  assert.match(sql, /p_config - 'promptSuggestions'/u);
  assert.match(sql, /ALTER TABLE oao\.runs ADD COLUMN suggestion text/u);
  assert.match(sql, /char_length\(suggestion\) BETWEEN 1 AND 500/u);
  assert.match(sql, /suggestion IS NULL OR state = 'completed'/u);
  // A newer run in the same thread voids the suggestion on every read.
  assert.match(sql, /CREATE FUNCTION oao\.current_run_suggestion/u);
  assert.match(
    sql,
    /\(newer\.created_at, newer\.id\) > \(p_run\.created_at, p_run\.id\)/u,
  );
  assert.doesNotMatch(sql, /DROP TABLE|DROP FUNCTION|UPDATE oao\./u);
});

test("a session's prompt cache key is a tenant-scoped, insert-only row that leaves with its session", async () => {
  const sql = await readFile(
    new URL("../../migrations/0065_session_prompt_caches.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE oao\.session_prompt_caches/u);
  assert.match(sql, /CHECK \(cache_key ~ '\^\[!-~\]\{1,64\}\$'\)/u);
  assert.match(sql, /CHECK \(initial_prefix_chars BETWEEN 0 AND 400000\)/u);
  assert.match(
    sql,
    /REFERENCES oao\.sessions \(organization_id, project_id, id\) ON DELETE CASCADE/u,
  );
  assert.match(
    sql,
    /REFERENCES oao\.runs \(organization_id, project_id, id\) ON DELETE CASCADE/u,
  );
  assert.match(
    sql,
    /ALTER TABLE oao\.session_prompt_caches FORCE ROW LEVEL SECURITY/u,
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT ON oao\.session_prompt_caches TO oao_app;/u,
  );
  assert.doesNotMatch(sql, /DROP |UPDATE oao\.|GRANT .*(?:UPDATE|DELETE)/u);
});
