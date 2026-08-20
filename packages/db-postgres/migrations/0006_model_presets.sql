-- Durable, project-scoped model presets.
--
-- A preset is an append-only approval record: rows are immutable, keys are
-- unique per project, and every agent version keeps referring to a key whose
-- meaning can never change. Deployment presets stay in environment
-- configuration and are deliberately absent from this table.

CREATE FUNCTION oao.is_valid_model_routing_policy(p_routing jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  entry jsonb;
  provider_key text;
BEGIN
  IF jsonb_typeof(p_routing) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_routing) AS k(name)
    WHERE k.name NOT IN (
      'allowFallbacks', 'requireParameters', 'dataCollection', 'zeroDataRetention',
      'providerOrder', 'providerAllowlist', 'providerDenylist', 'sort',
      'maxPromptPriceUsdPerMillion', 'maxCompletionPriceUsdPerMillion'
    )
  ) THEN
    RETURN false;
  END IF;
  FOREACH provider_key IN ARRAY ARRAY['allowFallbacks', 'requireParameters', 'zeroDataRetention'] LOOP
    IF p_routing ? provider_key
       AND jsonb_typeof(p_routing->provider_key) IS DISTINCT FROM 'boolean' THEN
      RETURN false;
    END IF;
  END LOOP;
  IF p_routing ? 'dataCollection'
     AND (jsonb_typeof(p_routing->'dataCollection') IS DISTINCT FROM 'string'
          OR p_routing->>'dataCollection' NOT IN ('deny', 'allow')) THEN
    RETURN false;
  END IF;
  IF p_routing ? 'sort'
     AND (jsonb_typeof(p_routing->'sort') IS DISTINCT FROM 'string'
          OR p_routing->>'sort' NOT IN ('price', 'throughput', 'latency')) THEN
    RETURN false;
  END IF;
  FOREACH provider_key IN ARRAY ARRAY['providerOrder', 'providerAllowlist', 'providerDenylist'] LOOP
    IF p_routing ? provider_key THEN
      IF jsonb_typeof(p_routing->provider_key) IS DISTINCT FROM 'array'
         OR jsonb_array_length(p_routing->provider_key) NOT BETWEEN 1 AND 16 THEN
        RETURN false;
      END IF;
      FOR entry IN SELECT value FROM jsonb_array_elements(p_routing->provider_key) LOOP
        IF jsonb_typeof(entry) IS DISTINCT FROM 'string'
           OR (entry #>> '{}') !~ '^[a-z0-9][a-z0-9._-]{0,79}$' THEN
          RETURN false;
        END IF;
      END LOOP;
      IF (SELECT count(*) FROM jsonb_array_elements_text(p_routing->provider_key))
         <> (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(p_routing->provider_key)) THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  FOREACH provider_key IN ARRAY ARRAY['maxPromptPriceUsdPerMillion', 'maxCompletionPriceUsdPerMillion'] LOOP
    IF p_routing ? provider_key THEN
      IF jsonb_typeof(p_routing->provider_key) IS DISTINCT FROM 'number'
         OR (p_routing->>provider_key)::numeric < 0
         OR (p_routing->>provider_key)::numeric > 1000000 THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN NOT oao.jsonb_has_forbidden_public_key(p_routing);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE TABLE oao.project_model_presets (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  preset_key text NOT NULL
    CHECK (preset_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*-v[1-9][0-9]{0,4}$' AND length(preset_key) BETWEEN 1 AND 120),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  -- Shape only. The API validates the identifier against the pinned catalog;
  -- this constraint keeps an obviously malformed value out of the table.
  model text NOT NULL
    CHECK (model ~ '^openrouter/[a-z0-9~][a-z0-9._:~/-]*$' AND length(model) BETWEEN 1 AND 300),
  routing jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (oao.is_valid_model_routing_policy(routing)),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, preset_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals(organization_id, project_id, id)
);

CREATE INDEX project_model_presets_created_idx
  ON oao.project_model_presets (organization_id, project_id, created_at DESC, id DESC);

-- Append-only: an approved preset can never be repointed or removed, so an
-- older immutable agent version always keeps the model it was published with.
CREATE TRIGGER project_model_presets_immutable
BEFORE UPDATE OR DELETE ON oao.project_model_presets
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

ALTER TABLE oao.project_model_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.project_model_presets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.project_model_presets
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON oao.project_model_presets TO oao_app;
REVOKE ALL ON FUNCTION oao.is_valid_model_routing_policy(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_model_routing_policy(jsonb) TO oao_app;
