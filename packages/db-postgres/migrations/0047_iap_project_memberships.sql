-- IAP organization roles and project membership are separate concerns. An
-- organization Owner/Admin can grant a verified IAP human access to the
-- current project without changing their organization role, and can revoke
-- only that project access later.

CREATE FUNCTION oao.add_iap_project_member(
  p_organization_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_email text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE
  actor oao.principals;
  actor_identity text;
  actor_role text;
  target_subject text;
  target_email text;
  target_display_name text;
  target_internal_subject text;
  target_role text;
  target_scopes text[];
  target_principal_id uuid;
  matching_subjects integer;
BEGIN
  IF p_organization_id IS DISTINCT FROM oao.current_organization_id()
     OR p_project_id IS DISTINCT FROM oao.current_project_id() THEN
    RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';
  END IF;
  p_email := lower(btrim(p_email));
  IF length(p_email) NOT BETWEEN 3 AND 320 OR position('@' IN p_email) <= 1 THEN
    RAISE EXCEPTION 'A valid IAP user email is required' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('iap-members/' || p_organization_id::text,0));
  SELECT * INTO actor FROM oao.principals p
    WHERE p.organization_id=p_organization_id AND p.project_id=p_project_id
      AND p.id=p_actor_id AND p.kind='human';
  SELECT ai.provider_subject INTO actor_identity FROM oao.auth_identities ai
    WHERE ai.organization_id=p_organization_id AND ai.project_id=p_project_id
      AND ai.principal_id=actor.id AND ai.provider='iap';
  actor_role := oao.iap_identity_role(p_organization_id,actor_identity);
  IF actor.id IS NULL OR actor_identity IS NULL
     OR NOT (actor.scopes && ARRAY['*','project:admin'])
     OR NOT EXISTS (
       SELECT 1 FROM oao.project_members pm
       WHERE pm.organization_id=p_organization_id AND pm.project_id=p_project_id
         AND pm.principal_id=actor.id
     )
     OR COALESCE(actor_role,'') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'An IAP organization owner or admin is required' USING ERRCODE='42501';
  END IF;

  SELECT count(DISTINCT ai.provider_subject)::integer INTO matching_subjects
  FROM oao.auth_identities ai
  JOIN oao.principals p
    ON p.organization_id=ai.organization_id AND p.project_id=ai.project_id
   AND p.id=ai.principal_id AND p.kind='human'
  WHERE ai.organization_id=p_organization_id AND ai.provider='iap'
    AND lower(ai.email)=p_email;
  IF matching_subjects=0 THEN
    RAISE EXCEPTION 'The user must sign in through IAP before project access can be granted'
      USING ERRCODE='P0002';
  ELSIF matching_subjects>1 THEN
    RAISE EXCEPTION 'Multiple IAP identities use this email; operator review is required'
      USING ERRCODE='22023';
  END IF;

  SELECT ai.provider_subject,lower(ai.email),ai.display_name,p.subject
    INTO target_subject,target_email,target_display_name,target_internal_subject
  FROM oao.auth_identities ai
  JOIN oao.principals p
    ON p.organization_id=ai.organization_id AND p.project_id=ai.project_id
   AND p.id=ai.principal_id AND p.kind='human'
  WHERE ai.organization_id=p_organization_id AND ai.provider='iap'
    AND lower(ai.email)=p_email
  ORDER BY ai.updated_at DESC,ai.project_id,ai.principal_id LIMIT 1;
  IF target_subject=actor_identity THEN
    RAISE EXCEPTION 'The active principal already has project access' USING ERRCODE='22023';
  END IF;
  target_role := oao.iap_identity_role(p_organization_id,target_subject);
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'The IAP user has no organization access' USING ERRCODE='42501';
  END IF;
  IF target_role='owner' AND actor_role<>'owner' THEN
    RAISE EXCEPTION 'Only an organization owner can manage Owner project access'
      USING ERRCODE='42501';
  END IF;
  target_scopes := oao.iap_role_scopes(target_role);

  SELECT ai.principal_id INTO target_principal_id FROM oao.auth_identities ai
  WHERE ai.organization_id=p_organization_id AND ai.project_id=p_project_id
    AND ai.provider='iap' AND ai.provider_subject=target_subject;
  IF target_principal_id IS NULL THEN
    target_principal_id := gen_random_uuid();
    INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
      VALUES (p_organization_id,p_project_id,target_principal_id,'human',
        target_internal_subject,target_scopes);
    INSERT INTO oao.auth_identities (
      organization_id,project_id,principal_id,provider,provider_subject,email,
      display_name,last_reconciled_at
    ) VALUES (
      p_organization_id,p_project_id,target_principal_id,'iap',target_subject,
      target_email,target_display_name,clock_timestamp()
    );
  ELSE
    UPDATE oao.principals SET scopes=target_scopes
    WHERE organization_id=p_organization_id AND project_id=p_project_id
      AND id=target_principal_id;
    UPDATE oao.auth_identities
       SET email=target_email,display_name=target_display_name,
           last_reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE organization_id=p_organization_id AND project_id=p_project_id
       AND principal_id=target_principal_id AND provider='iap';
  END IF;

  INSERT INTO oao.project_members (
    organization_id,project_id,principal_id,role,created_by_principal_id
  ) VALUES (
    p_organization_id,p_project_id,target_principal_id,
    target_role::oao.project_role,p_actor_id
  ) ON CONFLICT (organization_id,project_id,principal_id) DO UPDATE
    SET role=EXCLUDED.role,updated_at=clock_timestamp();
  RETURN target_principal_id;
