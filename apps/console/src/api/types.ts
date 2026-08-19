import type {
  ProductEvent,
  RunState,
  ToolOwner,
  ToolStage,
} from "@oao/contracts";

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
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly owner: ToolOwner;
  readonly approval: "never" | "always" | "conditional";
  readonly inputSchema: string;
}

export interface AgentVersionConfig {
  readonly systemInstructions: string;
  readonly modelPreset: string;
  readonly tools: readonly ToolDefinition[];
  readonly sandbox: {
    readonly enabled: boolean;
    readonly target: "local" | "eu" | "us";
    readonly timeoutSeconds: number;
    readonly networkPolicy: "deny" | "restricted";
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
  "user" | "assistant" | "tool" | "approval" | "error" | "retry" | "recovery";

export interface TimelineEvent {
  readonly id: string;
  readonly kind: TimelineKind;
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
  readonly agentVersion: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly attempt: number;
  readonly events: readonly TimelineEvent[];
  readonly capabilities: {
    readonly canCancel: boolean;
    readonly canResume: boolean;
    readonly canBranchReplay: boolean;
  };
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
    readonly displayName: string;
    readonly role: string;
  };
  readonly organizations: readonly {
    readonly id: string;
    readonly name: string;
  }[];
  readonly projects: readonly { readonly id: string; readonly name: string }[];
}

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
    readonly role: "owner" | "admin" | "operator" | "viewer";
  }[];
  readonly apiKeys: readonly {
    readonly id: string;
    readonly name: string;
    readonly prefix: string;
    readonly scopes: readonly string[];
    readonly lastUsedAt: string | null;
  }[];
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
  }): Promise<SessionSummary>;
  runSessionAction(
    id: string,
    action: "cancel" | "resume" | "branch-replay",
  ): Promise<SessionSummary>;
  listPendingWork(): Promise<readonly PendingWork[]>;
  claimTool(id: string): Promise<void>;
  submitToolResult(
    id: string,
    result: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  decideApproval(id: string, decision: "approved" | "denied"): Promise<void>;
  getSettings(): Promise<SettingsData>;
  connectEvents(input: {
    readonly after?: string;
    readonly signal?: AbortSignal;
    readonly onEvent: (event: ProductEvent) => void;
    readonly onCursor: (cursor: string) => void;
    readonly onError: (error: Error) => void;
  }): EventConnection;
}
