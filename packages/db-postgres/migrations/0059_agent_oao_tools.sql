-- Lets an agent version use the OAO MCP tools inside its runs.
--
-- The runtime worker calls the OAO API for such a tool with a run token. A
-- token belongs to one unsettled run and acts as the principal that created
-- the run, narrowed to the scopes the agent version grants and to what that
-- principal still holds. Only the SHA-256 of a token is stored.

CREATE TABLE oao.run_access_tokens (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  -- Tokens are ephemeral; a project purge deletes them with their runs.
  FOREIGN KEY (organization_id, project_id, run_id)
    REFERENCES oao.runs(organization_id, project_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);
CREATE INDEX run_access_tokens_run_idx
  ON oao.run_access_tokens (organization_id, project_id, run_id);
ALTER TABLE oao.run_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.run_access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.run_access_tokens
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());
GRANT SELECT, INSERT, DELETE ON oao.run_access_tokens TO oao_app;

-- A run that an agent's OAO tool started records the run that asked. Such
-- a run may read but not start or message further runs, which rules out
-- ask cycles and runaway fan-out.
ALTER TABLE oao.runs ADD COLUMN requested_by_run_id uuid;
ALTER TABLE oao.runs
  ADD CONSTRAINT runs_requested_by_run_fkey
  FOREIGN KEY (organization_id, project_id, requested_by_run_id)
  REFERENCES oao.runs(organization_id, project_id, id);

-- The OAO tool grant is validated beside the MCP bindings. The previous
-- validator keeps validating everything else.
ALTER FUNCTION oao.is_valid_agent_publication_config_with_mcp(jsonb)
  RENAME TO is_valid_agent_publication_config_without_oao_tools;

CREATE FUNCTION oao.is_valid_agent_publication_config_with_mcp(p_config jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE grant_ jsonb;
BEGIN
  grant_ := p_config->'oaoTools';
  IF grant_ IS NOT NULL AND (
       jsonb_typeof(grant_) IS DISTINCT FROM 'object'
       OR (grant_ - ARRAY['scopes','approval']) <> '{}'::jsonb
       OR jsonb_typeof(grant_->'scopes') IS DISTINCT FROM 'array'
       OR jsonb_array_length(grant_->'scopes') = 0
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(grant_->'scopes') scope
         WHERE jsonb_typeof(scope) IS DISTINCT FROM 'string'
            OR scope #>> '{}' NOT IN (
              'agent:read','agent:write','skill:read','skill:write','skill:bind',
              'mcp:read','mcp:write','mcp:discover','mcp:bind',
              'credential:read_metadata','session:read','session:write',
              'run:create','run:read','run:cancel','delegation:read',
              'delegation:message','audit:read'
            )
       )
       OR jsonb_array_length(grant_->'scopes') <>
          (SELECT count(DISTINCT scope) FROM jsonb_array_elements_text(grant_->'scopes') scope)
       OR (grant_ ? 'approval' AND grant_->>'approval' NOT IN ('never','always'))
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(p_config->'tools','[]'::jsonb)) tool
         WHERE tool->>'name' LIKE 'oao\_\_%'
       )
     ) THEN
    RETURN false;
  END IF;
  RETURN oao.is_valid_agent_publication_config_without_oao_tools(p_config - 'oaoTools');
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

-- authenticate_run_token runs before any tenant is known, so like
-- authenticate_api_key (0039) it is owned by oao_auth with read access to
-- exactly the rows it checks.
GRANT SELECT ON oao.run_access_tokens, oao.runs TO oao_auth;
CREATE POLICY cloud_sql_auth_access ON oao.run_access_tokens
  FOR SELECT TO oao_auth USING (true);
CREATE POLICY cloud_sql_auth_access ON oao.runs
  FOR SELECT TO oao_auth USING (true);

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

CREATE FUNCTION oao.authenticate_run_token(
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
      WHERE '*' = ANY(creator.scopes) OR scope = ANY(creator.scopes)
      -- A run another agent started reads only.
      EXCEPT SELECT unnest(
        CASE WHEN run.requested_by_run_id IS NULL THEN ARRAY[]::text[]
             ELSE ARRAY['run:create','session:write','delegation:message'] END)
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
REVOKE ALL ON FUNCTION oao.authenticate_run_token(bytea, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.authenticate_run_token(bytea, timestamptz) TO oao_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA oao FROM oao_auth;

DO $$
DECLARE migration_role name := current_user;
BEGIN
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.authenticate_run_token(bytea,timestamptz) TO %I',
    migration_role
  );
  IF current_setting('oao.migration_granted_auth',true)::boolean THEN
    EXECUTE format('REVOKE oao_auth FROM %I',migration_role);
  END IF;
END
$$;
