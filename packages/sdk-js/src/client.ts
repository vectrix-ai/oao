import type {
  AgentDefinition,
  AgentVersion,
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

import { createRoutes, type Routes } from "./routes.js";
import { parseEventStream } from "./sse.js";
import type {
  AgentToolInput,
  AuditEntry,
  AuditExport,
  AuthSession,
  CreatedPlatformApiKey,
  HealthStatus,
  Member,
  PaginationOptions,
  PlatformApiKey,
  ProjectEventFrame,
  ProjectEventStreamOptions,
  PublishAgentVersionInput,
  ReadinessStatus,
  RequestOptions,
  RunTimelineEntry,
  SandboxPolicyInput,
  ToolClaim,
  ToolResultSubmission,
  WriteOptions,
} from "./types.js";

type Credential =
  string | (() => string | undefined | Promise<string | undefined>);

export interface OaoClientOptions {
  readonly baseUrl: string;
  readonly apiPrefix?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly bearerToken?: Credential;
  readonly apiKey?: Credential;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
}

interface InternalRequestOptions extends RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class OaoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "OaoApiError";
  }
}

export class OaoClient {
  readonly routes: Routes;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #bearerToken: Credential | undefined;
  readonly #apiKey: Credential | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #credentials: RequestCredentials;

  constructor(options: OaoClientOptions) {
    if (!/^https?:\/\//u.test(options.baseUrl)) {
      throw new TypeError("baseUrl must be an absolute HTTP(S) URL");
    }
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#bearerToken = options.bearerToken;
    this.#apiKey = options.apiKey;
    this.#headers = options.headers ?? {};
    this.#credentials = options.credentials ?? "same-origin";
    this.routes = createRoutes(options.apiPrefix);
  }

  health(options?: RequestOptions): Promise<HealthStatus> {
    return this.#request(this.routes.health, options);
  }

  readiness(options?: RequestOptions): Promise<ReadinessStatus> {
    return this.#request(this.routes.readiness, options);
  }

