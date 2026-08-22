-- Provider-neutral remote MCP servers, reviewed immutable toolsets, encrypted
-- static credentials, exact-origin credential policies, and immutable
-- agent/session bindings. PostgreSQL remains the policy authority; secret
-- values never appear in public payloads or agent snapshots.

ALTER TABLE oao.product_events DROP CONSTRAINT product_events_event_kind_check;
ALTER TABLE oao.product_events ADD CONSTRAINT product_events_event_kind_check CHECK (event_kind IN (
  'delegation.created', 'delegation.follow_up_created', 'delegation.completed',
  'delegation.failed', 'delegation.cancelled',
  'skill.draft_created', 'skill.draft_discarded',
  'skill.created', 'skill.version_published', 'skill.version_deprecated',
  'skill.version_revoked', 'skill.activated', 'skill.resource_read',
  'mcp.server_created', 'mcp.server_version_published',
  'mcp.discovery_completed', 'mcp.discovery_failed', 'mcp.toolset_published',
  'mcp.credential_created', 'mcp.credential_rotated', 'mcp.credential_revoked',
  'mcp.call_started', 'mcp.call_completed', 'mcp.call_failed', 'mcp.call_cancelled',
  'run.created', 'run.state_changed', 'run.cancellation_requested', 'message.created',
  'tool_call.requested', 'tool_call.claimed', 'tool_call.result_submitted', 'tool_call.result_committed',
  'approval.requested', 'approval.resolved', 'sandbox.created', 'sandbox.started',
  'sandbox.stopped', 'sandbox.failed', 'sandbox.command_started', 'sandbox.command_completed',
  'sandbox.command_failed', 'model.invocation_completed', 'model.invocation_failed',
  'runtime.dispatch_reserved', 'runtime.dispatch_admitted', 'runtime.dispatch_reconciled',
  'runtime.recovery_started', 'runtime.recovery_completed', 'runtime.cancellation_draining',
  'session.summary_changed'
));

CREATE TABLE oao.mcp_servers (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  server_key text NOT NULL CHECK (
    length(server_key) BETWEEN 1 AND 120
    AND server_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  ),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  latest_version_id uuid,
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, server_key),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

CREATE TABLE oao.mcp_server_versions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  server_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  endpoint_url text NOT NULL CHECK (
    length(endpoint_url) BETWEEN 8 AND 2048
    AND endpoint_url ~ '^https://'
    AND endpoint_url !~ '[#]'
  ),
  transport text NOT NULL CHECK (transport IN ('streamable_http','legacy_sse')),
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, server_id, version),
  UNIQUE (organization_id, project_id, server_id, content_hash),
  UNIQUE (organization_id, project_id, id, server_id),
  FOREIGN KEY (organization_id, project_id, server_id)
    REFERENCES oao.mcp_servers (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

ALTER TABLE oao.mcp_servers
  ADD CONSTRAINT mcp_servers_latest_version_fkey
  FOREIGN KEY (organization_id, project_id, latest_version_id, id)
  REFERENCES oao.mcp_server_versions (organization_id, project_id, id, server_id);

CREATE TABLE oao.mcp_server_version_lifecycle (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  server_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated','revoked')),
  updated_by_principal_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, server_version_id),
  FOREIGN KEY (organization_id, project_id, server_version_id)
    REFERENCES oao.mcp_server_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, updated_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

CREATE TABLE oao.mcp_server_version_tools (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  server_version_id uuid NOT NULL,
  remote_tool_name text NOT NULL CHECK (length(remote_tool_name) BETWEEN 1 AND 200),
  title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  input_schema jsonb NOT NULL CHECK (oao.is_valid_published_json_schema(input_schema)),
  output_schema jsonb CHECK (
    output_schema IS NULL OR oao.is_valid_published_json_schema(output_schema)
  ),
  schema_hash bytea NOT NULL CHECK (octet_length(schema_hash) = 32),
  discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, server_version_id, remote_tool_name),
  FOREIGN KEY (organization_id, project_id, server_version_id)
    REFERENCES oao.mcp_server_versions (organization_id, project_id, id)
);

