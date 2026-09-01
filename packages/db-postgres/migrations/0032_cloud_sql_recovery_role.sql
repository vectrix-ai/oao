DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oao_recovery') THEN
    CREATE ROLE oao_recovery NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'oao_recovery'
      AND (
        rolcanlogin
        OR rolsuper
        OR rolcreatedb
        OR rolcreaterole
        OR rolinherit
        OR rolreplication
        OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'oao_recovery has forbidden privileged attributes';
  END IF;
END
$$;

-- PostgreSQL 17 gives a non-superuser CREATEROLE creator ADMIN membership on
-- newly created roles, but not SET membership. The DEV Cloud SQL runtime and
-- migration login is intentionally the same account, so persist only the
-- ability it needs to enter the least-privilege application role.
GRANT oao_app TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;

GRANT USAGE ON SCHEMA oao TO oao_recovery;
GRANT SELECT ON oao.thread_admission_heads, oao.runtime_dispatches TO oao_recovery;
GRANT SELECT, UPDATE ON oao.runtime_wake_jobs TO oao_recovery;

CREATE POLICY recovery_visibility ON oao.thread_admission_heads
  FOR SELECT TO oao_recovery
  USING (true);

CREATE POLICY recovery_visibility ON oao.runtime_dispatches
  FOR SELECT TO oao_recovery
  USING (true);

CREATE POLICY recovery_visibility ON oao.runtime_wake_jobs
  FOR ALL TO oao_recovery
  USING (true)
  WITH CHECK (true);

-- Projection observations arrive with provider correlation IDs before tenant
-- context is known. Resolve only the dispatch metadata needed to establish
-- that context; do not expose a general cross-tenant table read.
CREATE FUNCTION oao.find_runtime_dispatch(
  p_flue_submission_id text,
  p_flue_conversation_id text
) RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  run_id uuid,
  thread_id uuid,
  admission_key text,
  request_hash bytea,
  snapshot_hash bytea,
  state oao.runtime_dispatch_state,
  fence bigint,
  flue_conversation_id text,
  flue_submission_id text,
  flue_instance_uid text,
  flue_accepted_at timestamptz,
  deadline_at timestamptz,
  timeout_requested_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
  SELECT d.organization_id,d.project_id,d.run_id,d.thread_id,
         d.admission_key,d.request_hash,d.snapshot_hash,d.state,d.fence,
         d.flue_conversation_id,d.flue_submission_id,d.flue_instance_uid,
         d.flue_accepted_at,d.deadline_at,d.timeout_requested_at
  FROM oao.runtime_dispatches d
  WHERE (
    p_flue_submission_id <> ''
    AND d.flue_submission_id = p_flue_submission_id
  ) OR (
    p_flue_submission_id = ''
    AND p_flue_conversation_id <> ''
    AND d.flue_conversation_id = p_flue_conversation_id
  )
  ORDER BY CASE WHEN d.state <> 'settled' THEN 0 ELSE 1 END,d.created_at DESC
  LIMIT 1
$$;

-- Set the final ACL while the migration role still owns the functions. Once
-- ownership is transferred to the NOLOGIN recovery role, the migration login
-- must not retain role membership merely to change these privileges.
REVOKE ALL ON FUNCTION oao.list_runtime_recovery_heads() FROM PUBLIC, oao_app;
REVOKE ALL ON FUNCTION oao.runtime_has_active_dispatches() FROM PUBLIC, oao_app;
REVOKE ALL ON FUNCTION oao.find_runtime_dispatch(text,text) FROM PUBLIC, oao_app;
REVOKE ALL ON FUNCTION oao.claim_runtime_wakes(text,integer,interval) FROM PUBLIC, oao_app;
REVOKE ALL ON FUNCTION oao.complete_runtime_wake(uuid,uuid,uuid,text,bigint) FROM PUBLIC, oao_app;
REVOKE ALL ON FUNCTION oao.retry_runtime_wake(uuid,uuid,uuid,text,bigint,interval,jsonb,boolean) FROM PUBLIC, oao_app;
GRANT EXECUTE ON FUNCTION oao.list_runtime_recovery_heads() TO oao_app;
GRANT EXECUTE ON FUNCTION oao.runtime_has_active_dispatches() TO oao_app;
COMMENT ON FUNCTION oao.list_runtime_recovery_heads() IS
  'Cross-tenant runtime recovery helper owned by the NOLOGIN oao_recovery role, whose RLS policy exposes only the required recovery table.';
COMMENT ON FUNCTION oao.runtime_has_active_dispatches() IS
  'Cross-tenant runtime shutdown helper owned by the NOLOGIN oao_recovery role, whose RLS policy exposes only the required recovery table.';
COMMENT ON FUNCTION oao.find_runtime_dispatch(text,text) IS
  'Cross-tenant runtime projection lookup by opaque provider correlation ID; returns only dispatch metadata needed to establish tenant context.';
COMMENT ON FUNCTION oao.claim_runtime_wakes(text,integer,interval) IS
  'Cross-tenant runtime worker lease claim owned by the NOLOGIN oao_recovery role and bounded by limit and lease inputs.';
COMMENT ON FUNCTION oao.complete_runtime_wake(uuid,uuid,uuid,text,bigint) IS
  'Cross-tenant runtime worker completion owned by the NOLOGIN oao_recovery role and guarded by worker and lease fences.';
COMMENT ON FUNCTION oao.retry_runtime_wake(uuid,uuid,uuid,text,bigint,interval,jsonb,boolean) IS
  'Cross-tenant runtime worker retry owned by the NOLOGIN oao_recovery role and guarded by worker and lease fences.';

DO $$
DECLARE
  migration_role name := current_user;
  granted_membership boolean := NOT pg_has_role(
    current_user,
    'oao_recovery',
    'SET'
  );
BEGIN
  IF granted_membership THEN
    -- INHERIT is temporary: it lets the migration login grant from the new
    -- function owner after the transfer. The membership is revoked below.
    EXECUTE format(
      'GRANT oao_recovery TO %I WITH SET TRUE, INHERIT TRUE',
      migration_role
    );
  END IF;

  GRANT CREATE ON SCHEMA oao TO oao_recovery;
  ALTER FUNCTION oao.list_runtime_recovery_heads() OWNER TO oao_recovery;
  ALTER FUNCTION oao.runtime_has_active_dispatches() OWNER TO oao_recovery;
  ALTER FUNCTION oao.find_runtime_dispatch(text,text) OWNER TO oao_recovery;
  ALTER FUNCTION oao.claim_runtime_wakes(text,integer,interval) OWNER TO oao_recovery;
  ALTER FUNCTION oao.complete_runtime_wake(uuid,uuid,uuid,text,bigint) OWNER TO oao_recovery;
  ALTER FUNCTION oao.retry_runtime_wake(uuid,uuid,uuid,text,bigint,interval,jsonb,boolean) OWNER TO oao_recovery;
  REVOKE CREATE ON SCHEMA oao FROM oao_recovery;

  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.list_runtime_recovery_heads() TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.runtime_has_active_dispatches() TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.find_runtime_dispatch(text,text) TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.claim_runtime_wakes(text,integer,interval) TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.complete_runtime_wake(uuid,uuid,uuid,text,bigint) TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.retry_runtime_wake(uuid,uuid,uuid,text,bigint,interval,jsonb,boolean) TO %I',
    migration_role
  );

  IF granted_membership THEN
    EXECUTE format('REVOKE oao_recovery FROM %I', migration_role);
  END IF;

  IF NOT has_function_privilege(
    migration_role,
    'oao.list_runtime_recovery_heads()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    migration_role,
    'oao.runtime_has_active_dispatches()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    migration_role,
    'oao.find_runtime_dispatch(text,text)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    migration_role,
    'oao.claim_runtime_wakes(text,integer,interval)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    migration_role,
    'oao.complete_runtime_wake(uuid,uuid,uuid,text,bigint)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    migration_role,
    'oao.retry_runtime_wake(uuid,uuid,uuid,text,bigint,interval,jsonb,boolean)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'migration/runtime login lacks recovery function execution';
  END IF;
END
$$;
