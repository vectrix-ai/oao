-- Durable, provider-neutral multi-agent orchestration. Coordinator and child
-- agents keep isolated threads while sharing an explicit workspace identity.

ALTER TABLE oao.product_events DROP CONSTRAINT product_events_event_kind_check;
ALTER TABLE oao.product_events ADD CONSTRAINT product_events_event_kind_check CHECK (event_kind IN (
  'delegation.created', 'delegation.follow_up_created', 'delegation.completed',
  'delegation.failed', 'delegation.cancelled',
  'skill.created', 'skill.version_published', 'skill.version_deprecated',
  'skill.version_revoked', 'skill.activated', 'skill.resource_read',
  'run.created', 'run.state_changed', 'run.cancellation_requested', 'message.created',
  'tool_call.requested', 'tool_call.claimed', 'tool_call.result_submitted', 'tool_call.result_committed',
  'approval.requested', 'approval.resolved', 'sandbox.created', 'sandbox.started',
  'sandbox.stopped', 'sandbox.failed', 'sandbox.command_started', 'sandbox.command_completed',
  'sandbox.command_failed', 'model.invocation_completed', 'model.invocation_failed',
  'runtime.dispatch_reserved', 'runtime.dispatch_admitted', 'runtime.dispatch_reconciled',
  'runtime.recovery_started', 'runtime.recovery_completed', 'runtime.cancellation_draining',
  'session.summary_changed'
));

CREATE TABLE oao.agent_version_delegates (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  parent_agent_version_id uuid NOT NULL,
  delegate_key text NOT NULL CHECK (
    length(delegate_key) BETWEEN 1 AND 64
    AND delegate_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  ),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  child_agent_version_id uuid NOT NULL,
  max_parallel integer NOT NULL DEFAULT 1 CHECK (max_parallel BETWEEN 1 AND 8),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, parent_agent_version_id, delegate_key),
  UNIQUE (organization_id, project_id, parent_agent_version_id, child_agent_version_id),
  FOREIGN KEY (organization_id, project_id, parent_agent_version_id)
    REFERENCES oao.agent_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, child_agent_version_id)
    REFERENCES oao.agent_versions (organization_id, project_id, id)
);

CREATE TRIGGER agent_version_delegates_immutable
BEFORE UPDATE OR DELETE ON oao.agent_version_delegates
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