CREATE TABLE oao.mcp_credentials (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  credential_key text NOT NULL CHECK (
    length(credential_key) BETWEEN 1 AND 120
    AND credential_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  ),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  credential_kind text NOT NULL CHECK (
    credential_kind IN ('static_bearer','api_key_header')
  ),
  header_name text CHECK (
    (credential_kind='static_bearer' AND header_name IS NULL)
    OR
    (credential_kind='api_key_header' AND header_name IS NOT NULL
      AND length(header_name) BETWEEN 1 AND 64
      AND header_name ~ '^[a-zA-Z0-9!#$%&''*+.^_`|~-]+$'
      AND lower(header_name) NOT IN (
        'connection','content-length','cookie','host','proxy-authorization',
        'set-cookie','te','trailer','transfer-encoding','upgrade'
      ))
  ),
  active_version_id uuid,
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, credential_key),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

CREATE TABLE oao.mcp_credential_versions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  credential_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  encrypted_secret bytea NOT NULL CHECK (octet_length(encrypted_secret) BETWEEN 1 AND 16384),
  encryption_nonce bytea NOT NULL CHECK (octet_length(encryption_nonce) = 12),
  encryption_tag bytea NOT NULL CHECK (octet_length(encryption_tag) = 16),
  encryption_key_version integer NOT NULL CHECK (encryption_key_version > 0),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, credential_id, version),
  UNIQUE (organization_id, project_id, id, credential_id),
  FOREIGN KEY (organization_id, project_id, credential_id)
    REFERENCES oao.mcp_credentials (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

ALTER TABLE oao.mcp_credentials
  ADD CONSTRAINT mcp_credentials_active_version_fkey
  FOREIGN KEY (organization_id, project_id, active_version_id, id)
  REFERENCES oao.mcp_credential_versions (organization_id, project_id, id, credential_id);

CREATE TABLE oao.mcp_credential_version_lifecycle (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  credential_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated','revoked')),
  updated_by_principal_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, credential_version_id),
  FOREIGN KEY (organization_id, project_id, credential_version_id)
    REFERENCES oao.mcp_credential_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, updated_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

CREATE TABLE oao.mcp_credential_policies (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  policy_key text NOT NULL CHECK (
    length(policy_key) BETWEEN 1 AND 120
    AND policy_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  ),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  latest_version_id uuid,
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, policy_key),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

CREATE TABLE oao.mcp_credential_policy_versions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  policy_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  credential_id uuid NOT NULL,
  exact_origin text NOT NULL CHECK (
    length(exact_origin) BETWEEN 8 AND 512 AND exact_origin ~ '^https://[^/?#]+/?$'
  ),
  path_prefix text NOT NULL CHECK (
    length(path_prefix) BETWEEN 1 AND 1024 AND path_prefix ~ '^/'
  ),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 120000),
  maximum_response_bytes integer NOT NULL CHECK (
    maximum_response_bytes BETWEEN 1024 AND 10485760
  ),
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, policy_id, version),
  UNIQUE (organization_id, project_id, policy_id, content_hash),
  UNIQUE (organization_id, project_id, id, policy_id),
  FOREIGN KEY (organization_id, project_id, policy_id)
    REFERENCES oao.mcp_credential_policies (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, credential_id)
    REFERENCES oao.mcp_credentials (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

ALTER TABLE oao.mcp_credential_policies
  ADD CONSTRAINT mcp_credential_policies_latest_version_fkey
  FOREIGN KEY (organization_id, project_id, latest_version_id, id)
  REFERENCES oao.mcp_credential_policy_versions (organization_id, project_id, id, policy_id);

CREATE TABLE oao.mcp_credential_policy_version_lifecycle (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated','revoked')),
  updated_by_principal_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, policy_version_id),
  FOREIGN KEY (organization_id, project_id, policy_version_id)
    REFERENCES oao.mcp_credential_policy_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, updated_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

CREATE TABLE oao.mcp_toolsets (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  toolset_key text NOT NULL CHECK (
    length(toolset_key) BETWEEN 1 AND 120
    AND toolset_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  ),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  latest_version_id uuid,
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, toolset_key),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

CREATE TABLE oao.mcp_toolset_versions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  toolset_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  server_version_id uuid NOT NULL,
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, toolset_id, version),
  UNIQUE (organization_id, project_id, toolset_id, content_hash),
  UNIQUE (organization_id, project_id, id, server_version_id),
  UNIQUE (organization_id, project_id, id, toolset_id),
  FOREIGN KEY (organization_id, project_id, toolset_id)
    REFERENCES oao.mcp_toolsets (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, server_version_id)
    REFERENCES oao.mcp_server_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

