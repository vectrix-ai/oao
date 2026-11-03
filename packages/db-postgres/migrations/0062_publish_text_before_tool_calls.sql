-- An agent version may publish the text the model writes in each turn as its
-- own assistant message before that turn's tool calls run, instead of only in
-- the reply when the run settles. The setting is an optional boolean,
-- `publishTextBeforeToolCalls`; a config without it keeps its exact shape,
-- content hash, and behaviour.

-- The setting is validated beside the OAO tool grant. The previous validator
-- keeps validating everything else.
ALTER FUNCTION oao.is_valid_agent_publication_config_with_mcp(jsonb)
  RENAME TO is_valid_agent_publication_config_without_text_publication;

CREATE FUNCTION oao.is_valid_agent_publication_config_with_mcp(p_config jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_config ? 'publishTextBeforeToolCalls'
     AND jsonb_typeof(p_config->'publishTextBeforeToolCalls') IS DISTINCT FROM 'boolean' THEN
    RETURN false;
  END IF;
  RETURN oao.is_valid_agent_publication_config_without_text_publication(
    p_config - 'publishTextBeforeToolCalls'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;
