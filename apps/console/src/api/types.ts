import type {
  ModelCatalogEntry,
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
} from "@oao/contracts";

export type {
  ModelCatalogEntry,
  ModelPreset,
  ModelRoutingPolicy,
  ProjectModelProvider,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  SandboxSnapshotEntry,
};

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

export type AgentStatus = "published" | "draft" | "archived";

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly description: string;
  readonly model: string;
  readonly status: AgentStatus;
  readonly version: number;
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

export interface AgentVersionConfig {
  readonly systemPrompt: string;
  readonly modelPreset: string;
  readonly tools: readonly ToolDefinition[];
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
  readonly status: RunState;
  readonly agentId: string;
  readonly agentName: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
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

export interface TimelineEvent {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly source?: TimelineSource;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly durationMs: number | null;
  readonly status: "success" | "pending" | "error" | "info";
  readonly tokens?: { readonly input: number; readonly output: number };
  readonly costUsd?: number;
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
    readonly backedUp: boolean;
    readonly backedUpAt?: string;
  }[];
  readonly capabilities: {
    readonly canCancel: boolean;
    readonly canResume: boolean;
    readonly canBranchReplay: boolean;
  };
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
    readonly name: string;
    readonly slug: string;
    readonly createdAt: string;
  };
  readonly projects: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  }[];
  readonly members: readonly {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly role: "owner" | "admin" | "member" | "operator" | "viewer";
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

export interface ConsoleApi {
  getContext(): Promise<ProjectContext>;
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
  listSessions(filters: ListFilters): Promise<PageResult<SessionSummary>>;
  getSession(id: string): Promise<SessionDetail>;
  createSession(input: {
    readonly agentId: string;
    readonly title: string;
    readonly initialMessage: string;
  }): Promise<SessionSummary>;
  submitMessage(id: string, message: string): Promise<SessionSummary>;
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
  listModelCatalog(
    providerId: string,
    search?: string,
  ): Promise<ModelCatalogList>;
  createModelPreset(input: CreateModelPresetInput): Promise<ModelPreset>;
  getSettings(): Promise<SettingsData>;
  createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey>;
  connectEvents(input: {
    readonly after?: string;
    readonly signal?: AbortSignal;
    readonly onEvent: (event: ProductEvent) => void;
    readonly onCursor: (cursor: string) => void;
    readonly onError: (error: Error) => void;
  }): EventConnection;
}