ALTER TABLE oao.mcp_toolsets
  ADD CONSTRAINT mcp_toolsets_latest_version_fkey
  FOREIGN KEY (organization_id, project_id, latest_version_id, id)
  REFERENCES oao.mcp_toolset_versions (organization_id, project_id, id, toolset_id);

CREATE TABLE oao.mcp_toolset_version_lifecycle (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  toolset_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated','revoked')),
  updated_by_principal_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, toolset_version_id),
  FOREIGN KEY (organization_id, project_id, toolset_version_id)
    REFERENCES oao.mcp_toolset_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, updated_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

CREATE TABLE oao.mcp_toolset_version_tools (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  toolset_version_id uuid NOT NULL,
  server_version_id uuid NOT NULL,
  remote_tool_name text NOT NULL,
  approval text NOT NULL CHECK (approval IN ('never','always')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, toolset_version_id, remote_tool_name),
  FOREIGN KEY (organization_id, project_id, toolset_version_id, server_version_id)
    REFERENCES oao.mcp_toolset_versions (organization_id, project_id, id, server_version_id),
  FOREIGN KEY (organization_id, project_id, server_version_id, remote_tool_name)
    REFERENCES oao.mcp_server_version_tools (
      organization_id, project_id, server_version_id, remote_tool_name
    )
);

CREATE TABLE oao.agent_version_mcp_bindings (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  toolset_version_id uuid NOT NULL,
  credential_policy_version_id uuid NOT NULL,
  namespace text NOT NULL CHECK (
    length(namespace) BETWEEN 1 AND 64
    AND namespace ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, agent_version_id, toolset_version_id),
  UNIQUE (organization_id, project_id, agent_version_id, namespace),
  FOREIGN KEY (organization_id, project_id, agent_version_id)
    REFERENCES oao.agent_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, toolset_version_id)
    REFERENCES oao.mcp_toolset_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, credential_policy_version_id)
    REFERENCES oao.mcp_credential_policy_versions (organization_id, project_id, id)
);

CREATE TABLE oao.session_mcp_bindings (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  toolset_version_id uuid NOT NULL,
  credential_policy_version_id uuid NOT NULL,
  namespace text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, session_id, toolset_version_id),
  UNIQUE (organization_id, project_id, session_id, namespace),
  FOREIGN KEY (organization_id, project_id, session_id)
    REFERENCES oao.sessions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, agent_version_id)
    REFERENCES oao.agent_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, toolset_version_id)
    REFERENCES oao.mcp_toolset_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, credential_policy_version_id)
    REFERENCES oao.mcp_credential_policy_versions (organization_id, project_id, id)
);

CREATE TABLE oao.mcp_call_attempts (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  tool_call_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  server_version_id uuid NOT NULL,
  toolset_version_id uuid NOT NULL,
  credential_policy_version_id uuid NOT NULL,
  remote_tool_name text NOT NULL CHECK (length(remote_tool_name) BETWEEN 1 AND 200),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  state text NOT NULL CHECK (state IN ('started','completed','failed','cancelled','unknown')),
  response_bytes integer CHECK (response_bytes IS NULL OR response_bytes >= 0),
  safe_error_code text CHECK (safe_error_code IS NULL OR length(safe_error_code) BETWEEN 1 AND 120),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (organization_id, project_id, tool_call_id, attempt),
  FOREIGN KEY (organization_id, project_id, run_id, tool_call_id)
    REFERENCES oao.tool_calls (organization_id, project_id, run_id, id),
  FOREIGN KEY (organization_id, project_id, server_version_id)
    REFERENCES oao.mcp_server_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, toolset_version_id)
    REFERENCES oao.mcp_toolset_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, credential_policy_version_id)
    REFERENCES oao.mcp_credential_policy_versions (organization_id, project_id, id),
  CHECK ((state='started') = (completed_at IS NULL))
);

