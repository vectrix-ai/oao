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

export const SkillLifecycleStatusSchema = v.picklist([
  "active",
  "deprecated",
  "revoked",
]);

export const SkillSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  latestVersionId: v.nullable(IdSchema),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const SkillVersionFileManifestSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  contentType: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

export const SkillDraftEntrySchema = v.object({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  kind: v.picklist(["directory", "file"]),
  contentType: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  sizeBytes: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  sha256: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u))),
  dataBase64: v.optional(v.string()),
});

export const SkillDraftSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  skillId: v.nullable(IdSchema),
  sourceSkillVersionId: v.nullable(IdSchema),
  key: v.string(),
  displayName: v.string(),
  name: v.string(),
  description: v.string(),
  instructions: v.string(),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  status: v.picklist(["editing", "published", "discarded"]),
  publishedSkillVersionId: v.nullable(IdSchema),
  entries: v.array(SkillDraftEntrySchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const SkillVersionSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  skillId: IdSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64),
    v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  ),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
  instructions: v.pipe(v.string(), v.minLength(1), v.maxLength(200_000)),
  license: v.nullable(v.pipe(v.string(), v.maxLength(500))),
  compatibility: v.nullable(v.pipe(v.string(), v.maxLength(500))),
  metadata: v.record(v.string(), v.string()),
  allowedTools: v.nullable(v.pipe(v.string(), v.maxLength(2_000))),
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  totalBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  status: SkillLifecycleStatusSchema,
  files: v.optional(v.array(SkillVersionFileManifestSchema), []),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
});

export const ManagedSkillBindingSnapshotSchema = v.strictObject({
  skillId: IdSchema,
  skillVersionId: IdSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
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

/**
 * Binary document formats that are extracted to bounded Markdown when a run is
 * admitted. Text and native image inputs are accepted separately by media type.
 */
export const RUN_DOCUMENT_CONTENT_TYPE_BY_EXTENSION = Object.freeze({
  pdf: "application/pdf",
  rtf: "application/rtf",
  doc: "application/msword",
  dot: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docm: "application/vnd.ms-word.document.macroenabled.12",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  dotm: "application/vnd.ms-word.template.macroenabled.12",
  xls: "application/vnd.ms-excel",
  xlt: "application/vnd.ms-excel",
  xla: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  xlam: "application/vnd.ms-excel.addin.macroenabled.12",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  xltm: "application/vnd.ms-excel.template.macroenabled.12",
  ppt: "application/vnd.ms-powerpoint",
  pot: "application/vnd.ms-powerpoint",
  pps: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pptm: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ppsm: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
  potm: "application/vnd.ms-powerpoint.template.macroenabled.12",
  odt: "application/vnd.oasis.opendocument.text",
  ott: "application/vnd.oasis.opendocument.text-template",
  fodt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  ots: "application/vnd.oasis.opendocument.spreadsheet-template",
  fods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  otp: "application/vnd.oasis.opendocument.presentation-template",
  fodp: "application/vnd.oasis.opendocument.presentation",
  odg: "application/vnd.oasis.opendocument.graphics",
  otg: "application/vnd.oasis.opendocument.graphics-template",
  fodg: "application/vnd.oasis.opendocument.graphics",
  odf: "application/vnd.oasis.opendocument.formula",
  pages: "application/x-iwork-pages-sffpages",
  numbers: "application/x-iwork-numbers-sffnumbers",
  key: "application/x-iwork-keynote-sffkey",
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",
} as const);

export const RUN_DOCUMENT_EXTENSIONS = Object.freeze(
  Object.keys(RUN_DOCUMENT_CONTENT_TYPE_BY_EXTENSION),
);

export const RunFileSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  contentType: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  createdAt: TimestampSchema,
});
export const MessageSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  threadId: IdSchema,
  runId: IdSchema,
  role: MessageRoleSchema,
  redactedContent: v.string(),
  files: v.optional(v.array(RunFileSchema)),
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
  "delegation.created",
  "delegation.follow_up_created",
  "delegation.completed",
  "delegation.failed",
  "delegation.cancelled",
  "skill.draft_created",
  "skill.draft_discarded",
  "skill.created",
  "skill.version_published",
  "skill.version_deprecated",
  "skill.version_revoked",
  "skill.activated",
  "skill.resource_read",
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

