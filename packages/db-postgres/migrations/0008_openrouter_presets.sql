-- Allow OpenRouter saved presets to be approved through OAO model presets.
--
-- OpenRouter presets are called through the chat-completions model field using
-- @preset/<slug>. The public OAO model value keeps the provider prefix so the
-- runtime can route it through the selected project provider connection.

ALTER TABLE oao.project_model_presets DROP CONSTRAINT project_model_presets_model_check;
ALTER TABLE oao.project_model_presets
  ADD CONSTRAINT project_model_presets_model_check
  CHECK (
    (
      model ~ '^openrouter/(?:@preset/)?[A-Za-z0-9~][A-Za-z0-9._:~/-]*$'
      OR model ~ '^openai/[a-z0-9~][a-z0-9._:~/-]*$'
    )
    AND length(model) BETWEEN 1 AND 300
  );
