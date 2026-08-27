import type {
  ModelCatalogEntry,
  ModelGenerationSettings,
  ModelPreset,
  ModelRoutingPolicy,
  ProjectModelProvider,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  SandboxSnapshotEntry,
  ProductEvent,
  RunState,
  ToolOwner,
  ToolStage,
  McpServer,
  McpCredential,
  McpCredentialPolicy,
  McpToolset,
  ManagedHarnessOperation,
  CreateMcpServerInput,
  DiscoverMcpServerInput,
  CreateMcpCredentialInput,
  RotateMcpCredentialInput,
  CreateMcpCredentialPolicyInput,
  CreateMcpToolsetInput,
} from "@oao/contracts";

export type {
  ModelCatalogEntry,
  ModelGenerationSettings,
  ModelPreset,
  ModelRoutingPolicy,
  ProjectModelProvider,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  SandboxSnapshotEntry,
  McpServer,
  McpCredential,
  McpCredentialPolicy,
  McpToolset,
  ManagedHarnessOperation,
  CreateMcpServerInput,
  DiscoverMcpServerInput,
  CreateMcpCredentialInput,
  RotateMcpCredentialInput,
  CreateMcpCredentialPolicyInput,
  CreateMcpToolsetInput,
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

export interface ModelPresetList {
  readonly data: readonly ModelPreset[];
  readonly credentialEncryptionConfigured: boolean;
}

export interface ModelCatalogList {
  readonly data: readonly ModelCatalogEntry[];
  readonly providerId: string;
  readonly providerType: "openrouter" | "openai";
}

export interface CreateModelPresetInput {
  readonly key: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly routing: ModelRoutingPolicy;
  readonly settings?: ModelGenerationSettings | null;
}

export interface CreateModelProviderInput {
  readonly key: string;
  readonly displayName: string;
  readonly providerType: "openrouter" | "openai";
  readonly apiKey: string;
}

export interface CreateSandboxProviderInput {
  readonly key: string;
  readonly displayName: string;
  readonly providerType: "daytona";
  readonly apiKey: string;
  readonly target: string | null;
  readonly restrictedEgress: {
    readonly allowedDomains: readonly string[];
    readonly allowedCidrs: readonly string[];
  };
}

export interface UpdateSandboxProviderConfigurationInput {
  readonly target: string | null;
  readonly restrictedEgress: {
    readonly allowedDomains: readonly string[];
    readonly allowedCidrs: readonly string[];
  };
}

export interface SandboxProviderList {
  readonly data: readonly ProjectSandboxProvider[];
  readonly credentialEncryptionConfigured: boolean;
}

export interface SandboxSnapshotList {
  readonly data: readonly SandboxSnapshotEntry[];
  readonly providerId: string;
  readonly providerType: "daytona";
}

export interface CreateStorageProviderInput {
  readonly key: string;
  readonly displayName: string;
  readonly providerType: "s3";
  readonly endpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string | null;
  readonly forcePathStyle: boolean;
  readonly setDefault: boolean;
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

export type AgentStatus = "published" | "draft" | "archived";

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly description: string;
  readonly model: string | null;
  readonly status: AgentStatus;
  /** Draft Agent definitions have no immutable version until first publish. */
  readonly version: number | null;
  readonly latestVersionId: string | null;
  /** Draft and legacy Agent rows can legitimately have no published policy. */
  readonly sandbox: AgentVersionConfig["sandbox"] | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly owner: ToolOwner;
  readonly approval: "never" | "always";
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export type HarnessOperationDefinition = ManagedHarnessOperation;

export interface AgentVersionConfig {
  readonly systemPrompt: string;
  readonly modelPreset: string;
  readonly tools: readonly ToolDefinition[];
  readonly harnessOperations?: readonly HarnessOperationDefinition[];
  readonly skillVersionIds?: readonly string[];
  readonly mcpBindings?: readonly {
    readonly toolsetVersionId: string;
    readonly credentialPolicyVersionId: string;
    readonly namespace: string;
  }[];
  readonly delegates?: readonly {
    readonly key: string;
    readonly description: string;
    readonly agentVersionId: string;
    readonly maxParallel: number;
  }[];
  readonly sandbox: {
    readonly enabled: boolean;
    readonly provider: string;
    readonly snapshotId?: string;
    readonly network: "none" | "restricted";
    readonly capabilities: readonly (
      "filesystem_read" | "filesystem_write" | "shell" | "browser"
    )[];
  };
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

export interface SkillVersionView {
  readonly id: string;
  readonly skillId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
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

export interface CreateSkillInput {
  readonly key?: string;
  readonly displayName: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly files?: readonly SkillFileInput[];
}

export interface AgentVersionView {
  readonly id: string;
  readonly version: number;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly config: AgentVersionConfig;
}

export interface AgentDetail extends AgentSummary {
  readonly versions: readonly AgentVersionView[];
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  /** Present when this persistent session was created by a delegation. */
  readonly parentSessionId?: string;
  readonly delegateKey?: string;
  readonly status: RunState;
  readonly agentId: string;
  readonly agentName: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly observedCostUsd: number | null;
  readonly costProvenance: "provider_observed" | "estimated" | "unavailable";
  readonly createdAt: string;
  readonly lastActivityAt: string;
}

export type TimelineKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "approval"
  | "error"
  | "retry"
  | "recovery";

/**
 * Where an event belongs in the transcript.
 *
 * `message` is durable conversation, `activity` is work the agent did in
 * service of a message, and `runtime` is low-level platform telemetry that
 * stays collapsed so it cannot bury the conversation.
 */
export type TimelineSource = "message" | "activity" | "runtime";

export interface HarnessActivityStep {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly durationMs: number | null;
  readonly status: "success" | "pending" | "error" | "info";
  readonly tokens?: TimelineEvent["tokens"];
}

export interface HarnessActivityDetail {
  readonly operationKey: string;
  readonly toolCallId?: string;
  readonly phase: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly taskCharacters?: number;
  readonly timeoutMs?: number;
  readonly resultValidated?: boolean;
  readonly modelTurns: number;
  readonly toolSteps: number;
  readonly attribution: "complete" | "partial";
  readonly parallel?: {
    readonly groupId: string;
    readonly count: number;
    readonly index: number;
  };
  readonly steps: readonly HarnessActivityStep[];
}

export interface TimelineEvent {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly source?: TimelineSource;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly durationMs: number | null;
  readonly status: "success" | "pending" | "error" | "info";
  readonly files?: readonly {
    readonly id: string;
    readonly name: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }[];
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
  readonly costUsd?: number;
  readonly harness?: HarnessActivityDetail;
  readonly payload?: {
    readonly rendered: Readonly<Record<string, unknown>>;
    readonly raw: string | null;
    readonly redacted: boolean;
    readonly redactionReason?: string;
  };
}

export interface SessionDetail extends SessionSummary {
  readonly runId: string;
  readonly model?: string;
  readonly agentVersion: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly attempt: number;
  readonly events: readonly TimelineEvent[];
  readonly workspaceFiles: readonly {
    readonly name: string;
    readonly path: string;
    readonly sizeBytes?: number;
    readonly uploaded?: boolean;
    readonly backedUp: boolean;
    readonly backedUpAt?: string;
    readonly storageProviderId?: string;
    readonly objectKey?: string;
  }[];
  readonly capabilities: {
    readonly canCancel: boolean;
    readonly canResume: boolean;
    readonly canBranchReplay: boolean;
  };
  readonly skills: readonly {
    readonly skillId: string;
    readonly skillVersionId: string;
    readonly version: number;
    readonly name: string;
    readonly description: string;
    readonly contentHash: string;
    readonly status: "active" | "deprecated" | "revoked";
  }[];
  /** Tools the pinned agent version makes available to the model. */
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly owner: ToolOwner;
    readonly approval: "never" | "always";
  }[];
  readonly delegations: readonly {
    readonly id: string;
    readonly delegateKey: string;
    readonly direction: "outgoing" | "parent";
    readonly parentSessionId: string;
    readonly childAgentVersionId: string;
    readonly childSessionId: string;
    readonly latestChildRunId: string;
    readonly latestChildRunState: RunState;
    readonly state: "active" | "cancelled";
  }[];
  readonly runs?: readonly Readonly<Record<string, unknown>>[];
  readonly transcript?: readonly Readonly<Record<string, unknown>>[];
  readonly pendingWork?: readonly Readonly<Record<string, unknown>>[];
  readonly debug?: Readonly<Record<string, unknown>>;
}

export type PendingWork =
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly runId: string;
      readonly sessionId: string;
      readonly title: string;
      readonly toolName: string;
      readonly stage: ToolStage;
      readonly safeArguments: Readonly<Record<string, unknown>>;
      readonly claimedBy: string | null;
      readonly claimFence: string;
      readonly createdAt: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly runId: string;
      readonly sessionId: string;
      readonly title: string;
      readonly summary: string;
      readonly status: "pending" | "approved" | "denied" | "expired";
      readonly createdAt: string;
      readonly expiresAt: string;
    };

export interface PageResult<T> {
  readonly data: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface ListFilters {
  readonly search?: string;
  readonly status?: string;
  readonly date?: string;
  readonly page?: number;
}

export interface ProjectContext {
  readonly organization: { readonly id: string; readonly name: string };
  readonly project: { readonly id: string; readonly name: string };
  readonly currentPrincipal?: {
    readonly id: string;
    readonly kind: "human" | "api_key" | "service";
    readonly subject: string;
    readonly displayName: string;
    readonly role: string;
    readonly scopes: readonly string[];
  };
  readonly organizations: readonly {
    readonly id: string;
    readonly name: string;
  }[];
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly activeModelPresets?: readonly string[];
  readonly authProvider?: "development" | "workos";
}

export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt: string | null;
}

export interface CreateApiKeyInput {
  readonly name: string;
  readonly scopes: readonly string[];
}

export type CreatedApiKey = ApiKeySummary &
  (
    | { readonly shown: true; readonly secret: string }
    | { readonly shown: false; readonly secret?: never }
  );

export interface SettingsData {
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly createdAt: string;
  };
  readonly projects: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly createdAt: string;
    readonly current: boolean;
  }[];
  readonly members: readonly {
    readonly id: string;
    readonly name: string;
    readonly subject: string;
    readonly email?: string;
    readonly role: "owner" | "admin" | "member" | "viewer";
    readonly scopes: readonly string[];
    readonly current: boolean;
  }[];
  readonly apiKeys: readonly ApiKeySummary[];
  readonly hosting: readonly {
    readonly service: string;
    readonly status: "operational" | "degraded" | "offline";
    readonly region: string;
    readonly latencyMs: number | null;
    readonly checkedAt: string;
  }[];
}

