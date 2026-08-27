-- Immutable, provider-neutral generation controls for model presets.
-- Existing rows remain valid with NULL settings; the runtime supplies the
-- documented OpenAI defaults for those legacy presets.

CREATE FUNCTION oao.is_valid_model_generation_settings(p_settings jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(p_settings) = 'object'
    AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_settings) AS keys(key))
      = ARRAY['reasoningEffort','reasoningMode','reasoningSummary','textFormat','verbosity']
    AND jsonb_typeof(p_settings->'textFormat') = 'string'
    AND p_settings->>'textFormat' = 'text'
    AND jsonb_typeof(p_settings->'reasoningMode') = 'string'
    AND p_settings->>'reasoningMode' IN ('standard', 'pro')
    AND jsonb_typeof(p_settings->'reasoningEffort') = 'string'
    AND p_settings->>'reasoningEffort' IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')
    AND jsonb_typeof(p_settings->'verbosity') = 'string'
    AND p_settings->>'verbosity' IN ('low', 'medium', 'high')
    AND jsonb_typeof(p_settings->'reasoningSummary') = 'string'
    AND p_settings->>'reasoningSummary' IN ('auto', 'concise', 'detailed')
    AND NOT oao.jsonb_has_forbidden_public_key(p_settings)
$$;

ALTER TABLE oao.project_model_presets
  ADD COLUMN settings jsonb,
  ADD CONSTRAINT project_model_presets_settings_check
    CHECK (settings IS NULL OR oao.is_valid_model_generation_settings(settings));

REVOKE ALL ON FUNCTION oao.is_valid_model_generation_settings(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_model_generation_settings(jsonb) TO oao_app;
