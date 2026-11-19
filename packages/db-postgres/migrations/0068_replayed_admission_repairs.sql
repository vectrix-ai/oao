-- Chats broken by a replayed admission. Before 0067 a runtime wake could run
-- again after its lease expired. Replaying the admission of a run that had
-- already settled marked the thread's runtime instance corrupt
-- (flue_incarnation_mismatch), and every later run of the chat failed.
--
-- This migration only finds candidates: the runtime worker repairs each one
-- once at startup, after it has confirmed that Flue still stores the same
-- conversation identity, which only Flue can read. A thread corrupted for any
-- other reason never matches, and an empty database records nothing.

CREATE TABLE oao.runtime_incarnation_repairs (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  -- The thread's first incarnation-corrupt event and the run it names: the
  -- replayed run itself, or the run that held the thread's admission then.
  corruption_event_id uuid NOT NULL,
  affected_run_id uuid NOT NULL,
  -- The settled run whose admission wake ran again.
  replayed_run_id uuid NOT NULL,
  corrupted_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'repaired', 'skipped')),
  outcome_code text,
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY (organization_id, project_id, thread_id),
  FOREIGN KEY (organization_id, project_id, thread_id)
    REFERENCES oao.runtime_thread_instances (organization_id, project_id, thread_id)
    ON DELETE CASCADE,
  CHECK ((state = 'pending') = (resolved_at IS NULL))
);

-- Records every candidate thread once and returns how many it added. It reads
-- across tenants, so only the migration (below) and the test administrator
-- call it.
-- The signature, every part required:
-- 1. the thread instance is corrupt with code flue_incarnation_mismatch and a
--    bound Flue UID;
-- 2. its first runtime.recovery_completed event with outcome failed and that
--    code, which only the admission-path corruption writer appends, names a
--    run of the thread (the projection-path writer appends no event);
-- 3. another or the same run of the thread had settled, with a settled
--    dispatch, before that event;
-- 4. that run's admission wake (admit, reconcile, tool_result or approval,
--    all handled by admission) had been claimed more than once and last
--    changed at or after the event: it ran again after the run settled.
CREATE FUNCTION oao.detect_replayed_admission_repairs()
RETURNS integer LANGUAGE plpgsql
SET search_path = pg_catalog, oao
AS $$
DECLARE added integer;
BEGIN
  INSERT INTO oao.runtime_incarnation_repairs (
    organization_id, project_id, thread_id, corruption_event_id,
    affected_run_id, replayed_run_id, corrupted_at
  )
  SELECT first_event.organization_id, first_event.project_id,
         first_event.thread_id, first_event.event_id, first_event.affected_run_id,
         replayed.run_id, first_event.occurred_at
  FROM (
    SELECT DISTINCT ON (instance.organization_id, instance.project_id, instance.thread_id)
           instance.organization_id, instance.project_id, instance.thread_id,
           event.id AS event_id, event.aggregate_id AS affected_run_id,
           event.occurred_at
    FROM oao.runtime_thread_instances instance
    JOIN oao.runs run
      ON run.organization_id = instance.organization_id
     AND run.project_id = instance.project_id
     AND run.thread_id = instance.thread_id
    JOIN oao.product_events event
      ON event.organization_id = run.organization_id
     AND event.project_id = run.project_id
     AND event.aggregate_type = 'run'
     AND event.aggregate_id = run.id
     AND event.event_kind = 'runtime.recovery_completed'
     AND event.public_payload->>'outcome' = 'failed'
     AND event.public_payload->>'code' = 'flue_incarnation_mismatch'
    WHERE instance.state = 'corrupt'
      AND instance.safe_error->>'code' = 'flue_incarnation_mismatch'
      AND instance.flue_instance_uid IS NOT NULL
    ORDER BY instance.organization_id, instance.project_id, instance.thread_id,
             event.project_position
  ) first_event
  JOIN LATERAL (
    SELECT run.id AS run_id
    FROM oao.runs run
    JOIN oao.runtime_dispatches dispatch
      ON dispatch.organization_id = run.organization_id
     AND dispatch.project_id = run.project_id
     AND dispatch.run_id = run.id
    WHERE run.organization_id = first_event.organization_id
      AND run.project_id = first_event.project_id
      AND run.thread_id = first_event.thread_id
      AND run.state IN ('completed', 'failed', 'cancelled', 'timed_out')
      AND run.settled_at < first_event.occurred_at
      AND dispatch.state = 'settled'
      AND dispatch.updated_at < first_event.occurred_at
      AND EXISTS (
        SELECT 1 FROM oao.runtime_wake_jobs job
        WHERE job.organization_id = run.organization_id
          AND job.project_id = run.project_id
          AND job.run_id = run.id
          AND job.kind IN ('admit', 'reconcile', 'tool_result', 'approval')
          AND job.attempts >= 2
          AND job.updated_at >= first_event.occurred_at
      )
    ORDER BY run.settled_at DESC, run.id DESC
    LIMIT 1
  ) replayed ON true
  ON CONFLICT (organization_id, project_id, thread_id) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END
