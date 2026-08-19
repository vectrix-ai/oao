export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type OrganizationId = Brand<string, "OrganizationId">;
export type ProjectId = Brand<string, "ProjectId">;
export type PrincipalId = Brand<string, "PrincipalId">;
export type AgentDefinitionId = Brand<string, "AgentDefinitionId">;
export type AgentVersionId = Brand<string, "AgentVersionId">;
export type ThreadId = Brand<string, "ThreadId">;
export type SessionId = Brand<string, "SessionId">;
export type RunId = Brand<string, "RunId">;
export type MessageId = Brand<string, "MessageId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type EventId = Brand<string, "EventId">;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function brandedId<T extends Brand<string, string>>(value: string): T {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`Invalid UUID: ${value}`);
  return value as T;
}

export interface TenantIdentity {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
}

export interface Principal extends TenantIdentity {
  readonly id: PrincipalId;
  readonly kind: "human" | "api_key" | "service";
  readonly subject: string;
  readonly scopes: ReadonlySet<AuthorizationScope>;
}

export const AUTHORIZATION_ACTIONS = [
  "agent:read",
  "agent:write",
  "session:read",
  "session:write",
  "run:create",
  "run:read",
  "run:cancel",
  "tool_call:claim",
  "tool_call:submit",
  "approval:resolve",
  "audit:read",
  "project:admin",
] as const;
export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];
export type AuthorizationScope = AuthorizationAction | "*";

export function isAuthorized(
  principal: Principal,
  action: AuthorizationAction,
  tenant: TenantIdentity,
): boolean {
  return (
    principal.organizationId === tenant.organizationId &&
    principal.projectId === tenant.projectId &&
    (principal.scopes.has("*") || principal.scopes.has(action))
  );
}

export const RUN_STATES = [
  "queued",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "retry_scheduled",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type RunState = (typeof RUN_STATES)[number];

const RUN_TRANSITIONS: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  queued: new Set([
    "running",
    "retry_scheduled",
    "cancelled",
    "failed",
    "timed_out",
  ]),
  retry_scheduled: new Set(["queued", "cancelled", "failed", "timed_out"]),
  running: new Set([
    "waiting_for_tool",
    "waiting_for_approval",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
  ]),
  waiting_for_tool: new Set([
    "running",
    "waiting_for_approval",
    "failed",
    "cancelled",
    "timed_out",
  ]),
  waiting_for_approval: new Set([
    "running",
    "waiting_for_tool",
    "failed",
    "cancelled",
    "timed_out",
  ]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  timed_out: new Set(),
};

export interface RunTransitionContext {
  readonly admitted: boolean;
  readonly hasAdmissionHead: boolean;
}

export type RunTransitionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | "terminal_state"
        | "illegal_transition"
        | "retry_after_admission"
        | "reserved_cancellation";
    };

export function evaluateRunTransition(
  from: RunState,
  to: RunState,
  context: RunTransitionContext,
): RunTransitionDecision {
  if (from === to) return { allowed: true };
  if (RUN_TRANSITIONS[from].size === 0)
    return { allowed: false, reason: "terminal_state" };
  if (!RUN_TRANSITIONS[from].has(to))
    return { allowed: false, reason: "illegal_transition" };
  if (to === "retry_scheduled" && context.admitted)
    return { allowed: false, reason: "retry_after_admission" };
  if (
    (from === "queued" || from === "retry_scheduled") &&
    to === "cancelled" &&
    context.hasAdmissionHead
  ) {
    return { allowed: false, reason: "reserved_cancellation" };
  }
  return { allowed: true };
}

export function assertRunTransition(
  from: RunState,
  to: RunState,
  context: RunTransitionContext,
): void {
  const decision = evaluateRunTransition(from, to, context);
  if (!decision.allowed)
    throw new IllegalRunTransitionError(from, to, decision.reason);
}

export class IllegalRunTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
    readonly reason: Exclude<
      RunTransitionDecision,
      { allowed: true }
    >["reason"],
  ) {
    super(`Cannot transition run from ${from} to ${to}: ${reason}`);
    this.name = "IllegalRunTransitionError";
  }
}

export type AdmissionState = "reserved" | "ambiguous" | "admitted";
export interface ThreadAdmissionHead extends TenantIdentity {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly state: AdmissionState;
  readonly fence: bigint;
}

export function canInstallAdmissionHead(
  existing: ThreadAdmissionHead | undefined,
  candidateRunId: RunId,
): boolean {
  return existing === undefined || existing.runId === candidateRunId;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export interface AgentConfig {
  readonly systemPrompt: string;
  readonly modelPreset: string;
  readonly tools: readonly {
    readonly name: string;
    readonly owner: "runtime" | "caller";
    readonly approval: "never" | "always";
  }[];
  readonly sandboxPolicy: {
    readonly enabled: boolean;
    readonly network: "none" | "restricted";
  };
  readonly limits: { readonly maxTurns: number; readonly timeoutMs: number };
}
export type ImmutableAgentConfig = DeepReadonly<AgentConfig>;

export interface ClockPort {
  now(): Date;
}
export interface IdPort {
  next<T extends Brand<string, string>>(): T;
}
export interface ModelRequest {
  readonly modelPreset: string;
  readonly messages: readonly {
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly content: string;
  }[];
  readonly idempotencyKey: string;
}
export interface ModelResponse {
  readonly redactedText: string;
  readonly finishReason: "stop" | "tool_call" | "length" | "error";
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly providerRequestId?: string;
}
export interface ModelPort {
  invoke(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
export interface SandboxPort {
  create(input: {
    readonly tenant: TenantIdentity;
    readonly idempotencyKey: string;
  }): Promise<{ readonly sandboxRef: string }>;
  execute(input: {
    readonly sandboxRef: string;
    readonly command: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly exitCode: number; readonly redactedOutput: string }>;
  stop(sandboxRef: string): Promise<void>;
}
export interface RuntimePort {
  submit(input: {
    readonly tenant: TenantIdentity;
    readonly runId: RunId;
    readonly idempotencyKey: string;
  }): Promise<{ readonly canonicalRunRef: string }>;
  abort(input: {
    readonly tenant: TenantIdentity;
    readonly runId: RunId;
    readonly idempotencyKey: string;
  }): Promise<void>;
}
export interface AuthTenantPort {
  authenticate(token: string): Promise<Principal | undefined>;
}
export interface ArtifactPort {
  put(input: {
    readonly tenant: TenantIdentity;
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly ref: string }>;
}
export interface TelemetryPort {
  record(
    name: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
  ): void;
}

const FORBIDDEN_KEYS =
  /(?:authorization|cookie|password|secret|token|chain.?of.?thought|reasoning|raw.?payload|tool.?payload)/iu;
const REDACTED = "[REDACTED]";

export type PublicValue =
  | null
  | boolean
  | number
  | string
  | readonly PublicValue[]
  | { readonly [key: string]: PublicValue };

export function redactForPublic(value: unknown): PublicValue {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redactForPublic);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        FORBIDDEN_KEYS.test(key) ? REDACTED : redactForPublic(nested),
      ]),
    );
  }
  return String(value);
}

export function assertPublicPayload(value: PublicValue): void {
  if (Array.isArray(value)) {
    value.forEach(assertPublicPayload);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(key))
        throw new TypeError(`Unsafe public payload key: ${key}`);
      assertPublicPayload(nested);
    }
  }
}
