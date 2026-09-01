-- Organization-scoped project lifecycle and org-shared connections.
--
-- Projects become visible to their whole organization, can be created from
-- the API by organization owners/admins, and can be hard deleted. API keys,
-- model provider connections, storage provider connections, and MCP servers,
-- credentials, and credential policies are re-homed from project scope to
-- organization scope: the project_id column is dropped, row-level security
-- widens to the organization, and every project in the organization shares
-- the same pool of connections. MCP toolsets, model presets, sandbox
-- providers, agents, and Skills stay project-scoped.
--
-- API keys now authenticate against any project of their organization. Each
-- key materialises a per-project "mirror" principal (kind api_key, subject
-- api-key:{keyId}) on first use so audit, idempotency, and run foreign keys
-- keep a project-local principal to reference.

--------------------------------------------------------------------------------
-- 1. Projects: organization-wide visibility and writes.
--------------------------------------------------------------------------------

DROP POLICY projects_tenant ON oao.projects;
CREATE POLICY projects_organization ON oao.projects
  USING (organization_id = oao.current_organization_id())
  WITH CHECK (organization_id = oao.current_organization_id());

--------------------------------------------------------------------------------
-- 2. Deterministic WorkOS resolution once identities span multiple projects.
--    Prefer the requested project; otherwise fall back to the identity's
--    earliest-created project instead of refusing to resolve.
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION oao.resolve_workos_principal(
  p_provider_subject text,
  p_provider_tenant_id text DEFAULT NULL,
  p_project_id uuid DEFAULT NULL
) RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  principal_id uuid,
  subject text,
  scopes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE matching_organizations integer;
BEGIN
  -- Fail closed when the subject matches identities in more than one
  -- organization and the caller gave no tenant or project to disambiguate;
  -- inside a single organization the earliest-created project is the
  -- deterministic default.
  SELECT count(DISTINCT identity.organization_id) INTO matching_organizations
  FROM oao.auth_identities AS identity
  JOIN oao.project_members AS membership
    ON membership.organization_id = identity.organization_id
   AND membership.project_id = identity.project_id
   AND membership.principal_id = identity.principal_id
  LEFT JOIN oao.auth_tenant_links AS tenant
    ON tenant.organization_id = identity.organization_id
   AND tenant.project_id = identity.project_id
   AND tenant.provider = 'workos'
  WHERE identity.provider = 'workos'
    AND identity.provider_subject = p_provider_subject
    AND (p_provider_tenant_id IS NULL OR tenant.provider_tenant_id = p_provider_tenant_id)
    AND (p_project_id IS NULL OR identity.project_id = p_project_id);
  IF matching_organizations <> 1 THEN RETURN; END IF;
  RETURN QUERY
  SELECT identity.organization_id, identity.project_id, identity.principal_id,
         principal.subject, principal.scopes
  FROM oao.auth_identities AS identity
  JOIN oao.principals AS principal
    ON principal.organization_id = identity.organization_id
   AND principal.project_id = identity.project_id
   AND principal.id = identity.principal_id
  JOIN oao.project_members AS membership
    ON membership.organization_id = identity.organization_id
   AND membership.project_id = identity.project_id
   AND membership.principal_id = identity.principal_id
  JOIN oao.projects AS project
    ON project.organization_id = identity.organization_id
   AND project.id = identity.project_id
  LEFT JOIN oao.auth_tenant_links AS tenant
    ON tenant.organization_id = identity.organization_id
   AND tenant.project_id = identity.project_id
   AND tenant.provider = 'workos'
  WHERE identity.provider = 'workos'
    AND identity.provider_subject = p_provider_subject
    AND (p_provider_tenant_id IS NULL OR tenant.provider_tenant_id = p_provider_tenant_id)
    AND (p_project_id IS NULL OR identity.project_id = p_project_id)
  ORDER BY project.created_at, project.id
  LIMIT 1;
END
$$;

--------------------------------------------------------------------------------
-- 3. API keys become organization keys.
--------------------------------------------------------------------------------

-- Dropping project_id/principal_id cascades away the old primary key, the
-- one-key-per-principal unique, both principal foreign keys, the project
-- index, and the project-pinned row-level security policy.
ALTER TABLE oao.api_keys DROP COLUMN project_id CASCADE;
ALTER TABLE oao.api_keys DROP COLUMN principal_id CASCADE;

ALTER TABLE oao.api_keys ADD PRIMARY KEY (organization_id, id);
ALTER TABLE oao.api_keys
  ADD CONSTRAINT api_keys_organization_fkey
  FOREIGN KEY (organization_id) REFERENCES oao.organizations(id);
CREATE INDEX api_keys_organization_created_idx
  ON oao.api_keys (organization_id, created_at DESC, id DESC);
CREATE POLICY org_shared ON oao.api_keys
  USING (organization_id = oao.current_organization_id())
  WITH CHECK (organization_id = oao.current_organization_id());

