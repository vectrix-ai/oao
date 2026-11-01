-- Restricts an API key to one project. Since 0037 every key acts in any
-- project of its organization. A key with project_id set now authenticates
-- only inside that project, whatever the request path names, and the API
-- refuses it organization-wide administration.
--
-- There is no foreign key: projects are hard deleted and a deleted project's
-- keys must stay listed as revoked rather than block the purge or widen to
-- the whole organization. Deleting a project revokes its keys, and
-- authentication also refuses a key whose project no longer exists.

ALTER TABLE oao.api_keys ADD COLUMN project_id uuid;
CREATE INDEX api_keys_project_idx
  ON oao.api_keys (organization_id, project_id)
  WHERE project_id IS NOT NULL;

CREATE FUNCTION oao.revoke_project_api_keys() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, oao
AS $$
BEGIN
  UPDATE oao.api_keys
  SET revoked_at = COALESCE(revoked_at, clock_timestamp())
  WHERE organization_id = OLD.organization_id AND project_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE TRIGGER projects_revoke_api_keys
  AFTER DELETE ON oao.projects
  FOR EACH ROW EXECUTE FUNCTION oao.revoke_project_api_keys();

-- authenticate_api_key is owned by oao_auth (0039). Its result gains
-- project_restricted, so it is dropped and created again under that role.
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

DROP FUNCTION oao.authenticate_api_key(text, bytea, uuid, timestamptz);
CREATE FUNCTION oao.authenticate_api_key(
  p_prefix text,
  p_keyed_hash bytea,
  p_project_id uuid DEFAULT NULL,
  p_at timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  principal_id uuid,
  subject text,
  scopes text[],
  project_restricted boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
#variable_conflict use_column
DECLARE
  key oao.api_keys;
  target_project_id uuid;
  key_subject text;
  mirror_principal_id uuid;
  saved_organization text;
  saved_project text;
BEGIN
  IF octet_length(p_keyed_hash) <> 32 THEN
    RAISE EXCEPTION 'API key hash must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  saved_organization := current_setting('oao.organization_id', true);
  saved_project := current_setting('oao.project_id', true);

  UPDATE oao.api_keys AS candidate
  SET last_used_at = p_at
  WHERE candidate.key_prefix = p_prefix
    AND candidate.key_hash = p_keyed_hash
    AND candidate.revoked_at IS NULL
    AND (candidate.expires_at IS NULL OR candidate.expires_at > p_at)
  RETURNING * INTO key;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM set_config('oao.organization_id', key.organization_id::text, true);
  IF key.project_id IS NOT NULL THEN
    -- A restricted key always acts in its own project. A path naming
    -- another project then fails the API's project check with 403.
    SELECT project.id INTO target_project_id FROM oao.projects project
    WHERE project.organization_id = key.organization_id AND project.id = key.project_id;
  ELSIF p_project_id IS NOT NULL THEN
    SELECT project.id INTO target_project_id FROM oao.projects project
    WHERE project.organization_id = key.organization_id AND project.id = p_project_id;
  ELSE
    SELECT project.id INTO target_project_id FROM oao.projects project
    WHERE project.organization_id = key.organization_id
    ORDER BY project.created_at, project.id LIMIT 1;
  END IF;
  IF target_project_id IS NULL THEN
    PERFORM set_config('oao.organization_id', COALESCE(saved_organization, ''), true);
    RETURN;
  END IF;

  PERFORM set_config('oao.project_id', target_project_id::text, true);
  key_subject := 'api-key:' || key.id::text;
  INSERT INTO oao.principals (organization_id, project_id, id, kind, subject, scopes)
  VALUES (key.organization_id, target_project_id, gen_random_uuid(), 'api_key', key_subject, key.scopes)
  ON CONFLICT (organization_id, project_id, kind, subject) DO NOTHING;
  SELECT principal.id INTO mirror_principal_id FROM oao.principals principal
  WHERE principal.organization_id = key.organization_id
    AND principal.project_id = target_project_id
    AND principal.subject = key_subject AND principal.kind = 'api_key';

  PERFORM set_config('oao.organization_id', COALESCE(saved_organization, ''), true);
  PERFORM set_config('oao.project_id', COALESCE(saved_project, ''), true);
  RETURN QUERY SELECT key.organization_id, target_project_id, mirror_principal_id,
    key_subject, key.scopes, key.project_id IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION oao.authenticate_api_key(text, bytea, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.authenticate_api_key(text, bytea, uuid, timestamptz) TO oao_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA oao FROM oao_auth;

DO $$
DECLARE migration_role name := current_user;
BEGIN
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.authenticate_api_key(text,bytea,uuid,timestamptz) TO %I',
    migration_role
  );
  IF current_setting('oao.migration_granted_auth',true)::boolean THEN
    EXECUTE format('REVOKE oao_auth FROM %I',migration_role);
  END IF;
END
$$;