export interface EventConnection {
  close(): void;
}

export interface RunFileUpload {
  readonly name: string;
  readonly contentType: string;
  readonly dataBase64: string;
}

export interface ConsoleApi {
  getContext(): Promise<ProjectContext>;
  logout(): Promise<void>;
  listAgents(filters: ListFilters): Promise<PageResult<AgentSummary>>;
  getAgent(id: string): Promise<AgentDetail>;
  createAgent(input: {
    readonly name: string;
    readonly description: string;
    readonly initialConfig: AgentVersionConfig;
  }): Promise<AgentSummary>;
  publishAgentVersion(
    id: string,
    config: AgentVersionConfig,
  ): Promise<AgentDetail>;
  listSkills(filters: ListFilters): Promise<PageResult<SkillSummary>>;
  getSkill(id: string): Promise<SkillDetail>;
  createSkill(input: CreateSkillInput): Promise<SkillDetail>;
  publishSkillVersion(
    id: string,
    input: Omit<CreateSkillInput, "key" | "displayName">,
  ): Promise<SkillDetail>;
  exportSkillVersion(
    skillId: string,
    versionId: string,
  ): Promise<{ readonly files: readonly SkillFileInput[] }>;
  createSkillDraft(input?: {
    readonly skillId?: string;
    readonly sourceSkillVersionId?: string;
  }): Promise<SkillDraft>;
  updateSkillDraft(
    draftId: string,
    input: Pick<
      SkillDraft,
      "key" | "displayName" | "name" | "description" | "instructions"
    >,
  ): Promise<SkillDraft>;
  createSkillDraftDirectory(draftId: string, path: string): Promise<SkillDraft>;
  putSkillDraftFile(draftId: string, file: SkillFileInput): Promise<SkillDraft>;
  removeSkillDraftEntry(
    draftId: string,
    path: string,
    recursive: boolean,
  ): Promise<SkillDraft>;
  validateSkillDraft(draftId: string): Promise<{
    readonly valid: true;
    readonly contentHash: string;
    readonly totalBytes: number;
    readonly fileCount: number;
  }>;
  publishSkillDraft(
    draftId: string,
  ): Promise<{ readonly skillId: string; readonly versionId: string }>;
  discardSkillDraft(draftId: string): Promise<void>;
  updateSkillVersionLifecycle(
    skillId: string,
    versionId: string,
    status: "deprecated" | "revoked",
  ): Promise<SkillDetail>;
  listMcpServers(): Promise<McpServerList>;
  createMcpServer(input: CreateMcpServerInput): Promise<McpServer>;
  discoverMcpServer(
    serverId: string,
    input: DiscoverMcpServerInput,
  ): Promise<McpServer>;
  listMcpCredentials(): Promise<McpCredentialList>;
  createMcpCredential(input: CreateMcpCredentialInput): Promise<McpCredential>;
  rotateMcpCredential(
    credentialId: string,
    input: RotateMcpCredentialInput,
  ): Promise<McpCredential>;
  revokeMcpCredential(credentialId: string): Promise<McpCredential>;
  listMcpCredentialPolicies(): Promise<McpCredentialPolicyList>;
  createMcpCredentialPolicy(
    input: CreateMcpCredentialPolicyInput,
  ): Promise<McpCredentialPolicy>;
  listMcpToolsets(): Promise<McpToolsetList>;
  createMcpToolset(input: CreateMcpToolsetInput): Promise<McpToolset>;
  listSessions(filters: ListFilters): Promise<PageResult<SessionSummary>>;
  getSession(id: string): Promise<SessionDetail>;
  createSession(input: {
    readonly agentId: string;
    readonly title: string;
    readonly initialMessage: string;
    readonly files?: readonly RunFileUpload[];
  }): Promise<SessionSummary>;
  submitMessage(
    id: string,
    input: {
      readonly message: string;
      readonly files?: readonly RunFileUpload[];
    },
  ): Promise<SessionSummary>;
  runSessionAction(
    id: string,
    action: "cancel" | "resume" | "branch-replay",
  ): Promise<SessionSummary>;
  listPendingWork(): Promise<readonly PendingWork[]>;
  claimTool(id: string): Promise<void>;
  submitToolResult(
    id: string,
    fence: string,
    result: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  decideApproval(id: string, decision: "approved" | "denied"): Promise<void>;
  listModelPresets(): Promise<ModelPresetList>;
  listModelProviders(): Promise<readonly ProjectModelProvider[]>;
  createModelProvider(
    input: CreateModelProviderInput,
  ): Promise<ProjectModelProvider>;
  rotateModelProviderCredential(
    providerId: string,
    apiKey: string,
  ): Promise<ProjectModelProvider>;
  listSandboxProviders(): Promise<SandboxProviderList>;
  listSandboxSnapshots(providerId: string): Promise<SandboxSnapshotList>;
  createSandboxProvider(
    input: CreateSandboxProviderInput,
  ): Promise<ProjectSandboxProvider>;
  rotateSandboxProviderCredential(
    providerId: string,
    apiKey: string,
  ): Promise<ProjectSandboxProvider>;
  updateSandboxProviderConfiguration(
    providerId: string,
    input: UpdateSandboxProviderConfigurationInput,
  ): Promise<ProjectSandboxProvider>;
  listStorageProviders(): Promise<StorageProviderList>;
  createStorageProvider(
    input: CreateStorageProviderInput,
  ): Promise<ProjectStorageProvider>;
  rotateStorageProviderCredential(
    providerId: string,
    credential: Pick<
      CreateStorageProviderInput,
      "accessKeyId" | "secretAccessKey" | "sessionToken"
    >,
  ): Promise<ProjectStorageProvider>;
  setDefaultStorageProvider(
    providerId: string,
  ): Promise<ProjectStorageProvider>;
  listStorageObjects(
    providerId: string,
    query?: {
      readonly prefix?: string;
      readonly cursor?: string;
    },
  ): Promise<StorageObjectList>;
  listModelCatalog(
    providerId: string,
    search?: string,
  ): Promise<ModelCatalogList>;
  createModelPreset(input: CreateModelPresetInput): Promise<ModelPreset>;
  getSettings(): Promise<SettingsData>;
  addMember(input: {
    readonly subject: string;
    readonly role: SettingsData["members"][number]["role"];
    readonly scopes: readonly string[];
  }): Promise<void>;
  updateMemberRole(
    memberId: string,
    role: SettingsData["members"][number]["role"],
  ): Promise<void>;
  removeMember(memberId: string): Promise<void>;
  createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey>;
  connectEvents(input: {
    readonly after?: string;
    readonly signal?: AbortSignal;
    readonly onEvent: (event: ProductEvent) => void;
    readonly onCursor: (cursor: string) => void;
    readonly onError: (error: Error) => void;
  }): EventConnection;
}