CREATE OR REPLACE FUNCTION oao.is_valid_agent_publication_config_with_skills(p_config jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  skill_ids jsonb;
  delegates jsonb;
BEGIN
  skill_ids := COALESCE(p_config->'skillVersionIds', '[]'::jsonb);
  delegates := COALESCE(p_config->'delegates', '[]'::jsonb);
  IF jsonb_typeof(skill_ids) IS DISTINCT FROM 'array'
     OR jsonb_array_length(skill_ids) > 64
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(skill_ids) value
       WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
          OR trim(both '"' from value::text) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(delegates) IS DISTINCT FROM 'array'
     OR jsonb_array_length(delegates) > 32
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(delegates) delegate
       WHERE jsonb_typeof(delegate) IS DISTINCT FROM 'object'
          OR NOT (delegate ?& ARRAY['key', 'description', 'agentVersionId'])
          OR (delegate - ARRAY['key', 'description', 'agentVersionId', 'maxParallel']) <> '{}'::jsonb
          OR jsonb_typeof(delegate->'key') IS DISTINCT FROM 'string'
          OR length(delegate->>'key') NOT BETWEEN 1 AND 64
          OR (delegate->>'key') !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
          OR jsonb_typeof(delegate->'description') IS DISTINCT FROM 'string'
          OR length(delegate->>'description') NOT BETWEEN 1 AND 1024
          OR jsonb_typeof(delegate->'agentVersionId') IS DISTINCT FROM 'string'
          OR (delegate->>'agentVersionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (delegate ? 'maxParallel' AND (
            jsonb_typeof(delegate->'maxParallel') IS DISTINCT FROM 'number'
            OR (delegate->>'maxParallel')::integer NOT BETWEEN 1 AND 8
            OR (delegate->>'maxParallel')::numeric <> (delegate->>'maxParallel')::integer
          ))
     )
     OR (SELECT count(*) FROM jsonb_array_elements(delegates)) <>
        (SELECT count(DISTINCT delegate->>'key') FROM jsonb_array_elements(delegates) delegate)
     OR (SELECT count(*) FROM jsonb_array_elements(delegates)) <>
        (SELECT count(DISTINCT delegate->>'agentVersionId') FROM jsonb_array_elements(delegates) delegate)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_config->'tools', '[]'::jsonb)) tool
       WHERE tool->>'name' IN ('delegate_agent', 'message_agent')
     ) THEN
    RETURN false;
  END IF;
  RETURN oao.is_valid_agent_publication_config(
    p_config - 'skillVersionIds' - 'delegates'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE FUNCTION oao.capture_agent_version_delegates()
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
      )
  ) THEN
    RAISE EXCEPTION 'delegate agent version is missing, duplicated, or belongs to the coordinator agent'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    WITH RECURSIVE reachable(agent_version_id) AS (
      SELECT (delegate->>'agentVersionId')::uuid
      FROM jsonb_array_elements(COALESCE(NEW.config->'delegates', '[]'::jsonb)) delegate
      UNION
      SELECT edge.child_agent_version_id
      FROM reachable
      JOIN oao.agent_version_delegates edge
        ON edge.organization_id = NEW.organization_id
       AND edge.project_id = NEW.project_id
       AND edge.parent_agent_version_id = reachable.agent_version_id
    )
    SELECT 1
    FROM reachable
    JOIN oao.agent_versions version
      ON version.organization_id = NEW.organization_id
     AND version.project_id = NEW.project_id
     AND version.id = reachable.agent_version_id
    WHERE version.agent_definition_id = NEW.agent_definition_id
  ) THEN
    RAISE EXCEPTION 'delegate roster would create an agent-definition cycle'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM oao.agent_versions child
    WHERE child.organization_id = NEW.organization_id
      AND child.project_id = NEW.project_id
      AND child.id IN (
        SELECT (delegate->>'agentVersionId')::uuid
        FROM jsonb_array_elements(COALESCE(NEW.config->'delegates', '[]'::jsonb)) delegate
      )
      AND ((child.config->'sandbox') - 'capabilities'::text)
          IS DISTINCT FROM ((NEW.config->'sandbox') - 'capabilities'::text)
  ) THEN
    RAISE EXCEPTION 'coordinator and delegate sandbox provider, snapshot, enabled, and network policies must match'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO oao.agent_version_delegates (
    organization_id, project_id, parent_agent_version_id, delegate_key,
    description, child_agent_version_id, max_parallel
  )
  SELECT NEW.organization_id, NEW.project_id, NEW.id, delegate->>'key',
    delegate->>'description', (delegate->>'agentVersionId')::uuid,
    COALESCE((delegate->>'maxParallel')::integer, 1)
  FROM jsonb_array_elements(COALESCE(NEW.config->'delegates', '[]'::jsonb)) delegate;
  RETURN NEW;
END
$$;

CREATE TRIGGER capture_agent_version_delegates
AFTER INSERT ON oao.agent_versions
FOR EACH ROW EXECUTE FUNCTION oao.capture_agent_version_delegates();

CREATE TABLE oao.agent_workspaces (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  owner_thread_id uuid NOT NULL,
  owner_session_id uuid,
  owner_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, owner_thread_id),
  FOREIGN KEY (organization_id, project_id, owner_thread_id)
    REFERENCES oao.threads (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, owner_session_id, owner_thread_id)
    REFERENCES oao.sessions (organization_id, project_id, id, thread_id),
  FOREIGN KEY (organization_id, project_id, owner_run_id, owner_thread_id, owner_session_id)
    REFERENCES oao.runs (organization_id, project_id, id, thread_id, session_id),
  CHECK ((owner_session_id IS NULL) = (owner_run_id IS NULL))
);

