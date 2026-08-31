-- Skills can be disabled and removed from a project.
--
-- Versions, package files, agent-version bindings, and session bindings stay
-- immutable: agent versions pin exact Skill version IDs, so no row is ever
-- deleted. The Skill row gains two reversible-or-not markers instead:
--
-- * `disabled_at` pauses a Skill. New agent versions cannot pin any of its
--   versions until an operator enables the Skill again; published versions
--   and their sessions keep running with it, because thread incarnations pin
--   an immutable snapshot of the bound Skill set.
-- * `archived_at` removes a Skill. It leaves every list and lookup and its
--   key becomes free for a new Skill, while published versions keep running.
--   Removal is permanent.

ALTER TABLE oao.skills
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Replace the table-wide key uniqueness with one scoped to live Skills.
DO $$
DECLARE
  key_constraint text;
BEGIN
  SELECT con.conname INTO key_constraint
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'oao'
    AND rel.relname = 'skills'
    AND con.contype = 'u'
    AND (
      SELECT array_agg(att.attname::text ORDER BY att.attname)
      FROM unnest(con.conkey) AS cols(attnum)
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = cols.attnum
    ) = ARRAY['organization_id', 'project_id', 'skill_key']::text[];
  IF key_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE oao.skills DROP CONSTRAINT %I', key_constraint);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS skills_live_key_idx
  ON oao.skills (organization_id, project_id, skill_key)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS skills_live_created_idx
  ON oao.skills (organization_id, project_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL;

-- Publication now also requires the owning Skill to be enabled and present.
-- Body mirrors 0022 (MCP bindings) with the extra Skill-level guard.
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

ALTER TABLE oao.product_events DROP CONSTRAINT product_events_event_kind_check;
ALTER TABLE oao.product_events ADD CONSTRAINT product_events_event_kind_check CHECK (event_kind IN (
  'delegation.created', 'delegation.follow_up_created', 'delegation.completed',
  'delegation.failed', 'delegation.cancelled',
  'skill.draft_created', 'skill.draft_discarded',
  'skill.created', 'skill.version_published', 'skill.version_deprecated',
  'skill.version_revoked', 'skill.activated', 'skill.resource_read',
  'skill.disabled', 'skill.enabled', 'skill.deleted',
  'mcp.server_created', 'mcp.server_version_published',
  'mcp.discovery_completed', 'mcp.discovery_failed', 'mcp.toolset_published',
  'mcp.credential_created', 'mcp.credential_rotated', 'mcp.credential_revoked',
  'mcp.call_started', 'mcp.call_completed', 'mcp.call_failed', 'mcp.call_cancelled',
  'harness.operation_started', 'harness.operation_completed',
  'harness.operation_failed', 'harness.operation_cancelled',
  'harness.operation_timed_out', 'harness.operation_step',
  'run.created', 'run.state_changed', 'run.cancellation_requested', 'message.created',
  'tool_call.requested', 'tool_call.claimed', 'tool_call.result_submitted', 'tool_call.result_committed',
  'approval.requested', 'approval.resolved', 'sandbox.created', 'sandbox.started',
  'sandbox.stopped', 'sandbox.failed', 'sandbox.command_started', 'sandbox.command_completed',
  'sandbox.command_failed', 'model.invocation_completed', 'model.invocation_failed',
  'runtime.dispatch_reserved', 'runtime.dispatch_admitted', 'runtime.dispatch_reconciled',
  'runtime.recovery_started', 'runtime.recovery_completed', 'runtime.cancellation_draining',
  'session.summary_changed'
));
