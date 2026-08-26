-- Add the provider-neutral Harness Operation lifecycle vocabulary without
-- rewriting the already-applied immutable Harness Operation schema migration.

ALTER TABLE oao.product_events DROP CONSTRAINT product_events_event_kind_check;
ALTER TABLE oao.product_events ADD CONSTRAINT product_events_event_kind_check CHECK (event_kind IN (
  'delegation.created', 'delegation.follow_up_created', 'delegation.completed',
  'delegation.failed', 'delegation.cancelled',
  'skill.draft_created', 'skill.draft_discarded',
  'skill.created', 'skill.version_published', 'skill.version_deprecated',
  'skill.version_revoked', 'skill.activated', 'skill.resource_read',
  'mcp.server_created', 'mcp.server_version_published',
  'mcp.discovery_completed', 'mcp.discovery_failed', 'mcp.toolset_published',
  'mcp.credential_created', 'mcp.credential_rotated', 'mcp.credential_revoked',
  'mcp.call_started', 'mcp.call_completed', 'mcp.call_failed', 'mcp.call_cancelled',
  'harness.operation_started', 'harness.operation_completed',
  'harness.operation_failed', 'harness.operation_cancelled',
  'harness.operation_timed_out',
  'run.created', 'run.state_changed', 'run.cancellation_requested', 'message.created',
  'tool_call.requested', 'tool_call.claimed', 'tool_call.result_submitted', 'tool_call.result_committed',
  'approval.requested', 'approval.resolved', 'sandbox.created', 'sandbox.started',
  'sandbox.stopped', 'sandbox.failed', 'sandbox.command_started', 'sandbox.command_completed',
  'sandbox.command_failed', 'model.invocation_completed', 'model.invocation_failed',
  'runtime.dispatch_reserved', 'runtime.dispatch_admitted', 'runtime.dispatch_reconciled',
  'runtime.recovery_started', 'runtime.recovery_completed', 'runtime.cancellation_draining',
  'session.summary_changed'
));