$$;
REVOKE ALL ON FUNCTION oao.detect_replayed_admission_repairs() FROM PUBLIC, oao_app;

-- The owner reads tenant tables without tenant context only while finding
-- candidates; row-level security is forced again below.
ALTER TABLE oao.runtime_thread_instances NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.product_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.runtime_dispatches NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.runtime_wake_jobs NO FORCE ROW LEVEL SECURITY;

SELECT oao.detect_replayed_admission_repairs();

ALTER TABLE oao.runtime_thread_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.runs FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.product_events FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.runtime_dispatches FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.runtime_wake_jobs FORCE ROW LEVEL SECURITY;

ALTER TABLE oao.runtime_incarnation_repairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.runtime_incarnation_repairs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.runtime_incarnation_repairs
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());
GRANT SELECT, UPDATE ON oao.runtime_incarnation_repairs TO oao_app;

-- The worker finds pending repairs across tenants through this helper only;
-- it returns identifiers and repairs each thread inside its tenant context.
GRANT SELECT (organization_id, project_id, thread_id, state)
  ON oao.runtime_incarnation_repairs TO oao_recovery;
CREATE POLICY recovery_visibility ON oao.runtime_incarnation_repairs
  FOR SELECT TO oao_recovery
  USING (true);

CREATE FUNCTION oao.list_runtime_incarnation_repairs()
RETURNS TABLE (organization_id uuid, project_id uuid, thread_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
  SELECT repair.organization_id, repair.project_id, repair.thread_id
  FROM oao.runtime_incarnation_repairs repair
  WHERE repair.state = 'pending'
  ORDER BY repair.organization_id, repair.project_id, repair.thread_id
$$;

REVOKE ALL ON FUNCTION oao.list_runtime_incarnation_repairs() FROM PUBLIC, oao_app;
COMMENT ON FUNCTION oao.list_runtime_incarnation_repairs() IS
  'Cross-tenant runtime repair listing owned by the NOLOGIN oao_recovery role; returns only tenant and thread identifiers of pending repairs.';

DO $$
DECLARE
  migration_role name := current_user;
  granted_membership boolean := NOT pg_has_role(current_user, 'oao_recovery', 'SET');
BEGIN
  IF granted_membership THEN
    -- INHERIT is temporary: it lets the migration login grant from the new
    -- function owner after the transfer. The membership is revoked below.
    EXECUTE format('GRANT oao_recovery TO %I WITH SET TRUE, INHERIT TRUE', migration_role);
  END IF;

  GRANT CREATE ON SCHEMA oao TO oao_recovery;
  ALTER FUNCTION oao.list_runtime_incarnation_repairs() OWNER TO oao_recovery;
  REVOKE CREATE ON SCHEMA oao FROM oao_recovery;

  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.list_runtime_incarnation_repairs() TO %I',
    migration_role
  );

  IF granted_membership THEN
    EXECUTE format('REVOKE oao_recovery FROM %I', migration_role);
  END IF;

  IF NOT has_function_privilege(
    migration_role,
    'oao.list_runtime_incarnation_repairs()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'migration/runtime login lacks runtime repair listing execution';
  END IF;
END
$$;
