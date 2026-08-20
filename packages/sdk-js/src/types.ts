import type {
  AgentDefinition,
  AgentVersion,
  ApiError,
  Approval,
  Message,
  ModelCatalogEntry,
  ModelPreset,
  ProjectModelProvider,
  ModelRoutingPolicy,
  Organization,
  Page,
  ProductEvent,
  Project,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  SandboxSnapshotEntry,
  Run,
  Session,
  Thread,
  ToolCall,
  ToolResultEnvelope,
} from "@oao/contracts";

export type {
  AgentDefinition,
  AgentVersion,
  ApiError,
  Approval,
  Message,
  ModelCatalogEntry,
  ModelPreset,
  ProjectModelProvider,
  ModelRoutingPolicy,
  Organization,
  Page,
  ProductEvent,
  Project,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  SandboxSnapshotEntry,
  Run,
  Session,
  Thread,
  ToolCall,
  ToolResultEnvelope,
};

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
  readonly principal: {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly kind: "human" | "api_key" | "service";
    readonly subject: string;
    readonly scopes: readonly string[];
  };
}

export interface Member {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly subject?: string;
  readonly kind?: "human" | "api_key" | "service";
  readonly scopes?: readonly string[];
  readonly email?: string;
  readonly role: "owner" | "admin" | "member" | "viewer";
  readonly createdAt: string;
}

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

export interface PublishAgentVersionInput {
  readonly systemPrompt: string;
  readonly modelPreset: string;
  readonly tools: readonly AgentToolInput[];
  readonly sandbox: SandboxPolicyInput;
  readonly limits: {
    readonly maxTurns: 32;
    readonly timeoutMs: number;
  };
}

export interface CreateModelPresetInput {
  /** Stable, versioned key, for example `claude-sonnet-4-6-zdr-v1`. */
  readonly key: string;
  readonly displayName: string;
  readonly providerId: string;
  /** Approved catalog model, for example `openrouter/anthropic/claude-sonnet-4.6`. */
  readonly model: string;
  readonly routing?: ModelRoutingPolicy;
}

export interface ModelPresetPage extends Page<ModelPreset> {
  readonly credentialEncryptionConfigured: boolean;
}

export interface ModelCatalogPage extends Page<ModelCatalogEntry> {
  readonly providerId: string;
  readonly providerType: "openrouter" | "openai";
}

export interface CreateProjectModelProviderInput {
  readonly key: string;
  readonly displayName: string;
  readonly providerType: "openrouter" | "openai";
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

export interface CreateAgentInput {
  readonly key?: string;
  readonly name: string;
  readonly description?: string;
  readonly initialConfig?: PublishAgentVersionInput;
}

export type CreateSessionInput =
  | {
      readonly agentId: string;
      readonly agentVersionId?: string;
      readonly title?: string;
      readonly initialMessage: string;
    }
  | {
      readonly agentId?: never;
      readonly agentVersionId: string;
      readonly title?: string;
      readonly initialMessage: string;
    };

export type RunInput =
  | { readonly message: string; readonly redactedInput?: never }
  | { readonly message?: never; readonly redactedInput: string };

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
