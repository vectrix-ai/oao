import * as v from "valibot";

const IdSchema = v.pipe(v.string(), v.uuid());
const TimestampSchema = v.pipe(v.string(), v.isoTimestamp());
const JsonObjectSchema = v.record(v.string(), v.unknown());

export const OrganizationSchema = v.object({
  id: IdSchema,
  slug: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  createdAt: TimestampSchema,
});

export const ProjectSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  slug: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  createdAt: TimestampSchema,
});

export const AgentDefinitionSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  description: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
  latestVersionId: v.nullable(IdSchema),
  createdAt: TimestampSchema,
});

export const AgentVersionSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  agentDefinitionId: IdSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  config: JsonObjectSchema,
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
});

export const ThreadSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  title: v.optional(v.pipe(v.string(), v.maxLength(500))),
  createdAt: TimestampSchema,
});

export const SessionStatusSchema = v.picklist([
  "active",
  "idle",
  "closed",
  "errored",
]);
export const SessionSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  threadId: IdSchema,
  agentVersionId: IdSchema,
  status: SessionStatusSchema,
  createdAt: TimestampSchema,
  lastActivityAt: TimestampSchema,
});

export const RunStateSchema = v.picklist([
  "queued",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "retry_scheduled",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const RunSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  threadId: IdSchema,
  sessionId: IdSchema,
  agentVersionId: IdSchema,
  createdByPrincipalId: IdSchema,
  state: RunStateSchema,
  cancellationRequestedAt: v.nullable(TimestampSchema),
  admittedAt: v.nullable(TimestampSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const MessageRoleSchema = v.picklist([
  "system",
  "user",
  "assistant",
  "tool",
]);
export const MessageSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  threadId: IdSchema,
  runId: IdSchema,
  role: MessageRoleSchema,
  redactedContent: v.string(),
  createdAt: TimestampSchema,
});

export const ToolCallStatusSchema = v.picklist([
  "pending",
  "claimed",
  "result_submitted",
  "committed",
  "cancelled",
]);
export const ToolCallSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  toolName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  status: ToolCallStatusSchema,
  safeArguments: JsonObjectSchema,
  claimFence: v.pipe(v.number(), v.integer(), v.minValue(0)),
  createdAt: TimestampSchema,
});

export const ApprovalStatusSchema = v.picklist([
  "pending",
  "approved",
  "denied",
  "expired",
]);
export const ApprovalSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  toolCallId: v.nullable(IdSchema),
  status: ApprovalStatusSchema,
  summary: v.pipe(v.string(), v.maxLength(2_000)),
  expiresAt: v.nullable(TimestampSchema),
  resolvedByPrincipalId: v.nullable(IdSchema),
  resolvedAt: v.nullable(TimestampSchema),
});

export const ProductEventKindSchema = v.picklist([
  "run.created",
  "run.state_changed",
  "run.cancellation_requested",
  "message.created",
  "tool_call.requested",
  "tool_call.claimed",
  "tool_call.result_submitted",
  "tool_call.result_committed",
  "approval.requested",
  "approval.resolved",
  "sandbox.created",
  "sandbox.started",
  "sandbox.stopped",
  "sandbox.failed",
  "model.invocation_completed",
]);
export const ProductEventSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  aggregateType: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  aggregateId: IdSchema,
  aggregateSequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
  projectPosition: v.pipe(v.string(), v.regex(/^\d+$/u)),
  kind: ProductEventKindSchema,
  publicPayload: JsonObjectSchema,
  occurredAt: TimestampSchema,
});

export const CursorSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(256),
);
export const PaginationRequestSchema = v.object({
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)),
    50,
  ),
  cursor: v.optional(CursorSchema),
});
export const PageInfoSchema = v.object({
  nextCursor: v.nullable(CursorSchema),
  hasMore: v.boolean(),
});

export const ApiErrorCodeSchema = v.picklist([
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "rate_limited",
  "internal_error",
]);
export const ApiErrorSchema = v.object({
  error: v.object({
    code: ApiErrorCodeSchema,
    message: v.string(),
    requestId: v.optional(v.string()),
    details: v.optional(JsonObjectSchema),
  }),
});

export type Organization = v.InferOutput<typeof OrganizationSchema>;
export type Project = v.InferOutput<typeof ProjectSchema>;
export type AgentDefinition = v.InferOutput<typeof AgentDefinitionSchema>;
export type AgentVersion = v.InferOutput<typeof AgentVersionSchema>;
export type Thread = v.InferOutput<typeof ThreadSchema>;
export type Session = v.InferOutput<typeof SessionSchema>;
export type RunState = v.InferOutput<typeof RunStateSchema>;
export type Run = v.InferOutput<typeof RunSchema>;
export type Message = v.InferOutput<typeof MessageSchema>;
export type ToolCall = v.InferOutput<typeof ToolCallSchema>;
export type Approval = v.InferOutput<typeof ApprovalSchema>;
export type ProductEventKind = v.InferOutput<typeof ProductEventKindSchema>;
export type ProductEvent = v.InferOutput<typeof ProductEventSchema>;
export type ApiError = v.InferOutput<typeof ApiErrorSchema>;
export type Page<T> = {
  readonly data: readonly T[];
  readonly pageInfo: v.InferOutput<typeof PageInfoSchema>;
};