DROP FUNCTION oao.authenticate_api_key(text, bytea, timestamptz);
CREATE FUNCTION oao.authenticate_api_key(
  p_prefix text,
  p_keyed_hash bytea,
  p_project_id uuid DEFAULT NULL,
  p_at timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  principal_id uuid,
  subject text,
  scopes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
#variable_conflict use_column
DECLARE
  key oao.api_keys;
  target_project_id uuid;
  key_subject text;
  mirror_principal_id uuid;
  saved_organization text;
  saved_project text;
BEGIN
  IF octet_length(p_keyed_hash) <> 32 THEN
    RAISE EXCEPTION 'API key hash must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  saved_organization := current_setting('oao.organization_id', true);
  saved_project := current_setting('oao.project_id', true);

  UPDATE oao.api_keys AS candidate
  SET last_used_at = p_at
  WHERE candidate.key_prefix = p_prefix
    AND candidate.key_hash = p_keyed_hash
    AND candidate.revoked_at IS NULL
    AND (candidate.expires_at IS NULL OR candidate.expires_at > p_at)
  RETURNING * INTO key;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM set_config('oao.organization_id', key.organization_id::text, true);
  IF p_project_id IS NOT NULL THEN
    SELECT project.id INTO target_project_id FROM oao.projects project
    WHERE project.organization_id = key.organization_id AND project.id = p_project_id;
  ELSE
    SELECT project.id INTO target_project_id FROM oao.projects project
    WHERE project.organization_id = key.organization_id
    ORDER BY project.created_at, project.id LIMIT 1;
  END IF;
  IF target_project_id IS NULL THEN
    PERFORM set_config('oao.organization_id', COALESCE(saved_organization, ''), true);
    RETURN;
  END IF;

  PERFORM set_config('oao.project_id', target_project_id::text, true);
  key_subject := 'api-key:' || key.id::text;
  INSERT INTO oao.principals (organization_id, project_id, id, kind, subject, scopes)
  VALUES (key.organization_id, target_project_id, gen_random_uuid(), 'api_key', key_subject, key.scopes)
  ON CONFLICT (organization_id, project_id, kind, subject) DO NOTHING;
  SELECT principal.id INTO mirror_principal_id FROM oao.principals principal
  WHERE principal.organization_id = key.organization_id
    AND principal.project_id = target_project_id
    AND principal.subject = key_subject AND principal.kind = 'api_key';

  PERFORM set_config('oao.organization_id', COALESCE(saved_organization, ''), true);
  PERFORM set_config('oao.project_id', COALESCE(saved_project, ''), true);
  RETURN QUERY SELECT key.organization_id, target_project_id, mirror_principal_id,
    key_subject, key.scopes;
END
$$;
REVOKE ALL ON FUNCTION oao.authenticate_api_key(text, bytea, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.authenticate_api_key(text, bytea, uuid, timestamptz) TO oao_app;

--------------------------------------------------------------------------------
-- 4. Model provider connections become organization connections.
--------------------------------------------------------------------------------

ALTER TABLE oao.project_model_providers DISABLE TRIGGER project_model_providers_restrict_mutation;
UPDATE oao.project_model_providers pmp
SET provider_key = left(pmp.provider_key, 100) || '-' || left(pmp.id::text, 8)
WHERE pmp.archived_at IS NULL AND EXISTS (
  SELECT 1 FROM oao.project_model_providers other
  WHERE other.organization_id = pmp.organization_id
    AND other.provider_key = pmp.provider_key AND other.archived_at IS NULL
    AND (other.project_id, other.id) < (pmp.project_id, pmp.id)
);
ALTER TABLE oao.project_model_providers ENABLE TRIGGER project_model_providers_restrict_mutation;

ALTER TABLE oao.project_model_providers DROP COLUMN project_id CASCADE;
ALTER TABLE oao.project_model_providers ADD PRIMARY KEY (organization_id, id);
ALTER TABLE oao.project_model_providers
  ADD CONSTRAINT project_model_providers_organization_fkey
  FOREIGN KEY (organization_id) REFERENCES oao.organizations(id);
CREATE UNIQUE INDEX project_model_providers_live_key_idx
  ON oao.project_model_providers (organization_id, provider_key)
  WHERE archived_at IS NULL;
CREATE INDEX project_model_providers_created_idx
  ON oao.project_model_providers (organization_id, created_at DESC, id DESC);
CREATE POLICY org_shared ON oao.project_model_providers
  USING (organization_id = oao.current_organization_id())
  WITH CHECK (organization_id = oao.current_organization_id());

CREATE OR REPLACE FUNCTION oao.restrict_project_model_provider_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider_type IS DISTINCT FROM OLD.provider_type
     OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at) THEN
    RAISE EXCEPTION 'model provider connection identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NULL AND (
       NEW.provider_key IS DISTINCT FROM OLD.provider_key
       OR NEW.display_name IS DISTINCT FROM OLD.display_name
     ) THEN
    RAISE EXCEPTION 'model provider connection identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NULL
     AND NEW.encryption_key_version <= OLD.encryption_key_version THEN
    RAISE EXCEPTION 'provider credential version must increase' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

-- Presets stay project-scoped but bind to the shared organization connection.
ALTER TABLE oao.project_model_presets
  ADD CONSTRAINT project_model_presets_provider_fkey
  FOREIGN KEY (organization_id, provider_id)
  REFERENCES oao.project_model_providers (organization_id, id);

--------------------------------------------------------------------------------
-- 5. Storage provider connections become organization connections.
--------------------------------------------------------------------------------