CREATE TRIGGER mcp_server_versions_immutable BEFORE UPDATE OR DELETE ON oao.mcp_server_versions
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();
CREATE TRIGGER mcp_server_version_tools_immutable BEFORE UPDATE OR DELETE ON oao.mcp_server_version_tools
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();
CREATE TRIGGER mcp_credential_versions_immutable BEFORE UPDATE OR DELETE ON oao.mcp_credential_versions
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();
CREATE TRIGGER mcp_credential_policy_versions_immutable BEFORE UPDATE OR DELETE ON oao.mcp_credential_policy_versions
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();
CREATE TRIGGER mcp_toolset_versions_immutable BEFORE UPDATE OR DELETE ON oao.mcp_toolset_versions
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();
CREATE TRIGGER mcp_toolset_version_tools_immutable BEFORE UPDATE OR DELETE ON oao.mcp_toolset_version_tools
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();
CREATE TRIGGER agent_version_mcp_bindings_immutable BEFORE UPDATE OR DELETE ON oao.agent_version_mcp_bindings
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();
CREATE TRIGGER session_mcp_bindings_immutable BEFORE UPDATE OR DELETE ON oao.session_mcp_bindings
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

CREATE FUNCTION oao.enforce_mcp_lifecycle_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status='active' AND NEW.status IN ('deprecated','revoked'))
    OR (OLD.status='deprecated' AND NEW.status='revoked')
  ) THEN
    RAISE EXCEPTION 'invalid MCP lifecycle transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER mcp_server_version_lifecycle_transition
BEFORE UPDATE ON oao.mcp_server_version_lifecycle
FOR EACH ROW EXECUTE FUNCTION oao.enforce_mcp_lifecycle_transition();
CREATE TRIGGER mcp_credential_version_lifecycle_transition
BEFORE UPDATE ON oao.mcp_credential_version_lifecycle
FOR EACH ROW EXECUTE FUNCTION oao.enforce_mcp_lifecycle_transition();
CREATE TRIGGER mcp_credential_policy_version_lifecycle_transition
BEFORE UPDATE ON oao.mcp_credential_policy_version_lifecycle
FOR EACH ROW EXECUTE FUNCTION oao.enforce_mcp_lifecycle_transition();
CREATE TRIGGER mcp_toolset_version_lifecycle_transition
BEFORE UPDATE ON oao.mcp_toolset_version_lifecycle
FOR EACH ROW EXECUTE FUNCTION oao.enforce_mcp_lifecycle_transition();

CREATE FUNCTION oao.mcp_endpoint_matches_policy(
  p_endpoint text, p_exact_origin text, p_path_prefix text
) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(p_endpoint,'^(https://[^/]+).*$','\1')) =
         lower(regexp_replace(p_exact_origin,'/$','','g'))
     AND COALESCE(substring(p_endpoint from '^https://[^/]+(/[^?#]*)'),'/')
         LIKE p_path_prefix || '%'
$$;

CREATE FUNCTION oao.is_valid_agent_publication_config_with_mcp(p_config jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE bindings jsonb;
BEGIN
  bindings := COALESCE(p_config->'mcpBindings','[]'::jsonb);
  IF jsonb_typeof(bindings) IS DISTINCT FROM 'array'
     OR jsonb_array_length(bindings) > 16
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(bindings) binding
       WHERE jsonb_typeof(binding) IS DISTINCT FROM 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(binding)) <> 3
          OR NOT binding ?& ARRAY['toolsetVersionId','credentialPolicyVersionId','namespace']
          OR binding->>'toolsetVersionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR binding->>'credentialPolicyVersionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR binding->>'namespace' !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
          OR length(binding->>'namespace') NOT BETWEEN 1 AND 64
     )
     OR (SELECT count(*) FROM jsonb_array_elements(bindings)) <>
        (SELECT count(DISTINCT binding->>'namespace') FROM jsonb_array_elements(bindings) binding)
     OR (SELECT count(*) FROM jsonb_array_elements(bindings)) <>
        (SELECT count(DISTINCT concat(binding->>'toolsetVersionId',':',binding->>'credentialPolicyVersionId'))
           FROM jsonb_array_elements(bindings) binding) THEN
    RETURN false;
  END IF;
  RETURN oao.is_valid_agent_publication_config_with_skills(p_config - 'mcpBindings');
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION oao.publish_agent_version(
  p_organization_id uuid,
  p_project_id uuid,
  p_agent_definition_id uuid,
  p_version_id uuid,
  p_config jsonb,
  p_content_hash bytea,
  p_created_by_principal_id uuid
) RETURNS oao.agent_versions
LANGUAGE plpgsql
AS $$
DECLARE
  next_version integer;
  published oao.agent_versions;
  requested_skill_count integer;
  requested_mcp_count integer;
