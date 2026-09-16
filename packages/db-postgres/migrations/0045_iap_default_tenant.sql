-- Installation defaults are application data, not deployment inputs. Only this
-- bounded bootstrap function may initialize them; ordinary tenant writes cannot.
CREATE TABLE oao.iap_default_tenant (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  expected_audience text NOT NULL,
  setup_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects(organization_id, id)
);
ALTER TABLE oao.iap_default_tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.iap_default_tenant FORCE ROW LEVEL SECURITY;
REVOKE ALL ON oao.iap_default_tenant FROM PUBLIC, oao_app;
GRANT SELECT, INSERT ON oao.iap_default_tenant TO oao_auth;
GRANT UPDATE (setup_completed_at) ON oao.iap_default_tenant TO oao_auth;
CREATE POLICY auth_bootstrap_access ON oao.iap_default_tenant
  FOR ALL TO oao_auth USING (true) WITH CHECK (true);

CREATE FUNCTION oao.ensure_iap_default_tenant(p_expected_audience text)
RETURNS TABLE (organization_id uuid, project_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE
  default_organization_name CONSTANT text := 'Default organization';
  default_project_name CONSTANT text := 'Default project';
  selected_organization_id uuid;
  selected_project_id uuid;
  saved_audience text;
  matching_links bigint;
BEGIN
  IF p_expected_audience IS NULL OR p_expected_audience !~
    '^/projects/[0-9]+/locations/[a-z0-9-]+/services/[a-z0-9-]+$' THEN
    RAISE EXCEPTION 'A Cloud Run IAP audience is required' USING ERRCODE = '22023';
  END IF;

  -- Concurrent API starts must create/adopt exactly one default atomically.
  PERFORM pg_advisory_xact_lock(hashtextextended('oao.iap_default_tenant', 0));
  SELECT defaults.organization_id, defaults.project_id, defaults.expected_audience
    INTO selected_organization_id, selected_project_id, saved_audience
    FROM oao.iap_default_tenant AS defaults WHERE defaults.singleton;
  IF FOUND THEN
    IF saved_audience <> p_expected_audience OR NOT EXISTS (
      SELECT 1 FROM oao.auth_tenant_links AS link
       WHERE link.organization_id = selected_organization_id
         AND link.project_id = selected_project_id AND link.provider = 'iap'
         AND link.provider_tenant_id = p_expected_audience
    ) THEN
      RAISE EXCEPTION 'IAP default tenant audience/link mismatch; operator review required';
    END IF;
    RETURN QUERY SELECT selected_organization_id, selected_project_id;
    RETURN;
  END IF;

  -- Adopt an explicitly provisioned IAP link, never the first organization or
  -- a name/slug match. Preserve its IDs, names, users, roles and project data.
  SELECT count(*) INTO matching_links FROM oao.auth_tenant_links AS link
   WHERE link.provider = 'iap' AND link.provider_tenant_id = p_expected_audience;
  IF matching_links > 1 THEN
    RAISE EXCEPTION 'Multiple IAP tenants match; explicitly select the default in the database before startup';
  ELSIF matching_links = 1 THEN
    SELECT link.organization_id, link.project_id
      INTO selected_organization_id, selected_project_id
      FROM oao.auth_tenant_links AS link
     WHERE link.provider = 'iap' AND link.provider_tenant_id = p_expected_audience;
    -- A human is copied to a new project with a fresh principal UUID. Verify
    -- organization and project ownership independently so a valid copied
    -- owner from the previous provisioning contract remains adoptable.
    IF NOT EXISTS (
      SELECT 1 FROM oao.organization_members om
      JOIN oao.principals p
        ON p.organization_id=om.organization_id AND p.id=om.principal_id
      WHERE om.organization_id=selected_organization_id
        AND om.role='owner' AND p.kind='human'
    ) OR NOT EXISTS (
      SELECT 1 FROM oao.project_members pm
      JOIN oao.principals p
        ON p.organization_id=pm.organization_id AND p.project_id=pm.project_id
       AND p.id=pm.principal_id
      WHERE pm.organization_id=selected_organization_id
        AND pm.project_id=selected_project_id
        AND pm.role='owner' AND p.kind='human'
    ) THEN
      RAISE EXCEPTION 'Existing IAP tenant has no owner; operator review required';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM oao.organizations) THEN
      RAISE EXCEPTION 'Existing installation has no matching IAP default; operator review required';
    END IF;
    selected_organization_id := gen_random_uuid();
    selected_project_id := gen_random_uuid();
    INSERT INTO oao.organizations (id, slug, name)
      VALUES (selected_organization_id, 'default', default_organization_name);
    INSERT INTO oao.projects (organization_id, id, slug, name)
      VALUES (selected_organization_id, selected_project_id, 'default', default_project_name);
    INSERT INTO oao.auth_tenant_links (organization_id, project_id, provider, provider_tenant_id)
      VALUES (selected_organization_id, selected_project_id, 'iap', p_expected_audience);
  END IF;

  INSERT INTO oao.iap_default_tenant (organization_id, project_id, expected_audience, setup_completed_at)
    VALUES (selected_organization_id, selected_project_id, p_expected_audience,
      CASE WHEN matching_links=1 THEN clock_timestamp() ELSE NULL END);
  RETURN QUERY SELECT selected_organization_id, selected_project_id;
