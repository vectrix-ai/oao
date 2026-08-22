-- Additive hardening for MCP resources first introduced by migration 0022.
-- Existing call attempts predate exact credential-version attribution and keep
-- a NULL value; every runtime call created after this migration writes the
-- exact encrypted credential version used at egress.

ALTER TABLE oao.mcp_call_attempts
  ADD COLUMN credential_version_id uuid,
  ADD CONSTRAINT mcp_call_attempts_credential_version_fkey
    FOREIGN KEY (organization_id, project_id, credential_version_id)
    REFERENCES oao.mcp_credential_versions (organization_id, project_id, id);

CREATE OR REPLACE FUNCTION oao.enforce_mcp_lifecycle_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'updated_at' - 'updated_by_principal_id') IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'updated_at' - 'updated_by_principal_id') THEN
    RAISE EXCEPTION 'MCP lifecycle identity is immutable'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.status = OLD.status THEN
    NEW.updated_at := OLD.updated_at;
    NEW.updated_by_principal_id := OLD.updated_by_principal_id;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status='active' AND NEW.status IN ('deprecated','revoked'))
    OR (OLD.status='deprecated' AND NEW.status='revoked')
  ) THEN
    RAISE EXCEPTION 'invalid MCP lifecycle transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION oao.mcp_endpoint_matches_policy(
  p_endpoint text, p_exact_origin text, p_path_prefix text
) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(p_endpoint,'^(https://[^/]+).*$','\1')) =
         lower(regexp_replace(p_exact_origin,'/$','','g'))
     AND left(
           COALESCE(substring(p_endpoint from '^https://[^/]+(/[^?#]*)'),'/'),
           length(p_path_prefix)
         ) = p_path_prefix
$$;

CREATE FUNCTION oao.mcp_tool_name(p_namespace text,p_remote_name text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE prefix text := 'mcp__' || p_namespace || '__';
DECLARE safe_remote text;
DECLARE suffix text;
BEGIN
  safe_remote := trim(both '_' from regexp_replace(
    regexp_replace(p_remote_name,'[^a-zA-Z0-9_:-]+','_','g'),
    '_+','_','g'
  ));
  IF safe_remote = '' THEN RAISE EXCEPTION 'invalid MCP tool name'; END IF;
  IF length(prefix)+length(safe_remote) <= 200 THEN RETURN prefix||safe_remote; END IF;
  suffix := substr(encode(digest(convert_to(p_remote_name,'UTF8'),'sha256'),'hex'),1,12);
  RETURN prefix || substr(safe_remote,1,200-length(prefix)-length(suffix)-1) || '_' || suffix;
END
$$;

REVOKE ALL ON FUNCTION oao.mcp_tool_name(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.mcp_tool_name(text,text) TO oao_app;
