-- Keep model-preset settings safe for public payloads by using provider-neutral
-- field names. Migration 0028 is already applied in development and therefore
-- remains immutable; this migration updates only its validator.

CREATE OR REPLACE FUNCTION oao.is_valid_model_generation_settings(p_settings jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(p_settings) = 'object'
    AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_settings) AS keys(key))
      = ARRAY['effort','mode','summary','textFormat','verbosity']
    AND jsonb_typeof(p_settings->'textFormat') = 'string'
    AND p_settings->>'textFormat' = 'text'
    AND jsonb_typeof(p_settings->'mode') = 'string'
    AND p_settings->>'mode' IN ('standard', 'pro')
    AND jsonb_typeof(p_settings->'effort') = 'string'
    AND p_settings->>'effort' IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')
    AND jsonb_typeof(p_settings->'verbosity') = 'string'
    AND p_settings->>'verbosity' IN ('low', 'medium', 'high')
    AND jsonb_typeof(p_settings->'summary') = 'string'
    AND p_settings->>'summary' IN ('auto', 'concise', 'detailed')
    AND NOT oao.jsonb_has_forbidden_public_key(p_settings)
$$;

REVOKE ALL ON FUNCTION oao.is_valid_model_generation_settings(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_model_generation_settings(jsonb) TO oao_app;
