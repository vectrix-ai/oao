-- Projects copy human principals with fresh UUIDs while organization membership
-- remains attached to the source-project principal. Keep existing IAP tenant
-- adoption compatible with that supported shape.
DO $migration$
DECLARE
  migration_role name := current_user;
  granted_membership boolean := NOT pg_has_role(current_user,'oao_auth','SET');
BEGIN
  IF granted_membership THEN
    EXECUTE format('GRANT oao_auth TO %I WITH SET TRUE, INHERIT TRUE',migration_role);
  END IF;
  EXECUTE $function$
    CREATE OR REPLACE FUNCTION oao.ensure_iap_default_tenant(p_expected_audience text)
    RETURNS TABLE (organization_id uuid, project_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, oao
    AS $body$
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
      SELECT count(*) INTO matching_links FROM oao.auth_tenant_links AS link
       WHERE link.provider = 'iap' AND link.provider_tenant_id = p_expected_audience;
      IF matching_links > 1 THEN
        RAISE EXCEPTION 'Multiple IAP tenants match; explicitly select the default in the database before startup';
      ELSIF matching_links = 1 THEN
        SELECT link.organization_id, link.project_id
          INTO selected_organization_id, selected_project_id
          FROM oao.auth_tenant_links AS link
         WHERE link.provider = 'iap' AND link.provider_tenant_id = p_expected_audience;
        IF NOT EXISTS (
          SELECT 1 FROM oao.organization_members om
          JOIN oao.principals organization_owner
            ON organization_owner.organization_id=om.organization_id
           AND organization_owner.id=om.principal_id
           AND organization_owner.kind='human'
          JOIN oao.auth_identities organization_identity
            ON organization_identity.organization_id=organization_owner.organization_id
           AND organization_identity.project_id=organization_owner.project_id
           AND organization_identity.principal_id=organization_owner.id
           AND organization_identity.provider='iap'
          JOIN oao.auth_identities project_identity
            ON project_identity.organization_id=organization_identity.organization_id
           AND project_identity.project_id=selected_project_id
           AND project_identity.provider='iap'
           AND project_identity.provider_subject=organization_identity.provider_subject
          JOIN oao.principals project_owner
            ON project_owner.organization_id=project_identity.organization_id
           AND project_owner.project_id=project_identity.project_id
           AND project_owner.id=project_identity.principal_id
           AND project_owner.kind='human'
          JOIN oao.project_members pm
            ON pm.organization_id=project_owner.organization_id
           AND pm.project_id=project_owner.project_id
           AND pm.principal_id=project_owner.id
           AND pm.role='owner'
          WHERE om.organization_id=selected_organization_id AND om.role='owner'
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
    $body$
  $function$;
  IF granted_membership THEN
    EXECUTE format('REVOKE oao_auth FROM %I',migration_role);
  END IF;
END
$migration$;