END;
$$;

CREATE FUNCTION oao.remove_iap_project_member(
  p_organization_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_member_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE
  actor oao.principals;
  actor_identity text;
  actor_role text;
  target_identity text;
  target_role text;
BEGIN
  IF p_organization_id IS DISTINCT FROM oao.current_organization_id()
     OR p_project_id IS DISTINCT FROM oao.current_project_id() THEN
    RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('iap-members/' || p_organization_id::text,0));
  SELECT * INTO actor FROM oao.principals p
    WHERE p.organization_id=p_organization_id AND p.project_id=p_project_id
      AND p.id=p_actor_id AND p.kind='human';
  SELECT ai.provider_subject INTO actor_identity FROM oao.auth_identities ai
    WHERE ai.organization_id=p_organization_id AND ai.project_id=p_project_id
      AND ai.principal_id=actor.id AND ai.provider='iap';
  actor_role := oao.iap_identity_role(p_organization_id,actor_identity);
  IF actor.id IS NULL OR actor_identity IS NULL
     OR NOT (actor.scopes && ARRAY['*','project:admin'])
     OR COALESCE(actor_role,'') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'An IAP organization owner or admin is required' USING ERRCODE='42501';
  END IF;
  SELECT ai.provider_subject INTO target_identity
  FROM oao.auth_identities ai
  JOIN oao.project_members pm
    ON pm.organization_id=ai.organization_id AND pm.project_id=ai.project_id
   AND pm.principal_id=ai.principal_id
  WHERE ai.organization_id=p_organization_id AND ai.project_id=p_project_id
    AND ai.principal_id=p_member_id AND ai.provider='iap';
  IF target_identity IS NULL THEN
    RAISE EXCEPTION 'Project member not found' USING ERRCODE='P0002';
  END IF;
  IF target_identity=actor_identity THEN
    RAISE EXCEPTION 'You cannot remove your own project access' USING ERRCODE='22023';
  END IF;
  target_role := oao.iap_identity_role(p_organization_id,target_identity);
  IF target_role='owner' AND actor_role<>'owner' THEN
    RAISE EXCEPTION 'Only an organization owner can manage Owner project access'
      USING ERRCODE='42501';
  END IF;
  DELETE FROM oao.project_members
  WHERE organization_id=p_organization_id AND project_id=p_project_id
    AND principal_id=p_member_id;
  UPDATE oao.principals SET scopes='{}'
  WHERE organization_id=p_organization_id AND project_id=p_project_id
    AND id=p_member_id;
END;
$$;

REVOKE ALL ON FUNCTION oao.add_iap_project_member(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.remove_iap_project_member(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.add_iap_project_member(uuid,uuid,uuid,text) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.remove_iap_project_member(uuid,uuid,uuid,uuid) TO oao_app;

DO $$
DECLARE
  migration_role name := current_user;
  granted_membership boolean := NOT pg_has_role(current_user,'oao_auth','SET');
BEGIN
  IF granted_membership THEN
    EXECUTE format('GRANT oao_auth TO %I WITH SET TRUE, INHERIT TRUE',migration_role);
  END IF;
  GRANT CREATE ON SCHEMA oao TO oao_auth;
  ALTER FUNCTION oao.add_iap_project_member(uuid,uuid,uuid,text) OWNER TO oao_auth;
  ALTER FUNCTION oao.remove_iap_project_member(uuid,uuid,uuid,uuid) OWNER TO oao_auth;
  REVOKE CREATE ON SCHEMA oao FROM oao_auth;
  IF granted_membership THEN
    EXECUTE format('REVOKE oao_auth FROM %I',migration_role);
  END IF;
END;
$$;
