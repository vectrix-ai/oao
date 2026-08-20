-- Tenant-scoped Daytona connections and immutable sandbox capability policy.

CREATE FUNCTION oao.is_valid_sandbox_restricted_egress(p_config jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object'
     OR NOT p_config ?& ARRAY['allowedDomains','allowedCidrs']
     OR (SELECT count(*) FROM jsonb_object_keys(p_config)) <> 2
     OR jsonb_typeof(p_config->'allowedDomains') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_config->'allowedCidrs') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_config->'allowedDomains') item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
      OR length(item #>> '{}') NOT BETWEEN 1 AND 253
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_config->'allowedCidrs') item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
      OR length(item #>> '{}') NOT BETWEEN 3 AND 64
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE TABLE oao.project_sandbox_providers (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  provider_key text NOT NULL
    CHECK (
      provider_key <> 'local-fake'
      AND provider_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
      AND length(provider_key) BETWEEN 1 AND 120
    ),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  provider_type text NOT NULL CHECK (provider_type = 'daytona'),
  encrypted_api_key bytea NOT NULL CHECK (octet_length(encrypted_api_key) BETWEEN 1 AND 4096),
  encryption_nonce bytea NOT NULL CHECK (octet_length(encryption_nonce) = 12),
  encryption_tag bytea NOT NULL CHECK (octet_length(encryption_tag) = 16),
  encryption_key_version integer NOT NULL CHECK (encryption_key_version BETWEEN 1 AND 2147483647),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  target text CHECK (target IS NULL OR length(target) BETWEEN 1 AND 200),
  restricted_egress jsonb NOT NULL DEFAULT '{"allowedDomains":[],"allowedCidrs":[]}'::jsonb
    CHECK (oao.is_valid_sandbox_restricted_egress(restricted_egress))
    CHECK (NOT oao.jsonb_has_forbidden_public_key(restricted_egress)),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, provider_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals(organization_id, project_id, id)
);

CREATE FUNCTION oao.restrict_project_sandbox_provider_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credential_changed boolean;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.display_name IS DISTINCT FROM OLD.display_name
     OR NEW.provider_type IS DISTINCT FROM OLD.provider_type
     OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'project sandbox provider identity is immutable' USING ERRCODE = '55000';
  END IF;
  credential_changed := NEW.encrypted_api_key IS DISTINCT FROM OLD.encrypted_api_key
    OR NEW.encryption_nonce IS DISTINCT FROM OLD.encryption_nonce
    OR NEW.encryption_tag IS DISTINCT FROM OLD.encryption_tag
    OR NEW.credential_fingerprint IS DISTINCT FROM OLD.credential_fingerprint;
  IF NEW.encryption_key_version < OLD.encryption_key_version
     OR (credential_changed AND NEW.encryption_key_version <= OLD.encryption_key_version)
     OR (NOT credential_changed AND NEW.encryption_key_version <> OLD.encryption_key_version) THEN
    RAISE EXCEPTION 'sandbox provider credential version is invalid' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER project_sandbox_providers_restrict_mutation
BEFORE UPDATE ON oao.project_sandbox_providers
FOR EACH ROW EXECUTE FUNCTION oao.restrict_project_sandbox_provider_mutation();

ALTER TABLE oao.project_sandbox_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.project_sandbox_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.project_sandbox_providers
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());

CREATE INDEX project_sandbox_providers_created_idx
  ON oao.project_sandbox_providers (organization_id, project_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION oao.is_valid_agent_publication_config(p_config jsonb)
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
     OR (p_config->'limits'->>'maxTurns')::numeric <> 32
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

GRANT SELECT, INSERT, UPDATE, DELETE ON oao.project_sandbox_providers TO oao_app;
REVOKE ALL ON FUNCTION oao.is_valid_sandbox_restricted_egress(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.restrict_project_sandbox_provider_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_sandbox_restricted_egress(jsonb) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.restrict_project_sandbox_provider_mutation() TO oao_app;
