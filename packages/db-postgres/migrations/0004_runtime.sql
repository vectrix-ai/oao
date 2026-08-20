CREATE TYPE oao.runtime_wake_state AS ENUM ('pending', 'leased', 'completed', 'dead');
CREATE TYPE oao.runtime_dispatch_state AS ENUM (
  'reserved', 'dispatching', 'ambiguous', 'admitted', 'aborting', 'settled'
);

ALTER TABLE oao.sessions
  ADD CONSTRAINT sessions_thread_correlation_key
    UNIQUE (organization_id, project_id, id, thread_id);

ALTER TABLE oao.runs
  ADD CONSTRAINT runs_thread_session_correlation_key
    UNIQUE (organization_id, project_id, id, thread_id, session_id);

CREATE TABLE oao.runtime_wake_jobs (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  dispatch_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  kind text NOT NULL CHECK (kind IN ('admit', 'reconcile', 'cancel', 'deadline', 'tool_result', 'approval')),
  state oao.runtime_wake_state NOT NULL DEFAULT 'pending',
  payload_public jsonb NOT NULL DEFAULT '{}',
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  safe_error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, dispatch_key),
  FOREIGN KEY (organization_id, project_id, run_id)
    REFERENCES oao.runs (organization_id, project_id, id),
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (NOT oao.jsonb_has_forbidden_public_key(payload_public)),
  CHECK (safe_error IS NULL OR NOT oao.jsonb_has_forbidden_public_key(safe_error))
);

CREATE INDEX runtime_wake_jobs_claim_idx
  ON oao.runtime_wake_jobs (state, available_at, created_at)
  WHERE state IN ('pending', 'leased');

CREATE TABLE oao.runtime_thread_instances (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  session_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  snapshot_hash bytea NOT NULL CHECK (octet_length(snapshot_hash) = 32),
  flue_instance_id text NOT NULL,
  flue_instance_uid text,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'corrupt')),
  safe_error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, thread_id),
  UNIQUE (flue_instance_id),
  FOREIGN KEY (organization_id, project_id, thread_id)
    REFERENCES oao.threads (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, session_id, thread_id, agent_version_id)
    REFERENCES oao.sessions (organization_id, project_id, id, thread_id, agent_version_id),
  CHECK (safe_error IS NULL OR NOT oao.jsonb_has_forbidden_public_key(safe_error))
);

CREATE TABLE oao.runtime_dispatches (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  admission_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  snapshot_hash bytea NOT NULL CHECK (octet_length(snapshot_hash) = 32),
  state oao.runtime_dispatch_state NOT NULL DEFAULT 'reserved',
  fence bigint NOT NULL CHECK (fence > 0),
  flue_conversation_id text NOT NULL,
  flue_submission_id text,
  flue_instance_uid text,
  flue_accepted_at timestamptz,
  deadline_at timestamptz NOT NULL,
  timeout_requested_at timestamptz,
  safe_error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, run_id),
  UNIQUE (organization_id, project_id, admission_key),
  FOREIGN KEY (organization_id, project_id, thread_id, run_id)
    REFERENCES oao.runs (organization_id, project_id, thread_id, id),
  FOREIGN KEY (organization_id, project_id, thread_id)
    REFERENCES oao.runtime_thread_instances (organization_id, project_id, thread_id),
  CHECK (safe_error IS NULL OR NOT oao.jsonb_has_forbidden_public_key(safe_error))
);

ALTER TABLE oao.thread_admission_heads
  ADD COLUMN draining_at timestamptz;

ALTER TABLE oao.tool_calls
  ADD COLUMN flue_tool_call_ref text,
  ADD COLUMN request_key text,
  ADD COLUMN request_hash bytea CHECK (request_hash IS NULL OR octet_length(request_hash) = 32),
  ADD CONSTRAINT tool_calls_flue_ref_key
    UNIQUE (organization_id, project_id, run_id, flue_tool_call_ref),
  ADD CONSTRAINT tool_calls_request_key
    UNIQUE (organization_id, project_id, request_key),
  ADD CONSTRAINT tool_calls_runtime_correlation_check CHECK (
    (flue_tool_call_ref IS NULL AND request_key IS NULL AND request_hash IS NULL)
    OR
    (flue_tool_call_ref IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL)
  );

CREATE TABLE oao.sandbox_instances (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  session_id uuid NOT NULL,
  provider text NOT NULL,
  provider_ref text,
  target_preference text NOT NULL DEFAULT 'provider-default',
  state text NOT NULL CHECK (state IN ('creating', 'running', 'recovering', 'stopping', 'stopped', 'failed')),
  creation_key text NOT NULL,
  creation_fence bigint NOT NULL DEFAULT 1 CHECK (creation_fence > 0),
  egress_policy jsonb NOT NULL,
  safe_error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz,
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, thread_id),
  UNIQUE (organization_id, project_id, creation_key),
  FOREIGN KEY (organization_id, project_id, run_id, thread_id, session_id)
    REFERENCES oao.runs (organization_id, project_id, id, thread_id, session_id),
  FOREIGN KEY (organization_id, project_id, session_id, thread_id)
    REFERENCES oao.sessions (organization_id, project_id, id, thread_id),
  CHECK (NOT oao.jsonb_has_forbidden_public_key(egress_policy)),
  CHECK (safe_error IS NULL OR NOT oao.jsonb_has_forbidden_public_key(safe_error))
);

