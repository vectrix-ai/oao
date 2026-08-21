-- First-class, immutable Agent Skills with exact agent-version and session
-- bindings. PostgreSQL remains authoritative; package contents never depend
-- on a mutable sandbox workspace.

ALTER TABLE oao.product_events DROP CONSTRAINT product_events_event_kind_check;
ALTER TABLE oao.product_events ADD CONSTRAINT product_events_event_kind_check CHECK (event_kind IN (
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

CREATE TABLE oao.skills (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  skill_key text NOT NULL CHECK (
    length(skill_key) BETWEEN 1 AND 120
    AND skill_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  ),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  latest_version_id uuid,
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, skill_key),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

CREATE TABLE oao.skill_versions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  skill_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  skill_name text NOT NULL CHECK (
    length(skill_name) BETWEEN 1 AND 64
    AND skill_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  instructions text NOT NULL CHECK (length(instructions) BETWEEN 1 AND 200000),
  license text CHECK (license IS NULL OR length(license) BETWEEN 1 AND 500),
  compatibility text CHECK (
    compatibility IS NULL OR length(compatibility) BETWEEN 1 AND 500
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object'
    AND NOT oao.jsonb_has_forbidden_public_key(metadata)
  ),
  allowed_tools text CHECK (
    allowed_tools IS NULL OR length(allowed_tools) BETWEEN 1 AND 2000
  ),
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  total_bytes integer NOT NULL CHECK (total_bytes BETWEEN 1 AND 10485760),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, skill_id, version),
  UNIQUE (organization_id, project_id, skill_id, content_hash),
  UNIQUE (organization_id, project_id, id, skill_id),
  FOREIGN KEY (organization_id, project_id, skill_id)
    REFERENCES oao.skills (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

ALTER TABLE oao.skills
  ADD CONSTRAINT skills_latest_version_fkey
  FOREIGN KEY (organization_id, project_id, latest_version_id, id)
  REFERENCES oao.skill_versions (organization_id, project_id, id, skill_id);

CREATE TABLE oao.skill_version_files (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  skill_version_id uuid NOT NULL,
  file_path text NOT NULL CHECK (
    length(file_path) BETWEEN 1 AND 240
    AND file_path !~ '[[:cntrl:]\\]'
    AND file_path !~ '(^|/)(\.|\.\.)(/|$)'
    AND file_path !~ '^/'
    AND file_path !~ '/$'
    AND file_path <> 'SKILL.md'
  ),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 200),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  content_bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, skill_version_id, file_path),
  FOREIGN KEY (organization_id, project_id, skill_version_id)
    REFERENCES oao.skill_versions (organization_id, project_id, id),
  CHECK (octet_length(content_bytes) = size_bytes)
);

CREATE TABLE oao.skill_version_lifecycle (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  skill_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'deprecated', 'revoked')
  ),
  updated_by_principal_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, skill_version_id),
  FOREIGN KEY (organization_id, project_id, skill_version_id)
    REFERENCES oao.skill_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, updated_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id)
);

CREATE TABLE oao.agent_version_skill_bindings (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  skill_version_id uuid NOT NULL,
  skill_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, agent_version_id, skill_version_id),
  UNIQUE (organization_id, project_id, agent_version_id, skill_name),
  FOREIGN KEY (organization_id, project_id, agent_version_id)
    REFERENCES oao.agent_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, skill_version_id)
    REFERENCES oao.skill_versions (organization_id, project_id, id)
);

CREATE TABLE oao.session_skill_bindings (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  skill_version_id uuid NOT NULL,
  skill_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, session_id, skill_version_id),
  UNIQUE (organization_id, project_id, session_id, skill_name),
  FOREIGN KEY (organization_id, project_id, session_id)
    REFERENCES oao.sessions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, agent_version_id)
    REFERENCES oao.agent_versions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, skill_version_id)
    REFERENCES oao.skill_versions (organization_id, project_id, id)
);

CREATE TRIGGER skill_versions_immutable
BEFORE UPDATE OR DELETE ON oao.skill_versions
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();
CREATE TRIGGER skill_version_files_immutable
BEFORE UPDATE OR DELETE ON oao.skill_version_files
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();
CREATE TRIGGER agent_version_skill_bindings_immutable
BEFORE UPDATE OR DELETE ON oao.agent_version_skill_bindings
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();
CREATE TRIGGER session_skill_bindings_immutable
BEFORE UPDATE OR DELETE ON oao.session_skill_bindings
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

CREATE FUNCTION oao.enforce_skill_version_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.skill_version_id <> OLD.skill_version_id THEN
    RAISE EXCEPTION 'skill lifecycle identity is immutable' USING ERRCODE = '22023';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'active' AND NEW.status IN ('deprecated', 'revoked'))
    OR (OLD.status = 'deprecated' AND NEW.status = 'revoked')
  ) THEN
    RAISE EXCEPTION 'invalid skill lifecycle transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER skill_version_lifecycle_transition
