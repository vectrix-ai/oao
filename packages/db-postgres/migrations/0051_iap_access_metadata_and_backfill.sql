-- Re-run the 0049 backfill under the cross-tenant auth role. Cloud SQL
-- migration logins cannot bypass FORCE RLS, even when they own these tables.
DO $$
DECLARE
  migration_role name := current_user;
  granted_membership boolean := NOT pg_has_role(current_user,'oao_auth','SET');
BEGIN
  PERFORM set_config('oao.migration_granted_auth',granted_membership::text,true);
  IF granted_membership THEN
    EXECUTE format('GRANT oao_auth TO %I WITH SET TRUE, INHERIT TRUE',migration_role);
  END IF;
END
$$;

GRANT CREATE ON SCHEMA oao TO oao_auth;
SET ROLE oao_auth;

UPDATE oao.api_keys key
SET created_by_iap_subject=identity.provider_subject
FROM oao.auth_identities identity
WHERE identity.organization_id=key.organization_id
  AND identity.principal_id=key.created_by_principal_id
  AND identity.provider='iap'
  AND key.created_by_iap_subject IS NULL;

UPDATE oao.api_keys key
SET created_by_api_key_id=parent.id
FROM oao.principals creator
JOIN oao.api_keys parent
  ON parent.organization_id=creator.organization_id
 AND creator.subject='api-key:' || parent.id::text
WHERE creator.organization_id=key.organization_id
  AND creator.id=key.created_by_principal_id
  AND creator.kind='api_key'
  AND key.created_by_api_key_id IS NULL;

-- Expose only whether the caller's current project is the authentication anchor.
CREATE FUNCTION oao.is_iap_default_project() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
  SELECT EXISTS (
    SELECT 1 FROM oao.iap_default_tenant defaults
    WHERE defaults.organization_id=oao.current_organization_id()
      AND defaults.project_id=oao.current_project_id()
  )
$$;
REVOKE ALL ON FUNCTION oao.is_iap_default_project() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_iap_default_project() TO oao_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA oao FROM oao_auth;
DO $$
BEGIN
  IF current_setting('oao.migration_granted_auth',true)::boolean THEN
    EXECUTE format('REVOKE oao_auth FROM %I',current_user);
  END IF;
END
$$;
