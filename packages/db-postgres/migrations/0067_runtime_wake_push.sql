-- Runtime wakes: push, per-job lease renewal, an index-driven claim, and the
-- read-path indexes behind session detail. Every statement runs inside the
-- migrator's transaction, so the indexes are built without CONCURRENTLY.

-- A due wake notifies the runtime workers at commit; their poll is only a
-- fallback. A wake due more than a second from now (a run deadline, a retry
-- backoff) is found by that poll instead.
CREATE OR REPLACE FUNCTION oao.enqueue_runtime_wake(
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
  IF job.state = 'pending' AND job.available_at <= clock_timestamp() + interval '1 second' THEN
    PERFORM pg_notify('oao_runtime_wakes', '');
  END IF;
  RETURN job;
END
$$;

-- The claim reads two partial indexes in their own order: due pending wakes,
-- then leases that expired. Future deadline wakes and completed history are
-- never scanned.
DROP INDEX oao.runtime_wake_jobs_claim_idx;
CREATE INDEX runtime_wake_jobs_pending_idx
  ON oao.runtime_wake_jobs (available_at, created_at)
  WHERE state = 'pending';
CREATE INDEX runtime_wake_jobs_lease_expiry_idx
  ON oao.runtime_wake_jobs (lease_expires_at)
  WHERE state = 'leased';

-- Replacing functions owned by the NOLOGIN recovery role needs its privileges
-- until the end of this migration. INHERIT is temporary and revoked below.
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'oao_recovery', 'USAGE') THEN
    EXECUTE format(
      'GRANT oao_recovery TO %I WITH SET TRUE, INHERIT TRUE',
      current_user
    );
    PERFORM set_config('oao.migration_recovery_membership', 'granted', true);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION oao.claim_runtime_wakes(
  p_worker_id text, p_limit integer, p_lease interval
) RETURNS SETOF oao.runtime_wake_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, oao AS $$
DECLARE
  -- A value, not clock_timestamp() itself, so each branch can use it as an
  -- index condition and stop at the first wake that is not due yet.
  claimed_at timestamptz := clock_timestamp();
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'runtime wake claim limit out of range' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT organization_id, project_id, id, available_at, created_at
    FROM oao.runtime_wake_jobs
    WHERE state = 'pending' AND available_at <= claimed_at
    ORDER BY available_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), expired AS (
    SELECT organization_id, project_id, id, available_at, created_at
    FROM oao.runtime_wake_jobs
    WHERE state = 'leased' AND lease_expires_at <= claimed_at
      AND available_at <= claimed_at
    ORDER BY lease_expires_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), candidates AS (
    SELECT organization_id, project_id, id
    FROM (SELECT * FROM expired UNION ALL SELECT * FROM due) unclaimed
    ORDER BY available_at, created_at
    LIMIT p_limit
  )
  UPDATE oao.runtime_wake_jobs jobs
  SET state = 'leased', lease_owner = p_worker_id,
      lease_expires_at = claimed_at + p_lease,
      lease_fence = jobs.lease_fence + 1, attempts = jobs.attempts + 1,
      updated_at = clock_timestamp()
  FROM candidates
  WHERE jobs.organization_id = candidates.organization_id
    AND jobs.project_id = candidates.project_id AND jobs.id = candidates.id
  RETURNING jobs.*;
END
$$;

-- Owner, state and fence prove nobody re-claimed the job, so a handler that
-- outlived its lease still completes it instead of replaying it.
CREATE OR REPLACE FUNCTION oao.complete_runtime_wake(
  p_organization_id uuid, p_project_id uuid, p_id uuid,
  p_worker_id text, p_fence bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, oao AS $$
BEGIN
  UPDATE oao.runtime_wake_jobs SET state = 'completed', lease_owner = NULL,
    lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_id
    AND state = 'leased' AND lease_owner = p_worker_id AND lease_fence = p_fence;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale runtime wake fence' USING ERRCODE = '55000'; END IF;
END
$$;

-- A running handler extends its own lease. False means the job was re-claimed
-- or finished elsewhere and this handler no longer owns it.
CREATE FUNCTION oao.renew_runtime_wake(
  p_organization_id uuid, p_project_id uuid, p_id uuid,
  p_worker_id text, p_fence bigint, p_lease interval
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, oao AS $$
BEGIN
  IF p_lease IS NULL OR p_lease < interval '1 second' OR p_lease > interval '10 minutes' THEN
    RAISE EXCEPTION 'runtime wake lease out of range' USING ERRCODE = '22023';
  END IF;
  UPDATE oao.runtime_wake_jobs SET lease_expires_at = clock_timestamp() + p_lease,
    updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_id
    AND state = 'leased' AND lease_owner = p_worker_id AND lease_fence = p_fence;
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION oao.renew_runtime_wake(uuid,uuid,uuid,text,bigint,interval) FROM PUBLIC, oao_app;
COMMENT ON FUNCTION oao.renew_runtime_wake(uuid,uuid,uuid,text,bigint,interval) IS
  'Cross-tenant runtime worker lease renewal owned by the NOLOGIN oao_recovery role and guarded by worker and lease fences.';

DO $$
DECLARE
  migration_role name := current_user;
  granted_membership boolean :=
    current_setting('oao.migration_recovery_membership', true) = 'granted';
BEGIN
  GRANT CREATE ON SCHEMA oao TO oao_recovery;
  ALTER FUNCTION oao.renew_runtime_wake(uuid,uuid,uuid,text,bigint,interval) OWNER TO oao_recovery;
  REVOKE CREATE ON SCHEMA oao FROM oao_recovery;

  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.renew_runtime_wake(uuid,uuid,uuid,text,bigint,interval) TO %I',
    migration_role
  );

  IF granted_membership THEN
    EXECUTE format('REVOKE oao_recovery FROM %I', migration_role);
  END IF;

  IF NOT has_function_privilege(
    migration_role,
    'oao.renew_runtime_wake(uuid,uuid,uuid,text,bigint,interval)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    migration_role,
    'oao.claim_runtime_wakes(text,integer,interval)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    migration_role,
    'oao.complete_runtime_wake(uuid,uuid,uuid,text,bigint)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'migration/runtime login lacks runtime wake function execution';
  END IF;
END
$$;

-- Session detail and run lists read by session or project, newest first.
CREATE INDEX runs_session_created_idx
  ON oao.runs (organization_id, project_id, session_id, created_at DESC, id DESC);
CREATE INDEX runs_project_created_idx
  ON oao.runs (organization_id, project_id, created_at DESC, id DESC);
CREATE INDEX messages_run_created_idx
  ON oao.messages (organization_id, project_id, run_id, created_at, id);
CREATE INDEX product_events_aggregate_id_idx
  ON oao.product_events (organization_id, project_id, aggregate_id, project_position);
CREATE INDEX approvals_run_idx
  ON oao.approvals (organization_id, project_id, run_id, created_at, id);
CREATE INDEX sandbox_commands_run_idx
  ON oao.sandbox_commands (organization_id, project_id, run_id, created_at, id);