BEFORE UPDATE ON oao.skill_version_lifecycle
FOR EACH ROW EXECUTE FUNCTION oao.enforce_skill_version_lifecycle_transition();

CREATE INDEX skills_created_idx
  ON oao.skills (organization_id, project_id, created_at DESC, id DESC);
CREATE INDEX skill_versions_skill_created_idx
  ON oao.skill_versions (organization_id, project_id, skill_id, created_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'skills', 'skill_versions', 'skill_version_files',
    'skill_version_lifecycle', 'agent_version_skill_bindings',
    'session_skill_bindings'
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

CREATE FUNCTION oao.is_valid_agent_publication_config_with_skills(p_config jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  skill_ids jsonb;
BEGIN
  skill_ids := COALESCE(p_config->'skillVersionIds', '[]'::jsonb);
  IF jsonb_typeof(skill_ids) IS DISTINCT FROM 'array'
     OR jsonb_array_length(skill_ids) > 64
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(skill_ids) value
       WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
          OR trim(both '"' from value::text) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    RETURN false;
  END IF;
  RETURN oao.is_valid_agent_publication_config(p_config - 'skillVersionIds');
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
BEGIN
  IF NOT oao.is_valid_agent_publication_config_with_skills(p_config) THEN
    RAISE EXCEPTION 'invalid agent publication config' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_content_hash) <> 32 THEN
    RAISE EXCEPTION 'agent content hash must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM oao.agent_definitions
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND id = p_agent_definition_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent definition not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT jsonb_array_length(COALESCE(p_config->'skillVersionIds','[]'::jsonb))
    INTO requested_skill_count;
  IF requested_skill_count <> (
    SELECT count(DISTINCT value::uuid)
    FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
  ) THEN
    RAISE EXCEPTION 'agent skill versions must be unique' USING ERRCODE = '22023';
  END IF;
  IF requested_skill_count <> (
    SELECT count(*)
    FROM oao.skill_versions sv
    JOIN oao.skill_version_lifecycle lifecycle
      ON lifecycle.organization_id=sv.organization_id
     AND lifecycle.project_id=sv.project_id
     AND lifecycle.skill_version_id=sv.id
    WHERE sv.organization_id=p_organization_id
      AND sv.project_id=p_project_id
      AND sv.id IN (
        SELECT value::uuid
        FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
      )
      AND lifecycle.status='active'
  ) THEN
    RAISE EXCEPTION 'agent skill version is missing or unavailable' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM oao.skill_versions sv
    WHERE sv.organization_id=p_organization_id
      AND sv.project_id=p_project_id
      AND sv.id IN (
        SELECT value::uuid
        FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
      )
    GROUP BY sv.skill_name HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'agent skill names must be unique' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(max(version), 0) + 1 INTO next_version
  FROM oao.agent_versions
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND agent_definition_id = p_agent_definition_id;
  INSERT INTO oao.agent_versions (
    organization_id, project_id, id, agent_definition_id, version, config,
    content_hash, created_by_principal_id
  ) VALUES (
    p_organization_id, p_project_id, p_version_id, p_agent_definition_id,
    next_version, p_config, p_content_hash, p_created_by_principal_id
  ) RETURNING * INTO published;

  INSERT INTO oao.agent_version_skill_bindings (
    organization_id,project_id,agent_version_id,skill_version_id,skill_name
  )
  SELECT p_organization_id,p_project_id,p_version_id,sv.id,sv.skill_name
  FROM oao.skill_versions sv
  WHERE sv.organization_id=p_organization_id
    AND sv.project_id=p_project_id
    AND sv.id IN (
      SELECT value::uuid
      FROM jsonb_array_elements_text(COALESCE(p_config->'skillVersionIds','[]'::jsonb)) value
    );

  UPDATE oao.agent_definitions
  SET latest_version_id = p_version_id
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND id = p_agent_definition_id;
  RETURN published;
END
$$;

REVOKE ALL ON FUNCTION oao.is_valid_agent_publication_config_with_skills(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.publish_agent_version(uuid,uuid,uuid,uuid,jsonb,bytea,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.enforce_skill_version_lifecycle_transition() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_agent_publication_config_with_skills(jsonb) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.publish_agent_version(uuid,uuid,uuid,uuid,jsonb,bytea,uuid) TO oao_app;

GRANT SELECT, INSERT, UPDATE ON oao.skills TO oao_app;
GRANT SELECT, INSERT ON oao.skill_versions, oao.skill_version_files,
  oao.agent_version_skill_bindings, oao.session_skill_bindings TO oao_app;
GRANT SELECT, INSERT, UPDATE ON oao.skill_version_lifecycle TO oao_app;