ALTER TABLE oao.project_storage_providers DISABLE TRIGGER project_storage_providers_restrict_mutation;
UPDATE oao.project_storage_providers psp
SET provider_key = left(psp.provider_key, 100) || '-' || left(psp.id::text, 8)
WHERE EXISTS (
  SELECT 1 FROM oao.project_storage_providers other
  WHERE other.organization_id = psp.organization_id
    AND other.provider_key = psp.provider_key
    AND (other.project_id, other.id) < (psp.project_id, psp.id)
);
-- Keep the most recently created default per organization.
UPDATE oao.project_storage_providers psp
SET is_default = false
WHERE psp.is_default AND EXISTS (
  SELECT 1 FROM oao.project_storage_providers other
  WHERE other.organization_id = psp.organization_id AND other.is_default
    AND (other.created_at, other.id) > (psp.created_at, psp.id)
);
ALTER TABLE oao.project_storage_providers ENABLE TRIGGER project_storage_providers_restrict_mutation;

ALTER TABLE oao.project_storage_providers DROP COLUMN project_id CASCADE;
ALTER TABLE oao.project_storage_providers ADD PRIMARY KEY (organization_id, id);
ALTER TABLE oao.project_storage_providers
  ADD CONSTRAINT project_storage_providers_organization_fkey
  FOREIGN KEY (organization_id) REFERENCES oao.organizations(id);
ALTER TABLE oao.project_storage_providers
  ADD CONSTRAINT project_storage_providers_organization_id_provider_key_key
  UNIQUE (organization_id, provider_key);
CREATE UNIQUE INDEX project_storage_providers_one_default_idx
  ON oao.project_storage_providers (organization_id)
  WHERE is_default;
CREATE INDEX project_storage_providers_created_idx
  ON oao.project_storage_providers (organization_id, created_at DESC, id DESC);
ALTER TABLE oao.thread_workspace_backups
  ADD CONSTRAINT thread_workspace_backups_storage_provider_fkey
  FOREIGN KEY (organization_id, storage_provider_id)
  REFERENCES oao.project_storage_providers (organization_id, id);
CREATE POLICY org_shared ON oao.project_storage_providers
  USING (organization_id = oao.current_organization_id())
  WITH CHECK (organization_id = oao.current_organization_id());

CREATE OR REPLACE FUNCTION oao.restrict_project_storage_provider_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.id <> OLD.id
     OR NEW.provider_key <> OLD.provider_key
     OR NEW.display_name <> OLD.display_name
     OR NEW.provider_type <> OLD.provider_type
     OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
     OR NEW.region <> OLD.region
     OR NEW.bucket <> OLD.bucket
     OR NEW.object_prefix IS DISTINCT FROM OLD.object_prefix
     OR NEW.force_path_style <> OLD.force_path_style
     OR NEW.created_by_principal_id <> OLD.created_by_principal_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'storage provider configuration is immutable';
  END IF;
  IF NEW.encryption_key_version < OLD.encryption_key_version THEN
    RAISE EXCEPTION 'storage provider credential version cannot decrease';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

--------------------------------------------------------------------------------
-- 6. MCP servers, credentials, and credential policies become organization
--    connections. Toolsets and bindings stay project-scoped and re-bind to
--    the organization rows.
--------------------------------------------------------------------------------

UPDATE oao.mcp_servers s
SET server_key = left(s.server_key, 100) || '-' || left(s.id::text, 8)
WHERE EXISTS (
  SELECT 1 FROM oao.mcp_servers other
  WHERE other.organization_id = s.organization_id AND other.server_key = s.server_key
    AND (other.project_id, other.id) < (s.project_id, s.id)
);
UPDATE oao.mcp_credentials c
SET credential_key = left(c.credential_key, 100) || '-' || left(c.id::text, 8)
WHERE EXISTS (
  SELECT 1 FROM oao.mcp_credentials other
  WHERE other.organization_id = c.organization_id AND other.credential_key = c.credential_key
    AND (other.project_id, other.id) < (c.project_id, c.id)
);
UPDATE oao.mcp_credential_policies p
SET policy_key = left(p.policy_key, 100) || '-' || left(p.id::text, 8)
WHERE EXISTS (
  SELECT 1 FROM oao.mcp_credential_policies other
  WHERE other.organization_id = p.organization_id AND other.policy_key = p.policy_key
    AND (other.project_id, other.id) < (p.project_id, p.id)
);

ALTER TABLE oao.mcp_servers DROP COLUMN project_id CASCADE;
ALTER TABLE oao.mcp_server_versions DROP COLUMN project_id CASCADE;
ALTER TABLE oao.mcp_server_version_lifecycle DROP COLUMN project_id CASCADE;
ALTER TABLE oao.mcp_server_version_tools DROP COLUMN project_id CASCADE;
ALTER TABLE oao.mcp_credentials DROP COLUMN project_id CASCADE;
ALTER TABLE oao.mcp_credential_versions DROP COLUMN project_id CASCADE;
ALTER TABLE oao.mcp_credential_version_lifecycle DROP COLUMN project_id CASCADE;
ALTER TABLE oao.mcp_credential_policies DROP COLUMN project_id CASCADE;
ALTER TABLE oao.mcp_credential_policy_versions DROP COLUMN project_id CASCADE;
ALTER TABLE oao.mcp_credential_policy_version_lifecycle DROP COLUMN project_id CASCADE;

ALTER TABLE oao.mcp_servers ADD PRIMARY KEY (organization_id, id);
ALTER TABLE oao.mcp_servers
  ADD CONSTRAINT mcp_servers_organization_id_server_key_key UNIQUE (organization_id, server_key),
  ADD CONSTRAINT mcp_servers_organization_fkey
    FOREIGN KEY (organization_id) REFERENCES oao.organizations(id);