CREATE TABLE oao.thread_workspace_bindings (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('coordinator', 'child')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, thread_id),
  FOREIGN KEY (organization_id, project_id, thread_id)
    REFERENCES oao.threads (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, workspace_id)
    REFERENCES oao.agent_workspaces (organization_id, project_id, id)
);

INSERT INTO oao.agent_workspaces (
  organization_id, project_id, id, owner_thread_id, owner_session_id, owner_run_id, created_at
)
SELECT thread.organization_id, thread.project_id, thread.id, thread.id,
  first_run.session_id, first_run.id, thread.created_at
FROM oao.threads thread
LEFT JOIN LATERAL (
  SELECT run.id, run.session_id
  FROM oao.runs run
  WHERE run.organization_id = thread.organization_id
    AND run.project_id = thread.project_id
    AND run.thread_id = thread.id
  ORDER BY run.created_at, run.id
  LIMIT 1
) first_run ON true;

INSERT INTO oao.thread_workspace_bindings (
  organization_id, project_id, thread_id, workspace_id, role, created_at
)
SELECT organization_id, project_id, id, id, 'coordinator', created_at
FROM oao.threads;

CREATE FUNCTION oao.ensure_thread_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM oao.thread_workspace_bindings binding
    WHERE binding.organization_id = NEW.organization_id
      AND binding.project_id = NEW.project_id
      AND binding.thread_id = NEW.thread_id
  ) THEN
    UPDATE oao.agent_workspaces workspace
       SET owner_session_id = NEW.session_id, owner_run_id = NEW.id
     WHERE workspace.organization_id = NEW.organization_id
       AND workspace.project_id = NEW.project_id
       AND workspace.owner_thread_id = NEW.thread_id
       AND workspace.owner_run_id IS NULL;
    RETURN NEW;
  END IF;
  INSERT INTO oao.agent_workspaces (
    organization_id, project_id, id, owner_thread_id, owner_session_id, owner_run_id
  ) VALUES (
    NEW.organization_id, NEW.project_id, NEW.thread_id, NEW.thread_id, NEW.session_id, NEW.id
  ) ON CONFLICT (organization_id, project_id, owner_thread_id) DO UPDATE
    SET owner_session_id = COALESCE(oao.agent_workspaces.owner_session_id, EXCLUDED.owner_session_id),
        owner_run_id = COALESCE(oao.agent_workspaces.owner_run_id, EXCLUDED.owner_run_id);

  INSERT INTO oao.thread_workspace_bindings (
    organization_id, project_id, thread_id, workspace_id, role
  ) VALUES (
    NEW.organization_id, NEW.project_id, NEW.thread_id, NEW.thread_id, 'coordinator'
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER ensure_thread_workspace
AFTER INSERT ON oao.runs
FOR EACH ROW EXECUTE FUNCTION oao.ensure_thread_workspace();

CREATE TRIGGER thread_workspace_bindings_immutable
BEFORE UPDATE OR DELETE ON oao.thread_workspace_bindings
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

CREATE TABLE oao.agent_delegations (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  parent_thread_id uuid NOT NULL,
  parent_session_id uuid NOT NULL,
  parent_agent_version_id uuid NOT NULL,
  delegate_key text NOT NULL,
  child_agent_version_id uuid NOT NULL,
  child_thread_id uuid NOT NULL,
  child_session_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  request_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cancelled')),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, request_key),
  FOREIGN KEY (organization_id, project_id, parent_run_id, parent_thread_id, parent_session_id)
    REFERENCES oao.runs (organization_id, project_id, id, thread_id, session_id),
  FOREIGN KEY (organization_id, project_id, parent_agent_version_id, delegate_key)
    REFERENCES oao.agent_version_delegates (organization_id, project_id, parent_agent_version_id, delegate_key),
  FOREIGN KEY (organization_id, project_id, child_agent_version_id)
    REFERENCES oao.agent_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, child_session_id, child_thread_id)
    REFERENCES oao.sessions (organization_id, project_id, id, thread_id),
  FOREIGN KEY (organization_id, project_id, workspace_id)
    REFERENCES oao.agent_workspaces (organization_id, project_id, id),
  CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE FUNCTION oao.enforce_agent_delegation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.organization_id,NEW.project_id,NEW.id,NEW.parent_run_id,
      NEW.parent_thread_id,NEW.parent_session_id,NEW.parent_agent_version_id,
      NEW.delegate_key,NEW.child_agent_version_id,NEW.child_thread_id,
      NEW.child_session_id,NEW.workspace_id,NEW.request_key,NEW.request_hash,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id,OLD.project_id,OLD.id,OLD.parent_run_id,
      OLD.parent_thread_id,OLD.parent_session_id,OLD.parent_agent_version_id,
      OLD.delegate_key,OLD.child_agent_version_id,OLD.child_thread_id,
      OLD.child_session_id,OLD.workspace_id,OLD.request_key,OLD.request_hash,
      OLD.created_at) THEN
    RAISE EXCEPTION 'delegation identity is immutable' USING ERRCODE = '23000';
  END IF;
  IF OLD.state = 'cancelled' AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'cancelled delegation cannot be reactivated' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_delegation_update_guard