export const SandboxCapabilitySchema = v.picklist([
  "filesystem_read",
  "filesystem_write",
  "shell",
  "browser",
]);

export const DEFAULT_SANDBOX_CAPABILITIES = Object.freeze([
  "filesystem_read",
  "filesystem_write",
  "shell",
] as const);

const LegacySandboxProviderKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(
    /^(?:local-fake|[a-z][a-z0-9]*(-[a-z0-9]+)*)$/u,
    "provider must be local-fake or a lowercase project provider key",
  ),
);

const ProjectSandboxProviderKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u,
    "provider key must be lowercase and hyphen separated",
  ),
  v.check((value) => value !== "local-fake", "local-fake is reserved"),
);

const SandboxCapabilitiesSchema = v.pipe(
  v.array(SandboxCapabilitySchema),
  v.check(
    (value) => new Set(value).size === value.length,
    "sandbox capabilities must be unique",
  ),
);

export const ManagedAgentDelegateSchema = v.strictObject({
  key: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64),
    v.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  ),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
  agentVersionId: IdSchema,
  maxParallel: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
    1,
  ),
});

const ManagedAgentDelegatesSchema = v.pipe(
  v.array(ManagedAgentDelegateSchema),
  v.maxLength(32),
  v.check(
    (delegates) =>
      new Set(delegates.map((delegate) => delegate.key)).size ===
        delegates.length &&
      new Set(delegates.map((delegate) => delegate.agentVersionId)).size ===
        delegates.length,
    "delegate keys and agent versions must be unique",
  ),
);

export const ManagedAgentPublicationConfigSchema = v.pipe(
  v.strictObject({
    systemPrompt: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
    modelPreset: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
    tools: v.pipe(
      v.array(RuntimeToolSnapshotSchema),
      v.check(
        (tools) =>
          tools.every(
            (tool) =>
              tool.name !== "delegate_agent" && tool.name !== "message_agent",
          ),
        "delegate_agent and message_agent are reserved platform tools",
      ),
    ),
    skillVersionIds: v.optional(v.array(IdSchema), []),
    delegates: v.optional(ManagedAgentDelegatesSchema, []),
    sandbox: v.strictObject({
      enabled: v.boolean(),
      provider: ProjectSandboxProviderKeySchema,
      snapshotId: v.optional(IdSchema),
      network: v.picklist(["none", "restricted"]),
      capabilities: v.optional(SandboxCapabilitiesSchema, [
        ...DEFAULT_SANDBOX_CAPABILITIES,
      ]),
    }),
    limits: v.strictObject({
      maxTurns: v.literal(PLATFORM_MAX_TURNS),
      timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1_000)),
    }),
  }),
  v.check(
    (config) =>
      !config.sandbox.enabled || config.sandbox.snapshotId !== undefined,
    "sandbox.snapshotId is required when the sandbox is enabled",
  ),
);

export function parseManagedAgentSnapshotForPublication(
  input: unknown,
): ManagedAgentPublicationConfig {
  return v.parse(ManagedAgentPublicationConfigSchema, input);
}

export const ManagedAgentSnapshotSchema = v.strictObject({
  agentVersionId: IdSchema,
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  systemPrompt: ManagedAgentPublicationConfigSchema.entries.systemPrompt,
  modelPreset: ManagedAgentPublicationConfigSchema.entries.modelPreset,
  tools: ManagedAgentPublicationConfigSchema.entries.tools,
  skills: v.optional(v.array(ManagedSkillBindingSnapshotSchema), []),
  delegates: v.optional(ManagedAgentDelegatesSchema, []),
  sandbox: v.strictObject({
    enabled: v.boolean(),
    provider: v.optional(LegacySandboxProviderKeySchema, "local-fake"),
    snapshotId: v.optional(IdSchema),
    network: v.picklist(["none", "restricted"]),
    capabilities: v.optional(SandboxCapabilitiesSchema, [
      ...DEFAULT_SANDBOX_CAPABILITIES,
    ]),
  }),
  limits: ManagedAgentPublicationConfigSchema.entries.limits,
});