BEGIN
  IF NOT oao.is_valid_agent_publication_config_with_mcp(p_config) THEN
    RAISE EXCEPTION 'invalid agent publication config' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_content_hash) <> 32 THEN
    RAISE EXCEPTION 'agent content hash must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM oao.agent_definitions
  WHERE organization_id=p_organization_id AND project_id=p_project_id
    AND id=p_agent_definition_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent definition not found' USING ERRCODE='P0002'; END IF;

  SELECT jsonb_array_length(COALESCE(p_config->'skillVersionIds','[]'::jsonb))
    INTO requested_skill_count;
  IF requested_skill_count <> (
    SELECT count(DISTINCT value::uuid)
    FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
  ) THEN RAISE EXCEPTION 'agent skill versions must be unique' USING ERRCODE='22023'; END IF;
  IF requested_skill_count <> (
    SELECT count(*) FROM oao.skill_versions sv
    JOIN oao.skill_version_lifecycle lifecycle
      ON lifecycle.organization_id=sv.organization_id AND lifecycle.project_id=sv.project_id
     AND lifecycle.skill_version_id=sv.id
    WHERE sv.organization_id=p_organization_id AND sv.project_id=p_project_id
      AND sv.id IN (
        SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
      ) AND lifecycle.status='active'
  ) THEN RAISE EXCEPTION 'agent skill version is missing or unavailable' USING ERRCODE='22023'; END IF;
  IF EXISTS (
    SELECT 1 FROM oao.skill_versions sv
    WHERE sv.organization_id=p_organization_id AND sv.project_id=p_project_id
      AND sv.id IN (
        SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
      ) GROUP BY sv.skill_name HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'agent skill names must be unique' USING ERRCODE='22023'; END IF;

  SELECT jsonb_array_length(COALESCE(p_config->'mcpBindings','[]'::jsonb))
    INTO requested_mcp_count;
  IF requested_mcp_count <> (
    SELECT count(*)
    FROM jsonb_array_elements(COALESCE(p_config->'mcpBindings','[]'::jsonb)) requested
    JOIN oao.mcp_toolset_versions toolset
      ON toolset.organization_id=p_organization_id AND toolset.project_id=p_project_id
     AND toolset.id=(requested->>'toolsetVersionId')::uuid
    JOIN oao.mcp_toolset_version_lifecycle toolset_lifecycle
      ON toolset_lifecycle.organization_id=toolset.organization_id
     AND toolset_lifecycle.project_id=toolset.project_id
     AND toolset_lifecycle.toolset_version_id=toolset.id
     AND toolset_lifecycle.status='active'
    JOIN oao.mcp_server_versions server
      ON server.organization_id=toolset.organization_id AND server.project_id=toolset.project_id
     AND server.id=toolset.server_version_id
    JOIN oao.mcp_server_version_lifecycle server_lifecycle
      ON server_lifecycle.organization_id=server.organization_id
     AND server_lifecycle.project_id=server.project_id
     AND server_lifecycle.server_version_id=server.id
     AND server_lifecycle.status='active'
    JOIN oao.mcp_credential_policy_versions policy
      ON policy.organization_id=p_organization_id AND policy.project_id=p_project_id
     AND policy.id=(requested->>'credentialPolicyVersionId')::uuid
     AND oao.mcp_endpoint_matches_policy(
       server.endpoint_url,policy.exact_origin,policy.path_prefix
     )
    JOIN oao.mcp_credential_policy_version_lifecycle policy_lifecycle
      ON policy_lifecycle.organization_id=policy.organization_id
     AND policy_lifecycle.project_id=policy.project_id
     AND policy_lifecycle.policy_version_id=policy.id
     AND policy_lifecycle.status='active'
    JOIN oao.mcp_credentials credential
      ON credential.organization_id=policy.organization_id AND credential.project_id=policy.project_id
     AND credential.id=policy.credential_id AND credential.active_version_id IS NOT NULL
    JOIN oao.mcp_credential_version_lifecycle credential_lifecycle
      ON credential_lifecycle.organization_id=credential.organization_id
     AND credential_lifecycle.project_id=credential.project_id
     AND credential_lifecycle.credential_version_id=credential.active_version_id
     AND credential_lifecycle.status='active'
  ) THEN RAISE EXCEPTION 'agent MCP binding is missing, unavailable, or outside its credential policy' USING ERRCODE='22023'; END IF;

  SELECT COALESCE(max(version),0)+1 INTO next_version
  FROM oao.agent_versions
  WHERE organization_id=p_organization_id AND project_id=p_project_id
    AND agent_definition_id=p_agent_definition_id;
  INSERT INTO oao.agent_versions (
    organization_id,project_id,id,agent_definition_id,version,config,
    content_hash,created_by_principal_id
  ) VALUES (
    p_organization_id,p_project_id,p_version_id,p_agent_definition_id,next_version,
    p_config,p_content_hash,p_created_by_principal_id
  ) RETURNING * INTO published;

  INSERT INTO oao.agent_version_skill_bindings (
    organization_id,project_id,agent_version_id,skill_version_id,skill_name
  )
  SELECT p_organization_id,p_project_id,p_version_id,sv.id,sv.skill_name
  FROM oao.skill_versions sv
  WHERE sv.organization_id=p_organization_id AND sv.project_id=p_project_id
    AND sv.id IN (
      SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
    );

  INSERT INTO oao.agent_version_mcp_bindings (
    organization_id,project_id,agent_version_id,toolset_version_id,
    credential_policy_version_id,namespace
  )
  SELECT p_organization_id,p_project_id,p_version_id,
         (binding->>'toolsetVersionId')::uuid,
         (binding->>'credentialPolicyVersionId')::uuid,
         binding->>'namespace'
  FROM jsonb_array_elements(COALESCE(p_config->'mcpBindings','[]'::jsonb)) binding;

  UPDATE oao.agent_definitions SET latest_version_id=p_version_id
  WHERE organization_id=p_organization_id AND project_id=p_project_id
    AND id=p_agent_definition_id;
  RETURN published;
END
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'mcp_servers','mcp_server_versions','mcp_server_version_lifecycle',
    'mcp_server_version_tools','mcp_credentials','mcp_credential_versions',
    'mcp_credential_version_lifecycle','mcp_credential_policies',
    'mcp_credential_policy_versions','mcp_credential_policy_version_lifecycle',
    'mcp_toolsets','mcp_toolset_versions','mcp_toolset_version_lifecycle',
    'mcp_toolset_version_tools','agent_version_mcp_bindings',
    'session_mcp_bindings','mcp_call_attempts'
  ] LOOP
    EXECUTE format('ALTER TABLE oao.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE oao.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON oao.%I USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id()) WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())',
      table_name
    );
  END LOOP;
