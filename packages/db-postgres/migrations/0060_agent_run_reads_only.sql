-- A run that another agent's OAO tool started, or a delegated child of such
-- a run, now keeps only the read scopes of its grant. 0059 removed only the
-- scopes that start or message runs, so such a run could still publish
-- agents, change Skills, or cancel runs for the person who started the chain.

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

CREATE OR REPLACE FUNCTION oao.authenticate_run_token(
  p_token_hash bytea,
  p_at timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  principal_id uuid,
  principal_kind text,
  subject text,
  scopes text[],
  run_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
  SELECT token.organization_id, token.project_id, creator.id, creator.kind::text,
    creator.subject,
    ARRAY(
      SELECT scope FROM unnest(token.scopes) scope
      WHERE ('*' = ANY(creator.scopes) OR scope = ANY(creator.scopes))
        AND (
          run.requested_by_run_id IS NULL
          OR scope IN (
            'agent:read','skill:read','mcp:read','credential:read_metadata',
            'session:read','run:read','delegation:read','audit:read'
          )
        )
      ORDER BY 1
    ),
    run.id
  FROM oao.run_access_tokens token
  JOIN oao.runs run
    ON run.organization_id = token.organization_id
   AND run.project_id = token.project_id
   AND run.id = token.run_id
  JOIN oao.principals creator
    ON creator.organization_id = run.organization_id
   AND creator.project_id = run.project_id
   AND creator.id = run.created_by_principal_id
  LEFT JOIN oao.project_members member
    ON member.organization_id = creator.organization_id
   AND member.project_id = creator.project_id
   AND member.principal_id = creator.id
  LEFT JOIN oao.api_keys api_key
    ON creator.kind = 'api_key'
   AND api_key.organization_id = creator.organization_id
   AND 'api-key:' || api_key.id::text = creator.subject
   AND api_key.revoked_at IS NULL
   AND (api_key.expires_at IS NULL OR api_key.expires_at > p_at)
  WHERE octet_length(p_token_hash) = 32
    AND token.token_hash = p_token_hash
    AND token.expires_at > p_at
    AND run.settled_at IS NULL
    AND (creator.kind <> 'human' OR member.principal_id IS NOT NULL)
    AND (creator.kind <> 'api_key' OR api_key.id IS NOT NULL)
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA oao FROM oao_auth;

DO $$
DECLARE migration_role name := current_user;
BEGIN
  IF current_setting('oao.migration_granted_auth',true)::boolean THEN
    EXECUTE format('REVOKE oao_auth FROM %I',migration_role);
  END IF;
END
$$;