ALTER TABLE oao.mcp_server_versions ADD PRIMARY KEY (organization_id, id);
ALTER TABLE oao.mcp_server_versions
  ADD CONSTRAINT mcp_server_versions_server_version_key UNIQUE (organization_id, server_id, version),
  ADD CONSTRAINT mcp_server_versions_server_content_key UNIQUE (organization_id, server_id, content_hash),
  ADD CONSTRAINT mcp_server_versions_id_server_key UNIQUE (organization_id, id, server_id),
  ADD CONSTRAINT mcp_server_versions_server_fkey
    FOREIGN KEY (organization_id, server_id) REFERENCES oao.mcp_servers (organization_id, id);
ALTER TABLE oao.mcp_servers
  ADD CONSTRAINT mcp_servers_latest_version_fkey
  FOREIGN KEY (organization_id, latest_version_id, id)
  REFERENCES oao.mcp_server_versions (organization_id, id, server_id);

ALTER TABLE oao.mcp_server_version_lifecycle ADD PRIMARY KEY (organization_id, server_version_id);
ALTER TABLE oao.mcp_server_version_lifecycle
  ADD CONSTRAINT mcp_server_version_lifecycle_version_fkey
  FOREIGN KEY (organization_id, server_version_id)
  REFERENCES oao.mcp_server_versions (organization_id, id);

ALTER TABLE oao.mcp_server_version_tools
  ADD PRIMARY KEY (organization_id, server_version_id, remote_tool_name);
ALTER TABLE oao.mcp_server_version_tools
  ADD CONSTRAINT mcp_server_version_tools_version_fkey
  FOREIGN KEY (organization_id, server_version_id)
  REFERENCES oao.mcp_server_versions (organization_id, id);

ALTER TABLE oao.mcp_credentials ADD PRIMARY KEY (organization_id, id);
ALTER TABLE oao.mcp_credentials
  ADD CONSTRAINT mcp_credentials_organization_id_credential_key_key UNIQUE (organization_id, credential_key),
  ADD CONSTRAINT mcp_credentials_organization_fkey
    FOREIGN KEY (organization_id) REFERENCES oao.organizations(id);

ALTER TABLE oao.mcp_credential_versions ADD PRIMARY KEY (organization_id, id);
ALTER TABLE oao.mcp_credential_versions
  ADD CONSTRAINT mcp_credential_versions_credential_version_key UNIQUE (organization_id, credential_id, version),
  ADD CONSTRAINT mcp_credential_versions_id_credential_key UNIQUE (organization_id, id, credential_id),
  ADD CONSTRAINT mcp_credential_versions_credential_fkey
    FOREIGN KEY (organization_id, credential_id) REFERENCES oao.mcp_credentials (organization_id, id);
ALTER TABLE oao.mcp_credentials
  ADD CONSTRAINT mcp_credentials_active_version_fkey
  FOREIGN KEY (organization_id, active_version_id, id)
  REFERENCES oao.mcp_credential_versions (organization_id, id, credential_id);

ALTER TABLE oao.mcp_credential_version_lifecycle ADD PRIMARY KEY (organization_id, credential_version_id);
ALTER TABLE oao.mcp_credential_version_lifecycle
  ADD CONSTRAINT mcp_credential_version_lifecycle_version_fkey
  FOREIGN KEY (organization_id, credential_version_id)
  REFERENCES oao.mcp_credential_versions (organization_id, id);

ALTER TABLE oao.mcp_credential_policies ADD PRIMARY KEY (organization_id, id);
ALTER TABLE oao.mcp_credential_policies
  ADD CONSTRAINT mcp_credential_policies_organization_id_policy_key_key UNIQUE (organization_id, policy_key),
  ADD CONSTRAINT mcp_credential_policies_organization_fkey
    FOREIGN KEY (organization_id) REFERENCES oao.organizations(id);

ALTER TABLE oao.mcp_credential_policy_versions ADD PRIMARY KEY (organization_id, id);
ALTER TABLE oao.mcp_credential_policy_versions
  ADD CONSTRAINT mcp_credential_policy_versions_policy_version_key UNIQUE (organization_id, policy_id, version),
  ADD CONSTRAINT mcp_credential_policy_versions_policy_content_key UNIQUE (organization_id, policy_id, content_hash),
  ADD CONSTRAINT mcp_credential_policy_versions_id_policy_key UNIQUE (organization_id, id, policy_id),
  ADD CONSTRAINT mcp_credential_policy_versions_policy_fkey
    FOREIGN KEY (organization_id, policy_id) REFERENCES oao.mcp_credential_policies (organization_id, id),
  ADD CONSTRAINT mcp_credential_policy_versions_credential_fkey
    FOREIGN KEY (organization_id, credential_id) REFERENCES oao.mcp_credentials (organization_id, id);
ALTER TABLE oao.mcp_credential_policies
  ADD CONSTRAINT mcp_credential_policies_latest_version_fkey
  FOREIGN KEY (organization_id, latest_version_id, id)
  REFERENCES oao.mcp_credential_policy_versions (organization_id, id, policy_id);

