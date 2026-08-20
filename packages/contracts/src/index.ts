import * as v from "valibot";

const IdSchema = v.pipe(v.string(), v.uuid());
const TimestampSchema = v.pipe(v.string(), v.isoTimestamp());
const JsonObjectSchema = v.record(v.string(), v.unknown());

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isSupportedToolJsonSchema(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if ("enum" in value) {
    return (
      hasOnlyKeys(value, ["enum"]) &&
      Array.isArray(value.enum) &&
      value.enum.length > 0 &&
      value.enum.every(
        (entry) =>
          entry === null ||
          typeof entry === "string" ||
          typeof entry === "number" ||
          typeof entry === "boolean",
      )
    );
  }
  switch (value.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return hasOnlyKeys(value, ["type"]);
    case "array":
      return (
        hasOnlyKeys(value, ["type", "items"]) &&
        isSupportedToolJsonSchema(value.items)
      );
    case "object": {
      const properties = value.properties;
      const required = value.required;
      if (
        !hasOnlyKeys(value, [
          "type",
          "properties",
          "required",
          "additionalProperties",
        ]) ||
        value.additionalProperties !== false ||
        !isPlainRecord(properties) ||
        !Array.isArray(required) ||
        required.some((key) => typeof key !== "string") ||
        new Set(required).size !== required.length ||
        required.some((key) => typeof key !== "string" || !(key in properties))
      )
        return false;
      return Object.values(properties).every(isSupportedToolJsonSchema);
    }
    default:
      return false;
  }
}

const PublishedPropertySchema = v.pipe(
  JsonObjectSchema,
  v.check(
    (value: Record<string, unknown>) => isSupportedToolJsonSchema(value),
    "Tool JSON schema uses unsupported or ignored keywords",
  ),
);

const PublishedObjectSchema = v.pipe(
  v.strictObject({
    type: v.literal("object"),
    properties: v.record(v.string(), PublishedPropertySchema),
    required: v.optional(v.array(v.string()), []),
    additionalProperties: v.literal(false),
  }),
  v.check(
    (value: {
      type: "object";
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: false;
    }) => isSupportedToolJsonSchema(value),
    "Tool JSON schema must be a closed supported object schema",
  ),
);

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

export const ToolOwnerSchema = v.picklist(["caller", "platform"]);
export const ToolStageSchema = v.picklist([
  "caller_pending",
  "caller_claimed",
  "platform_ready",
  "platform_executing",
  "result_submitted",
  "result_committed",
  "approval_denied",
  "approval_expired",
  "cancelled",
  "expired",
  "failed",
]);
export const ToolCallSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  toolName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  owner: ToolOwnerSchema,
  stage: ToolStageSchema,
  safeArguments: JsonObjectSchema,
  claimFence: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/u)),
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
  "model.invocation_failed",
  "sandbox.command_started",
  "sandbox.command_completed",
  "sandbox.command_failed",
  "runtime.dispatch_reserved",
  "runtime.dispatch_admitted",
  "runtime.dispatch_reconciled",
  "runtime.recovery_started",
  "runtime.recovery_completed",
  "runtime.cancellation_draining",
  "session.summary_changed",
]);

export const RuntimeToolSnapshotSchema = v.strictObject({
  schemaVersion: v.optional(v.literal(1), 1),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
  owner: v.picklist(["platform", "caller"]),
  approval: v.picklist(["never", "always"]),
  inputSchema: PublishedObjectSchema,
  outputSchema: PublishedObjectSchema,
});

export const PLATFORM_MAX_TURNS = 32;

export const ManagedAgentPublicationConfigSchema = v.strictObject({
  systemPrompt: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
  modelPreset: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  tools: v.array(RuntimeToolSnapshotSchema),
  sandbox: v.strictObject({
    enabled: v.boolean(),
    network: v.picklist(["none", "restricted"]),
  }),
  limits: v.strictObject({
    maxTurns: v.literal(PLATFORM_MAX_TURNS),
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1_000)),
  }),
});

export function parseManagedAgentSnapshotForPublication(
  input: unknown,
): ManagedAgentPublicationConfig {
  return v.parse(ManagedAgentPublicationConfigSchema, input);
}

export const ManagedAgentSnapshotSchema = v.strictObject({
  agentVersionId: IdSchema,
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  ...ManagedAgentPublicationConfigSchema.entries,
});

export const ManagedAgentInstanceDataSchema = v.object({
  organizationId: IdSchema,
  projectId: IdSchema,
  threadId: IdSchema,
  sessionId: IdSchema,
  snapshot: ManagedAgentSnapshotSchema,
});

export const ManagedRunDeliverySchema = v.object({
  version: v.literal("1"),
  runId: IdSchema,
  sessionId: IdSchema,
  snapshotHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

export const ManagedRunInputV1Schema = v.object({
  message: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
});

export const ToolResultFailureCodeSchema = v.picklist([
  "approval_denied",
  "approval_expired",
  "run_cancelled",
  "tool_expired",
  "tool_failed",
  "platform_tool_failed",
  "invalid_tool_arguments",
  "invalid_tool_result",
]);

export const ToolResultEnvelopeSchema = v.variant("status", [
  v.object({
    version: v.literal(1),
    status: v.literal("success"),
    value: JsonObjectSchema,
  }),
  v.object({
    version: v.literal(1),
    status: v.literal("failure"),
    error: v.object({
      code: ToolResultFailureCodeSchema,
      message: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    }),
  }),
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
export type ToolOwner = v.InferOutput<typeof ToolOwnerSchema>;
export type ToolStage = v.InferOutput<typeof ToolStageSchema>;
export type Approval = v.InferOutput<typeof ApprovalSchema>;
export type ProductEventKind = v.InferOutput<typeof ProductEventKindSchema>;
export type ProductEvent = v.InferOutput<typeof ProductEventSchema>;
export type ManagedAgentSnapshot = v.InferOutput<
  typeof ManagedAgentSnapshotSchema
>;
export type ManagedAgentPublicationConfig = v.InferOutput<
  typeof ManagedAgentPublicationConfigSchema
>;
export type ManagedAgentInstanceData = v.InferOutput<
  typeof ManagedAgentInstanceDataSchema
>;
export type ManagedRunDelivery = v.InferOutput<typeof ManagedRunDeliverySchema>;
export type ManagedRunInputV1 = v.InferOutput<typeof ManagedRunInputV1Schema>;
export type ToolResultEnvelope = v.InferOutput<typeof ToolResultEnvelopeSchema>;
export type ApiError = v.InferOutput<typeof ApiErrorSchema>;
export type Page<T> = {
  readonly data: readonly T[];
  readonly pageInfo: v.InferOutput<typeof PageInfoSchema>;
};
