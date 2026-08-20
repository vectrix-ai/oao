-- Tenant-scoped hosted model providers and encrypted API credentials.
--
-- Provider credentials are encrypted by the API before insertion. PostgreSQL
-- stores only ciphertext, a unique nonce, the authentication tag, and a
-- non-secret fingerprint. The composite keys and foreign keys repeat tenant
-- identity so a provider or preset cannot be moved between projects.

CREATE TABLE oao.project_model_providers (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  provider_key text NOT NULL
    CHECK (provider_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(provider_key) BETWEEN 1 AND 120),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  provider_type text NOT NULL CHECK (provider_type IN ('openrouter', 'openai')),
  encrypted_api_key bytea NOT NULL CHECK (octet_length(encrypted_api_key) BETWEEN 1 AND 4096),
  encryption_nonce bytea NOT NULL CHECK (octet_length(encryption_nonce) = 12),
  encryption_tag bytea NOT NULL CHECK (octet_length(encryption_tag) = 16),
  encryption_key_version integer NOT NULL CHECK (encryption_key_version BETWEEN 1 AND 2147483647),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, provider_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals(organization_id, project_id, id)
);

CREATE FUNCTION oao.restrict_project_model_provider_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.display_name IS DISTINCT FROM OLD.display_name
     OR NEW.provider_type IS DISTINCT FROM OLD.provider_type
     OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'project model provider identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.encryption_key_version <= OLD.encryption_key_version THEN
    RAISE EXCEPTION 'provider credential version must increase' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER project_model_providers_restrict_mutation
BEFORE UPDATE ON oao.project_model_providers
FOR EACH ROW EXECUTE FUNCTION oao.restrict_project_model_provider_mutation();

ALTER TABLE oao.project_model_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.project_model_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.project_model_providers
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());

-- Existing 0006 rows remain readable as legacy, unbound presets. New API
-- writes always provide provider_id. They cannot be executed until recreated
-- against a project provider connection.
ALTER TABLE oao.project_model_presets
  ADD COLUMN provider_id uuid,
  ADD CONSTRAINT project_model_presets_provider_fkey
    FOREIGN KEY (organization_id, project_id, provider_id)
    REFERENCES oao.project_model_providers(organization_id, project_id, id);

ALTER TABLE oao.project_model_presets DROP CONSTRAINT project_model_presets_model_check;
ALTER TABLE oao.project_model_presets
  ADD CONSTRAINT project_model_presets_model_check
  CHECK (
    model ~ '^(openrouter|openai)/[a-z0-9~][a-z0-9._:~/-]*$'
    AND length(model) BETWEEN 1 AND 300
  );

CREATE INDEX project_model_presets_provider_idx
  ON oao.project_model_presets (organization_id, project_id, provider_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON oao.project_model_providers TO oao_app;
REVOKE ALL ON FUNCTION oao.restrict_project_model_provider_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.restrict_project_model_provider_mutation() TO oao_app;