ALTER TABLE oao.mcp_credential_policy_version_lifecycle ADD PRIMARY KEY (organization_id, policy_version_id);
ALTER TABLE oao.mcp_credential_policy_version_lifecycle
  ADD CONSTRAINT mcp_credential_policy_version_lifecycle_version_fkey
  FOREIGN KEY (organization_id, policy_version_id)
  REFERENCES oao.mcp_credential_policy_versions (organization_id, id);

-- Project-scoped consumers re-bind to the organization rows.
ALTER TABLE oao.mcp_toolset_versions
  ADD CONSTRAINT mcp_toolset_versions_server_version_fkey
  FOREIGN KEY (organization_id, server_version_id)
  REFERENCES oao.mcp_server_versions (organization_id, id);
ALTER TABLE oao.mcp_toolset_version_tools
  ADD CONSTRAINT mcp_toolset_version_tools_server_tool_fkey
  FOREIGN KEY (organization_id, server_version_id, remote_tool_name)
  REFERENCES oao.mcp_server_version_tools (organization_id, server_version_id, remote_tool_name);
ALTER TABLE oao.agent_version_mcp_bindings
  ADD CONSTRAINT agent_version_mcp_bindings_policy_version_fkey
  FOREIGN KEY (organization_id, credential_policy_version_id)
  REFERENCES oao.mcp_credential_policy_versions (organization_id, id);
ALTER TABLE oao.session_mcp_bindings
  ADD CONSTRAINT session_mcp_bindings_policy_version_fkey
  FOREIGN KEY (organization_id, credential_policy_version_id)
  REFERENCES oao.mcp_credential_policy_versions (organization_id, id);
ALTER TABLE oao.mcp_call_attempts
  ADD CONSTRAINT mcp_call_attempts_server_version_fkey
    FOREIGN KEY (organization_id, server_version_id)
    REFERENCES oao.mcp_server_versions (organization_id, id),
  ADD CONSTRAINT mcp_call_attempts_policy_version_fkey
    FOREIGN KEY (organization_id, credential_policy_version_id)
    REFERENCES oao.mcp_credential_policy_versions (organization_id, id),
  ADD CONSTRAINT mcp_call_attempts_credential_version_fkey
    FOREIGN KEY (organization_id, credential_version_id)
    REFERENCES oao.mcp_credential_versions (organization_id, id);

CREATE INDEX mcp_servers_created_idx
  ON oao.mcp_servers (organization_id, created_at DESC, id DESC);
CREATE INDEX mcp_credentials_created_idx
  ON oao.mcp_credentials (organization_id, created_at DESC, id DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'mcp_servers', 'mcp_server_versions', 'mcp_server_version_lifecycle',
    'mcp_server_version_tools', 'mcp_credentials', 'mcp_credential_versions',
    'mcp_credential_version_lifecycle', 'mcp_credential_policies',
    'mcp_credential_policy_versions', 'mcp_credential_policy_version_lifecycle'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY org_shared ON oao.%I USING (organization_id = oao.current_organization_id()) WITH CHECK (organization_id = oao.current_organization_id())',
      table_name
    );
  END LOOP;
END
$$;

