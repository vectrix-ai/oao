-- Keep durable creator provenance after project deletion so later IAP role
-- reductions can still revoke organization-scoped keys and their descendants.
ALTER TABLE oao.api_keys
  ADD COLUMN created_by_iap_subject text,
  ADD COLUMN created_by_api_key_id uuid,
  ADD CONSTRAINT api_keys_creator_iap_subject_check
    CHECK (created_by_iap_subject IS NULL OR length(created_by_iap_subject) BETWEEN 1 AND 500),
  ADD CONSTRAINT api_keys_creator_api_key_fkey
    FOREIGN KEY (organization_id,created_by_api_key_id)
    REFERENCES oao.api_keys(organization_id,id);

UPDATE oao.api_keys key
SET created_by_iap_subject=identity.provider_subject
FROM oao.auth_identities identity
WHERE identity.organization_id=key.organization_id
  AND identity.principal_id=key.created_by_principal_id
  AND identity.provider='iap';

UPDATE oao.api_keys key
SET created_by_api_key_id=substring(creator.subject FROM 9)::uuid
FROM oao.principals creator
WHERE creator.organization_id=key.organization_id
  AND creator.id=key.created_by_principal_id
  AND creator.kind='api_key'
  AND creator.subject ~ '^api-key:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- Historical keys whose creator principal was already deleted have no safe
-- identity attribution left. Fail closed instead of allowing stale authority.
UPDATE oao.api_keys key
SET revoked_at=COALESCE(key.revoked_at,clock_timestamp())
WHERE key.created_by_iap_subject IS NULL
  AND key.created_by_api_key_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM oao.principals creator
    WHERE creator.organization_id=key.organization_id
      AND creator.id=key.created_by_principal_id
  );

