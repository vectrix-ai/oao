-- Rebind the publication function to the stricter validator created in 0010.
-- PostgreSQL may cache the function OID referenced by the original PL/pgSQL
-- publication body, so replacing the body is an additive, deterministic fix.

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
  current_version integer;
  published oao.agent_versions;
BEGIN
  IF NOT oao.is_valid_agent_publication_config(p_config) THEN
    RAISE EXCEPTION 'invalid managed agent publication config' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM oao.agent_definitions
   WHERE organization_id=p_organization_id
     AND project_id=p_project_id
     AND id=p_agent_definition_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent definition not found' USING ERRCODE='P0002';
  END IF;
  SELECT COALESCE(max(version),0)+1 INTO current_version
    FROM oao.agent_versions
   WHERE organization_id=p_organization_id
     AND project_id=p_project_id
     AND agent_definition_id=p_agent_definition_id;
  INSERT INTO oao.agent_versions(
    organization_id,project_id,id,agent_definition_id,version,content_hash,config,created_by_principal_id
  ) VALUES (
    p_organization_id,p_project_id,p_version_id,p_agent_definition_id,current_version,
    p_content_hash,p_config,p_created_by_principal_id
  ) RETURNING * INTO published;
  UPDATE oao.agent_definitions
     SET latest_version_id=p_version_id
   WHERE organization_id=p_organization_id
     AND project_id=p_project_id
     AND id=p_agent_definition_id;
  RETURN published;
END
$$;

REVOKE ALL ON FUNCTION oao.publish_agent_version(uuid,uuid,uuid,uuid,jsonb,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.publish_agent_version(uuid,uuid,uuid,uuid,jsonb,bytea,uuid) TO oao_app;
