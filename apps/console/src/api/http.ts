import type { ConsoleApi, EventConnection, ListFilters } from "./types";
import { parseProductEvent, parseSseFrames } from "./sse";

export class HttpConsoleApi implements ConsoleApi {
  readonly #baseUrl: string;
  readonly #getAccessToken: () => Promise<string | null>;

  constructor(
    input: {
      readonly baseUrl?: string;
      readonly getAccessToken?: () => Promise<string | null>;
    } = {},
  ) {
    this.#baseUrl = input.baseUrl ?? "/api";
    this.#getAccessToken = input.getAccessToken ?? (async () => null);
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.#getAccessToken();
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return (await response.json()) as T;
  }

  #query(filters: ListFilters): string {
    const query = new URLSearchParams();
    if (filters.search) query.set("search", filters.search);
    if (filters.status) query.set("status", filters.status);
    if (filters.date) query.set("date", filters.date);
    if (filters.page) query.set("page", String(filters.page));
    const value = query.toString();
    return value ? `?${value}` : "";
  }

  getContext = () =>
    this.#request<Awaited<ReturnType<ConsoleApi["getContext"]>>>("/context");
  listAgents = (filters: ListFilters) =>
    this.#request<Awaited<ReturnType<ConsoleApi["listAgents"]>>>(
      `/agents${this.#query(filters)}`,
    );
  getAgent = (id: string) =>
    this.#request<Awaited<ReturnType<ConsoleApi["getAgent"]>>>(
      `/agents/${encodeURIComponent(id)}`,
    );
  createAgent = (input: Parameters<ConsoleApi["createAgent"]>[0]) =>
    this.#request<Awaited<ReturnType<ConsoleApi["createAgent"]>>>("/agents", {
      method: "POST",
      body: JSON.stringify(input),
    });
  publishAgentVersion = (
    id: string,
    config: Parameters<ConsoleApi["publishAgentVersion"]>[1],
  ) =>
    this.#request<Awaited<ReturnType<ConsoleApi["publishAgentVersion"]>>>(
      `/agents/${encodeURIComponent(id)}/versions`,
      { method: "POST", body: JSON.stringify({ config }) },
    );
  listSessions = (filters: ListFilters) =>
    this.#request<Awaited<ReturnType<ConsoleApi["listSessions"]>>>(
      `/sessions${this.#query(filters)}`,
    );
  getSession = (id: string) =>
    this.#request<Awaited<ReturnType<ConsoleApi["getSession"]>>>(
      `/sessions/${encodeURIComponent(id)}`,
    );
  createSession = (input: Parameters<ConsoleApi["createSession"]>[0]) =>
    this.#request<Awaited<ReturnType<ConsoleApi["createSession"]>>>(
      "/sessions",
      { method: "POST", body: JSON.stringify(input) },
    );
  runSessionAction = (
    id: string,
    action: Parameters<ConsoleApi["runSessionAction"]>[1],
  ) =>
    this.#request<Awaited<ReturnType<ConsoleApi["runSessionAction"]>>>(
      `/sessions/${encodeURIComponent(id)}/actions`,
      { method: "POST", body: JSON.stringify({ action }) },
    );
  listPendingWork = () =>
    this.#request<Awaited<ReturnType<ConsoleApi["listPendingWork"]>>>(
      "/pending-work",
    );
  claimTool = (id: string) =>
    this.#request<void>(`/pending-work/tools/${encodeURIComponent(id)}/claim`, {
      method: "POST",
    });
  submitToolResult = (id: string, result: Readonly<Record<string, unknown>>) =>
    this.#request<void>(
      `/pending-work/tools/${encodeURIComponent(id)}/result`,
      { method: "POST", body: JSON.stringify({ result }) },
    );
  decideApproval = (
    id: string,
    decision: Parameters<ConsoleApi["decideApproval"]>[1],
  ) =>
    this.#request<void>(`/pending-work/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  getSettings = () =>
    this.#request<Awaited<ReturnType<ConsoleApi["getSettings"]>>>("/settings");

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
        const response = await fetch(`${this.#baseUrl}/events`, {
          headers: {
            accept: "text/event-stream",
            ...(cursor ? { "last-event-id": cursor } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          signal,
        });
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
            if (frame.id) {
              cursor = frame.id;
              input.onCursor(frame.id);
            }
            const event = parseProductEvent(frame);
            if (event) input.onEvent(event);
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