  login(
    input: { readonly organizationHint?: string } = {},
    options?: RequestOptions,
  ): Promise<{ readonly redirectUrl: string }> {
    return this.#request(this.routes.auth.login, {
      ...options,
      method: "POST",
      body: input,
    });
  }

  developmentLogin(
    input: { readonly projectId?: string } = {},
    options?: RequestOptions,
  ): Promise<AuthSession> {
    return this.#request(this.routes.auth.developmentLogin, {
      ...options,
      method: "POST",
      body: input,
    });
  }

  refreshAuth(options?: RequestOptions): Promise<AuthSession> {
    return this.#request(this.routes.auth.refresh, {
      ...options,
      method: "POST",
    });
  }

  logout(options?: RequestOptions): Promise<void> {
    return this.#request(this.routes.auth.logout, {
      ...options,
      method: "POST",
    });
  }

  listOrganizations(
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Organization>> {
    return this.#request(
      this.#path(this.routes.organizations, pagination),
      options,
    );
  }

  getOrganization(
    organizationId: string,
    options?: RequestOptions,
  ): Promise<Organization> {
    return this.#request(this.routes.organization(organizationId), options);
  }

  listProjects(
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Project>> {
    return this.#request(this.#path(this.routes.projects, pagination), options);
  }

  getProject(projectId: string, options?: RequestOptions): Promise<Project> {
    return this.#request(this.routes.project(projectId), options);
  }

  listMembers(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Member>> {
    return this.#request(
      this.#path(this.routes.members(projectId), pagination),
      options,
    );
  }

  addMember(
    projectId: string,
    input: {
      readonly subject: string;
      readonly role: Member["role"];
      readonly scopes: readonly string[];
    },
    options: WriteOptions,
  ): Promise<Member> {
    return this.#write(this.routes.members(projectId), "POST", input, options);
  }

  updateMember(
    projectId: string,
    memberId: string,
    input: { readonly role: Member["role"] },
    options: WriteOptions,
  ): Promise<Member> {
    return this.#write(
      this.routes.member(projectId, memberId),
      "PATCH",
      input,
      options,
    );
  }

  removeMember(
    projectId: string,
    memberId: string,
    options: WriteOptions,
  ): Promise<void> {
    return this.#write(
      this.routes.member(projectId, memberId),
      "DELETE",
      undefined,
      options,
    );
  }

  listApiKeys(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<PlatformApiKey>> {
    return this.#request(
      this.#path(this.routes.apiKeys(projectId), pagination),
      options,
    );
  }

  createApiKey(
    projectId: string,
    input: { readonly name: string; readonly scopes: readonly string[] },
    options: WriteOptions,
  ): Promise<CreatedPlatformApiKey> {
    return this.#write(this.routes.apiKeys(projectId), "POST", input, options);
  }

  revokeApiKey(
    projectId: string,
    apiKeyId: string,
    options: WriteOptions,
  ): Promise<void> {
    return this.#write(
      this.routes.apiKey(projectId, apiKeyId),
      "DELETE",
      undefined,
      options,
    );
  }

  listAgents(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<AgentDefinition>> {
    return this.#request(
      this.#path(this.routes.agents(projectId), pagination),
      options,
    );
  }

  createAgent(
    projectId: string,
    input: {
      readonly key: string;
      readonly name: string;
      readonly description?: string;
    },
    options: WriteOptions,
  ): Promise<AgentDefinition> {
    return this.#write(this.routes.agents(projectId), "POST", input, options);
  }

  getAgent(
    projectId: string,
    agentId: string,
    options?: RequestOptions,
  ): Promise<AgentDefinition> {
    return this.#request(this.routes.agent(projectId, agentId), options);
  }

  publishAgentVersion(
    projectId: string,
    agentId: string,
    input: PublishAgentVersionInput,
    options: WriteOptions,
  ): Promise<AgentVersion> {
    return this.#write(
      this.routes.agentVersions(projectId, agentId),
      "POST",
      input,
      options,
    );
  }

  listAgentVersions(
    projectId: string,
    agentId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<AgentVersion>> {
    return this.#request(
      this.#path(this.routes.agentVersions(projectId, agentId), pagination),
      options,
    );
  }

  getAgentVersion(
    projectId: string,
    agentId: string,
    versionId: string,
    options?: RequestOptions,
  ): Promise<AgentVersion> {
    return this.#request(
      this.routes.agentVersion(projectId, agentId, versionId),
      options,
    );
  }

  listSessions(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Session>> {
    return this.#request(
      this.#path(this.routes.sessions(projectId), pagination),
      options,
    );
  }

  createSession(
    projectId: string,
    input: { readonly agentVersionId: string; readonly title?: string },
    options: WriteOptions,
  ): Promise<Session> {
    return this.#write(this.routes.sessions(projectId), "POST", input, options);
  }

  getSession(
    projectId: string,
    sessionId: string,
    options?: RequestOptions,
  ): Promise<Session> {
    return this.#request(this.routes.session(projectId, sessionId), options);
  }

  listThreads(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Thread>> {
    return this.#request(
      this.#path(this.routes.threads(projectId), pagination),
      options,
    );
  }

  getThread(
    projectId: string,
    threadId: string,
    options?: RequestOptions,
  ): Promise<Thread> {
    return this.#request(this.routes.thread(projectId, threadId), options);
  }

  listRuns(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Run>> {
    return this.#request(
      this.#path(this.routes.runs(projectId), pagination),
      options,
    );
  }

  submitRun(
    projectId: string,
    sessionId: string,
    input: { readonly redactedInput: string },
    options: WriteOptions,
  ): Promise<Run> {
    return this.#write(
      this.routes.sessionRuns(projectId, sessionId),
      "POST",
      input,
      options,
    );
  }

  resumeRun(
    projectId: string,
    runId: string,
    input: { readonly redactedInput: string },
    options: WriteOptions,
  ): Promise<Run> {
    return this.#write(
      this.routes.resumeRun(projectId, runId),
      "POST",
      input,
      options,
    );
  }

  getRun(
    projectId: string,
    runId: string,
    options?: RequestOptions,
  ): Promise<Run> {
    return this.#request(this.routes.run(projectId, runId), options);
  }

  cancelRun(
    projectId: string,
    runId: string,
    options: WriteOptions,
  ): Promise<Run> {
    return this.#write(
      this.routes.cancelRun(projectId, runId),
      "POST",
      {},
      options,
    );
  }

  listRunMessages(
    projectId: string,
    runId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Message>> {
    return this.#request(
      this.#path(this.routes.runMessages(projectId, runId), pagination),
      options,
    );
  }

  listRunTimeline(
    projectId: string,
    runId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<RunTimelineEntry>> {
    return this.#request(
      this.#path(this.routes.runTimeline(projectId, runId), pagination),
      options,
    );
  }

  listToolCalls(
    projectId: string,
    pagination: PaginationOptions & { readonly runId?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<ToolCall>> {
    return this.#request(
      this.#path(this.routes.toolCalls(projectId), pagination),
      options,
    );
  }

  claimToolCall(
    projectId: string,
    toolCallId: string,
    input: { readonly leaseMs: number },
    options: WriteOptions,
  ): Promise<ToolClaim> {
    return this.#write(
      this.routes.claimToolCall(projectId, toolCallId),
      "POST",
      input,
      options,
    );
  }

  renewToolCall(
    projectId: string,
    toolCallId: string,
    input: { readonly fence: string; readonly leaseMs: number },
    options: WriteOptions,
  ): Promise<ToolClaim> {
    return this.#write(
      this.routes.renewToolCall(projectId, toolCallId),
      "POST",
      input,
      options,
    );
  }

  releaseToolCall(
    projectId: string,
    toolCallId: string,
    input: { readonly fence: string },
    options: WriteOptions,
  ): Promise<ToolClaim> {
    return this.#write(
      this.routes.releaseToolCall(projectId, toolCallId),
      "POST",
      input,
      options,
    );
  }

  submitToolResult(
    projectId: string,
    toolCallId: string,
    input: {
      readonly fence: string;
      readonly safeResult: Readonly<Record<string, unknown>>;
    },
    options: WriteOptions,
  ): Promise<ToolResultSubmission> {
    return this.#write(
      this.routes.submitToolResult(projectId, toolCallId),
      "POST",
      input,
      options,
    );
  }

  listApprovals(
    projectId: string,
    pagination: PaginationOptions & { readonly runId?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<Approval>> {
    return this.#request(
      this.#path(this.routes.approvals(projectId), pagination),
      options,
    );
  }

  decideApproval(
    projectId: string,
    approvalId: string,
    input: { readonly status: "approved" | "denied"; readonly note?: string },
    options: WriteOptions,
  ): Promise<Approval> {
    return this.#write(
      this.routes.decideApproval(projectId, approvalId),
      "POST",
      input,
      options,
    );
  }

  listAuditEntries(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<AuditEntry>> {
    return this.#request(
      this.#path(this.routes.audit(projectId), pagination),
      options,
    );
  }

  exportAudit(
    projectId: string,
    input: { readonly from?: string; readonly to?: string } = {},
    options: WriteOptions,
  ): Promise<AuditExport> {
    return this.#write(
      this.routes.auditExport(projectId),
      "POST",
      input,
      options,
    );
  }

  async *streamProjectEvents(
    projectId: string,
    options: ProjectEventStreamOptions = {},
  ): AsyncGenerator<ProjectEventFrame> {
    let lastEventId = options.lastEventId;
    let reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    do {
      throwIfAborted(options.signal);
      const headers = await this.#requestHeaders({
        accept: "text/event-stream",
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      });
      const response = await this.#fetch(
        this.#url(this.routes.events(projectId)),
        {
          method: "GET",
          headers,
          credentials: this.#credentials,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      if (!response.ok) await this.#throwResponseError(response);
      if (response.body === null) {
        throw new OaoApiError(
          response.status,
          "invalid_response",
          "SSE response has no body",
        );
      }
      for await (const frame of parseEventStream(response.body)) {
        if (frame.retry !== undefined) reconnectDelayMs = frame.retry;
        if (frame.id !== undefined) lastEventId = frame.id;
        let data: ProductEvent;
        try {
          data = JSON.parse(frame.data) as ProductEvent;
        } catch {
          throw new OaoApiError(
            response.status,
            "invalid_response",
            "SSE event contained invalid JSON",
          );
        }
        yield {
          id: frame.id ?? lastEventId ?? "",
          event: frame.event ?? "message",
          data,
        };
      }
      if (options.reconnect === false) return;
      await abortableDelay(reconnectDelayMs, options.signal);
    } while (true);
  }

  async #write<T>(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    options: WriteOptions,
  ): Promise<T> {
    if (options.idempotencyKey.trim().length === 0) {
      throw new TypeError("idempotencyKey must not be empty");
    }
    return this.#request(path, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      method,
      body,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async #request<T>(
    path: string,
    options: InternalRequestOptions = {},
  ): Promise<T> {
    const headers = await this.#requestHeaders({
      accept: "application/json",
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { "idempotency-key": options.idempotencyKey }),
      ...options.headers,
    });
    const response = await this.#fetch(this.#url(path), {
      method: options.method ?? "GET",
      headers,
      credentials: this.#credentials,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) await this.#throwResponseError(response);
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new OaoApiError(
        response.status,
        "invalid_response",
        "API response was not JSON",
        response.headers.get("x-request-id") ?? undefined,
      );
    }
    return (await response.json()) as T;
  }

  async #throwResponseError(response: Response): Promise<never> {
    let envelope:
      | {
          readonly error?: {
            readonly code?: string;
            readonly message?: string;
            readonly requestId?: string;
            readonly details?: Readonly<Record<string, unknown>>;
          };
        }
      | undefined;
    if (
      (response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      try {
        envelope = (await response.json()) as typeof envelope;
      } catch {
        envelope = undefined;
      }
    }
    const requestId =
      envelope?.error?.requestId ??
      response.headers.get("x-request-id") ??
      undefined;
    throw new OaoApiError(
      response.status,
      envelope?.error?.code ?? "http_error",
      envelope?.error?.message ??
        `API request failed with status ${response.status}`,
      requestId,
      envelope?.error?.details,
    );
  }

  async #requestHeaders(
    requestHeaders: Readonly<Record<string, string>>,
  ): Promise<Headers> {
    const headers = new Headers(this.#headers);
    for (const [key, value] of Object.entries(requestHeaders))
      headers.set(key, value);
    const bearerToken = await resolveCredential(this.#bearerToken);
    const apiKey = await resolveCredential(this.#apiKey);
    if (bearerToken !== undefined && apiKey !== undefined) {
      throw new TypeError("Configure either bearerToken or apiKey, not both");
    }
    if (bearerToken !== undefined)
      headers.set("authorization", `Bearer ${bearerToken}`);
    if (apiKey !== undefined) headers.set("authorization", `Bearer ${apiKey}`);
    return headers;
  }

  #path(path: string, query: object): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const encoded = params.toString();
    return encoded.length === 0 ? path : `${path}?${encoded}`;
  }

  #url(path: string, query?: object): string {
    return `${this.#baseUrl}${query === undefined ? path : this.#path(path, query)}`;
  }
}

async function resolveCredential(
  credential: Credential | undefined,
): Promise<string | undefined> {
  const value =
    typeof credential === "function" ? await credential() : credential;
  return value === undefined || value.length === 0 ? undefined : value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  }
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError"),
        );
      },
      { once: true },
    );
  });
}

export type { AgentToolInput, SandboxPolicyInput };
