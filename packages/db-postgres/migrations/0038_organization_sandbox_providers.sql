-- Sandbox provider connections become organization connections, completing
-- the organization-shared resource families started by migration 0037: every
-- project of an organization now runs on the same pool of Daytona
-- connections. Agent versions keep pinning a provider by key inside their
-- immutable config; publication validation resolves the key against the
-- organization pool.

ALTER TABLE oao.project_sandbox_providers
  DISABLE TRIGGER project_sandbox_providers_restrict_mutation;
UPDATE oao.project_sandbox_providers psp
SET provider_key = left(psp.provider_key, 100) || '-' || left(psp.id::text, 8)
WHERE EXISTS (
  SELECT 1 FROM oao.project_sandbox_providers other
  WHERE other.organization_id = psp.organization_id
    AND other.provider_key = psp.provider_key
    AND (other.project_id, other.id) < (psp.project_id, psp.id)
);
ALTER TABLE oao.project_sandbox_providers
  ENABLE TRIGGER project_sandbox_providers_restrict_mutation;

ALTER TABLE oao.project_sandbox_providers DROP COLUMN project_id CASCADE;
ALTER TABLE oao.project_sandbox_providers ADD PRIMARY KEY (organization_id, id);
ALTER TABLE oao.project_sandbox_providers
  ADD CONSTRAINT project_sandbox_providers_organization_fkey
    FOREIGN KEY (organization_id) REFERENCES oao.organizations(id),
  ADD CONSTRAINT project_sandbox_providers_organization_id_provider_key_key
    UNIQUE (organization_id, provider_key);
CREATE INDEX project_sandbox_providers_created_idx
  ON oao.project_sandbox_providers (organization_id, created_at DESC, id DESC);
CREATE POLICY org_shared ON oao.project_sandbox_providers
  USING (organization_id = oao.current_organization_id())
  WITH CHECK (organization_id = oao.current_organization_id());

CREATE OR REPLACE FUNCTION oao.restrict_project_sandbox_provider_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credential_changed boolean;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.display_name IS DISTINCT FROM OLD.display_name
     OR NEW.provider_type IS DISTINCT FROM OLD.provider_type
     OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sandbox provider identity is immutable' USING ERRCODE = '55000';
  END IF;
  credential_changed := NEW.encrypted_api_key IS DISTINCT FROM OLD.encrypted_api_key
    OR NEW.encryption_nonce IS DISTINCT FROM OLD.encryption_nonce
    OR NEW.encryption_tag IS DISTINCT FROM OLD.encryption_tag
    OR NEW.credential_fingerprint IS DISTINCT FROM OLD.credential_fingerprint;
  IF NEW.encryption_key_version < OLD.encryption_key_version
     OR (credential_changed AND NEW.encryption_key_version <= OLD.encryption_key_version)
     OR (NOT credential_changed AND NEW.encryption_key_version <> OLD.encryption_key_version) THEN
    RAISE EXCEPTION 'sandbox provider credential version is invalid' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

-- Sandbox providers are no longer project-scoped, so project deletion no
-- longer purges them. The function body otherwise matches migration 0037.
CREATE OR REPLACE FUNCTION oao.delete_organization_project(
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
    'project_model_presets',
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