BEFORE UPDATE ON oao.agent_delegations
FOR EACH ROW EXECUTE FUNCTION oao.enforce_agent_delegation_update();

CREATE TABLE oao.delegation_runs (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  delegation_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  requested_by_run_id uuid NOT NULL,
  child_run_id uuid NOT NULL,
  request_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, delegation_id, ordinal),
  UNIQUE (organization_id, project_id, child_run_id),
  UNIQUE (organization_id, project_id, request_key),
  FOREIGN KEY (organization_id, project_id, delegation_id)
    REFERENCES oao.agent_delegations (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, requested_by_run_id)
    REFERENCES oao.runs (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, child_run_id)
    REFERENCES oao.runs (organization_id, project_id, id)
);

CREATE TRIGGER delegation_runs_immutable
BEFORE UPDATE OR DELETE ON oao.delegation_runs
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

CREATE FUNCTION oao.enforce_agent_workspace_owner_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.organization_id,NEW.project_id,NEW.id,NEW.owner_thread_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id,OLD.project_id,OLD.id,OLD.owner_thread_id,OLD.created_at)
     OR OLD.owner_run_id IS NOT NULL
     OR NEW.owner_run_id IS NULL
     OR NEW.owner_session_id IS NULL THEN
    RAISE EXCEPTION 'workspace identity and established owner are immutable'
      USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_workspace_owner_update_guard
BEFORE UPDATE ON oao.agent_workspaces
FOR EACH ROW EXECUTE FUNCTION oao.enforce_agent_workspace_owner_update();

CREATE INDEX agent_delegations_parent_session_idx
  ON oao.agent_delegations (organization_id, project_id, parent_session_id, created_at, id);
CREATE INDEX agent_delegations_child_session_idx
  ON oao.agent_delegations (organization_id, project_id, child_session_id);
CREATE INDEX delegation_runs_delegation_idx
  ON oao.delegation_runs (organization_id, project_id, delegation_id, ordinal DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'agent_version_delegates', 'agent_workspaces', 'thread_workspace_bindings',
    'agent_delegations', 'delegation_runs'
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

REVOKE ALL ON FUNCTION oao.capture_agent_version_delegates() FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.ensure_thread_workspace() FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.enforce_agent_delegation_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.enforce_agent_workspace_owner_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_agent_publication_config_with_skills(jsonb) TO oao_app;
GRANT SELECT, INSERT ON oao.agent_version_delegates,
  oao.thread_workspace_bindings, oao.delegation_runs TO oao_app;
GRANT SELECT, INSERT, UPDATE ON oao.agent_workspaces TO oao_app;
GRANT SELECT, INSERT, UPDATE ON oao.agent_delegations TO oao_app;
