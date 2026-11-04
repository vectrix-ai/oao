-- The price of a model preset, per one million tokens in USD. A preset itself
-- is immutable because agent versions pin it, while a provider's price changes,
-- so prices are their own append-only rows. A new price adds a row with the time
-- it starts; a model call is charged the row in effect when it started, and the
-- invocation records those rates, so past runs keep the cost they were given.

CREATE TABLE oao.model_preset_prices (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  preset_id uuid NOT NULL,
  input_usd_per_million numeric(14, 6) NOT NULL
    CHECK (input_usd_per_million >= 0),
  cached_input_usd_per_million numeric(14, 6) NOT NULL
    CHECK (cached_input_usd_per_million >= 0),
  cache_write_usd_per_million numeric(14, 6) NOT NULL
    CHECK (cache_write_usd_per_million >= 0),
  output_usd_per_million numeric(14, 6) NOT NULL
    CHECK (output_usd_per_million >= 0),
  -- Optional higher rates for a model call whose whole input is above this size.
  long_context_above_input_tokens bigint
    CHECK (long_context_above_input_tokens > 0),
  long_context_input_usd_per_million numeric(14, 6)
    CHECK (long_context_input_usd_per_million >= 0),
  long_context_cached_input_usd_per_million numeric(14, 6)
    CHECK (long_context_cached_input_usd_per_million >= 0),
  long_context_cache_write_usd_per_million numeric(14, 6)
    CHECK (long_context_cache_write_usd_per_million >= 0),
  long_context_output_usd_per_million numeric(14, 6)
    CHECK (long_context_output_usd_per_million >= 0),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, preset_id, valid_from),
  -- Project deletion removes presets; their prices go with them.
  FOREIGN KEY (organization_id, project_id, preset_id)
    REFERENCES oao.project_model_presets (organization_id, project_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals (organization_id, project_id, id),
  CONSTRAINT model_preset_prices_long_context_complete CHECK (
    num_nonnulls(
      long_context_above_input_tokens,
      long_context_input_usd_per_million,
      long_context_cached_input_usd_per_million,
      long_context_cache_write_usd_per_million,
      long_context_output_usd_per_million
    ) IN (0, 5)
  )
);

CREATE TRIGGER model_preset_prices_immutable
BEFORE UPDATE ON oao.model_preset_prices
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

-- Rows leave only with their preset: a direct delete fails, the foreign key's
-- cascade (which runs inside a trigger) does not.
CREATE FUNCTION oao.reject_direct_model_preset_price_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '23000';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER model_preset_prices_no_direct_delete
BEFORE DELETE ON oao.model_preset_prices
FOR EACH ROW EXECUTE FUNCTION oao.reject_direct_model_preset_price_delete();

ALTER TABLE oao.model_preset_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.model_preset_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.model_preset_prices
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());

GRANT SELECT, INSERT ON oao.model_preset_prices TO oao_app;

-- The project usage report reads model calls by time.
CREATE INDEX model_invocations_project_started_idx
  ON oao.model_invocations (organization_id, project_id, started_at);