CREATE TABLE oao.sandbox_commands (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  sandbox_id uuid NOT NULL,
  run_id uuid NOT NULL,
  command_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  execution_fence bigint NOT NULL DEFAULT 1 CHECK (execution_fence > 0),
  state text NOT NULL CHECK (state IN ('reserved', 'running', 'completed', 'failed', 'cancelled')),
  safe_command jsonb NOT NULL,
  safe_result jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, command_key),
  FOREIGN KEY (organization_id, project_id, sandbox_id)
    REFERENCES oao.sandbox_instances (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, run_id)
    REFERENCES oao.runs (organization_id, project_id, id),
  CHECK (NOT oao.jsonb_has_forbidden_public_key(safe_command)),
  CHECK (safe_result IS NULL OR NOT oao.jsonb_has_forbidden_public_key(safe_result))
);

CREATE TABLE oao.sandbox_artifacts (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  sandbox_id uuid NOT NULL,
  run_id uuid NOT NULL,
  command_id uuid,
  artifact_key text NOT NULL,
  artifact_ref text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, artifact_key),
  FOREIGN KEY (organization_id, project_id, sandbox_id)
    REFERENCES oao.sandbox_instances (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, run_id)
    REFERENCES oao.runs (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, command_id)
    REFERENCES oao.sandbox_commands (organization_id, project_id, id)
);

ALTER TABLE oao.model_invocations
  ADD COLUMN usage_source text NOT NULL DEFAULT 'provider_reported'
    CHECK (usage_source IN ('provider_reported', 'estimated', 'unavailable')),
  ADD COLUMN pricing_snapshot jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN provider_route jsonb NOT NULL DEFAULT '{}',
  ADD CONSTRAINT model_invocations_pricing_safe
    CHECK (NOT oao.jsonb_has_forbidden_public_key(pricing_snapshot)),
  ADD CONSTRAINT model_invocations_route_safe
    CHECK (NOT oao.jsonb_has_forbidden_public_key(provider_route));

ALTER TABLE oao.product_events DROP CONSTRAINT product_events_event_kind_check;
ALTER TABLE oao.product_events ADD CONSTRAINT product_events_event_kind_check CHECK (event_kind IN (
  'run.created', 'run.state_changed', 'run.cancellation_requested', 'message.created',
  'tool_call.requested', 'tool_call.claimed', 'tool_call.result_submitted', 'tool_call.result_committed',
  'approval.requested', 'approval.resolved', 'sandbox.created', 'sandbox.started',
  'sandbox.stopped', 'sandbox.failed', 'sandbox.command_started', 'sandbox.command_completed',
  'sandbox.command_failed', 'model.invocation_completed', 'model.invocation_failed',
  'runtime.dispatch_reserved', 'runtime.dispatch_admitted', 'runtime.dispatch_reconciled',
  'runtime.recovery_started', 'runtime.recovery_completed', 'runtime.cancellation_draining',
  'session.summary_changed'
));

CREATE FUNCTION oao.enqueue_runtime_wake(
  p_organization_id uuid, p_project_id uuid, p_id uuid, p_run_id uuid,
  p_dispatch_key text, p_request_hash bytea, p_kind text, p_payload_public jsonb,
  p_available_at timestamptz DEFAULT clock_timestamp()
) RETURNS oao.runtime_wake_jobs LANGUAGE plpgsql AS $$
DECLARE job oao.runtime_wake_jobs;
BEGIN
  INSERT INTO oao.runtime_wake_jobs (
    organization_id, project_id, id, run_id, dispatch_key, request_hash,
    kind, payload_public, available_at
  ) VALUES (
    p_organization_id, p_project_id, p_id, p_run_id, p_dispatch_key,
    p_request_hash, p_kind, p_payload_public, p_available_at
  ) ON CONFLICT (organization_id, project_id, dispatch_key) DO NOTHING;
  SELECT * INTO job FROM oao.runtime_wake_jobs
    WHERE organization_id = p_organization_id AND project_id = p_project_id
      AND dispatch_key = p_dispatch_key FOR UPDATE;
  IF job.request_hash <> p_request_hash OR job.kind <> p_kind OR job.run_id <> p_run_id THEN
    RAISE EXCEPTION 'runtime wake idempotency conflict' USING ERRCODE = '22023';
  END IF;
  RETURN job;
END
$$;

CREATE FUNCTION oao.claim_runtime_wakes(
  p_worker_id text, p_limit integer, p_lease interval
) RETURNS SETOF oao.runtime_wake_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, oao AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'runtime wake claim limit out of range' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT organization_id, project_id, id
    FROM oao.runtime_wake_jobs
    WHERE (state = 'pending' OR (state = 'leased' AND lease_expires_at <= clock_timestamp()))
      AND available_at <= clock_timestamp()
    ORDER BY available_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE oao.runtime_wake_jobs jobs
  SET state = 'leased', lease_owner = p_worker_id,
      lease_expires_at = clock_timestamp() + p_lease,
      lease_fence = jobs.lease_fence + 1, attempts = jobs.attempts + 1,
      updated_at = clock_timestamp()
  FROM candidates
  WHERE jobs.organization_id = candidates.organization_id
    AND jobs.project_id = candidates.project_id AND jobs.id = candidates.id
  RETURNING jobs.*;
