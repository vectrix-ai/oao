import type {
  AgentDefinition,
  AgentVersion,
  AgentDelegation,
  ApiError,
  Approval,
  Message,
  ModelCatalogEntry,
  ModelGenerationSettings,
  ModelPreset,
  ProjectModelProvider,
  ModelRoutingPolicy,
  Organization,
  Page,
  ProductEvent,
  Project,
  ProjectMember,
  ProjectMemberRole,
  CreateProjectMemberInput,
  UpdateProjectMemberInput,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  RunFile,
  SandboxSnapshotEntry,
  Run,
  Session,
  Thread,
  ToolCall,
  ToolResultEnvelope,
  McpServer,
  McpCredential,
  McpCredentialPolicy,
  McpToolset,
  CreateMcpServerInput,
  DiscoverMcpServerInput,
  CreateMcpCredentialInput,
  RotateMcpCredentialInput,
  CreateMcpCredentialPolicyInput,
  CreateMcpToolsetInput,
  PublicPrincipal,
  AuthLogoutResult,
} from "@oao/contracts";

export type {
  AgentDefinition,
  AgentVersion,
  AgentDelegation,
  ApiError,
  Approval,
  Message,
  ModelCatalogEntry,
  ModelGenerationSettings,
  ModelPreset,
  ProjectModelProvider,
  ModelRoutingPolicy,
  Organization,
  Page,
  ProductEvent,
  Project,
  ProjectMember,
  ProjectMemberRole,
  CreateProjectMemberInput,
  UpdateProjectMemberInput,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  RunFile,
  SandboxSnapshotEntry,
  Run,
  Session,
  Thread,
  ToolCall,
  ToolResultEnvelope,
  McpServer,
  McpCredential,
  McpCredentialPolicy,
  McpToolset,
  CreateMcpServerInput,
  DiscoverMcpServerInput,
  CreateMcpCredentialInput,
  RotateMcpCredentialInput,
  CreateMcpCredentialPolicyInput,
  CreateMcpToolsetInput,
  PublicPrincipal,
  AuthLogoutResult,
};

export interface McpServerList {
  readonly data: readonly McpServer[];
  readonly credentialEncryptionConfigured: boolean;
}

export interface McpCredentialList {
  readonly data: readonly McpCredential[];
  readonly credentialEncryptionConfigured: boolean;
}

export interface McpCredentialPolicyList {
  readonly data: readonly McpCredentialPolicy[];
}

export interface McpToolsetList {
  readonly data: readonly McpToolset[];
}

export interface HealthStatus {
  readonly status: "ok";
  readonly service?: string;
  readonly version?: string;
}

export interface ReadinessStatus {
  readonly status: "ready" | "not_ready";
  readonly checks?: Readonly<Record<string, "ready" | "not_ready">>;
}

export interface AuthSession {
  readonly expiresAt: string;
  readonly principal: PublicPrincipal;
}

export interface ProjectContext {
  readonly principal: PublicPrincipal;
  readonly organization: Organization;
  readonly project: Project;
  readonly organizations: readonly Organization[];
  readonly projects: readonly Project[];
  readonly activeModelPresets: readonly string[];
  readonly authProvider: "development" | "workos";
}

export interface WaitForRunOptions extends RequestOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/** @deprecated Use ProjectMember. */
export type Member = ProjectMember;

export interface PlatformApiKey {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt?: string | null;
  readonly revokedAt?: string | null;
  readonly expiresAt?: string;
  readonly shown?: boolean;
}

/** The secret is present only on the first successful create response. */
export type CreatedPlatformApiKey = PlatformApiKey &
  (
    | { readonly shown: true; readonly secret: string }
    | { readonly shown: false; readonly secret?: never }
  );

export type ToolSchemaType =
  "string" | "number" | "integer" | "boolean" | "null" | "array" | "object";

export type ToolSchemaPrimitive = string | number | boolean | null;

