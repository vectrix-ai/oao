import type {
  AgentDefinition,
  AgentVersion,
  ApiError,
  Approval,
  Message,
  Organization,
  Page,
  ProductEvent,
  Project,
  Run,
  Session,
  Thread,
  ToolCall,
} from "@oao/contracts";

export type {
  AgentDefinition,
  AgentVersion,
  ApiError,
  Approval,
  Message,
  Organization,
  Page,
  ProductEvent,
  Project,
  Run,
  Session,
  Thread,
  ToolCall,
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
  readonly name: string;
  readonly description?: string;
  readonly owner: "caller" | "platform";
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly approval: "never" | "always";
}

export interface SandboxPolicyInput {
  readonly enabled: boolean;
  readonly network: "none" | "restricted";
  readonly timeoutMs?: number;
}

export interface PublishAgentVersionInput {
  readonly instructions: string;
  readonly modelPreset: string;
  readonly tools: readonly AgentToolInput[];
  readonly sandboxPolicy: SandboxPolicyInput;
  readonly limits?: {
    readonly maxTurns: number;
    readonly timeoutMs: number;
  };
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
