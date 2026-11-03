-- Delegates and Skill bindings may follow the latest published version of an
-- agent or Skill instead of pinning one exact version. A delegate names
-- either agentVersionId (pinned) or agentId (follows); a config lists pinned
-- Skill versions in skillVersionIds and followed Skills in skillIds. Pinned
-- configs keep their exact shape and meaning.
--
-- "Latest" is resolved once, when a root session starts, for the root agent
-- version and every delegate it can reach. The resolution is stored per
-- session, and delegated child sessions carry the root's copy, so a
-- publication during a session never changes the versions it runs.

--------------------------------------------------------------------------------
-- 1. Publication shape: followed Skills and followed delegates.
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION oao.is_valid_agent_publication_config_with_skills(p_config jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  skill_ids jsonb;
  followed_skill_ids jsonb;
  delegates jsonb;
BEGIN
  skill_ids := COALESCE(p_config->'skillVersionIds', '[]'::jsonb);
  followed_skill_ids := COALESCE(p_config->'skillIds', '[]'::jsonb);
  delegates := COALESCE(p_config->'delegates', '[]'::jsonb);
  IF jsonb_typeof(skill_ids) IS DISTINCT FROM 'array'
     OR jsonb_typeof(followed_skill_ids) IS DISTINCT FROM 'array'
     OR jsonb_array_length(skill_ids) + jsonb_array_length(followed_skill_ids) > 64
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(skill_ids || followed_skill_ids) value
       WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
          OR (value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     )
     OR jsonb_array_length(followed_skill_ids) <> (
       SELECT count(DISTINCT lower(value #>> '{}'))
       FROM jsonb_array_elements(followed_skill_ids) value
     ) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(delegates) IS DISTINCT FROM 'array'
     OR jsonb_array_length(delegates) > 32
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(delegates) delegate
       WHERE jsonb_typeof(delegate) IS DISTINCT FROM 'object'
          OR NOT (delegate ?& ARRAY['key', 'description'])
          -- Exactly one target: a pinned version or a followed agent.
          OR (delegate ? 'agentVersionId') = (delegate ? 'agentId')
          OR (delegate - ARRAY['key', 'description', 'agentVersionId', 'agentId', 'maxParallel']) <> '{}'::jsonb
          OR jsonb_typeof(delegate->'key') IS DISTINCT FROM 'string'
          OR length(delegate->>'key') NOT BETWEEN 1 AND 64
          OR (delegate->>'key') !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
          OR jsonb_typeof(delegate->'description') IS DISTINCT FROM 'string'
          OR length(delegate->>'description') NOT BETWEEN 1 AND 1024
          OR jsonb_typeof(COALESCE(delegate->'agentVersionId', delegate->'agentId')) IS DISTINCT FROM 'string'
          OR COALESCE(delegate->>'agentVersionId', delegate->>'agentId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (delegate ? 'maxParallel' AND (
            jsonb_typeof(delegate->'maxParallel') IS DISTINCT FROM 'number'
            OR (delegate->>'maxParallel')::integer NOT BETWEEN 1 AND 8
            OR (delegate->>'maxParallel')::numeric <> (delegate->>'maxParallel')::integer
          ))
     )
     OR (SELECT count(*) FROM jsonb_array_elements(delegates)) <>
        (SELECT count(DISTINCT delegate->>'key') FROM jsonb_array_elements(delegates) delegate)
     OR (SELECT count(*) FROM jsonb_array_elements(delegates)) <> (
       SELECT count(DISTINCT CASE WHEN delegate ? 'agentId'
         THEN 'agent:' || lower(delegate->>'agentId')
         ELSE 'version:' || lower(delegate->>'agentVersionId') END)
       FROM jsonb_array_elements(delegates) delegate
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_config->'tools', '[]'::jsonb)) tool
       WHERE tool->>'name' IN ('delegate_agent', 'message_agent')
     ) THEN
    RETURN false;
  END IF;
  RETURN oao.is_valid_agent_publication_config(
    p_config - 'skillVersionIds' - 'skillIds' - 'delegates'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

--------------------------------------------------------------------------------
-- 2. Delegate edges name a pinned version or a followed agent definition.
--------------------------------------------------------------------------------

ALTER TABLE oao.agent_version_delegates
  ALTER COLUMN child_agent_version_id DROP NOT NULL,
  ADD COLUMN child_agent_definition_id uuid,
  ADD CONSTRAINT agent_version_delegates_one_child CHECK (
    num_nonnulls(child_agent_version_id, child_agent_definition_id) = 1
  ),
  ADD CONSTRAINT agent_version_delegates_followed_agent_fkey
    FOREIGN KEY (organization_id, project_id, child_agent_definition_id)
    REFERENCES oao.agent_definitions (organization_id, project_id, id),
  ADD CONSTRAINT agent_version_delegates_followed_agent_unique
    UNIQUE (organization_id, project_id, parent_agent_version_id, child_agent_definition_id);

-- A followed delegate is checked against its agent's latest version at
-- publication; a later publication of that agent is checked when a session
-- resolves it. Cycles are walked through followed agents' latest versions
-- and through edges that follow the coordinator itself, which a new version
-- of the coordinator would close.
CREATE OR REPLACE FUNCTION oao.capture_agent_version_delegates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested_count integer;
BEGIN
  requested_count := jsonb_array_length(COALESCE(NEW.config->'delegates', '[]'::jsonb));
  IF requested_count <> (
    SELECT count(*)
    FROM oao.agent_versions child
    WHERE child.organization_id = NEW.organization_id
      AND child.project_id = NEW.project_id
      AND child.agent_definition_id <> NEW.agent_definition_id
      AND child.id IN (
        SELECT (delegate->>'agentVersionId')::uuid
        FROM jsonb_array_elements(COALESCE(NEW.config->'delegates', '[]'::jsonb)) delegate
        WHERE delegate ? 'agentVersionId'
      )
  ) + (
    SELECT count(*)
    FROM oao.agent_definitions followed
    WHERE followed.organization_id = NEW.organization_id
      AND followed.project_id = NEW.project_id
      AND followed.id <> NEW.agent_definition_id
      AND followed.id IN (
        SELECT (delegate->>'agentId')::uuid
        FROM jsonb_array_elements(COALESCE(NEW.config->'delegates', '[]'::jsonb)) delegate
        WHERE delegate ? 'agentId'
      )
  ) THEN
    RAISE EXCEPTION 'delegate agent version is missing, duplicated, or belongs to the coordinator agent'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    WITH RECURSIVE reachable(agent_definition_id, agent_version_id) AS (
      SELECT COALESCE(followed.id, child.agent_definition_id),
             COALESCE(child.id, followed.latest_version_id)
      FROM jsonb_array_elements(COALESCE(NEW.config->'delegates', '[]'::jsonb)) delegate
      LEFT JOIN oao.agent_versions child
        ON child.organization_id = NEW.organization_id
       AND child.project_id = NEW.project_id
       AND child.id = (delegate->>'agentVersionId')::uuid
      LEFT JOIN oao.agent_definitions followed
        ON followed.organization_id = NEW.organization_id
       AND followed.project_id = NEW.project_id
       AND followed.id = (delegate->>'agentId')::uuid
      UNION
      SELECT COALESCE(edge.child_agent_definition_id, child.agent_definition_id),
             COALESCE(edge.child_agent_version_id, followed.latest_version_id)
      FROM reachable
      JOIN oao.agent_version_delegates edge
        ON edge.organization_id = NEW.organization_id
       AND edge.project_id = NEW.project_id
       AND edge.parent_agent_version_id = reachable.agent_version_id
      LEFT JOIN oao.agent_versions child
        ON child.organization_id = edge.organization_id
       AND child.project_id = edge.project_id
       AND child.id = edge.child_agent_version_id
      LEFT JOIN oao.agent_definitions followed
        ON followed.organization_id = edge.organization_id
       AND followed.project_id = edge.project_id
       AND followed.id = edge.child_agent_definition_id
    )
    SELECT 1 FROM reachable
    WHERE reachable.agent_definition_id = NEW.agent_definition_id
  ) THEN
    RAISE EXCEPTION 'delegate roster would create an agent-definition cycle'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(NEW.config->'delegates', '[]'::jsonb)) delegate
    LEFT JOIN oao.agent_definitions followed
      ON followed.organization_id = NEW.organization_id
     AND followed.project_id = NEW.project_id
     AND followed.id = (delegate->>'agentId')::uuid
    JOIN oao.agent_versions child
      ON child.organization_id = NEW.organization_id
     AND child.project_id = NEW.project_id
     AND child.id = COALESCE((delegate->>'agentVersionId')::uuid, followed.latest_version_id)
    WHERE ((child.config->'sandbox') - 'capabilities'::text)
          IS DISTINCT FROM ((NEW.config->'sandbox') - 'capabilities'::text)
  ) THEN
    RAISE EXCEPTION 'coordinator and delegate sandbox provider, snapshot, enabled, and network policies must match'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO oao.agent_version_delegates (
    organization_id, project_id, parent_agent_version_id, delegate_key,
    description, child_agent_version_id, child_agent_definition_id, max_parallel
  )
  SELECT NEW.organization_id, NEW.project_id, NEW.id, delegate->>'key',
    delegate->>'description', (delegate->>'agentVersionId')::uuid,
    (delegate->>'agentId')::uuid,
    COALESCE((delegate->>'maxParallel')::integer, 1)
  FROM jsonb_array_elements(COALESCE(NEW.config->'delegates', '[]'::jsonb)) delegate;
  RETURN NEW;