END
$$;

CREATE INDEX mcp_servers_created_idx
  ON oao.mcp_servers (organization_id,project_id,created_at DESC,id DESC);
CREATE INDEX mcp_toolsets_created_idx
  ON oao.mcp_toolsets (organization_id,project_id,created_at DESC,id DESC);
CREATE INDEX mcp_credentials_created_idx
  ON oao.mcp_credentials (organization_id,project_id,created_at DESC,id DESC);
CREATE INDEX mcp_call_attempts_run_idx
  ON oao.mcp_call_attempts (organization_id,project_id,run_id,started_at DESC);

REVOKE ALL ON FUNCTION oao.is_valid_agent_publication_config_with_mcp(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.enforce_mcp_lifecycle_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.mcp_endpoint_matches_policy(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_agent_publication_config_with_mcp(jsonb) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.mcp_endpoint_matches_policy(text,text,text) TO oao_app;

GRANT SELECT,INSERT,UPDATE ON
  oao.mcp_servers,oao.mcp_server_version_lifecycle,
  oao.mcp_credentials,oao.mcp_credential_version_lifecycle,
  oao.mcp_credential_policies,oao.mcp_credential_policy_version_lifecycle,
  oao.mcp_toolsets,oao.mcp_toolset_version_lifecycle,
  oao.mcp_call_attempts TO oao_app;
GRANT SELECT,INSERT ON
  oao.mcp_server_versions,oao.mcp_server_version_tools,
  oao.mcp_credential_versions,oao.mcp_credential_policy_versions,
  oao.mcp_toolset_versions,oao.mcp_toolset_version_tools,
  oao.agent_version_mcp_bindings,oao.session_mcp_bindings TO oao_app;
