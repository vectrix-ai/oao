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

CREATE POLICY recovery_visibility ON oao.thread_admission_heads
  FOR SELECT TO oao_recovery
  USING (true);

CREATE POLICY recovery_visibility ON oao.runtime_dispatches
  FOR SELECT TO oao_recovery
  USING (true);

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
    EXECUTE format('GRANT oao_recovery TO %I', migration_role);
  END IF;

  GRANT CREATE ON SCHEMA oao TO oao_recovery;
  ALTER FUNCTION oao.list_runtime_recovery_heads() OWNER TO oao_recovery;
  ALTER FUNCTION oao.runtime_has_active_dispatches() OWNER TO oao_recovery;
  REVOKE CREATE ON SCHEMA oao FROM oao_recovery;

  IF granted_membership THEN
    EXECUTE format('REVOKE oao_recovery FROM %I', migration_role);
  END IF;
END
$$;

REVOKE ALL ON FUNCTION oao.list_runtime_recovery_heads() FROM PUBLIC, oao_app;
REVOKE ALL ON FUNCTION oao.runtime_has_active_dispatches() FROM PUBLIC, oao_app;
GRANT EXECUTE ON FUNCTION oao.list_runtime_recovery_heads() TO oao_app;
GRANT EXECUTE ON FUNCTION oao.runtime_has_active_dispatches() TO oao_app;

COMMENT ON FUNCTION oao.list_runtime_recovery_heads() IS
  'Cross-tenant runtime recovery helper owned by the NOLOGIN oao_recovery role, whose RLS policy exposes only the required recovery table.';
COMMENT ON FUNCTION oao.runtime_has_active_dispatches() IS
  'Cross-tenant runtime shutdown helper owned by the NOLOGIN oao_recovery role, whose RLS policy exposes only the required recovery table.';
