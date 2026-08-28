-- Add direct xAI connections for dynamically discovered Grok language models
-- without changing already-applied provider migrations.

ALTER TABLE oao.project_model_providers
  DROP CONSTRAINT project_model_providers_provider_type_check;
ALTER TABLE oao.project_model_providers
  ADD CONSTRAINT project_model_providers_provider_type_check
  CHECK (provider_type IN ('openrouter', 'openai', 'anthropic', 'xai'));

ALTER TABLE oao.project_model_presets
  DROP CONSTRAINT project_model_presets_model_check;
ALTER TABLE oao.project_model_presets
  ADD CONSTRAINT project_model_presets_model_check
  CHECK (
    model ~ '^(openrouter/(?:@preset/)?|openai/|anthropic/|xai/)[a-zA-Z0-9~][a-zA-Z0-9._:~/-]*$'
    AND length(model) BETWEEN 1 AND 300
  );
