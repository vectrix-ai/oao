-- Cloud SQL database owners are CREATEROLE users, not PostgreSQL
-- superusers. SECURITY DEFINER functions owned by that login therefore do
-- not bypass FORCE ROW LEVEL SECURITY. Give only the pre-authentication and
-- bootstrap functions a dedicated NOLOGIN owner with explicit table access.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oao_auth') THEN
    CREATE ROLE oao_auth NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'oao_auth'
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
    RAISE EXCEPTION 'oao_auth has forbidden privileged attributes';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA oao TO oao_auth;
GRANT SELECT, INSERT ON oao.organizations, oao.projects TO oao_auth;
GRANT SELECT, INSERT ON
  oao.principals,
  oao.organization_members,
  oao.project_members,
  oao.auth_tenant_links,
  oao.auth_identities
TO oao_auth;
GRANT SELECT, UPDATE ON oao.auth_sessions, oao.api_keys TO oao_auth;
GRANT SELECT, INSERT, UPDATE ON oao.workos_webhook_events TO oao_auth;
GRANT EXECUTE ON FUNCTION oao.jsonb_has_forbidden_public_key(jsonb) TO oao_auth;
GRANT EXECUTE ON FUNCTION oao.is_sensitive_public_key(text) TO oao_auth;

CREATE POLICY cloud_sql_auth_access ON oao.organizations
  FOR ALL TO oao_auth USING (true) WITH CHECK (true);
CREATE POLICY cloud_sql_auth_access ON oao.projects
  FOR ALL TO oao_auth USING (true) WITH CHECK (true);
CREATE POLICY cloud_sql_auth_access ON oao.principals
  FOR ALL TO oao_auth USING (true) WITH CHECK (true);
CREATE POLICY cloud_sql_auth_access ON oao.organization_members
  FOR ALL TO oao_auth USING (true) WITH CHECK (true);
CREATE POLICY cloud_sql_auth_access ON oao.project_members
  FOR ALL TO oao_auth USING (true) WITH CHECK (true);
CREATE POLICY cloud_sql_auth_access ON oao.auth_tenant_links
  FOR ALL TO oao_auth USING (true) WITH CHECK (true);
CREATE POLICY cloud_sql_auth_access ON oao.auth_identities
  FOR ALL TO oao_auth USING (true) WITH CHECK (true);
CREATE POLICY cloud_sql_auth_access ON oao.auth_sessions
  FOR ALL TO oao_auth USING (true) WITH CHECK (true);
CREATE POLICY cloud_sql_auth_access ON oao.api_keys
  FOR ALL TO oao_auth USING (true) WITH CHECK (true);

REVOKE ALL ON FUNCTION oao.bootstrap_project(uuid,text,text,uuid,text,text,uuid,text,text)
  FROM PUBLIC, oao_app;
REVOKE ALL ON FUNCTION oao.authenticate_api_key(text,bytea,uuid,timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.resolve_auth_session(bytea,timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.resolve_workos_principal(text,text,uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.claim_workos_webhook_event(text,text,bytea,timestamptz,interval)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.complete_workos_webhook_event(text,bytea,jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.release_workos_webhook_event(text,bytea,jsonb)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION oao.bootstrap_project(uuid,text,text,uuid,text,text,uuid,text,text)
  TO oao_migrator;
GRANT EXECUTE ON FUNCTION oao.authenticate_api_key(text,bytea,uuid,timestamptz)
  TO oao_app;
GRANT EXECUTE ON FUNCTION oao.resolve_auth_session(bytea,timestamptz)
  TO oao_app;
GRANT EXECUTE ON FUNCTION oao.resolve_workos_principal(text,text,uuid)
  TO oao_app;
GRANT EXECUTE ON FUNCTION oao.claim_workos_webhook_event(text,text,bytea,timestamptz,interval)
  TO oao_app;
GRANT EXECUTE ON FUNCTION oao.complete_workos_webhook_event(text,bytea,jsonb)
  TO oao_app;
GRANT EXECUTE ON FUNCTION oao.release_workos_webhook_event(text,bytea,jsonb)
  TO oao_app;

DO $$
DECLARE
  migration_role name := current_user;
  granted_membership boolean := NOT pg_has_role(
    current_user,
    'oao_auth',
    'SET'
  );
BEGIN
  IF granted_membership THEN
    EXECUTE format(
      'GRANT oao_auth TO %I WITH SET TRUE, INHERIT TRUE',
      migration_role
    );
  END IF;

  GRANT CREATE ON SCHEMA oao TO oao_auth;
  ALTER FUNCTION oao.bootstrap_project(uuid,text,text,uuid,text,text,uuid,text,text)
    OWNER TO oao_auth;
  ALTER FUNCTION oao.authenticate_api_key(text,bytea,uuid,timestamptz)
    OWNER TO oao_auth;
  ALTER FUNCTION oao.resolve_auth_session(bytea,timestamptz)
    OWNER TO oao_auth;
  ALTER FUNCTION oao.resolve_workos_principal(text,text,uuid)
    OWNER TO oao_auth;
  ALTER FUNCTION oao.claim_workos_webhook_event(text,text,bytea,timestamptz,interval)
    OWNER TO oao_auth;
  ALTER FUNCTION oao.complete_workos_webhook_event(text,bytea,jsonb)
    OWNER TO oao_auth;
  ALTER FUNCTION oao.release_workos_webhook_event(text,bytea,jsonb)
    OWNER TO oao_auth;
  REVOKE CREATE ON SCHEMA oao FROM oao_auth;

  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.bootstrap_project(uuid,text,text,uuid,text,text,uuid,text,text) TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.authenticate_api_key(text,bytea,uuid,timestamptz) TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.resolve_auth_session(bytea,timestamptz) TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.resolve_workos_principal(text,text,uuid) TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.claim_workos_webhook_event(text,text,bytea,timestamptz,interval) TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.complete_workos_webhook_event(text,bytea,jsonb) TO %I',
    migration_role
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.release_workos_webhook_event(text,bytea,jsonb) TO %I',
    migration_role
  );

  IF granted_membership THEN
    EXECUTE format('REVOKE oao_auth FROM %I', migration_role);
  END IF;
END
$$;

COMMENT ON ROLE oao_auth IS
  'NOLOGIN owner for bounded cross-tenant authentication and initial bootstrap functions under FORCE RLS.';