export const ManagedAgentInstanceDataSchema = v.object({
  organizationId: IdSchema,
  projectId: IdSchema,
  threadId: IdSchema,
  sessionId: IdSchema,
  workspace: v.optional(
    v.strictObject({
      id: IdSchema,
      ownerThreadId: IdSchema,
      ownerSessionId: IdSchema,
      ownerRunId: IdSchema,
    }),
  ),
  snapshot: ManagedAgentSnapshotSchema,
});

export const AgentDelegationStateSchema = v.picklist(["active", "cancelled"]);

export const AgentDelegationSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  parentRunId: IdSchema,
  parentThreadId: IdSchema,
  parentSessionId: IdSchema,
  parentAgentVersionId: IdSchema,
  delegateKey: ManagedAgentDelegateSchema.entries.key,
  childAgentVersionId: IdSchema,
  childThreadId: IdSchema,
  childSessionId: IdSchema,
  workspaceId: IdSchema,
  state: AgentDelegationStateSchema,
  latestChildRunId: IdSchema,
  latestChildRunState: RunStateSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const ManagedRunDeliverySchema = v.object({
  version: v.literal("1"),
  runId: IdSchema,
  sessionId: IdSchema,
  snapshotHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

export const ManagedRunInputV1Schema = v.object({
  message: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
  files: v.optional(
    v.pipe(
      v.array(
        v.object({
          id: IdSchema,
          name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
          contentType: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
          sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
          sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
          storageProviderId: IdSchema,
          objectKey: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
        }),
      ),
      v.maxLength(8),
    ),
  ),
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
export type Skill = v.InferOutput<typeof SkillSchema>;
export type SkillVersion = v.InferOutput<typeof SkillVersionSchema>;
export type SkillDraft = v.InferOutput<typeof SkillDraftSchema>;
export type SkillDraftEntry = v.InferOutput<typeof SkillDraftEntrySchema>;
export type SkillLifecycleStatus = v.InferOutput<
  typeof SkillLifecycleStatusSchema
>;
export type ManagedSkillBindingSnapshot = v.InferOutput<
  typeof ManagedSkillBindingSnapshotSchema
>;
export type ManagedAgentDelegate = v.InferOutput<
  typeof ManagedAgentDelegateSchema
>;
export type Thread = v.InferOutput<typeof ThreadSchema>;
export type Session = v.InferOutput<typeof SessionSchema>;
export type RunState = v.InferOutput<typeof RunStateSchema>;
export type Run = v.InferOutput<typeof RunSchema>;
export type Message = v.InferOutput<typeof MessageSchema>;
export type RunFile = v.InferOutput<typeof RunFileSchema>;
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
export type SandboxCapability = v.InferOutput<typeof SandboxCapabilitySchema>;
export type ManagedAgentInstanceData = v.InferOutput<
  typeof ManagedAgentInstanceDataSchema
>;
export type AgentDelegation = v.InferOutput<typeof AgentDelegationSchema>;
export type AgentDelegationState = v.InferOutput<
  typeof AgentDelegationStateSchema
>;
export type ManagedRunDelivery = v.InferOutput<typeof ManagedRunDeliverySchema>;
export type ManagedRunInputV1 = v.InferOutput<typeof ManagedRunInputV1Schema>;
export type ToolResultEnvelope = v.InferOutput<typeof ToolResultEnvelopeSchema>;
export type ApiError = v.InferOutput<typeof ApiErrorSchema>;
export type Page<T> = {
  readonly data: readonly T[];
  readonly pageInfo: v.InferOutput<typeof PageInfoSchema>;
};

/**
 * Model presets are the only way an agent version names a model. The key is
 * stable and versioned so an already published, immutable agent version can
 * never be silently repointed at a different model or routing policy.
 */
export const MODEL_PRESET_KEY_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]{0,4}$/u;

const ProviderSlugSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(80),
  v.regex(/^[a-z0-9][a-z0-9._-]*$/u),
);
const ProviderSlugListSchema = v.pipe(
  v.array(ProviderSlugSchema),
  v.minLength(1),
  v.maxLength(16),
  v.check(
    (value: string[]) => new Set(value).size === value.length,
    "Provider list entries must be unique",
  ),
);
const PriceCapSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
  v.maxValue(1_000_000),
);

/**
 * Provider-neutral routing and data-handling policy. Provider specific wire
 * names stay behind the model adapter; the public contract never carries a
 * provider credential.
 */
export const ModelRoutingPolicySchema = v.strictObject({
  allowFallbacks: v.optional(v.boolean()),
  requireParameters: v.optional(v.boolean()),
  dataCollection: v.optional(v.picklist(["deny", "allow"])),
  zeroDataRetention: v.optional(v.boolean()),
  providerOrder: v.optional(ProviderSlugListSchema),
  providerAllowlist: v.optional(ProviderSlugListSchema),
  providerDenylist: v.optional(ProviderSlugListSchema),
  sort: v.optional(v.picklist(["price", "throughput", "latency"])),
  maxPromptPriceUsdPerMillion: v.optional(PriceCapSchema),
  maxCompletionPriceUsdPerMillion: v.optional(PriceCapSchema),
});

export const ModelPresetOriginSchema = v.picklist(["deployment", "project"]);
export const ModelProviderTypeSchema = v.picklist(["openrouter", "openai"]);

export const ProjectModelProviderSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: ModelProviderTypeSchema,
  credentialConfigured: v.literal(true),
  credentialFingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{12}$/u)),
  credentialVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const ModelProviderKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u,
    "key must be lowercase and hyphen separated",
  ),
);

