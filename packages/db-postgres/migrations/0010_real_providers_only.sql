-- New agent versions must bind to a real project sandbox provider.
-- Historical immutable versions remain readable, but cannot be republished.

ALTER FUNCTION oao.is_valid_agent_publication_config(jsonb)
  RENAME TO is_valid_legacy_agent_publication_config;

CREATE FUNCTION oao.is_valid_agent_publication_config(p_config jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  sandbox jsonb;
BEGIN
  IF NOT oao.is_valid_legacy_agent_publication_config(p_config) THEN
    RETURN false;
  END IF;
  sandbox := p_config->'sandbox';
  IF NOT sandbox ?& ARRAY['enabled','provider','network','capabilities']
     OR (SELECT count(*) FROM jsonb_object_keys(sandbox)) <> 4
     OR jsonb_typeof(sandbox->'provider') IS DISTINCT FROM 'string'
     OR sandbox->>'provider' = 'local-fake'
     OR length(sandbox->>'provider') NOT BETWEEN 1 AND 120
     OR sandbox->>'provider' !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION oao.is_valid_legacy_agent_publication_config(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.is_valid_agent_publication_config(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_legacy_agent_publication_config(jsonb) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.is_valid_agent_publication_config(jsonb) TO oao_app;
