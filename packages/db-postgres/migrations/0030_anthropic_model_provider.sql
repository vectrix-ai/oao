-- Add direct Anthropic connections and provider-specific Claude generation
-- settings without changing the already-applied provider/settings migrations.

ALTER TABLE oao.project_model_providers
  DROP CONSTRAINT project_model_providers_provider_type_check;
ALTER TABLE oao.project_model_providers
  ADD CONSTRAINT project_model_providers_provider_type_check
  CHECK (provider_type IN ('openrouter', 'openai', 'anthropic'));

ALTER TABLE oao.project_model_presets
  DROP CONSTRAINT project_model_presets_model_check;
ALTER TABLE oao.project_model_presets
  ADD CONSTRAINT project_model_presets_model_check
  CHECK (
    model ~ '^(openrouter/(?:@preset/)?|openai/|anthropic/)[a-zA-Z0-9~][a-zA-Z0-9._:~/-]*$'
    AND length(model) BETWEEN 1 AND 300
  );

CREATE OR REPLACE FUNCTION oao.is_valid_model_generation_settings(p_settings jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (
    jsonb_typeof(p_settings) = 'object'
    AND (
      (
        (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_settings) AS keys(key))
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
      )
      OR
      (
        (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_settings) AS keys(key))
          = ARRAY['effort','maxTokens','thinking']
        AND jsonb_typeof(p_settings->'thinking') = 'string'
        AND p_settings->>'thinking' IN ('disabled', 'adaptive')
        AND jsonb_typeof(p_settings->'maxTokens') = 'number'
        AND (p_settings->>'maxTokens')::numeric = trunc((p_settings->>'maxTokens')::numeric)
        AND (p_settings->>'maxTokens')::numeric BETWEEN 1 AND 300000
        AND jsonb_typeof(p_settings->'effort') = 'string'
        AND p_settings->>'effort' IN ('low', 'medium', 'high', 'xhigh', 'max')
      )
    )
    AND NOT oao.jsonb_has_forbidden_public_key(p_settings)
  )
$$;

REVOKE ALL ON FUNCTION oao.is_valid_model_generation_settings(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_valid_model_generation_settings(jsonb) TO oao_app;
