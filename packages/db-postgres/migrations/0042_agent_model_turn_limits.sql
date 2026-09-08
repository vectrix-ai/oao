-- Configurable model turns; existing versions and their hashes remain unchanged.
CREATE OR REPLACE FUNCTION oao.is_valid_legacy_agent_publication_config(p_config jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  tool jsonb;
  capability jsonb;
  sandbox_key_count integer;
BEGIN
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF NOT p_config ?& ARRAY['systemPrompt','modelPreset','tools','sandbox','limits']
     OR (SELECT count(*) FROM jsonb_object_keys(p_config)) <> 5 THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_config->'systemPrompt') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_config->'modelPreset') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_config->'tools') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_config->'sandbox') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_config->'limits') IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF length(p_config->>'systemPrompt') NOT BETWEEN 1 AND 100000
     OR length(p_config->>'modelPreset') NOT BETWEEN 1 AND 120 THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO sandbox_key_count FROM jsonb_object_keys(p_config->'sandbox');
  IF NOT (p_config->'sandbox') ?& ARRAY['enabled','network']
     OR sandbox_key_count NOT IN (2,4) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_config->'sandbox'->'enabled') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_config->'sandbox'->'network') IS DISTINCT FROM 'string'
     OR p_config->'sandbox'->>'network' NOT IN ('none','restricted') THEN
    RETURN false;
  END IF;
  IF sandbox_key_count = 4 THEN
    IF NOT (p_config->'sandbox') ?& ARRAY['provider','capabilities']
       OR jsonb_typeof(p_config->'sandbox'->'provider') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_config->'sandbox'->'capabilities') IS DISTINCT FROM 'array'
       OR length(p_config->'sandbox'->>'provider') NOT BETWEEN 1 AND 120
       OR p_config->'sandbox'->>'provider' !~ '^(local-fake|[a-z][a-z0-9]*(-[a-z0-9]+)*)$' THEN
      RETURN false;
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(p_config->'sandbox'->'capabilities'))
       <> (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_config->'sandbox'->'capabilities')) THEN
      RETURN false;
    END IF;
    FOR capability IN SELECT value FROM jsonb_array_elements(p_config->'sandbox'->'capabilities') LOOP
      IF jsonb_typeof(capability) IS DISTINCT FROM 'string'
         OR capability #>> '{}' NOT IN ('filesystem_read','filesystem_write','shell','browser') THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;
  IF NOT (p_config->'limits') ?& ARRAY['maxTurns','timeoutMs']
     OR (SELECT count(*) FROM jsonb_object_keys(p_config->'limits')) <> 2 THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_config->'limits'->'maxTurns') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_config->'limits'->'timeoutMs') IS DISTINCT FROM 'number'
     OR (p_config->'limits'->>'maxTurns') !~ '^[0-9]+$'
     OR (p_config->'limits'->>'timeoutMs') !~ '^[0-9]+$'
     OR (p_config->'limits'->>'maxTurns')::numeric NOT BETWEEN 1 AND 256
     OR (p_config->'limits'->>'timeoutMs')::numeric < 1000 THEN
    RETURN false;
  END IF;
  FOR tool IN SELECT value FROM jsonb_array_elements(p_config->'tools') LOOP
    IF jsonb_typeof(tool) IS DISTINCT FROM 'object'
       OR NOT tool ?& ARRAY['schemaVersion','name','description','owner','approval','inputSchema','outputSchema']
       OR (SELECT count(*) FROM jsonb_object_keys(tool)) <> 7
       OR jsonb_typeof(tool->'schemaVersion') IS DISTINCT FROM 'number'
       OR jsonb_typeof(tool->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(tool->'description') IS DISTINCT FROM 'string'
       OR jsonb_typeof(tool->'owner') IS DISTINCT FROM 'string'
       OR jsonb_typeof(tool->'approval') IS DISTINCT FROM 'string'
       OR jsonb_typeof(tool->'inputSchema') IS DISTINCT FROM 'object'
       OR jsonb_typeof(tool->'outputSchema') IS DISTINCT FROM 'object'
       OR tool->>'schemaVersion' <> '1'
       OR length(tool->>'name') NOT BETWEEN 1 AND 200
       OR length(tool->>'description') NOT BETWEEN 1 AND 2000
       OR tool->>'owner' NOT IN ('platform','caller')
       OR tool->>'approval' NOT IN ('never','always')
       OR NOT oao.is_valid_published_json_schema(tool->'inputSchema')
       OR NOT oao.is_valid_published_json_schema(tool->'outputSchema') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

-- Durable reservations survive compaction and worker recovery. Serialize on the
-- run row before counting so parallel scratch calls share the same run budget.
CREATE TABLE IF NOT EXISTS oao.run_model_turns (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  turn_id text NOT NULL,
  PRIMARY KEY (organization_id, project_id, run_id, turn_id)
);
-- Replace the preview's non-cascading foreign key too. Reservations belong to
-- the run and must not block the existing project purge when it deletes runs.
ALTER TABLE oao.run_model_turns
  DROP CONSTRAINT IF EXISTS run_model_turns_organization_id_project_id_run_id_fkey;
ALTER TABLE oao.run_model_turns
  ADD CONSTRAINT run_model_turns_organization_id_project_id_run_id_fkey
  FOREIGN KEY (organization_id, project_id, run_id)
  REFERENCES oao.runs (organization_id, project_id, id) ON DELETE CASCADE;
ALTER TABLE oao.run_model_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.run_model_turns FORCE ROW LEVEL SECURITY;
-- A local preview of this migration used the name 0040_agent_model_turn_limits.
-- Preserve its existing reservations when upgrading that development database.
DO $$
BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='oao' AND tablename='run_model_turns' AND policyname='tenant_isolation') THEN
CREATE POLICY tenant_isolation ON oao.run_model_turns
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());
END IF;
END
$$;
GRANT SELECT, INSERT ON oao.run_model_turns TO oao_app;