export const CreateProjectModelProviderInputSchema = v.strictObject({
  key: ModelProviderKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: ModelProviderTypeSchema,
  apiKey: v.pipe(v.string(), v.minLength(8), v.maxLength(4096)),
});

export const RotateProjectModelProviderCredentialInputSchema = v.strictObject({
  apiKey: v.pipe(v.string(), v.minLength(8), v.maxLength(4096)),
});

const SandboxDomainSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(253),
  v.regex(
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    "domain must be a hostname or wildcard hostname",
  ),
);

const SandboxCidrSchema = v.pipe(
  v.string(),
  v.minLength(3),
  v.maxLength(64),
  v.regex(/^[0-9a-f:.]+\/[0-9]{1,3}$/u, "CIDR must include a prefix length"),
);

export const SandboxRestrictedEgressSchema = v.strictObject({
  allowedDomains: v.optional(v.array(SandboxDomainSchema), []),
  allowedCidrs: v.optional(v.array(SandboxCidrSchema), []),
});

export const ProjectSandboxProviderSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  key: ProjectSandboxProviderKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: v.literal("daytona"),
  credentialConfigured: v.literal(true),
  credentialFingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{12}$/u)),
  credentialVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  target: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  restrictedEgress: SandboxRestrictedEgressSchema,
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/** Safe, credential-free metadata for a Daytona snapshot. */
export const SandboxSnapshotEntrySchema = v.object({
  id: IdSchema,
  providerType: v.literal("daytona"),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  state: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  available: v.boolean(),
  imageName: v.nullable(v.pipe(v.string(), v.maxLength(500))),
  general: v.boolean(),
  cpu: v.pipe(v.number(), v.minValue(0)),
  gpu: v.pipe(v.number(), v.minValue(0)),
  memoryGiB: v.pipe(v.number(), v.minValue(0)),
  diskGiB: v.pipe(v.number(), v.minValue(0)),
  regionIds: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  sandboxClass: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(80))),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastUsedAt: v.nullable(TimestampSchema),
});

