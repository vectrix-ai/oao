-- The context window and output limit of a model preset, in tokens. A preset
-- itself is immutable because agent versions pin it, while the right limits
-- for the model behind it change, so limits are their own append-only rows.
-- The latest row applies from the next run that activates the preset; a null
-- limit leaves the model's catalog value, or OAO's default, in place.
--
-- Numbered 0066 so it stays clear of 0065, which another open change adds.

CREATE TABLE oao.model_preset_limits (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  preset_id uuid NOT NULL,
  context_window integer
    CONSTRAINT model_preset_limits_context_window_range
      CHECK (context_window BETWEEN 1024 AND 10000000),
  max_output_tokens integer
    CONSTRAINT model_preset_limits_max_output_tokens_range
      CHECK (max_output_tokens BETWEEN 1 AND 1000000),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  -- The newest row applies, so two rows of a preset never share a time; a
  -- restore keeps the times, and with them which row is newest.
  CONSTRAINT model_preset_limits_one_per_instant
    UNIQUE (organization_id, project_id, preset_id, created_at),
  -- Project deletion removes presets; their limits go with them.
  FOREIGN KEY (organization_id, project_id, preset_id)
    REFERENCES oao.project_model_presets (organization_id, project_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id),
  CONSTRAINT model_preset_limits_output_fits_context CHECK (
    context_window IS NULL
    OR max_output_tokens IS NULL
    OR max_output_tokens <= context_window
  )
);

CREATE TRIGGER model_preset_limits_immutable
BEFORE UPDATE ON oao.model_preset_limits
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

-- Rows leave only with their preset, the same way prices do.
CREATE TRIGGER model_preset_limits_no_direct_delete
BEFORE DELETE ON oao.model_preset_limits
FOR EACH ROW EXECUTE FUNCTION oao.reject_direct_model_preset_price_delete();

ALTER TABLE oao.model_preset_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.model_preset_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.model_preset_limits
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());

GRANT SELECT, INSERT ON oao.model_preset_limits TO oao_app;
