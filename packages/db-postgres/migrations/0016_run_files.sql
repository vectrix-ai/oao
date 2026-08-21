CREATE TABLE oao.run_files (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  message_id uuid NOT NULL,
  file_name text NOT NULL CHECK (
    length(file_name) BETWEEN 1 AND 255
    AND file_name !~ '[[:cntrl:]]'
    AND file_name !~ '[/\\\\]'
  ),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 200),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  content_bytes bytea NOT NULL,
  extracted_text text CHECK (
    extracted_text IS NULL OR length(extracted_text) BETWEEN 1 AND 200000
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, run_id, id),
  UNIQUE (organization_id, project_id, message_id, file_name),
  FOREIGN KEY (organization_id, project_id, run_id)
    REFERENCES oao.runs (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, message_id)
    REFERENCES oao.messages (organization_id, project_id, id),
  CHECK (octet_length(content_bytes) = size_bytes)
);

CREATE INDEX run_files_run_created_idx
  ON oao.run_files (organization_id, project_id, run_id, created_at, id);

ALTER TABLE oao.run_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.run_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.run_files
  USING (
    organization_id = oao.current_organization_id()
    AND project_id = oao.current_project_id()
  )
  WITH CHECK (
    organization_id = oao.current_organization_id()
    AND project_id = oao.current_project_id()
  );

CREATE TRIGGER run_files_immutable
BEFORE UPDATE OR DELETE ON oao.run_files
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

GRANT SELECT, INSERT ON oao.run_files TO oao_app;