export const CreateProjectSandboxProviderInputSchema = v.strictObject({
  key: ProjectSandboxProviderKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: v.literal("daytona"),
  apiKey: v.pipe(v.string(), v.minLength(8), v.maxLength(4096)),
  target: v.optional(
    v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    null,
  ),
  restrictedEgress: v.optional(SandboxRestrictedEgressSchema, {
    allowedDomains: [],
    allowedCidrs: [],
  }),
});

export const RotateProjectSandboxProviderCredentialInputSchema = v.strictObject(
  {
    apiKey: v.pipe(v.string(), v.minLength(8), v.maxLength(4096)),
  },
);

export const UpdateProjectSandboxProviderConfigurationInputSchema =
  v.strictObject({
    target: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    restrictedEgress: SandboxRestrictedEgressSchema,
  });

const S3EndpointSchema = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.url(),
  v.check(
    (value) => ["http:", "https:"].includes(new URL(value).protocol),
    "endpoint must use HTTP or HTTPS",
  ),
);

const S3ObjectPrefixSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  v.check(
    (value) =>
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((segment) => segment && segment !== "." && segment !== ".."),
    "object prefix must be a safe relative path",
  ),
);

export const ProjectStorageProviderSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  key: ProjectSandboxProviderKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: v.literal("s3"),
  endpoint: v.nullable(S3EndpointSchema),
  region: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  bucket: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  prefix: v.nullable(S3ObjectPrefixSchema),
  forcePathStyle: v.boolean(),
  default: v.boolean(),
  credentialConfigured: v.literal(true),
  credentialFingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{12}$/u)),
  credentialVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const S3CredentialFields = {
  accessKeyId: v.pipe(v.string(), v.minLength(3), v.maxLength(512)),
  secretAccessKey: v.pipe(v.string(), v.minLength(8), v.maxLength(4096)),
  sessionToken: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(8192)),
  ),
};

export const CreateProjectStorageProviderInputSchema = v.strictObject({
  key: ProjectSandboxProviderKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: v.literal("s3"),
  endpoint: v.nullable(S3EndpointSchema),
  region: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  bucket: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  prefix: v.nullable(S3ObjectPrefixSchema),
  forcePathStyle: v.boolean(),
  setDefault: v.optional(v.boolean(), true),
  ...S3CredentialFields,
});

export const RotateProjectStorageProviderCredentialInputSchema =
  v.strictObject(S3CredentialFields);

export const ModelPresetSchema = v.object({
  id: v.nullable(IdSchema),
  organizationId: v.nullable(IdSchema),
  projectId: v.nullable(IdSchema),
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  origin: ModelPresetOriginSchema,
  providerId: v.nullable(IdSchema),
  providerType: v.nullable(ModelProviderTypeSchema),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  routing: ModelRoutingPolicySchema,
  hosted: v.boolean(),
  available: v.boolean(),
  createdByPrincipalId: v.nullable(IdSchema),
  createdAt: v.nullable(TimestampSchema),
});

export const CreateModelPresetInputSchema = v.strictObject({
  key: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(120),
    v.regex(
      MODEL_PRESET_KEY_PATTERN,
      "key must be lowercase, hyphen separated, and end with a version suffix such as -v1",
    ),
  ),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerId: IdSchema,
  model: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(300),
    v.regex(
      /^(?:openrouter\/(?:@preset\/)?[a-zA-Z0-9~][a-zA-Z0-9._:~/-]*|openai\/[a-z0-9~][a-z0-9._:~/-]*)$/u,
      "model must be an approved OpenRouter/OpenAI model or OpenRouter preset reference",
    ),
  ),
  routing: v.optional(ModelRoutingPolicySchema, {}),
});

/** Safe, credential-free metadata for one provider catalog model or preset. */
export const ModelCatalogEntrySchema = v.object({
  providerType: ModelProviderTypeSchema,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  catalogId: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  contextWindow: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  maxOutputTokens: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  reasoning: v.boolean(),
});

