-- Immutable, version-scoped Harness Operations. Each operation becomes a
-- model-callable tool at runtime but remains part of its parent Agent version;
-- it has no separate Agent, model, sandbox, capability policy, or Skill binding.

CREATE TABLE oao.agent_version_harness_operations (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (
    length(operation_key) BETWEEN 1 AND 64
    AND operation_key ~ '^[a-z][a-z0-9_-]*$'
  ),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  instructions text NOT NULL CHECK (length(instructions) BETWEEN 1 AND 100000),
  result_schema jsonb NOT NULL CHECK (
    jsonb_typeof(result_schema) = 'object'
    AND result_schema->>'type' = 'object'
    AND octet_length(convert_to(result_schema::text, 'UTF8')) <= 65536
    AND oao.is_valid_published_json_schema_node(result_schema, 0)
  ),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 300000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, agent_version_id, operation_key),
  FOREIGN KEY (organization_id, project_id, agent_version_id)
    REFERENCES oao.agent_versions (organization_id, project_id, id)
);

CREATE TRIGGER agent_version_harness_operations_immutable
BEFORE UPDATE OR DELETE ON oao.agent_version_harness_operations
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

CREATE OR REPLACE FUNCTION oao.is_valid_agent_publication_config_with_mcp(p_config jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE bindings jsonb;
DECLARE operations jsonb;
BEGIN
  bindings := COALESCE(p_config->'mcpBindings','[]'::jsonb);
  operations := COALESCE(p_config->'harnessOperations','[]'::jsonb);
  IF jsonb_typeof(bindings) IS DISTINCT FROM 'array'
     OR jsonb_array_length(bindings) > 16
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(bindings) binding
       WHERE jsonb_typeof(binding) IS DISTINCT FROM 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(binding)) <> 3
          OR NOT binding ?& ARRAY['toolsetVersionId','credentialPolicyVersionId','namespace']
          OR binding->>'toolsetVersionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR binding->>'credentialPolicyVersionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR binding->>'namespace' !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
          OR length(binding->>'namespace') NOT BETWEEN 1 AND 64
     )
     OR (SELECT count(*) FROM jsonb_array_elements(bindings)) <>
        (SELECT count(DISTINCT binding->>'namespace') FROM jsonb_array_elements(bindings) binding)
     OR (SELECT count(*) FROM jsonb_array_elements(bindings)) <>
        (SELECT count(DISTINCT concat(binding->>'toolsetVersionId',':',binding->>'credentialPolicyVersionId'))
           FROM jsonb_array_elements(bindings) binding) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(operations) IS DISTINCT FROM 'array'
     OR jsonb_array_length(operations) > 32
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(operations) operation
       WHERE jsonb_typeof(operation) IS DISTINCT FROM 'object'
          OR NOT operation ?& ARRAY['key','description','instructions','resultSchema','timeoutMs']
          OR (operation - ARRAY['key','description','instructions','resultSchema','timeoutMs']) <> '{}'::jsonb
          OR jsonb_typeof(operation->'key') IS DISTINCT FROM 'string'
          OR length(operation->>'key') NOT BETWEEN 1 AND 64
          OR operation->>'key' !~ '^[a-z][a-z0-9_-]*$'
          OR jsonb_typeof(operation->'description') IS DISTINCT FROM 'string'
          OR length(operation->>'description') NOT BETWEEN 1 AND 2000
          OR jsonb_typeof(operation->'instructions') IS DISTINCT FROM 'string'
          OR length(operation->>'instructions') NOT BETWEEN 1 AND 100000
          OR jsonb_typeof(operation->'resultSchema') IS DISTINCT FROM 'object'
          OR operation->'resultSchema'->>'type' IS DISTINCT FROM 'object'
          OR octet_length(convert_to((operation->'resultSchema')::text,'UTF8')) > 65536
          OR NOT oao.is_valid_published_json_schema_node(operation->'resultSchema',0)
          OR jsonb_typeof(operation->'timeoutMs') IS DISTINCT FROM 'number'
          OR (operation->>'timeoutMs')::numeric <> (operation->>'timeoutMs')::integer
          OR (operation->>'timeoutMs')::integer NOT BETWEEN 1000 AND 300000
     )
     OR (SELECT count(*) FROM jsonb_array_elements(operations)) <>
        (SELECT count(DISTINCT operation->>'key') FROM jsonb_array_elements(operations) operation)
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(operations) operation
       WHERE operation->>'key' IN (
         'task','finish','give_up','activate_skill','read_skill_resource',
         'read','write','edit','bash','grep','glob','delegate_agent','message_agent'
       )
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(operations) operation
       JOIN jsonb_array_elements(COALESCE(p_config->'tools','[]'::jsonb)) tool
         ON tool->>'name'=operation->>'key'
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(COALESCE(p_config->'tools','[]'::jsonb)) tool
       WHERE tool->>'name' IN (
         'task','finish','give_up','activate_skill','read_skill_resource',
         'read','write','edit','bash','grep','glob','delegate_agent','message_agent'
       )
     ) THEN
    RETURN false;
  END IF;
  RETURN oao.is_valid_agent_publication_config_with_skills(
    p_config - 'mcpBindings' - 'harnessOperations'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE FUNCTION oao.capture_agent_version_harness_operations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    WITH mcp_names AS (
      SELECT oao.mcp_tool_name(binding->>'namespace',selection.remote_tool_name) AS tool_name
      FROM jsonb_array_elements(COALESCE(NEW.config->'mcpBindings','[]'::jsonb)) binding
      JOIN oao.mcp_toolset_version_tools selection
        ON selection.organization_id=NEW.organization_id
       AND selection.project_id=NEW.project_id
       AND selection.toolset_version_id=(binding->>'toolsetVersionId')::uuid
    ), visible_names AS (
      SELECT tool->>'name' AS tool_name
      FROM jsonb_array_elements(COALESCE(NEW.config->'tools','[]'::jsonb)) tool
      UNION ALL
      SELECT operation->>'key'
      FROM jsonb_array_elements(COALESCE(NEW.config->'harnessOperations','[]'::jsonb)) operation
      UNION ALL
      SELECT tool_name FROM mcp_names
    )
    SELECT 1 FROM visible_names GROUP BY tool_name HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'agent tool namespace collision involving a Harness Operation or MCP tool'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO oao.agent_version_harness_operations (
    organization_id,project_id,agent_version_id,operation_key,
    description,instructions,result_schema,timeout_ms
  )
  SELECT NEW.organization_id,NEW.project_id,NEW.id,operation->>'key',
         operation->>'description',operation->>'instructions',
         operation->'resultSchema',(operation->>'timeoutMs')::integer
  FROM jsonb_array_elements(COALESCE(NEW.config->'harnessOperations','[]'::jsonb)) operation;
  RETURN NEW;
END
$$;

CREATE TRIGGER capture_agent_version_harness_operations
AFTER INSERT ON oao.agent_versions
FOR EACH ROW EXECUTE FUNCTION oao.capture_agent_version_harness_operations();

ALTER TABLE oao.agent_version_harness_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.agent_version_harness_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.agent_version_harness_operations
  USING (
    organization_id=oao.current_organization_id()
    AND project_id=oao.current_project_id()
  )
  WITH CHECK (
    organization_id=oao.current_organization_id()
    AND project_id=oao.current_project_id()
  );

REVOKE ALL ON FUNCTION oao.capture_agent_version_harness_operations() FROM PUBLIC;
GRANT SELECT, INSERT ON oao.agent_version_harness_operations TO oao_app;
