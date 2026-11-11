-- An agent version may ask OAO to predict the message the user is most likely
-- to send next, after each of its runs completes. The setting is an optional
-- boolean, `promptSuggestions`; a config without it keeps its exact shape,
-- content hash, and behaviour.

-- The setting is validated beside the text publication setting. The previous
-- validator keeps validating everything else.
ALTER FUNCTION oao.is_valid_agent_publication_config_with_mcp(jsonb)
  RENAME TO is_valid_agent_publication_config_without_prompt_suggestions;

CREATE FUNCTION oao.is_valid_agent_publication_config_with_mcp(p_config jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_config ? 'promptSuggestions'
     AND jsonb_typeof(p_config->'promptSuggestions') IS DISTINCT FROM 'boolean' THEN
    RETURN false;
  END IF;
  RETURN oao.is_valid_agent_publication_config_without_prompt_suggestions(
    p_config - 'promptSuggestions'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

-- The suggestion is public text that belongs to one completed run. It is not a
-- message: nothing about it enters the transcript or the model's conversation.
ALTER TABLE oao.runs ADD COLUMN suggestion text
  CONSTRAINT runs_suggestion_bounded
    CHECK (char_length(suggestion) BETWEEN 1 AND 500);
ALTER TABLE oao.runs ADD CONSTRAINT runs_suggestion_completed
  CHECK (suggestion IS NULL OR state = 'completed');

-- A suggestion is void once its session has a newer run. Every read uses this
-- so the API, the session read, and webhook delivery agree.
CREATE FUNCTION oao.current_run_suggestion(p_run oao.runs)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT p_run.suggestion
   WHERE p_run.suggestion IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM oao.runs newer
        WHERE newer.organization_id = p_run.organization_id
          AND newer.project_id = p_run.project_id
          AND newer.thread_id = p_run.thread_id
          AND (newer.created_at, newer.id) > (p_run.created_at, p_run.id)
     )
$$;

-- The event that tells readers a run has a suggestion. It names the run and
-- carries no text.
ALTER TABLE oao.product_events DROP CONSTRAINT product_events_event_kind_check;
ALTER TABLE oao.product_events ADD CONSTRAINT product_events_event_kind_check CHECK (event_kind IN (
  'delegation.created', 'delegation.follow_up_created', 'delegation.completed',
  'delegation.failed', 'delegation.cancelled',
  'skill.draft_created', 'skill.draft_discarded',
  'skill.created', 'skill.version_published', 'skill.version_deprecated',
  'skill.version_revoked', 'skill.activated', 'skill.resource_read',
  'skill.disabled', 'skill.enabled', 'skill.deleted',
  'mcp.server_created', 'mcp.server_version_published',
  'mcp.discovery_completed', 'mcp.discovery_failed', 'mcp.toolset_published',
  'mcp.credential_created', 'mcp.credential_rotated', 'mcp.credential_revoked',
  'mcp.call_started', 'mcp.call_completed', 'mcp.call_failed', 'mcp.call_cancelled',
  'harness.operation_started', 'harness.operation_completed',
  'harness.operation_failed', 'harness.operation_cancelled',
  'harness.operation_timed_out', 'harness.operation_step',
  'run.created', 'run.state_changed', 'run.cancellation_requested',
  'run.suggestion_created', 'message.created',
  'tool_call.requested', 'tool_call.claimed', 'tool_call.result_submitted', 'tool_call.result_committed',
  'approval.requested', 'approval.resolved', 'sandbox.created', 'sandbox.started',
  'sandbox.stopped', 'sandbox.failed', 'sandbox.command_started', 'sandbox.command_completed',
  'sandbox.command_failed', 'model.invocation_completed', 'model.invocation_failed',
  'model.invocation_started', 'model.retry_scheduled',
  'runtime.dispatch_reserved', 'runtime.dispatch_admitted', 'runtime.dispatch_reconciled',
  'runtime.recovery_started', 'runtime.recovery_completed', 'runtime.cancellation_draining',
  'session.summary_changed'
));