END
$$;

CREATE FUNCTION oao.complete_runtime_wake(
  p_organization_id uuid, p_project_id uuid, p_id uuid,
  p_worker_id text, p_fence bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, oao AS $$
BEGIN
  UPDATE oao.runtime_wake_jobs SET state = 'completed', lease_owner = NULL,
    lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_id
    AND state = 'leased' AND lease_owner = p_worker_id AND lease_fence = p_fence
    AND lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'stale runtime wake fence' USING ERRCODE = '55000'; END IF;
END
$$;

CREATE FUNCTION oao.retry_runtime_wake(
  p_organization_id uuid, p_project_id uuid, p_id uuid,
  p_worker_id text, p_fence bigint, p_delay interval, p_safe_error jsonb,
  p_dead boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, oao AS $$
BEGIN
  UPDATE oao.runtime_wake_jobs SET state = CASE WHEN p_dead
    THEN 'dead'::oao.runtime_wake_state ELSE 'pending'::oao.runtime_wake_state END,
    lease_owner = NULL, lease_expires_at = NULL,
    available_at = clock_timestamp() + p_delay, safe_error = p_safe_error,
    updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_id
    AND state = 'leased' AND lease_owner = p_worker_id AND lease_fence = p_fence;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale runtime wake fence' USING ERRCODE = '55000'; END IF;
END
$$;

CREATE FUNCTION oao.list_runtime_recovery_heads()
RETURNS TABLE (organization_id uuid, project_id uuid, run_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
  SELECT h.organization_id, h.project_id, h.run_id
  FROM oao.thread_admission_heads h
  ORDER BY h.updated_at
$$;

CREATE FUNCTION oao.runtime_has_active_dispatches()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
  SELECT EXISTS (
    SELECT 1 FROM oao.runtime_dispatches WHERE state <> 'settled'
  )
$$;

COMMENT ON FUNCTION oao.list_runtime_recovery_heads() IS
  'Cross-tenant runtime recovery helper. Ownership remains with the privileged migration role, which must have BYPASSRLS; never transfer to oao_app.';
COMMENT ON FUNCTION oao.runtime_has_active_dispatches() IS
  'Cross-tenant runtime shutdown helper. Ownership remains with the privileged migration role, which must have BYPASSRLS; never transfer to oao_app.';
REVOKE ALL ON FUNCTION oao.list_runtime_recovery_heads() FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.runtime_has_active_dispatches() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.list_runtime_recovery_heads() TO oao_app;
GRANT EXECUTE ON FUNCTION oao.runtime_has_active_dispatches() TO oao_app;

CREATE FUNCTION oao.publish_runtime_tool_call(
  p_organization_id uuid, p_project_id uuid, p_id uuid, p_run_id uuid,
  p_flue_tool_call_ref text, p_request_key text, p_request_hash bytea,
  p_tool_name text, p_owner oao.tool_owner, p_safe_arguments jsonb
) RETURNS oao.tool_calls LANGUAGE plpgsql AS $$
DECLARE call oao.tool_calls;
BEGIN
  INSERT INTO oao.tool_calls (
    organization_id, project_id, id, run_id, tool_name, owner, stage,
    safe_arguments, flue_tool_call_ref, request_key, request_hash
  ) VALUES (
    p_organization_id, p_project_id, p_id, p_run_id, p_tool_name, p_owner,
    CASE WHEN p_owner = 'caller' THEN 'caller_pending'::oao.tool_stage ELSE 'platform_ready'::oao.tool_stage END,
    p_safe_arguments, p_flue_tool_call_ref, p_request_key, p_request_hash
  ) ON CONFLICT (organization_id, project_id, request_key) DO NOTHING;
  SELECT * INTO call FROM oao.tool_calls
    WHERE organization_id = p_organization_id AND project_id = p_project_id
      AND request_key = p_request_key FOR UPDATE;
  IF call.request_hash <> p_request_hash OR call.run_id <> p_run_id
     OR call.flue_tool_call_ref <> p_flue_tool_call_ref OR call.tool_name <> p_tool_name
     OR call.owner <> p_owner THEN
    RAISE EXCEPTION 'runtime tool request idempotency conflict' USING ERRCODE = '22023';
  END IF;
  RETURN call;
END
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'runtime_wake_jobs', 'runtime_thread_instances', 'runtime_dispatches', 'sandbox_instances',
    'sandbox_commands', 'sandbox_artifacts'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON oao.runtime_wake_jobs, oao.runtime_thread_instances, oao.runtime_dispatches,
  oao.sandbox_instances, oao.sandbox_commands, oao.sandbox_artifacts TO oao_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA oao FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA oao TO oao_app;