export function parseCreateModelPresetInput(
  input: unknown,
): CreateModelPresetInput {
  return v.parse(CreateModelPresetInputSchema, input);
}

export function parseCreateProjectModelProviderInput(
  input: unknown,
): CreateProjectModelProviderInput {
  return v.parse(CreateProjectModelProviderInputSchema, input);
}

export function parseRotateProjectModelProviderCredentialInput(
  input: unknown,
): RotateProjectModelProviderCredentialInput {
  return v.parse(RotateProjectModelProviderCredentialInputSchema, input);
}

export function parseCreateProjectSandboxProviderInput(
  input: unknown,
): CreateProjectSandboxProviderInput {
  return v.parse(CreateProjectSandboxProviderInputSchema, input);
}

export function parseRotateProjectSandboxProviderCredentialInput(
  input: unknown,
): RotateProjectSandboxProviderCredentialInput {
  return v.parse(RotateProjectSandboxProviderCredentialInputSchema, input);
}

export function parseUpdateProjectSandboxProviderConfigurationInput(
  input: unknown,
): UpdateProjectSandboxProviderConfigurationInput {
  return v.parse(UpdateProjectSandboxProviderConfigurationInputSchema, input);
}

export function parseCreateProjectStorageProviderInput(
  input: unknown,
): CreateProjectStorageProviderInput {
  return v.parse(CreateProjectStorageProviderInputSchema, input);
}

export function parseRotateProjectStorageProviderCredentialInput(
  input: unknown,
): RotateProjectStorageProviderCredentialInput {
  return v.parse(RotateProjectStorageProviderCredentialInputSchema, input);
}

export function parseModelRoutingPolicy(input: unknown): ModelRoutingPolicy {
  return v.parse(ModelRoutingPolicySchema, input);
}

export type ModelRoutingPolicy = v.InferOutput<typeof ModelRoutingPolicySchema>;
export type ModelPresetOrigin = v.InferOutput<typeof ModelPresetOriginSchema>;
export type ModelProviderType = v.InferOutput<typeof ModelProviderTypeSchema>;
export type ProjectModelProvider = v.InferOutput<
  typeof ProjectModelProviderSchema
>;
export type CreateProjectModelProviderInput = v.InferOutput<
  typeof CreateProjectModelProviderInputSchema
>;
export type RotateProjectModelProviderCredentialInput = v.InferOutput<
  typeof RotateProjectModelProviderCredentialInputSchema
>;
export type SandboxRestrictedEgress = v.InferOutput<
  typeof SandboxRestrictedEgressSchema
>;
export type ProjectSandboxProvider = v.InferOutput<
  typeof ProjectSandboxProviderSchema
>;
export type SandboxSnapshotEntry = v.InferOutput<
  typeof SandboxSnapshotEntrySchema
>;
export type CreateProjectSandboxProviderInput = v.InferOutput<
  typeof CreateProjectSandboxProviderInputSchema
>;
export type RotateProjectSandboxProviderCredentialInput = v.InferOutput<
  typeof RotateProjectSandboxProviderCredentialInputSchema
>;
export type UpdateProjectSandboxProviderConfigurationInput = v.InferOutput<
  typeof UpdateProjectSandboxProviderConfigurationInputSchema
>;
export type ProjectStorageProvider = v.InferOutput<
  typeof ProjectStorageProviderSchema
>;
export type CreateProjectStorageProviderInput = v.InferOutput<
  typeof CreateProjectStorageProviderInputSchema
>;
export type RotateProjectStorageProviderCredentialInput = v.InferOutput<
  typeof RotateProjectStorageProviderCredentialInputSchema
>;
export type ModelPreset = v.InferOutput<typeof ModelPresetSchema>;
export type CreateModelPresetInput = v.InferOutput<
  typeof CreateModelPresetInputSchema
>;
export type ModelCatalogEntry = v.InferOutput<typeof ModelCatalogEntrySchema>;