export interface ToolJsonSchema {
  readonly type?:
    | ToolSchemaType
    | readonly [Exclude<ToolSchemaType, "null">, "null"]
    | readonly ["null", Exclude<ToolSchemaType, "null">];
  readonly title?: string;
  readonly description?: string;
  readonly examples?: readonly unknown[];
  readonly enum?: readonly ToolSchemaPrimitive[];
  readonly const?: ToolSchemaPrimitive;
  readonly properties?: Readonly<Record<string, ToolJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | ToolJsonSchema;
  readonly items?: ToolJsonSchema;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly format?: "date" | "date-time" | "email" | "time" | "uri" | "uuid";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface ToolJsonObjectSchema extends ToolJsonSchema {
  readonly type: "object";
}

export interface AgentToolInput {
  readonly schemaVersion?: 1;
  readonly name: string;
  readonly description: string;
  readonly owner: "caller" | "platform";
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly approval: "never" | "always";
}

export interface SandboxPolicyInput {
  readonly enabled: boolean;
  readonly provider: string;
  readonly snapshotId?: string;
  readonly network: "none" | "restricted";
  readonly capabilities?: readonly (
    "filesystem_read" | "filesystem_write" | "shell" | "browser"
  )[];
}

export interface HarnessOperationInput {
  readonly key: string;
  readonly description: string;
  readonly instructions: string;
  readonly resultSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface PublishAgentVersionInput {
  readonly systemPrompt: string;
  readonly modelPreset: string;
  readonly tools: readonly AgentToolInput[];
  readonly skillVersionIds?: readonly string[];
  readonly harnessOperations?: readonly HarnessOperationInput[];
  readonly mcpBindings?: readonly {
    readonly toolsetVersionId: string;
    readonly credentialPolicyVersionId: string;
    readonly namespace: string;
  }[];
  readonly delegates?: readonly {
    readonly key: string;
    readonly description: string;
    readonly agentVersionId: string;
    readonly maxParallel?: number;
  }[];
  readonly sandbox: SandboxPolicyInput;
  readonly limits: {
    readonly maxTurns: 32;
    readonly timeoutMs: number;
  };
}

export interface SkillFileInput {
  readonly path: string;
  readonly contentType: string;
  readonly dataBase64: string;
}

export interface SkillDraftEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly dataBase64?: string;
}

export interface SkillDraft {
  readonly id: string;
  readonly skillId: string | null;
  readonly sourceSkillVersionId: string | null;
  readonly key: string;
  readonly displayName: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly revision: number;
  readonly status: "editing" | "published" | "discarded";
  readonly publishedSkillVersionId: string | null;
  readonly entries: readonly SkillDraftEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateSkillDraftInput {
  readonly key?: string;
  readonly displayName?: string;
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
}

export interface SkillDraftValidation {
  readonly valid: true;
  readonly contentHash: string;
  readonly totalBytes: number;
  readonly fileCount: number;
}

export interface PublishSkillVersionInput {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Informational only. OAO and Flue do not enforce this field. */
  readonly allowedTools?: string;
  readonly files?: readonly SkillFileInput[];
}

export interface CreateSkillInput extends PublishSkillVersionInput {
  readonly key?: string;
  readonly displayName?: string;
}

export interface SkillVersionView {
  readonly id: string;
  readonly skillId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly allowedTools: string | null;
  readonly contentHash: string;
  readonly totalBytes: number;
  readonly status: "active" | "deprecated" | "revoked";
  readonly files: readonly {
    readonly path: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }[];
  readonly createdAt: string;
}

export interface SkillSummary {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
  readonly latestVersionId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly contentHash: string;
  readonly status: "active" | "deprecated" | "revoked";
  readonly fileCount: number;
  readonly versionIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillDetail extends SkillSummary {
  readonly versions: readonly SkillVersionView[];
}

export interface SkillExport {
  readonly schemaVersion: 1;
  readonly version: SkillVersionView;
  readonly files: readonly SkillFileInput[];
}

export interface CreateModelPresetInput {
  /** Stable, versioned key, for example `claude-sonnet-4-6-zdr-v1`. */
  readonly key: string;
  readonly displayName: string;
  readonly providerId: string;
  /** Approved catalog model, for example `openrouter/anthropic/claude-sonnet-4.6`. */
  readonly model: string;
  readonly routing?: ModelRoutingPolicy;
  readonly settings?: ModelGenerationSettings | null;
}

export interface ModelPresetPage extends Page<ModelPreset> {
  readonly credentialEncryptionConfigured: boolean;
}

export interface ModelCatalogPage extends Page<ModelCatalogEntry> {
  readonly providerId: string;
  readonly providerType: "openrouter" | "openai" | "anthropic" | "xai";
}

export interface CreateProjectModelProviderInput {
  readonly key: string;
  readonly displayName: string;
  readonly providerType: "openrouter" | "openai" | "anthropic" | "xai";
  readonly apiKey: string;
}

export interface RotateProjectModelProviderCredentialInput {
  readonly apiKey: string;
}

export interface CreateProjectSandboxProviderInput {
  readonly key: string;
  readonly displayName: string;
  readonly providerType: "daytona";
  readonly apiKey: string;
  readonly target?: string | null;
  readonly restrictedEgress?: {
    readonly allowedDomains: readonly string[];
    readonly allowedCidrs: readonly string[];
  };
}

export interface RotateProjectSandboxProviderCredentialInput {
  readonly apiKey: string;
}

export interface UpdateProjectSandboxProviderConfigurationInput {
  readonly target: string | null;
  readonly restrictedEgress: {
    readonly allowedDomains: readonly string[];
    readonly allowedCidrs: readonly string[];
  };
}

export interface SandboxProviderPage extends Page<ProjectSandboxProvider> {
  readonly credentialEncryptionConfigured: boolean;
}

export interface SandboxSnapshotList {
  readonly data: readonly SandboxSnapshotEntry[];
  readonly providerId: string;
  readonly providerType: "daytona";
}

export interface CreateProjectStorageProviderInput {
  readonly key: string;
  readonly displayName: string;
  readonly providerType: "s3";
  readonly endpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string | null;
  readonly forcePathStyle: boolean;
  readonly setDefault?: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface RotateProjectStorageProviderCredentialInput {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface StorageProviderList {
  readonly data: readonly ProjectStorageProvider[];
  readonly credentialEncryptionConfigured: boolean;
}

export interface StorageObjectEntry {
  readonly key: string;
  readonly sizeBytes: number;
  readonly lastModifiedAt?: string;
}

export interface StorageObjectList {
  readonly providerId: string;
  readonly prefix: string;
  readonly folders: readonly string[];
  readonly objects: readonly StorageObjectEntry[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

export interface CreateAgentInput {
  readonly key?: string;
  readonly name: string;
  readonly description?: string;
  readonly initialConfig?: PublishAgentVersionInput;
}

export interface RunFileInput {
  readonly name: string;
  readonly contentType: string;
  readonly dataBase64: string;
}

type NonEmptyRunFiles = readonly [RunFileInput, ...RunFileInput[]];

type InitialSessionContent =
  | {
      readonly initialMessage: string;
      readonly files?: readonly RunFileInput[];
    }
  | { readonly initialMessage?: never; readonly files: NonEmptyRunFiles };

export type CreateSessionInput = (
  | {
      readonly agentId: string;
      readonly agentVersionId?: string;
      readonly title?: string;
    }
  | {
      readonly agentId?: never;
      readonly agentVersionId: string;
      readonly title?: string;
    }
) &
  InitialSessionContent;

export type RunInput =
  | {
      readonly message: string;
      readonly redactedInput?: never;
      readonly files?: readonly RunFileInput[];
    }
  | {
      readonly message?: never;
      readonly redactedInput: string;
      readonly files?: readonly RunFileInput[];
    }
  | {
      readonly message?: never;
      readonly redactedInput?: never;
      readonly files: NonEmptyRunFiles;
    };

/** Response from creating a session and its first queued run atomically. */
export interface CreatedSession {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly agentVersionId: string;
  readonly status: Run["state"];
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly latestRunId: string;
  readonly run: Run;
}

export interface DelegationMessageResult {
  readonly delegationId: string;
  readonly childSessionId: string;
  readonly childRunId: string;
  readonly status: "queued";
}

export interface RunTimelineEntry {
  readonly entrySequence: string;
  readonly entryType: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly safeDetail: Readonly<Record<string, unknown>>;
}

export interface AuditEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly principalId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly safeDetail: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface AuditExport {
  readonly artifactRef: string;
  readonly contentType: string;
  readonly expiresAt?: string;
}

export interface ToolClaim {
  readonly fence: string;
}

export interface ToolResultSubmission {
  readonly outcome: "submitted" | "replayed";
  readonly normalizedFailure?: {
    readonly code: "invalid_tool_result";
    readonly path: string;
  };
}

export interface ProjectEventFrame {
  readonly id: string;
  readonly event: string;
  readonly data: ProductEvent;
}

export interface PaginationOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface WriteOptions extends RequestOptions {
  readonly idempotencyKey: string;
}

export interface ProjectEventStreamOptions extends RequestOptions {
  readonly lastEventId?: string;
  readonly reconnect?: boolean;
  readonly reconnectDelayMs?: number;
}