END
$$;

--------------------------------------------------------------------------------
-- 3. Publication checks followed Skills against their latest version.
--------------------------------------------------------------------------------

-- Matches migration 0037, plus followed Skills: each must be enabled, not
-- removed, and have an active latest version; a Skill is pinned or followed,
-- not both; and names stay unique across pinned versions and the latest
-- versions of followed Skills.
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
  requested_followed_skill_count integer;
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
    AND (
      skill.id IN (
        SELECT sv.skill_id FROM oao.skill_versions sv
        WHERE sv.organization_id=p_organization_id
          AND sv.project_id=p_project_id
          AND sv.id IN (
            SELECT value::uuid
            FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
          )
      )
      OR skill.id IN (
        SELECT value::uuid
        FROM jsonb_array_elements_text(COALESCE(p_config->'skillIds','[]'::jsonb)) value
      )
    )
  ORDER BY skill.id
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

  SELECT jsonb_array_length(COALESCE(p_config->'skillIds','[]'::jsonb))
    INTO requested_followed_skill_count;
  IF requested_followed_skill_count <> (
    SELECT count(*) FROM oao.skills skill
    JOIN oao.skill_versions latest
      ON latest.organization_id=skill.organization_id AND latest.project_id=skill.project_id
     AND latest.id=skill.latest_version_id
    JOIN oao.skill_version_lifecycle lifecycle
      ON lifecycle.organization_id=latest.organization_id AND lifecycle.project_id=latest.project_id
     AND lifecycle.skill_version_id=latest.id
    WHERE skill.organization_id=p_organization_id AND skill.project_id=p_project_id
      AND skill.id IN (
        SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_config->'skillIds','[]'::jsonb)) value
      ) AND lifecycle.status='active'
      AND skill.disabled_at IS NULL
      AND skill.archived_at IS NULL
  ) THEN RAISE EXCEPTION 'followed Skill is missing, unavailable, or has no active published version' USING ERRCODE='22023'; END IF;
  IF EXISTS (
    SELECT 1 FROM oao.skill_versions sv
    WHERE sv.organization_id=p_organization_id AND sv.project_id=p_project_id
      AND sv.id IN (
        SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
      )
      AND sv.skill_id IN (
        SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_config->'skillIds','[]'::jsonb)) value
      )
  ) THEN RAISE EXCEPTION 'a Skill is either pinned or followed, not both' USING ERRCODE='22023'; END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT sv.skill_name FROM oao.skill_versions sv
      WHERE sv.organization_id=p_organization_id AND sv.project_id=p_project_id
        AND sv.id IN (
          SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
        )
      UNION ALL
      SELECT latest.skill_name FROM oao.skills skill
      JOIN oao.skill_versions latest
        ON latest.organization_id=skill.organization_id AND latest.project_id=skill.project_id
       AND latest.id=skill.latest_version_id
      WHERE skill.organization_id=p_organization_id AND skill.project_id=p_project_id
        AND skill.id IN (
          SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_config->'skillIds','[]'::jsonb)) value
        )
    ) bound GROUP BY bound.skill_name HAVING count(*) > 1
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
-- 4. The versions a session tree runs, fixed when its root session started.
--------------------------------------------------------------------------------

-- One immutable row per session. A root session's row is written when it is
-- created; a delegated child session gets a copy of its parent's row. The
-- application role may only read and insert. Rows go with their session, so
-- a project purge removes them without listing this table.
CREATE TABLE oao.session_version_resolutions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  resolution jsonb NOT NULL CHECK (
    jsonb_typeof(resolution) = 'object'
    AND resolution->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof(resolution->'agentVersions') = 'array'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, session_id),
  FOREIGN KEY (organization_id, project_id, session_id)
    REFERENCES oao.sessions (organization_id, project_id, id) ON DELETE CASCADE
);

ALTER TABLE oao.session_version_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.session_version_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.session_version_resolutions
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());
GRANT SELECT, INSERT ON oao.session_version_resolutions TO oao_app;