-- The immutable IAP subject joins legacy per-project principal aliases safely.
CREATE FUNCTION oao.iap_identity_role(p_organization_id uuid, p_subject text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, oao
AS $$
  SELECT om.role::text FROM oao.auth_identities ai
  JOIN oao.principals p ON p.organization_id=ai.organization_id AND p.project_id=ai.project_id AND p.id=ai.principal_id AND p.kind='human'
  JOIN oao.organization_members om ON om.organization_id=p.organization_id AND om.principal_id=p.id
  WHERE ai.organization_id=p_organization_id AND ai.provider='iap' AND ai.provider_subject=p_subject
  ORDER BY CASE om.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END LIMIT 1;
$$;

-- IAP project switching must follow the verified identity, not an arbitrary
-- legacy internal subject shared with an unlinked principal.
CREATE FUNCTION oao.resolve_iap_project_member(p_organization_id uuid, p_source_project_id uuid, p_source_id uuid, p_target_project_id uuid)
RETURNS TABLE (id uuid, subject text, scopes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, oao
AS $$
  SELECT target.id,target.subject,target.scopes
  FROM oao.principals source
  JOIN oao.project_members source_member ON source_member.organization_id=source.organization_id AND source_member.project_id=source.project_id AND source_member.principal_id=source.id
  JOIN oao.auth_identities source_identity ON source_identity.organization_id=source.organization_id AND source_identity.project_id=source.project_id AND source_identity.principal_id=source.id AND source_identity.provider='iap'
  JOIN oao.auth_tenant_links source_tenant ON source_tenant.organization_id=source.organization_id AND source_tenant.project_id=source.project_id AND source_tenant.provider='iap'
  JOIN oao.auth_tenant_links target_tenant ON target_tenant.organization_id=source.organization_id AND target_tenant.project_id=p_target_project_id AND target_tenant.provider='iap' AND target_tenant.provider_tenant_id=source_tenant.provider_tenant_id
  JOIN oao.auth_identities target_identity ON target_identity.organization_id=source.organization_id AND target_identity.project_id=p_target_project_id AND target_identity.provider='iap' AND target_identity.provider_subject=source_identity.provider_subject
  JOIN oao.principals target ON target.organization_id=target_identity.organization_id AND target.project_id=target_identity.project_id AND target.id=target_identity.principal_id AND target.kind='human'
  JOIN oao.project_members target_member ON target_member.organization_id=target.organization_id AND target_member.project_id=target.project_id AND target_member.principal_id=target.id
  WHERE source.organization_id=p_organization_id AND source.project_id=p_source_project_id AND source.id=p_source_id AND source.kind='human'
    AND p_organization_id=oao.current_organization_id() AND p_source_project_id=oao.current_project_id();
$$;

-- Persisted membership, not wildcard scopes, supplies the displayed role.
CREATE FUNCTION oao.principal_membership_roles(p_organization_id uuid, p_project_id uuid, p_principal_id uuid)
RETURNS TABLE (organization_role text, project_role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, oao
AS $$
  SELECT CASE WHEN identity.provider_subject IS NOT NULL THEN oao.iap_identity_role(p.organization_id,identity.provider_subject) ELSE (
    SELECT om.role::text FROM oao.organization_members om
    JOIN oao.principals sibling ON sibling.organization_id=om.organization_id AND sibling.id=om.principal_id
    WHERE sibling.organization_id=p.organization_id AND sibling.kind=p.kind AND sibling.subject=p.subject
    ORDER BY CASE om.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END LIMIT 1
  ) END, pm.role::text
  FROM oao.principals p JOIN oao.project_members pm
    ON pm.organization_id=p.organization_id AND pm.project_id=p.project_id AND pm.principal_id=p.id
  LEFT JOIN oao.auth_identities identity ON identity.organization_id=p.organization_id AND identity.project_id=p.project_id AND identity.principal_id=p.id AND identity.provider='iap'
  WHERE p.organization_id=p_organization_id AND p.project_id=p_project_id AND p.id=p_principal_id
    AND p_organization_id=oao.current_organization_id() AND p_project_id=oao.current_project_id();
$$;

-- Only explicit profiles: new API actions never become admin permissions implicitly.
CREATE FUNCTION oao.iap_role_scopes(p_role text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$
  SELECT CASE p_role
    WHEN 'owner' THEN ARRAY['*']
    WHEN 'viewer' THEN ARRAY['agent:read','skill:read','mcp:read','credential:read_metadata','session:read','run:read','delegation:read']
    WHEN 'member' THEN ARRAY['agent:read','agent:write','skill:read','skill:write','skill:bind','skill:revoke','mcp:read','mcp:execute','credential:read_metadata','session:read','session:write','run:create','run:read','run:cancel','tool_call:claim','tool_call:submit','approval:resolve','delegation:read','delegation:message','delegation:cancel']
    WHEN 'admin' THEN ARRAY['agent:read','agent:write','skill:read','skill:write','skill:bind','skill:revoke','mcp:read','mcp:write','mcp:discover','mcp:bind','mcp:execute','credential:read_metadata','credential:write','credential:rotate','credential:revoke','session:read','session:write','run:create','run:read','run:cancel','tool_call:claim','tool_call:submit','approval:resolve','delegation:read','delegation:message','delegation:cancel','audit:read','project:admin']
  END;
$$;

-- A single bounded operation changes every existing project copy of an IAP
-- person. Only an existing owner may grant or change owner access; it never
-- creates membership in another project.
CREATE FUNCTION oao.change_iap_member_role(
  p_organization_id uuid, p_project_id uuid, p_actor_id uuid, p_member_id uuid, p_role text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oao
AS $$
DECLARE
  actor oao.principals;
  target oao.principals;
  actor_identity text;
  actor_role text;
  target_identity text;
  target_role text;
  target_ids uuid[];
  next_scopes text[];
  actor_is_owner boolean;
  target_is_owner boolean;
  prior_rank integer;
BEGIN
  IF p_organization_id IS DISTINCT FROM oao.current_organization_id()
     OR p_project_id IS DISTINCT FROM oao.current_project_id() THEN
    RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('iap-members/' || p_organization_id::text,0));
  SELECT * INTO actor FROM oao.principals p
    WHERE p.organization_id=p_organization_id AND p.project_id=p_project_id AND p.id=p_actor_id AND p.kind='human';
  SELECT ai.provider_subject INTO actor_identity FROM oao.auth_identities ai
    WHERE ai.organization_id=p_organization_id AND ai.project_id=p_project_id AND ai.principal_id=actor.id AND ai.provider='iap';
  actor_role := oao.iap_identity_role(p_organization_id,actor_identity);
  IF actor.id IS NULL OR actor_identity IS NULL OR NOT (actor.scopes && ARRAY['*','project:admin']) OR NOT EXISTS (
    SELECT 1 FROM oao.project_members pm WHERE pm.organization_id=p_organization_id AND pm.project_id=p_project_id AND pm.principal_id=actor.id
  ) OR COALESCE(actor_role,'') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'An IAP organization owner or admin is required' USING ERRCODE='42501';
  END IF;
  SELECT p.* INTO target FROM oao.principals p JOIN oao.project_members pm
    ON pm.organization_id=p.organization_id AND pm.project_id=p.project_id AND pm.principal_id=p.id
    WHERE p.organization_id=p_organization_id AND p.project_id=p_project_id AND p.id=p_member_id AND p.kind='human';
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='P0002'; END IF;
  SELECT ai.provider_subject INTO target_identity FROM oao.auth_identities ai
    WHERE ai.organization_id=p_organization_id AND ai.project_id=p_project_id AND ai.principal_id=target.id AND ai.provider='iap';
  IF target_identity IS NULL THEN RAISE EXCEPTION 'Member must sign in through IAP first' USING ERRCODE='22023'; END IF;
  IF actor_identity=target_identity THEN RAISE EXCEPTION 'You cannot change your own access' USING ERRCODE='22023'; END IF;
  target_role := oao.iap_identity_role(p_organization_id,target_identity);
  actor_is_owner := actor_role='owner';
  target_is_owner := COALESCE(target_role='owner',false);
  IF (target_is_owner OR p_role='owner') AND NOT actor_is_owner THEN
    RAISE EXCEPTION 'Only an organization owner can grant or change Owner access' USING ERRCODE='42501';
  END IF;
  IF target_is_owner AND p_role IS DISTINCT FROM 'owner' AND (
    SELECT count(DISTINCT COALESCE(ai.provider_subject,'principal:' || p.subject)) FROM oao.organization_members om
    JOIN oao.principals p ON p.organization_id=om.organization_id AND p.id=om.principal_id
    LEFT JOIN oao.auth_identities ai ON ai.organization_id=p.organization_id AND ai.project_id=p.project_id AND ai.principal_id=p.id AND ai.provider='iap'
    WHERE p.organization_id=p_organization_id AND p.kind='human' AND om.role='owner'
  ) <= 1 THEN RAISE EXCEPTION 'The last organization owner cannot be removed' USING ERRCODE='22023'; END IF;
  prior_rank := CASE target_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 WHEN 'viewer' THEN 3 ELSE 4 END;
  next_scopes := oao.iap_role_scopes(p_role);
  IF p_role <> 'removed' AND next_scopes IS NULL THEN
    RAISE EXCEPTION 'IAP role must be owner, admin, member, or viewer' USING ERRCODE='22023';
  END IF;
  IF p_role IS NULL THEN RAISE EXCEPTION 'Role is required' USING ERRCODE='22023'; END IF;
  SELECT array_agg(p.id) INTO target_ids FROM oao.principals p
    JOIN oao.auth_identities ai ON ai.organization_id=p.organization_id AND ai.project_id=p.project_id AND ai.principal_id=p.id
    WHERE p.organization_id=p_organization_id AND p.kind='human'
      AND ai.provider='iap' AND ai.provider_subject=target_identity;
  -- Lowering access also revokes keys minted by this identity, so an old
  -- administrative key cannot retain the removed authority.
  IF p_role='removed' OR (CASE p_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 WHEN 'viewer' THEN 3 ELSE 4 END) > COALESCE(prior_rank,4) THEN
    WITH RECURSIVE affected_keys(id) AS (
      SELECT k.id FROM oao.api_keys k
      WHERE k.organization_id=p_organization_id
        AND (k.created_by_principal_id=ANY(target_ids)
          OR k.created_by_iap_subject=target_identity)
      UNION
      SELECT child.id FROM affected_keys parent
      JOIN oao.api_keys child ON child.organization_id=p_organization_id
        AND (child.created_by_api_key_id=parent.id OR EXISTS (
          SELECT 1 FROM oao.principals creator
          WHERE creator.organization_id=p_organization_id
            AND creator.kind='api_key'
            AND creator.subject='api-key:' || parent.id::text
            AND child.created_by_principal_id=creator.id
        ))
    )
    UPDATE oao.api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp())
      WHERE organization_id=p_organization_id AND id IN (SELECT id FROM affected_keys);
  END IF;
  IF p_role='removed' THEN
    DELETE FROM oao.project_members WHERE organization_id=p_organization_id AND principal_id=ANY(target_ids);
    DELETE FROM oao.organization_members WHERE organization_id=p_organization_id AND principal_id=ANY(target_ids);
    UPDATE oao.principals SET scopes='{}' WHERE organization_id=p_organization_id AND id=ANY(target_ids);
  ELSE
    IF NOT EXISTS (SELECT 1 FROM oao.organization_members WHERE organization_id=p_organization_id AND principal_id=ANY(target_ids)) THEN
      RAISE EXCEPTION 'Organization membership is required' USING ERRCODE='42501';
    END IF;
    UPDATE oao.organization_members SET role=p_role::oao.organization_role,updated_at=clock_timestamp()
      WHERE organization_id=p_organization_id AND principal_id=ANY(target_ids);
    UPDATE oao.project_members SET role=p_role::oao.project_role,updated_at=clock_timestamp()
      WHERE organization_id=p_organization_id AND principal_id=ANY(target_ids);
    UPDATE oao.principals SET scopes=next_scopes WHERE organization_id=p_organization_id AND id=ANY(target_ids);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION oao.current_organization_id(), oao.current_project_id() TO oao_auth;
GRANT UPDATE (scopes) ON oao.principals TO oao_auth;
GRANT UPDATE (role,updated_at), DELETE ON oao.organization_members, oao.project_members TO oao_auth;
REVOKE ALL ON FUNCTION oao.resolve_iap_project_member(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.resolve_iap_project_member(uuid,uuid,uuid,uuid) TO oao_app;
REVOKE ALL ON FUNCTION oao.iap_identity_role(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.principal_membership_roles(uuid,uuid,uuid), oao.iap_role_scopes(text), oao.change_iap_member_role(uuid,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.principal_membership_roles(uuid,uuid,uuid), oao.change_iap_member_role(uuid,uuid,uuid,uuid,text) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.iap_role_scopes(text) TO oao_auth;
DO $$
DECLARE
  migration_role name := current_user;
  granted_membership boolean := NOT pg_has_role(current_user,'oao_auth','SET');
BEGIN
  IF granted_membership THEN EXECUTE format('GRANT oao_auth TO %I WITH SET TRUE, INHERIT TRUE',migration_role); END IF;
  GRANT CREATE ON SCHEMA oao TO oao_auth;
  ALTER FUNCTION oao.resolve_iap_project_member(uuid,uuid,uuid,uuid) OWNER TO oao_auth;
  ALTER FUNCTION oao.iap_identity_role(uuid,text) OWNER TO oao_auth;
  ALTER FUNCTION oao.principal_membership_roles(uuid,uuid,uuid) OWNER TO oao_auth;
  ALTER FUNCTION oao.change_iap_member_role(uuid,uuid,uuid,uuid,text) OWNER TO oao_auth;
  REVOKE CREATE ON SCHEMA oao FROM oao_auth;
  IF granted_membership THEN EXECUTE format('REVOKE oao_auth FROM %I',migration_role); END IF;
END;
$$;
