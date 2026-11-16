-- A session may name a prompt cache key when it is created. Every model call
-- of the session, follow-up runs included, sends the key to the provider as
-- its cache and routing key, so sessions with the same key read each other's
-- cached input. The first `initial_prefix_chars` characters of the initial
-- run's message are the same for every session with the key, and the runtime
-- ends them in a cache breakpoint of their own.
--
-- The setting is fixed when the session is created. A session without a row
-- keeps a per-agent-version key.
CREATE TABLE oao.session_prompt_caches (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  cache_key text NOT NULL
    CONSTRAINT session_prompt_caches_key_format
      CHECK (cache_key ~ '^[!-~]{1,64}$'),
  initial_run_id uuid NOT NULL,
  initial_prefix_chars integer NOT NULL DEFAULT 0
    CONSTRAINT session_prompt_caches_prefix_bounded
      CHECK (initial_prefix_chars BETWEEN 0 AND 400000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, session_id),
  FOREIGN KEY (organization_id, project_id, session_id)
    REFERENCES oao.sessions (organization_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, initial_run_id)
    REFERENCES oao.runs (organization_id, project_id, id) ON DELETE CASCADE
);

CREATE INDEX session_prompt_caches_initial_run_idx
  ON oao.session_prompt_caches (organization_id, project_id, initial_run_id);

ALTER TABLE oao.session_prompt_caches ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.session_prompt_caches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.session_prompt_caches
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());
GRANT SELECT, INSERT ON oao.session_prompt_caches TO oao_app;
