import type {
  AgentDetail,
  AgentSummary,
  ConsoleApi,
  EventConnection,
  ListFilters,
  PageResult,
  PendingWork,
  ProjectContext,
  SessionDetail,
  SessionSummary,
  SettingsData,
  TimelineEvent,
  TimelineKind,
} from "./types";
import { parseProductEvent, parseSseFrames } from "./sse";

interface CursorPage<T> {
  readonly data: readonly T[];
  readonly pageInfo?: {
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
  readonly page?: number;
  readonly pageSize?: number;
  readonly total?: number;
}

interface ContextResponse {
  readonly principal: {
    readonly id: string;
    readonly kind: "human" | "api_key" | "service";
    readonly subject: string;
    readonly scopes: readonly string[];
  };
  readonly organization: { readonly id: string; readonly name: string };
  readonly project: { readonly id: string; readonly name: string };
  readonly organizations: readonly {
    readonly id: string;
    readonly name: string;
  }[];
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly activeModelPresets?: readonly string[];
  readonly authProvider?: "development" | "workos";
}

class HttpConsoleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpConsoleError";
  }
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function idempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `console-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function contextView(response: ContextResponse): ProjectContext {
  const subject = response.principal.subject;
  const displayName = subject.includes("@")
    ? subject.slice(0, subject.indexOf("@")).replaceAll(/[._-]+/gu, " ")
    : subject.replaceAll(/[._-]+/gu, " ");
  return {
    organization: response.organization,
    project: response.project,
    currentPrincipal: {
      ...response.principal,
      displayName: displayName || "Authenticated user",
      role: response.principal.scopes.includes("*")
        ? "Platform owner"
        : response.principal.kind.replaceAll("_", " "),
    },
    organizations: response.organizations,
    projects: response.projects,
    ...(response.activeModelPresets
      ? { activeModelPresets: response.activeModelPresets }
      : {}),
    ...(response.authProvider ? { authProvider: response.authProvider } : {}),
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timelineKind(value: unknown): TimelineKind {
  const kind = text(value).toLowerCase();
  if (kind.includes("approval")) return "approval";
  if (kind.includes("tool") || kind.includes("sandbox")) return "tool";
  if (kind.includes("retry")) return "retry";
  if (kind.includes("recover")) return "recovery";
  if (kind.includes("error") || kind.includes("fail")) return "error";
  if (kind === "user") return "user";
  return "assistant";
}

function durationMs(startedAt: unknown, completedAt: unknown): number | null {
  if (!startedAt || !completedAt) return null;
  const duration = Date.parse(text(completedAt)) - Date.parse(text(startedAt));
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function safePayload(
  rendered: Readonly<Record<string, unknown>>,
): NonNullable<TimelineEvent["payload"]> {
  return {
    rendered,
    raw: null,
    redacted: true,
    redactionReason:
      "Only public, redacted metadata is available in this view.",
  };
}

function sessionSummary(
  value: Readonly<Record<string, unknown>>,
): SessionSummary {
  const costProvenance = text(
    value.costProvenance,
    "unavailable",
  ) as SessionSummary["costProvenance"];
  return {
    id: text(value.id),
    title: text(value.title, "Untitled session"),
    status: text(value.status, "queued") as SessionSummary["status"],
    agentId: text(value.agentId),
    agentName: text(value.agentName, "Managed agent"),
    inputTokens: numeric(value.inputTokens),
    outputTokens: numeric(value.outputTokens),
    observedCostUsd:
      costProvenance === "unavailable" ||
      value.costMicrounits === null ||
      value.costMicrounits === undefined
        ? null
        : numeric(value.costMicrounits) / 1_000_000,
    costProvenance,
    createdAt: text(value.createdAt),
    lastActivityAt: text(value.lastActivityAt ?? value.createdAt),
  };
}

function sessionDetail(
  value: Readonly<Record<string, unknown>>,
): SessionDetail {
  const summary = sessionSummary(value);
  const runs = Array.isArray(value.runs) ? value.runs.map(record) : [];
  const latestRunId = text(value.latestRunId ?? value.runId ?? runs.at(-1)?.id);
  const latestRun =
    runs.find((run) => text(run.id) === latestRunId) ?? runs.at(-1) ?? {};
  const transcript: TimelineEvent[] = (
    Array.isArray(value.transcript) ? value.transcript : []
  ).map((item, index) => {
    const message = record(item);
    const role = text(message.role, "assistant");
    return {
      id: text(message.id, `message-${index}`),
      kind: timelineKind(role),
      title: role === "user" ? "User" : role === "tool" ? "Tool" : "Assistant",
      summary: text(message.redactedContent, "Redacted message"),
      createdAt: text(message.createdAt, summary.createdAt),
      durationMs: null,
      status: "success",
    };
  });
  const timeline: TimelineEvent[] = (
    Array.isArray(value.timeline) ? value.timeline : []
  ).map((item, index) => {
    const entry = record(item);
    const type = text(entry.entryType, "runtime event");
    const detail = record(entry.safeDetail);
    const completedAt = entry.completedAt;
    return {
      id: `${text(entry.runId, latestRunId)}:timeline:${text(entry.entrySequence, String(index))}`,
      kind: timelineKind(type),
      title: type.replaceAll("_", " "),
      summary: text(detail.summary ?? detail.message, "Safe runtime metadata"),
      createdAt: text(entry.startedAt, summary.createdAt),
      durationMs: durationMs(entry.startedAt, completedAt),
      status:
        timelineKind(type) === "error"
          ? "error"
          : completedAt
            ? "success"
            : "pending",
      payload: safePayload(detail),
    };
  });
  const debug = record(value.debug);
  const debugEvents: TimelineEvent[] = [];
  for (const [collection, items] of Object.entries(debug)) {
    if (!Array.isArray(items)) continue;
    items.forEach((item, index) => {
      const detail = record(item);
      const type = text(
        detail.eventKind ?? detail.toolName ?? detail.status ?? collection,
        collection,
      );
      const createdAt =
        detail.occurredAt ??
        detail.startedAt ??
        detail.createdAt ??
        summary.createdAt;
      debugEvents.push({
        id: `debug:${collection}:${text(detail.id, String(index))}`,
        kind: timelineKind(`${collection} ${type}`),
        title: type.replaceAll("_", " "),
        summary: `${collection.replaceAll(/([A-Z])/gu, " $1").toLowerCase()} metadata`,
        createdAt: text(createdAt),
        durationMs: durationMs(
          detail.startedAt ?? detail.createdAt,
          detail.completedAt ?? detail.updatedAt,
        ),
        status: type.includes("fail") ? "error" : "info",
        ...(detail.inputTokens !== undefined ||
        detail.outputTokens !== undefined
          ? {
              tokens: {
                input: numeric(detail.inputTokens),
                output: numeric(detail.outputTokens),
              },
            }
          : {}),
        ...(detail.costMicrounits !== undefined
          ? { costUsd: numeric(detail.costMicrounits) / 1_000_000 }
          : {}),
        payload: safePayload(detail),
      });
    });
  }
  const settled = ["completed", "failed", "cancelled", "timed_out"].includes(
    summary.status,
  );
  return {
    ...summary,
    runId: latestRunId,
    agentVersion: numeric(value.agentVersion),
    startedAt: text(value.startedAt ?? latestRun.createdAt, summary.createdAt),
    completedAt: value.completedAt
      ? text(value.completedAt)
      : latestRun.settledAt
        ? text(latestRun.settledAt)
        : null,
    attempt: Math.max(
      1,
      ...(
        (Array.isArray(debug.modelInvocations)
          ? debug.modelInvocations
          : []) as unknown[]
      ).map((item) => numeric(record(item).attempt)),
    ),
    events: [...transcript, ...timeline, ...debugEvents].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    capabilities: {
      canCancel: !settled,
      canResume: false,
      canBranchReplay: false,
    },
    runs,
    transcript: Array.isArray(value.transcript)
      ? value.transcript.map(record)
      : [],
    pendingWork: Array.isArray(value.pendingWork)
      ? value.pendingWork.map(record)
      : [],
    debug,
  };
}

export class HttpConsoleApi implements ConsoleApi {
  readonly #baseUrl: string;
  readonly #getAccessToken: () => Promise<string | null>;
  #contextPromise: Promise<ProjectContext> | undefined;

  constructor(
    input: {
      readonly baseUrl?: string;
      readonly getAccessToken?: () => Promise<string | null>;
    } = {},
  ) {
    this.#baseUrl = (input.baseUrl ?? "/v1").replace(/\/$/u, "");
    this.#getAccessToken = input.getAccessToken ?? (async () => null);
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.#getAccessToken();
    const method = (init.method ?? "GET").toUpperCase();
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(UNSAFE_METHODS.has(method)
          ? { "idempotency-key": idempotencyKey() }
          : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const body = (await response.json()) as {
          readonly error?: { readonly message?: string };
          readonly message?: string;
        };
        message = body.error?.message ?? body.message ?? message;
      } catch {
        // The status remains actionable when a proxy returns a non-JSON body.
      }
      throw new HttpConsoleError(response.status, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async #loadContext(): Promise<ProjectContext> {
    try {
      return contextView(await this.#request<ContextResponse>("/context"));
    } catch (error) {
      if (!(error instanceof HttpConsoleError) || error.status !== 401)
        throw error;
      try {
        await this.#request("/auth/development/login", {
          method: "POST",
          body: "{}",
        });
      } catch (loginError) {
        if (loginError instanceof HttpConsoleError && loginError.status === 404)
          throw error;
        throw loginError;
      }
      return contextView(await this.#request<ContextResponse>("/context"));
    }
  }

  getContext = (): Promise<ProjectContext> => {
    if (!this.#contextPromise) {
      this.#contextPromise = this.#loadContext().catch((error: unknown) => {
        this.#contextPromise = undefined;
        throw error;
      });
    }
    return this.#contextPromise;
  };

  async #projectPath(path: string): Promise<string> {
    const context = await this.getContext();
    return `/projects/${encodeURIComponent(context.project.id)}${path}`;
  }

  async #projectRequest<T>(path: string, init?: RequestInit): Promise<T> {
    return this.#request<T>(await this.#projectPath(path), init);
  }

  #page<T extends { readonly status?: string; readonly createdAt?: string }>(
    response: CursorPage<T>,
    filters: ListFilters,
    searchable: (item: T) => string,
  ): PageResult<T> {
    if (
      response.page !== undefined &&
      response.pageSize !== undefined &&
      response.total !== undefined
    )
      return response as PageResult<T>;
    const term = filters.search?.trim().toLowerCase();
    const filtered = response.data.filter(
      (item) =>
        (!term || searchable(item).toLowerCase().includes(term)) &&
        (!filters.status || item.status === filters.status) &&
        (!filters.date || item.createdAt?.slice(0, 10) === filters.date),
    );
    const page = filters.page ?? 1;
    const pageSize = 10;
    return {
      data: filtered.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: filtered.length,
    };
  }

  listAgents = async (filters: ListFilters) => {
    const response =
      await this.#projectRequest<CursorPage<AgentSummary>>("/agents?limit=100");
    return this.#page(
      response,
      filters,
      (agent) =>
        `${agent.name} ${agent.key} ${agent.description} ${agent.model}`,
    );
  };

  getAgent = async (id: string): Promise<AgentDetail> => {
    const path = `/agents/${encodeURIComponent(id)}`;
    const agent = await this.#projectRequest<AgentDetail>(path);
    if (Array.isArray(agent.versions))
      return {
        ...agent,
        versions: agent.versions.map((version) => ({
          ...version,
          createdBy:
            version.createdBy ??
            text(
              (version as unknown as Record<string, unknown>)
                .createdByPrincipalId,
              "Unknown principal",
            ),
        })),
      };
    const versions = await this.#projectRequest<
      CursorPage<AgentDetail["versions"][number]>
    >(`${path}/versions?limit=100`);
    return { ...agent, versions: versions.data };
  };

  createAgent = async (input: Parameters<ConsoleApi["createAgent"]>[0]) => {
    const created = await this.#projectRequest<AgentSummary>("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        config: input.initialConfig,
      }),
    });
    return (await this.getAgent(created.id)) as AgentSummary;
  };

  publishAgentVersion = async (
    id: string,
    config: Parameters<ConsoleApi["publishAgentVersion"]>[1],
  ) => {
    await this.#projectRequest(`/agents/${encodeURIComponent(id)}/versions`, {
      method: "POST",
      body: JSON.stringify({ config }),
    });
    return this.getAgent(id);
  };

  listSessions = async (filters: ListFilters) => {
    const response = await this.#projectRequest<
      CursorPage<Record<string, unknown>>
    >("/sessions?limit=100");
    return this.#page(
      { ...response, data: response.data.map(sessionSummary) },
      filters,
      (session) => `${session.id} ${session.title} ${session.agentName}`,
    );
  };

  getSession = async (id: string) =>
    sessionDetail(
      await this.#projectRequest<Record<string, unknown>>(
        `/sessions/${encodeURIComponent(id)}`,
      ),
    );

  createSession = async (input: Parameters<ConsoleApi["createSession"]>[0]) => {
    const agent = await this.getAgent(input.agentId);
    const agentVersionId = agent.versions.find(
      (version) => version.version === agent.version,
    )?.id;
    if (!agentVersionId)
      throw new Error("Publish the agent before creating a session.");
    const created = await this.#projectRequest<Record<string, unknown>>(
      "/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          agentId: input.agentId,
          agentVersionId,
          title: input.title,
          initialMessage: input.initialMessage,
        }),
      },
    );
    const sessionId = String(created.id ?? "");
    if (!sessionId) throw new Error("The API did not return a session id.");
    if (
      typeof created.runId !== "string" &&
      typeof created.latestRunId !== "string"
    )
      await this.#createRun(sessionId, input.initialMessage);
    return this.getSession(sessionId);
  };

  async #createRun(sessionId: string, message: string): Promise<void> {
    await this.#projectRequest(
      `/sessions/${encodeURIComponent(sessionId)}/runs`,
      {
        method: "POST",
        body: JSON.stringify({ redactedInput: message }),
      },
    );
  }

  submitMessage = async (id: string, message: string) => {
    await this.#createRun(id, message);
    return this.getSession(id);
  };

  runSessionAction = async (
    id: string,
    action: Parameters<ConsoleApi["runSessionAction"]>[1],
  ) => {
    if (action !== "cancel")
      throw new Error(
        `${action.replaceAll("-", " ")} is deferred in the local MVP.`,
      );
    const session = await this.getSession(id);
    await this.#projectRequest(
      `/runs/${encodeURIComponent(session.runId)}/cancel`,
      {
        method: "POST",
        body: "{}",
      },
    );
    return this.getSession(id);
  };

  listPendingWork = async (): Promise<readonly PendingWork[]> => {
    const response =
      await this.#projectRequest<CursorPage<Record<string, unknown>>>(
        "/pending-work",
      );
    const toolWork: PendingWork[] = response.data
      .filter((tool) => tool.kind === "tool")
      .filter((tool) =>
        ["caller_pending", "caller_claimed"].includes(String(tool.stage)),
      )
      .map((tool) => ({
        kind: "tool",
        id: String(tool.id),
        runId: String(tool.runId),
        sessionId: String(tool.sessionId ?? ""),
        title: String(tool.sessionTitle ?? tool.title ?? "Managed session"),
        toolName: String(tool.toolName),
        stage: tool.stage as Extract<PendingWork, { kind: "tool" }>["stage"],
        safeArguments: (tool.safeArguments ?? {}) as Readonly<
          Record<string, unknown>
        >,
        claimedBy:
          tool.claimedBy === null || tool.claimedBy === undefined
            ? null
            : String(tool.claimedBy),
        claimFence: String(tool.claimFence ?? "0"),
        createdAt: String(tool.createdAt),
        expiresAt: String(
          tool.leaseExpiresAt ?? tool.expiresAt ?? tool.createdAt,
        ),
      }));
    const approvalWork: PendingWork[] = response.data
      .filter((approval) => approval.kind === "approval")
      .filter((approval) => String(approval.status) === "pending")
      .map((approval) => ({
        kind: "approval",
        id: String(approval.id),
        runId: String(approval.runId),
        sessionId: String(approval.sessionId ?? ""),
        title: String(
          approval.sessionTitle ?? approval.title ?? "Managed session",
        ),
        summary: String(approval.summary),
        status: "pending",
        createdAt: String(approval.createdAt),
        expiresAt: String(approval.expiresAt ?? approval.createdAt),
      }));
    return [...toolWork, ...approvalWork];
  };

  claimTool = async (id: string) => {
    await this.#projectRequest(`/tool-calls/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      body: JSON.stringify({ leaseMs: 120_000 }),
    });
  };

  submitToolResult = async (
    id: string,
    fence: string,
    result: Readonly<Record<string, unknown>>,
  ) => {
    await this.#projectRequest(`/tool-calls/${encodeURIComponent(id)}/result`, {
      method: "POST",
      body: JSON.stringify({ fence, safeResult: result }),
    });
  };

  decideApproval = async (
    id: string,
    decision: Parameters<ConsoleApi["decideApproval"]>[1],
  ) => {
    await this.#projectRequest(
      `/approvals/${encodeURIComponent(id)}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ status: decision }),
      },
    );
  };

  getSettings = async (): Promise<SettingsData> => {
    const context = await this.getContext();
    const [organization, members, apiKeys] = await Promise.all([
      this.#request<Record<string, unknown>>(
        `/organizations/${encodeURIComponent(context.organization.id)}`,
      ),
      this.#projectRequest<CursorPage<Record<string, unknown>>>(
        "/members?limit=100",
      ),
      this.#projectRequest<CursorPage<Record<string, unknown>>>(
        "/api-keys?limit=100",
      ),
    ]);
    return {
      organization: {
        name: String(organization.name ?? context.organization.name),
        slug: String(organization.slug ?? ""),
        createdAt: String(organization.createdAt ?? ""),
      },
      projects: context.projects.map((project) => ({ ...project, slug: "" })),
      members: members.data.map((member) => ({
        id: String(member.id ?? member.principalId),
        name: String(member.name ?? member.subject ?? "Project member"),
        email: String(member.email ?? member.subject ?? ""),
        role: String(member.role) as SettingsData["members"][number]["role"],
      })),
      apiKeys: apiKeys.data.map((key) => ({
        id: String(key.id),
        name: String(key.name),
        prefix: String(key.prefix),
        scopes: Array.isArray(key.scopes) ? key.scopes.map(String) : [],
        lastUsedAt: key.lastUsedAt ? String(key.lastUsedAt) : null,
      })),
      hosting: [],
    };
  };

  connectEvents(
    input: Parameters<ConsoleApi["connectEvents"]>[0],
  ): EventConnection {
    const controller = new AbortController();
    const close = () => controller.abort();
    input.signal?.addEventListener("abort", close, { once: true });
    void this.#streamEvents(input, controller.signal);
    return { close };
  }

  async #streamEvents(
    input: Parameters<ConsoleApi["connectEvents"]>[0],
    signal: AbortSignal,
  ): Promise<void> {
    let cursor = input.after;
    let retryMs = 750;
    while (!signal.aborted) {
      try {
        const token = await this.#getAccessToken();
        const response = await fetch(
          `${this.#baseUrl}${await this.#projectPath("/events")}`,
          {
            credentials: "include",
            headers: {
              accept: "text/event-stream",
              ...(cursor ? { "last-event-id": cursor } : {}),
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            signal,
          },
        );
        if (!response.ok || !response.body)
          throw new Error(`Event stream failed (${response.status})`);
        retryMs = 750;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const parsed = parseSseFrames(buffer);
          buffer = parsed.rest;
          for (const frame of parsed.frames) {
            const event = parseProductEvent(frame);
            if (event) input.onEvent(event);
            if (frame.id) {
              cursor = frame.id;
              input.onCursor(frame.id);
            }
          }
        }
      } catch (error) {
        if (!signal.aborted)
          input.onError(
            error instanceof Error ? error : new Error("Event stream failed"),
          );
      }
      if (!signal.aborted)
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  }
}