--------------------------------------------------------------------------------
-- 7. Agent publication re-validated against organization-scoped MCP rows.
--------------------------------------------------------------------------------

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

  -- Lock the owning Skill rows so a concurrent disable or removal
  -- serializes with this validation instead of committing between the
  -- availability check below and the binding insert.
  PERFORM 1 FROM oao.skills skill
  WHERE skill.organization_id=p_organization_id
    AND skill.project_id=p_project_id
    AND skill.id IN (
      SELECT sv.skill_id FROM oao.skill_versions sv
      WHERE sv.organization_id=p_organization_id
        AND sv.project_id=p_project_id
        AND sv.id IN (
          SELECT value::uuid
          FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
        )
    )
  FOR UPDATE;

  SELECT jsonb_array_length(COALESCE(p_config->'skillVersionIds','[]'::jsonb))
    INTO requested_skill_count;
  IF requested_skill_count <> (
    SELECT count(DISTINCT value::uuid)
    FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
  ) THEN RAISE EXCEPTION 'agent skill versions must be unique' USING ERRCODE='22023'; END IF;
  IF requested_skill_count <> (
    SELECT count(*) FROM oao.skill_versions sv
    JOIN oao.skills skill
      ON skill.organization_id=sv.organization_id AND skill.project_id=sv.project_id
     AND skill.id=sv.skill_id
    JOIN oao.skill_version_lifecycle lifecycle
      ON lifecycle.organization_id=sv.organization_id AND lifecycle.project_id=sv.project_id
     AND lifecycle.skill_version_id=sv.id
    WHERE sv.organization_id=p_organization_id AND sv.project_id=p_project_id
      AND sv.id IN (
        SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
      ) AND lifecycle.status='active'
      AND skill.disabled_at IS NULL
      AND skill.archived_at IS NULL
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
      ON server.organization_id=toolset.organization_id
     AND server.id=toolset.server_version_id
    JOIN oao.mcp_server_version_lifecycle server_lifecycle
      ON server_lifecycle.organization_id=server.organization_id
     AND server_lifecycle.server_version_id=server.id
     AND server_lifecycle.status='active'
    JOIN oao.mcp_credential_policy_versions policy
      ON policy.organization_id=p_organization_id
     AND policy.id=(requested->>'credentialPolicyVersionId')::uuid
     AND oao.mcp_endpoint_matches_policy(
       server.endpoint_url,policy.exact_origin,policy.path_prefix
     )
    JOIN oao.mcp_credential_policy_version_lifecycle policy_lifecycle
      ON policy_lifecycle.organization_id=policy.organization_id
     AND policy_lifecycle.policy_version_id=policy.id
     AND policy_lifecycle.status='active'
    JOIN oao.mcp_credentials credential
      ON credential.organization_id=policy.organization_id
     AND credential.id=policy.credential_id AND credential.active_version_id IS NOT NULL
    JOIN oao.mcp_credential_version_lifecycle credential_lifecycle
      ON credential_lifecycle.organization_id=credential.organization_id
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

--------------------------------------------------------------------------------
-- 8. Project creation by organization owners/admins.
--------------------------------------------------------------------------------

-- The organization membership row is attached to one principal per subject
-- while sessions may act through per-project principal copies, so authority
-- checks resolve the role by subject across project boundaries.
CREATE FUNCTION oao.organization_role_for_subject(
  p_organization_id uuid,
  p_kind oao.principal_kind,
  p_subject text
) RETURNS oao.organization_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
  SELECT membership.role FROM oao.organization_members membership
  JOIN oao.principals owner_principal
    ON owner_principal.organization_id = membership.organization_id
   AND owner_principal.id = membership.principal_id
  WHERE membership.organization_id = p_organization_id
    AND owner_principal.kind = p_kind
    AND owner_principal.subject = p_subject
$$;
REVOKE ALL ON FUNCTION oao.organization_role_for_subject(uuid, oao.principal_kind, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.organization_role_for_subject(uuid, oao.principal_kind, text) TO oao_app;

CREATE FUNCTION oao.create_organization_project(
  p_organization_id uuid,
  p_project_id uuid,
  p_slug text,
  p_name text,
  p_actor_principal_id uuid
) RETURNS oao.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE
  actor oao.principals;
  actor_role oao.organization_role;
  created oao.projects;
  new_principal_id uuid;
  actor_identities oao.auth_identities[];
  actor_tenant_links oao.auth_tenant_links[];
  saved_organization text;
  saved_project text;
BEGIN
  SELECT * INTO actor FROM oao.principals
  WHERE organization_id = p_organization_id AND id = p_actor_principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'actor principal not found' USING ERRCODE = '22023';
  END IF;
  IF actor.kind = 'api_key' THEN
    -- Organization API keys carry authority through scopes instead of an
    -- organization membership row.
    IF NOT (actor.scopes && ARRAY['*', 'project:admin']) THEN
      RAISE EXCEPTION 'organization owner or admin role is required'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- The membership row is attached to one principal per subject; project
    -- switching and project creation copy principals into other projects, so
    -- authority is resolved by subject rather than principal id.
    SELECT membership.role INTO actor_role
    FROM oao.organization_members membership
    JOIN oao.principals owner_principal
      ON owner_principal.organization_id = membership.organization_id
     AND owner_principal.id = membership.principal_id
    WHERE membership.organization_id = p_organization_id
      AND owner_principal.kind = actor.kind
      AND owner_principal.subject = actor.subject;
    IF actor_role IS NULL OR actor_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'organization owner or admin role is required'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Capture the creator's identity rows while the caller's tenant context
  -- (the actor's project) still satisfies row-level security.
  SELECT COALESCE(array_agg(identity), '{}') INTO actor_identities
  FROM oao.auth_identities identity
  WHERE identity.organization_id = p_organization_id
    AND identity.project_id = actor.project_id
    AND identity.principal_id = actor.id;
  SELECT COALESCE(array_agg(link), '{}') INTO actor_tenant_links
  FROM oao.auth_tenant_links link
  WHERE link.organization_id = p_organization_id
    AND link.project_id = actor.project_id;

  saved_organization := current_setting('oao.organization_id', true);
  saved_project := current_setting('oao.project_id', true);
  PERFORM set_config('oao.organization_id', p_organization_id::text, true);
  PERFORM set_config('oao.project_id', p_project_id::text, true);

  INSERT INTO oao.projects (organization_id, id, slug, name)
  VALUES (p_organization_id, p_project_id, p_slug, p_name)
  RETURNING * INTO created;

  -- Provision a human creator inside the new project so the identity
  -- provider can resolve into it: principal copy, owner membership, identity
  -- rows, and tenant links mirroring the creator's current project. API-key
  -- actors need no provisioning: their per-project mirror principal is
  -- materialised on first authenticated use.
  IF actor.kind <> 'api_key' THEN
    new_principal_id := gen_random_uuid();
    INSERT INTO oao.principals (organization_id, project_id, id, kind, subject, scopes)
    VALUES (p_organization_id, p_project_id, new_principal_id, actor.kind, actor.subject, actor.scopes);
    INSERT INTO oao.project_members (
      organization_id, project_id, principal_id, role, created_by_principal_id
    ) VALUES (p_organization_id, p_project_id, new_principal_id, 'owner', new_principal_id);
    INSERT INTO oao.auth_identities (
      organization_id, project_id, principal_id, provider, provider_subject,
      email, display_name, last_reconciled_at
    )
    SELECT p_organization_id, p_project_id, new_principal_id, identity.provider,
           identity.provider_subject, identity.email, identity.display_name, clock_timestamp()
    FROM unnest(actor_identities) identity;
    INSERT INTO oao.auth_tenant_links (
      organization_id, project_id, provider, provider_tenant_id
    )
    SELECT p_organization_id, p_project_id, link.provider, link.provider_tenant_id
    FROM unnest(actor_tenant_links) link
    ON CONFLICT DO NOTHING;
  END IF;

  PERFORM set_config('oao.organization_id', COALESCE(saved_organization, ''), true);
  PERFORM set_config('oao.project_id', COALESCE(saved_project, ''), true);
  RETURN created;
END
$$;
REVOKE ALL ON FUNCTION oao.create_organization_project(uuid, uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.create_organization_project(uuid, uuid, text, text, uuid) TO oao_app;

--------------------------------------------------------------------------------
-- 9. Hard project deletion by organization owners/admins.
--
-- The user-facing contract is a hard delete: every project-scoped row is
-- removed, including runs, events, and the audit trail. Immutability
-- triggers are suspended for the duration of the purge transaction. Flue
-- canonical conversation state for the project's threads is purged when the
-- worker has created those tables. Object storage (workspace backups and
-- run files) is not touched here; operators remove the project's
-- workspace-backups/ and run-files/ prefixes separately.
--------------------------------------------------------------------------------

CREATE FUNCTION oao.delete_organization_project(
  p_organization_id uuid,
  p_project_id uuid,
  p_actor_principal_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE
  actor oao.principals;
  actor_role oao.organization_role;
  doomed_membership record;
  replacement_principal_id uuid;
  live_project_count integer;
  flue_conversation_ids text[];
  saved_organization text;
  saved_project text;
  purge_tables constant text[] := ARRAY[
    -- Ordered children-first; the pass loop below tolerates residual cycles.
    'mcp_call_attempts', 'tool_call_results', 'approvals', 'tool_calls',
    'timeline_entries', 'model_invocations', 'messages',
    'sandbox_commands', 'sandbox_artifacts', 'sandbox_instances',
    'runtime_dispatches', 'runtime_wake_jobs', 'run_admission_attempts',
    'delegation_runs', 'agent_delegations', 'runs',
    'runtime_thread_instances', 'thread_admission_heads',
    'thread_workspace_backups', 'thread_workspace_bindings', 'agent_workspaces',
    'session_summaries', 'session_mcp_bindings', 'session_skill_bindings',
    'sessions', 'threads',
    'agent_version_mcp_bindings', 'agent_version_skill_bindings',
    'agent_version_delegates', 'agent_version_harness_operations',
    'mcp_toolset_version_lifecycle', 'mcp_toolset_version_tools',
    'mcp_toolset_versions', 'mcp_toolsets',
    'agent_versions', 'agent_definitions',
    'skill_version_files', 'skill_version_lifecycle', 'skill_versions', 'skills',
    'skill_package_draft_entries', 'skill_package_drafts',
    'project_model_presets', 'project_sandbox_providers',
    'product_events', 'project_event_positions',
    'audit_entries', 'audit_chain_heads',
    'api_request_idempotency', 'api_idempotency',
    'auth_sessions', 'auth_identities', 'auth_tenant_links',
    'project_members'
  ];
  table_name text;
  blocked integer;
  pass integer;
BEGIN
  SELECT * INTO actor FROM oao.principals
  WHERE organization_id = p_organization_id AND id = p_actor_principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'actor principal not found' USING ERRCODE = '22023';
  END IF;
  IF actor.kind = 'api_key' THEN
    -- Organization API keys carry authority through scopes instead of an
    -- organization membership row.
    IF NOT (actor.scopes && ARRAY['*', 'project:admin']) THEN
      RAISE EXCEPTION 'organization owner or admin role is required'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Authority is resolved by subject: the membership row is attached to
    -- one principal per subject while sessions may act through per-project
    -- principal copies.
    SELECT membership.role INTO actor_role
    FROM oao.organization_members membership
    JOIN oao.principals owner_principal
      ON owner_principal.organization_id = membership.organization_id
     AND owner_principal.id = membership.principal_id
    WHERE membership.organization_id = p_organization_id
      AND owner_principal.kind = actor.kind
      AND owner_principal.subject = actor.subject;
    IF actor_role IS NULL OR actor_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'organization owner or admin role is required'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF actor.project_id = p_project_id THEN
    RAISE EXCEPTION 'the active project cannot delete itself' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM oao.projects
  WHERE organization_id = p_organization_id AND id = p_project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*) INTO live_project_count FROM oao.projects
  WHERE organization_id = p_organization_id;
  IF live_project_count <= 1 THEN
    RAISE EXCEPTION 'the last project of an organization cannot be deleted'
      USING ERRCODE = '22023';
  END IF;

  saved_organization := current_setting('oao.organization_id', true);
  saved_project := current_setting('oao.project_id', true);
  PERFORM set_config('oao.organization_id', p_organization_id::text, true);
  PERFORM set_config('oao.project_id', p_project_id::text, true);

  SELECT COALESCE(array_agg(DISTINCT instance.flue_conversation_id), '{}')
    INTO flue_conversation_ids
  FROM oao.runtime_dispatches instance
  WHERE instance.organization_id = p_organization_id
    AND instance.project_id = p_project_id;

  FOREACH table_name IN ARRAY purge_tables LOOP
    EXECUTE format('ALTER TABLE oao.%I DISABLE TRIGGER USER', table_name);
  END LOOP;

  UPDATE oao.agent_definitions SET latest_version_id = NULL
  WHERE organization_id = p_organization_id AND project_id = p_project_id;
  UPDATE oao.mcp_toolsets SET latest_version_id = NULL
  WHERE organization_id = p_organization_id AND project_id = p_project_id;
  UPDATE oao.skills SET latest_version_id = NULL
  WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND latest_version_id IS NOT NULL;

  FOR pass IN 1..8 LOOP
    blocked := 0;
    FOREACH table_name IN ARRAY purge_tables LOOP
      BEGIN
        EXECUTE format(
          'DELETE FROM oao.%I WHERE organization_id = $1 AND project_id = $2',
          table_name
        ) USING p_organization_id, p_project_id;
      EXCEPTION WHEN foreign_key_violation THEN
        blocked := blocked + 1;
      END;
    END LOOP;
    EXIT WHEN blocked = 0;
  END LOOP;
  IF blocked > 0 THEN
    RAISE EXCEPTION 'project purge did not converge' USING ERRCODE = '55000';
  END IF;

  -- Organization memberships attach to one principal per subject. Re-home
  -- memberships held by principals of the doomed project onto a surviving
  -- same-subject principal so nobody silently loses their organization role.
  FOR doomed_membership IN
    SELECT membership.principal_id, doomed.subject
    FROM oao.organization_members membership
    JOIN oao.principals doomed
      ON doomed.organization_id = membership.organization_id
     AND doomed.id = membership.principal_id
    WHERE membership.organization_id = p_organization_id
      AND doomed.project_id = p_project_id
  LOOP
    SELECT survivor.id INTO replacement_principal_id
    FROM oao.principals survivor
    WHERE survivor.organization_id = p_organization_id
      AND survivor.project_id <> p_project_id
      AND survivor.kind = 'human'
      AND survivor.subject = doomed_membership.subject
    ORDER BY survivor.created_at, survivor.id LIMIT 1;
    IF replacement_principal_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM oao.organization_members existing
      WHERE existing.organization_id = p_organization_id
        AND existing.principal_id = replacement_principal_id
    ) THEN
      UPDATE oao.organization_members
      SET principal_id = replacement_principal_id
      WHERE organization_id = p_organization_id
        AND principal_id = doomed_membership.principal_id;
    END IF;
  END LOOP;
  DELETE FROM oao.organization_members membership
  WHERE membership.organization_id = p_organization_id
    AND membership.principal_id IN (
      SELECT principal.id FROM oao.principals principal
      WHERE principal.organization_id = p_organization_id
        AND principal.project_id = p_project_id
    );
  IF NOT EXISTS (
    SELECT 1 FROM oao.organization_members membership
    WHERE membership.organization_id = p_organization_id
      AND membership.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'deleting this project would remove the organization''s last owner'
      USING ERRCODE = '22023';
  END IF;
  DELETE FROM oao.principals
  WHERE organization_id = p_organization_id AND project_id = p_project_id;
  DELETE FROM oao.projects
  WHERE organization_id = p_organization_id AND id = p_project_id;

  FOREACH table_name IN ARRAY purge_tables LOOP
    EXECUTE format('ALTER TABLE oao.%I ENABLE TRIGGER USER', table_name);
  END LOOP;

  -- Purge Flue canonical state for the project's conversations when the
  -- runtime worker has created those tables in this database.
  IF to_regclass('public.flue_conversation_streams') IS NOT NULL
     AND cardinality(flue_conversation_ids) > 0 THEN
    DELETE FROM public.flue_conversation_stream_batches batch
    WHERE EXISTS (
      SELECT 1 FROM unnest(flue_conversation_ids) conversation(id)
      WHERE batch.path LIKE 'agents/%/' || conversation.id
    );
    DELETE FROM public.flue_conversation_fold_checkpoints checkpoint
    WHERE EXISTS (
      SELECT 1 FROM unnest(flue_conversation_ids) conversation(id)
      WHERE checkpoint.path LIKE 'agents/%/' || conversation.id
    );
    DELETE FROM public.flue_conversation_streams stream
    WHERE EXISTS (
      SELECT 1 FROM unnest(flue_conversation_ids) conversation(id)
      WHERE stream.path LIKE 'agents/%/' || conversation.id
    );
    DELETE FROM public.flue_attachments attachment
    WHERE attachment.conversation_id = ANY (flue_conversation_ids)
       OR EXISTS (
         SELECT 1 FROM unnest(flue_conversation_ids) conversation(id)
         WHERE attachment.stream_path LIKE 'agents/%/' || conversation.id
       );
    DELETE FROM public.flue_submission_chunks chunk
    WHERE chunk.submission_id IN (
      SELECT submission.submission_id FROM public.flue_agent_submissions submission
      WHERE EXISTS (
        SELECT 1 FROM unnest(flue_conversation_ids) conversation(id)
        WHERE submission.session_key LIKE '%' || conversation.id || '%'
      )
    );
    DELETE FROM public.flue_agent_submissions submission
    WHERE EXISTS (
      SELECT 1 FROM unnest(flue_conversation_ids) conversation(id)
      WHERE submission.session_key LIKE '%' || conversation.id || '%'
    );
  END IF;

  PERFORM set_config('oao.organization_id', COALESCE(saved_organization, ''), true);
  PERFORM set_config('oao.project_id', COALESCE(saved_project, ''), true);
END
$$;
REVOKE ALL ON FUNCTION oao.delete_organization_project(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.delete_organization_project(uuid, uuid, uuid) TO oao_app;
