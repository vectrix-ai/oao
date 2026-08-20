CREATE TABLE oao.project_storage_providers (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  provider_key text NOT NULL CHECK (
    provider_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    AND length(provider_key) BETWEEN 1 AND 120
  ),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  provider_type text NOT NULL CHECK (provider_type = 's3'),
  endpoint text,
  region text NOT NULL CHECK (length(region) BETWEEN 1 AND 120),
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 1 AND 255),
  object_prefix text,
  force_path_style boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  encrypted_credential bytea NOT NULL,
  encryption_nonce bytea NOT NULL CHECK (octet_length(encryption_nonce) = 12),
  encryption_tag bytea NOT NULL CHECK (octet_length(encryption_tag) = 16),
  encryption_key_version integer NOT NULL DEFAULT 1 CHECK (encryption_key_version > 0),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, provider_key),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id),
  CHECK (endpoint IS NULL OR (length(endpoint) BETWEEN 8 AND 2048)),
  CHECK (object_prefix IS NULL OR length(object_prefix) BETWEEN 1 AND 512)
);

CREATE UNIQUE INDEX project_storage_providers_one_default_idx
  ON oao.project_storage_providers (organization_id, project_id)
  WHERE is_default;

CREATE INDEX project_storage_providers_created_idx
  ON oao.project_storage_providers (organization_id, project_id, created_at DESC, id DESC);

CREATE FUNCTION oao.restrict_project_storage_provider_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.id <> OLD.id
     OR NEW.provider_key <> OLD.provider_key
     OR NEW.display_name <> OLD.display_name
     OR NEW.provider_type <> OLD.provider_type
     OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
     OR NEW.region <> OLD.region
     OR NEW.bucket <> OLD.bucket
     OR NEW.object_prefix IS DISTINCT FROM OLD.object_prefix
     OR NEW.force_path_style <> OLD.force_path_style
     OR NEW.created_by_principal_id <> OLD.created_by_principal_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'project storage provider configuration is immutable';
  END IF;
  IF NEW.encryption_key_version < OLD.encryption_key_version THEN
    RAISE EXCEPTION 'project storage provider credential version cannot decrease';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER project_storage_providers_restrict_mutation
BEFORE UPDATE ON oao.project_storage_providers
FOR EACH ROW EXECUTE FUNCTION oao.restrict_project_storage_provider_mutation();

ALTER TABLE oao.project_storage_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.project_storage_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.project_storage_providers
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());

CREATE TABLE oao.thread_workspace_backups (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  session_id uuid NOT NULL,
  storage_provider_id uuid NOT NULL,
  last_run_id uuid NOT NULL,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
  content_length bigint NOT NULL CHECK (content_length >= 0),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  backed_up_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_restored_at timestamptz,
  PRIMARY KEY (organization_id, project_id, thread_id),
  FOREIGN KEY (organization_id, project_id, thread_id)
    REFERENCES oao.threads (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, session_id, thread_id)
    REFERENCES oao.sessions (organization_id, project_id, id, thread_id),
  FOREIGN KEY (organization_id, project_id, last_run_id, thread_id, session_id)
    REFERENCES oao.runs (organization_id, project_id, id, thread_id, session_id),
  FOREIGN KEY (organization_id, project_id, storage_provider_id)
    REFERENCES oao.project_storage_providers (organization_id, project_id, id)
);

ALTER TABLE oao.thread_workspace_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.thread_workspace_backups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.thread_workspace_backups
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());

GRANT SELECT, INSERT, UPDATE ON oao.project_storage_providers TO oao_app;
GRANT SELECT, INSERT, UPDATE ON oao.thread_workspace_backups TO oao_app;
