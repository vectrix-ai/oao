import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpConsoleApi } from "../src/api/http";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const CONTEXT = {
  principal: {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "human",
    subject: "development-user",
    scopes: ["*"],
  },
  organization: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Local organization",
  },
  project: { id: PROJECT_ID, name: "Local project" },
  organizations: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Local organization",
    },
  ],
  projects: [{ id: PROJECT_ID, name: "Local project" }],
  activeModelPresets: ["local-default"],
  authProvider: "development",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("HTTP console adapter", () => {
  it("maps authenticated context and includes cookie credentials", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(CONTEXT));
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi({ baseUrl: "/v1" });
    await expect(api.getContext()).resolves.toMatchObject({
      project: { id: PROJECT_ID },
      currentPrincipal: {
        id: CONTEXT.principal.id,
        scopes: ["*"],
        displayName: "development user",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/context",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("bootstraps a development session once after an unauthenticated context", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ principal: CONTEXT.principal }))
      .mockResolvedValueOnce(jsonResponse(CONTEXT));
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi();
    await expect(api.getContext()).resolves.toMatchObject({
      project: { id: PROJECT_ID },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/context",
      "/v1/auth/development/login",
      "/v1/context",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "idempotency-key": expect.any(String),
        }),
      }),
    );
  });

  it("scopes project requests and adds a unique idempotency key to mutations", async () => {
    const agent = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Local agent",
      key: "local-agent-a1b2c3d4",
      description: "Local",
      model: "local-default",
      status: "published",
      version: 1,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      versions: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(jsonResponse(agent))
      .mockResolvedValueOnce(jsonResponse(agent));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi();

    await api.createAgent({
      name: "Local agent",
      description: "Local",
      initialConfig: {
        systemPrompt: "Act as a deterministic local managed agent.",
        modelPreset: "local-default",
        tools: [],
        sandbox: { enabled: false, network: "none" },
        limits: { maxTurns: 32, timeoutMs: 60_000 },
      },
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/agents`,
    );
    const createInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(createInit.headers).toEqual(
      expect.objectContaining({ "idempotency-key": expect.any(String) }),
    );
    expect(JSON.parse(String(createInit.body))).toMatchObject({
      name: "Local agent",
      config: { modelPreset: "local-default" },
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/agents/${agent.id}`,
    );
  });

  it("includes cookies and bearer headers on project-scoped resumable SSE", async () => {
    let aborted = false;
    const fetchMock = vi.fn(
      (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(url) === "/v1/context")
          return Promise.resolve(jsonResponse(CONTEXT));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi({
      getAccessToken: async () => "machine-token",
    });

    const connection = api.connectEvents({
      after: "djE6NDI",
      onEvent: vi.fn(),
      onCursor: vi.fn(),
      onError: vi.fn(),
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`/v1/projects/${PROJECT_ID}/events`);
    expect(String(url)).not.toContain("machine-token");
    expect(init).toEqual(
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          accept: "text/event-stream",
          authorization: "Bearer machine-token",
          "last-event-id": "djE6NDI",
        }),
      }),
    );
    connection.close();
    await waitFor(() => expect(aborted).toBe(true));
  });
});
