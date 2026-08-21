-- Mutable, PostgreSQL-authoritative authoring workspaces for immutable Skill
-- packages. A draft may contain real directory entries while it is edited;
-- publication copies only file entries into skill_version_files.

ALTER TABLE oao.product_events DROP CONSTRAINT product_events_event_kind_check;
ALTER TABLE oao.product_events ADD CONSTRAINT product_events_event_kind_check CHECK (event_kind IN (
  'delegation.created', 'delegation.follow_up_created', 'delegation.completed',
  'delegation.failed', 'delegation.cancelled',
  'skill.draft_created', 'skill.draft_discarded',
  'skill.created', 'skill.version_published', 'skill.version_deprecated',
  'skill.version_revoked', 'skill.activated', 'skill.resource_read',
  'run.created', 'run.state_changed', 'run.cancellation_requested', 'message.created',
  'tool_call.requested', 'tool_call.claimed', 'tool_call.result_submitted', 'tool_call.result_committed',
  'approval.requested', 'approval.resolved', 'sandbox.created', 'sandbox.started',
  'sandbox.stopped', 'sandbox.failed', 'sandbox.command_started', 'sandbox.command_completed',
  'sandbox.command_failed', 'model.invocation_completed', 'model.invocation_failed',
  'runtime.dispatch_reserved', 'runtime.dispatch_admitted', 'runtime.dispatch_reconciled',
  'runtime.recovery_started', 'runtime.recovery_completed', 'runtime.cancellation_draining',
  'session.summary_changed'
));

CREATE TABLE oao.skill_package_drafts (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  skill_id uuid,
  source_skill_version_id uuid,
  skill_key text NOT NULL DEFAULT '' CHECK (length(skill_key) <= 120),
  display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 200),
  skill_name text NOT NULL DEFAULT '' CHECK (length(skill_name) <= 64),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1024),
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 200000),
  license text CHECK (license IS NULL OR length(license) BETWEEN 1 AND 500),
  compatibility text CHECK (
    compatibility IS NULL OR length(compatibility) BETWEEN 1 AND 500
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object'
    AND NOT oao.jsonb_has_forbidden_public_key(metadata)
  ),
  allowed_tools text CHECK (
    allowed_tools IS NULL OR length(allowed_tools) BETWEEN 1 AND 2000
  ),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'editing' CHECK (status IN ('editing', 'published', 'discarded')),
  published_skill_version_id uuid,
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, skill_id)
    REFERENCES oao.skills (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, source_skill_version_id, skill_id)
    REFERENCES oao.skill_versions (organization_id, project_id, id, skill_id),
  FOREIGN KEY (organization_id, project_id, published_skill_version_id, skill_id)
    REFERENCES oao.skill_versions (organization_id, project_id, id, skill_id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id),
  CHECK ((published_skill_version_id IS NULL) = (status <> 'published'))
);

CREATE TABLE oao.skill_package_draft_entries (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  entry_path text NOT NULL CHECK (
    length(entry_path) BETWEEN 1 AND 240
    AND entry_path !~ '[[:cntrl:]\\]'
    AND entry_path !~ '(^|/)(\.|\.\.)(/|$)'
    AND entry_path !~ '^/'
    AND entry_path !~ '/$'
    AND lower(entry_path) <> 'skill.md'
  ),
  entry_kind text NOT NULL CHECK (entry_kind IN ('directory', 'file')),
  content_type text,
  size_bytes integer,
  content_sha256 bytea,
  content_bytes bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, draft_id, entry_path),
  FOREIGN KEY (organization_id, project_id, draft_id)
    REFERENCES oao.skill_package_drafts (organization_id, project_id, id)
    ON DELETE CASCADE,
  CHECK (
    (entry_kind = 'directory'
      AND content_type IS NULL
      AND size_bytes IS NULL
      AND content_sha256 IS NULL
      AND content_bytes IS NULL)
    OR
    (entry_kind = 'file'
      AND content_type IS NOT NULL
      AND length(content_type) BETWEEN 1 AND 200
      AND size_bytes BETWEEN 1 AND 5242880
      AND octet_length(content_sha256) = 32
      AND octet_length(content_bytes) = size_bytes)
  )
);

CREATE UNIQUE INDEX skill_package_draft_entries_folded_path_key
  ON oao.skill_package_draft_entries (
    organization_id, project_id, draft_id, lower(entry_path)
  );
CREATE INDEX skill_package_drafts_updated_idx
  ON oao.skill_package_drafts (
    organization_id, project_id, status, updated_at DESC, id DESC
  );

ALTER TABLE oao.skill_package_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.skill_package_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.skill_package_drafts
  USING (
    organization_id = oao.current_organization_id()
    AND project_id = oao.current_project_id()
  )
  WITH CHECK (
    organization_id = oao.current_organization_id()
    AND project_id = oao.current_project_id()
  );

ALTER TABLE oao.skill_package_draft_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.skill_package_draft_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.skill_package_draft_entries
  USING (
    organization_id = oao.current_organization_id()
    AND project_id = oao.current_project_id()
  )
  WITH CHECK (
    organization_id = oao.current_organization_id()
    AND project_id = oao.current_project_id()
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON
  oao.skill_package_drafts, oao.skill_package_draft_entries TO oao_app;
