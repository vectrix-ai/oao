-- Preserve every publication invariant while rebinding validation to the
-- stricter real-provider-only function introduced in 0010.

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

REVOKE ALL ON FUNCTION oao.publish_agent_version(uuid,uuid,uuid,uuid,jsonb,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.publish_agent_version(uuid,uuid,uuid,uuid,jsonb,bytea,uuid) TO oao_app;
