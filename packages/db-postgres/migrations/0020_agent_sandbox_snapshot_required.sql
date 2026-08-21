-- Sandbox-enabled agent versions must select an explicit Daytona snapshot.
-- Disabled sandbox policies may omit the snapshot while retaining the rest of
-- the immutable provider-neutral policy shape.

CREATE OR REPLACE FUNCTION oao.is_valid_agent_publication_config(p_config jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  sandbox jsonb;
  sandbox_without_snapshot jsonb;
  sandbox_key_count integer;
BEGIN
  sandbox := p_config->'sandbox';
  sandbox_without_snapshot := sandbox - 'snapshotId';

  IF NOT oao.is_valid_legacy_agent_publication_config(
    jsonb_set(p_config, '{sandbox}', sandbox_without_snapshot)
  ) THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO sandbox_key_count FROM jsonb_object_keys(sandbox);
  IF NOT sandbox ?& ARRAY['enabled','provider','network','capabilities']
     OR sandbox_key_count NOT IN (4,5)
     OR jsonb_typeof(sandbox->'provider') IS DISTINCT FROM 'string'
     OR sandbox->>'provider' = 'local-fake'
     OR length(sandbox->>'provider') NOT BETWEEN 1 AND 120
     OR sandbox->>'provider' !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
     OR (sandbox->>'enabled')::boolean AND sandbox_key_count <> 5 THEN
    RETURN false;
  END IF;

  IF sandbox_key_count = 5 AND (
    NOT sandbox ? 'snapshotId'
    OR jsonb_typeof(sandbox->'snapshotId') IS DISTINCT FROM 'string'
    OR sandbox->>'snapshotId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RETURN false;
  END IF;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION oao.is_valid_agent_publication_config(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_agent_publication_config(jsonb) TO oao_app;