END
$$;
REVOKE ALL ON FUNCTION oao.ensure_iap_default_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.ensure_iap_default_tenant(text) TO oao_app;

-- Called inside the onboarding transaction. A later insert/audit failure also
-- rolls back the claim. The marker never resets when memberships are removed.
CREATE FUNCTION oao.claim_iap_initial_owner(p_organization_id uuid, p_project_id uuid, p_expected_audience text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oao
AS $$
DECLARE
  defaults oao.iap_default_tenant;
BEGIN
  SELECT * INTO defaults FROM oao.iap_default_tenant WHERE singleton FOR UPDATE;
  IF NOT FOUND OR defaults.organization_id IS DISTINCT FROM p_organization_id
    OR defaults.project_id IS DISTINCT FROM p_project_id
    OR defaults.expected_audience IS DISTINCT FROM p_expected_audience THEN
    RAISE EXCEPTION 'IAP default tenant mismatch; operator review required';
  END IF;
  IF defaults.setup_completed_at IS NOT NULL THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM oao.principals WHERE organization_id=p_organization_id) THEN
    RAISE EXCEPTION 'Pending installation already has identities; operator review required';
  END IF;
  UPDATE oao.iap_default_tenant SET setup_completed_at=clock_timestamp() WHERE singleton;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION oao.claim_iap_initial_owner(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.claim_iap_initial_owner(uuid,uuid,text) TO oao_app;

-- Follow the Cloud SQL-compatible non-superuser ownership transfer pattern.
DO $$
DECLARE
  migration_role name := current_user;
  granted_membership boolean := NOT pg_has_role(current_user, 'oao_auth', 'SET');
BEGIN
  IF granted_membership THEN
    EXECUTE format('GRANT oao_auth TO %I WITH SET TRUE, INHERIT TRUE', migration_role);
  END IF;
  GRANT CREATE ON SCHEMA oao TO oao_auth;
  ALTER FUNCTION oao.ensure_iap_default_tenant(text) OWNER TO oao_auth;
  ALTER FUNCTION oao.claim_iap_initial_owner(uuid,uuid,text) OWNER TO oao_auth;
  REVOKE CREATE ON SCHEMA oao FROM oao_auth;
  EXECUTE format('GRANT EXECUTE ON FUNCTION oao.ensure_iap_default_tenant(text) TO %I', migration_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oao.claim_iap_initial_owner(uuid,uuid,text) TO %I', migration_role);
  IF granted_membership THEN
    EXECUTE format('REVOKE oao_auth FROM %I', migration_role);
  END IF;
END
$$;
