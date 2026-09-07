-- IAP authenticates requests at the edge. OAO verifies the signed assertion
-- again and resolves only identities linked by an explicit operator action.
ALTER TABLE oao.auth_tenant_links
  DROP CONSTRAINT auth_tenant_links_provider_check,
  ADD CONSTRAINT auth_tenant_links_provider_check
    CHECK (provider IN ('development', 'iap', 'workos'));
ALTER TABLE oao.auth_identities
  DROP CONSTRAINT auth_identities_provider_check,
  ADD CONSTRAINT auth_identities_provider_check
    CHECK (provider IN ('development', 'iap', 'workos'));
ALTER TABLE oao.auth_sessions
  DROP CONSTRAINT auth_sessions_provider_check,
  ADD CONSTRAINT auth_sessions_provider_check
    CHECK (provider IN ('development', 'iap', 'workos'));

GRANT SELECT, UPDATE ON oao.auth_identities TO oao_auth;

CREATE FUNCTION oao.resolve_iap_principal(
  p_provider_subject text,
  p_email text,
  p_expected_audience text,
  p_organization_id uuid,
  p_project_id uuid
) RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  principal_id uuid,
  kind text,
  subject text,
  scopes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE
  mapped_principal_id uuid;
BEGIN
  p_provider_subject := btrim(p_provider_subject);
  p_email := lower(btrim(p_email));
  IF length(p_provider_subject) NOT BETWEEN 1 AND 500
    OR length(p_email) NOT BETWEEN 3 AND 320
    OR position('@' IN p_email) <= 1
    OR length(p_expected_audience) NOT BETWEEN 1 AND 500
    OR p_organization_id IS NULL
    OR p_project_id IS NULL
  THEN
    RETURN;
  END IF;

  UPDATE oao.auth_identities AS identity
     SET email = p_email,
         display_name = p_email,
         last_reconciled_at = clock_timestamp(),
         updated_at = clock_timestamp()
   WHERE identity.organization_id = p_organization_id
     AND identity.project_id = p_project_id
     AND identity.provider = 'iap'
     AND identity.provider_subject = p_provider_subject
     AND EXISTS (
       SELECT 1 FROM oao.auth_tenant_links AS tenant
        WHERE tenant.organization_id = identity.organization_id
          AND tenant.project_id = identity.project_id
          AND tenant.provider = 'iap'
          AND tenant.provider_tenant_id = p_expected_audience
     )
   RETURNING identity.principal_id INTO mapped_principal_id;

  -- An operator may pre-authorize a signed IAP email before its immutable sub
  -- is known. The first matching assertion claims that existing mapping; it
  -- never creates a principal or grants membership.
  IF mapped_principal_id IS NULL THEN
    -- Serialize first-use claims for one tenant/email. Without this lock, two
    -- concurrent assertions could race to replace the same pending mapping.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      p_organization_id::text || '/' || p_project_id::text || '/' || p_email,
      0
    ));

    UPDATE oao.auth_identities AS identity
       SET provider_subject = p_provider_subject,
           email = p_email,
           display_name = p_email,
           last_reconciled_at = clock_timestamp(),
           updated_at = clock_timestamp()
     WHERE identity.organization_id = p_organization_id
       AND identity.project_id = p_project_id
       AND identity.provider = 'iap'
       AND identity.provider_subject = 'pending-email:' || p_email
       AND identity.email = p_email
       AND EXISTS (
         SELECT 1 FROM oao.auth_tenant_links AS tenant
          WHERE tenant.organization_id = identity.organization_id
            AND tenant.project_id = identity.project_id
            AND tenant.provider = 'iap'
            AND tenant.provider_tenant_id = p_expected_audience
       )
     RETURNING identity.principal_id INTO mapped_principal_id;
  END IF;

  IF mapped_principal_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT principal.organization_id, principal.project_id, principal.id,
         principal.kind::text, principal.subject, principal.scopes
    FROM oao.principals AS principal
    JOIN oao.project_members AS membership
      ON membership.organization_id = principal.organization_id
     AND membership.project_id = principal.project_id
     AND membership.principal_id = principal.id
   WHERE principal.organization_id = p_organization_id
     AND principal.project_id = p_project_id
     AND principal.id = mapped_principal_id;
END
$$;

REVOKE ALL ON FUNCTION oao.resolve_iap_principal(text,text,text,uuid,uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.resolve_iap_principal(text,text,text,uuid,uuid)
  TO oao_app;

-- Add metadata while the migrator still owns the function.
COMMENT ON FUNCTION oao.resolve_iap_principal(text,text,text,uuid,uuid) IS
  'Resolves an explicitly provisioned Google IAP subject after exact audience verification.';

DO $$
DECLARE
  migration_role name := current_user;
  granted_membership boolean := NOT pg_has_role(current_user, 'oao_auth', 'SET');
BEGIN
  IF granted_membership THEN
    EXECUTE format(
      'GRANT oao_auth TO %I WITH SET TRUE, INHERIT TRUE',
      migration_role
    );
  END IF;

  -- PostgreSQL requires the new owner to have schema CREATE permission
  -- during ownership transfer, even for a database-owner migrator.
  GRANT CREATE ON SCHEMA oao TO oao_auth;
  ALTER FUNCTION oao.resolve_iap_principal(text,text,text,uuid,uuid)
    OWNER TO oao_auth;
  REVOKE CREATE ON SCHEMA oao FROM oao_auth;
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.resolve_iap_principal(text,text,text,uuid,uuid) TO %I',
    migration_role
  );

  IF granted_membership THEN
    EXECUTE format('REVOKE oao_auth FROM %I', migration_role);
  END IF;
END
$$;
