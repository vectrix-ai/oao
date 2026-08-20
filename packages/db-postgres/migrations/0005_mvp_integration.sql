CREATE FUNCTION oao.is_valid_published_json_schema(p_schema jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  item jsonb;
  required_count integer;
  distinct_required_count integer;
BEGIN
  IF jsonb_typeof(p_schema) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF p_schema ? 'enum' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_schema)) <> 1
       OR jsonb_typeof(p_schema->'enum') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_schema->'enum') = 0 THEN
      RETURN false;
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_schema->'enum') LOOP
      IF jsonb_typeof(item) NOT IN ('null','string','number','boolean') THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF NOT p_schema ? 'type'
     OR jsonb_typeof(p_schema->'type') IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  IF p_schema->>'type' IN ('string','number','integer','boolean','null') THEN
    RETURN (SELECT count(*) FROM jsonb_object_keys(p_schema)) = 1;
  END IF;
  IF p_schema->>'type' = 'array' THEN
    IF NOT p_schema ?& ARRAY['type','items']
       OR (SELECT count(*) FROM jsonb_object_keys(p_schema)) <> 2 THEN
      RETURN false;
    END IF;
    RETURN oao.is_valid_published_json_schema(p_schema->'items');
  END IF;
  IF p_schema->>'type' <> 'object' THEN RETURN false; END IF;
  IF NOT p_schema ?& ARRAY['type','properties','required','additionalProperties']
     OR (SELECT count(*) FROM jsonb_object_keys(p_schema)) <> 4 THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_schema->'properties') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_schema->'required') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_schema->'additionalProperties') IS DISTINCT FROM 'boolean'
     OR p_schema->'additionalProperties' <> 'false'::jsonb THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_schema->'required') entry
    WHERE jsonb_typeof(entry) IS DISTINCT FROM 'string'
  ) THEN
    RETURN false;
  END IF;
  SELECT count(*),count(DISTINCT value)
    INTO required_count,distinct_required_count
    FROM jsonb_array_elements_text(p_schema->'required');
  IF required_count <> distinct_required_count
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_schema->'required') entry
       WHERE jsonb_typeof(entry) IS DISTINCT FROM 'string'
          OR NOT (p_schema->'properties' ? (entry #>> '{}'))
     ) THEN
    RETURN false;
  END IF;
  FOR item IN SELECT value FROM jsonb_each(p_schema->'properties') LOOP
    IF NOT oao.is_valid_published_json_schema(item) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE FUNCTION oao.is_valid_agent_publication_config(p_config jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  tool jsonb;
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
  IF NOT (p_config->'sandbox') ?& ARRAY['enabled','network']
     OR (SELECT count(*) FROM jsonb_object_keys(p_config->'sandbox')) <> 2 THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_config->'sandbox'->'enabled') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_config->'sandbox'->'network') IS DISTINCT FROM 'string'
     OR p_config->'sandbox'->>'network' NOT IN ('none','restricted') THEN
    RETURN false;
  END IF;
  IF NOT (p_config->'limits') ?& ARRAY['maxTurns','timeoutMs']
     OR (SELECT count(*) FROM jsonb_object_keys(p_config->'limits')) <> 2 THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_config->'limits'->'maxTurns') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_config->'limits'->'timeoutMs') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;
  IF (p_config->'limits'->>'maxTurns') !~ '^[0-9]+$'
     OR (p_config->'limits'->>'timeoutMs') !~ '^[0-9]+$' THEN
    RETURN false;
  END IF;
  IF (p_config->'limits'->>'maxTurns')::numeric <> 32
     OR (p_config->'limits'->>'timeoutMs')::numeric < 1000 THEN
    RETURN false;
  END IF;
  FOR tool IN SELECT value FROM jsonb_array_elements(p_config->'tools') LOOP
    IF jsonb_typeof(tool) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF NOT tool ?& ARRAY['schemaVersion','name','description','owner','approval','inputSchema','outputSchema']
       OR (SELECT count(*) FROM jsonb_object_keys(tool)) <> 7 THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(tool->'schemaVersion') IS DISTINCT FROM 'number'
       OR jsonb_typeof(tool->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(tool->'description') IS DISTINCT FROM 'string'
       OR jsonb_typeof(tool->'owner') IS DISTINCT FROM 'string'
       OR jsonb_typeof(tool->'approval') IS DISTINCT FROM 'string'
       OR jsonb_typeof(tool->'inputSchema') IS DISTINCT FROM 'object'
       OR jsonb_typeof(tool->'outputSchema') IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    IF tool->>'schemaVersion' <> '1'
       OR length(tool->>'name') NOT BETWEEN 1 AND 200
       OR length(tool->>'description') NOT BETWEEN 1 AND 2000
       OR tool->>'owner' NOT IN ('platform','caller')
       OR tool->>'approval' NOT IN ('never','always') THEN
      RETURN false;
    END IF;
    IF NOT oao.is_valid_published_json_schema(tool->'inputSchema')
       OR NOT oao.is_valid_published_json_schema(tool->'outputSchema') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION oao.publish_agent_version(
  p_organization_id uuid,
  p_project_id uuid,
  p_agent_definition_id uuid,
  p_version_id uuid,
  p_config jsonb,
  p_content_hash bytea,
  p_created_by_principal_id uuid
) RETURNS oao.agent_versions
LANGUAGE plpgsql
AS $$
DECLARE
  next_version integer;
  published oao.agent_versions;
BEGIN
  IF NOT oao.is_valid_agent_publication_config(p_config) THEN
    RAISE EXCEPTION 'invalid agent publication config' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_content_hash) <> 32 THEN
    RAISE EXCEPTION 'agent content hash must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM oao.agent_definitions
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND id = p_agent_definition_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent definition not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO next_version
  FROM oao.agent_versions
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND agent_definition_id = p_agent_definition_id;
  INSERT INTO oao.agent_versions (
    organization_id, project_id, id, agent_definition_id, version, config,
    content_hash, created_by_principal_id
  ) VALUES (
    p_organization_id, p_project_id, p_version_id, p_agent_definition_id,
    next_version, p_config, p_content_hash, p_created_by_principal_id
  ) RETURNING * INTO published;
  UPDATE oao.agent_definitions
  SET latest_version_id = p_version_id
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND id = p_agent_definition_id;
  RETURN published;
END
$$;

REVOKE ALL ON FUNCTION oao.is_valid_published_json_schema(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.is_valid_agent_publication_config(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_published_json_schema(jsonb) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.is_valid_agent_publication_config(jsonb) TO oao_app;
