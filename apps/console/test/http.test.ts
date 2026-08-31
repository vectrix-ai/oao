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

  it("prefers authenticated display metadata over the internal principal subject", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ...CONTEXT,
        principal: {
          ...CONTEXT.principal,
          displayName: "Ben Selleslagh",
        },
        authProvider: "workos",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HttpConsoleApi().getContext()).resolves.toMatchObject({
      currentPrincipal: {
        subject: "development-user",
        displayName: "Ben Selleslagh",
      },
      authProvider: "workos",
    });
  });

  it("loads organization, project, and WorkOS-backed member settings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(
        jsonResponse({
          id: CONTEXT.organization.id,
          name: "Development organization",
          slug: "development",
          createdAt: "2026-08-20T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: PROJECT_ID,
              name: "Default project",
              slug: "default",
              createdAt: "2026-08-20T00:00:00.000Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: CONTEXT.principal.id,
              principalId: CONTEXT.principal.id,
              subject: "development-user",
              displayName: "Ben Selleslagh",
              email: "developer@example.test",
              role: "owner",
              scopes: ["*"],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HttpConsoleApi().getSettings()).resolves.toMatchObject({
      organization: {
        id: CONTEXT.organization.id,
        slug: "development",
      },
      projects: [{ id: PROJECT_ID, slug: "default", current: true }],
      members: [
        {
          name: "Ben Selleslagh",
          subject: "development-user",
          email: "developer@example.test",
          current: true,
        },
      ],
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/context",
      `/v1/organizations/${CONTEXT.organization.id}`,
      "/v1/projects?limit=100",
      `/v1/projects/${PROJECT_ID}/members?limit=100`,
      `/v1/projects/${PROJECT_ID}/api-keys?limit=100`,
    ]);
  });

  it("creates, updates, and removes project members", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi();

    await api.addMember({
      subject: "reviewer@example.test",
      role: "viewer",
      scopes: ["agent:read"],
    });
    await api.updateMemberRole("member/one", "member");
    await api.removeMember("member/one");

    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `/v1/projects/${PROJECT_ID}/members`,
      `/v1/projects/${PROJECT_ID}/members/member%2Fone`,
      `/v1/projects/${PROJECT_ID}/members/member%2Fone`,
    ]);
    expect(
      (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.method,
    ).toBe("POST");
    expect(
      (fetchMock.mock.calls[2]?.[1] as RequestInit | undefined)?.method,
    ).toBe("PATCH");
    expect(
      (fetchMock.mock.calls[3]?.[1] as RequestInit | undefined)?.method,
    ).toBe("DELETE");
  });

  it("archives model presets and removes provider connections with DELETE requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi();

    await api.archiveModelPreset("preset/one");
    await api.removeModelProvider("provider/one");

    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `/v1/projects/${PROJECT_ID}/model-presets/preset%2Fone`,
      `/v1/projects/${PROJECT_ID}/model-providers/provider%2Fone`,
    ]);
    for (const call of fetchMock.mock.calls.slice(1)) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe("DELETE");
      expect(new Headers(init.headers).get("idempotency-key")).toBeTruthy();
    }
  });

  it("deletes an agent with an idempotent DELETE request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValue(jsonResponse({ id: "agent/one", deleted: true }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi();

    await api.deleteAgent("agent/one");

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/agents/agent%2Fone`,
    );
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).get("idempotency-key")).toBeTruthy();
  });

  it("disables and removes Skills with idempotent PATCH and DELETE requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(jsonResponse({ id: "skill/one", enabled: false }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "skill/one", disabledAt: "2026-08-30T00:00:00Z" }),
      )
      .mockResolvedValue(jsonResponse({ id: "skill/one", deleted: true }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi();

    await api.setSkillEnabled("skill/one", false);
    await api.deleteSkill("skill/one");

    const calls = fetchMock.mock.calls.slice(1);
    expect(calls.map(([url]) => url)).toEqual([
      `/v1/projects/${PROJECT_ID}/skills/skill%2Fone`,
      `/v1/projects/${PROJECT_ID}/skills/skill%2Fone`,
      `/v1/projects/${PROJECT_ID}/skills/skill%2Fone`,
    ]);
    const patch = calls[0]?.[1] as RequestInit;
    expect(patch.method).toBe("PATCH");
    expect(patch.body).toBe(JSON.stringify({ enabled: false }));
    expect(new Headers(patch.headers).get("idempotency-key")).toBeTruthy();
    expect((calls[1]?.[1] as RequestInit | undefined)?.method ?? "GET").toBe(
      "GET",
    );
    const remove = calls[2]?.[1] as RequestInit;
    expect(remove.method).toBe("DELETE");
    expect(new Headers(remove.headers).get("idempotency-key")).toBeTruthy();
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

  it("uses the configured development provider without an unauthenticated probe", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ principal: CONTEXT.principal }))
      .mockResolvedValueOnce(jsonResponse(CONTEXT));
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi({ authProvider: "development" });
    await expect(api.getContext()).resolves.toMatchObject({
      project: { id: PROJECT_ID },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/auth/development/login",
      "/v1/context",
    ]);
  });

  it("maps delegated parent metadata from session-list responses", async () => {
    const createdAt = "2026-08-21T07:48:00.000Z";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "35891f51-4956-4356-8339-000000000001",
              title: "Delegated: shipment extraction",
              parentSessionId: "6e90d649-a536-4356-98f6-000000000001",
              delegateKey: "shipment-extraction",
              status: "completed",
              agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              agentName: "Shipment extractor",
              inputTokens: 850,
              outputTokens: 17,
              cacheReadTokens: 640,
              cacheWriteTokens: 128,
              costMicrounits: 0,
              costProvenance: "estimated",
              createdAt,
              lastActivityAt: createdAt,
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HttpConsoleApi().listSessions({});

    expect(result.data[0]).toMatchObject({
      parentSessionId: "6e90d649-a536-4356-98f6-000000000001",
      delegateKey: "shipment-extraction",
      cacheReadTokens: 640,
      cacheWriteTokens: 128,
    });
  });

  it("starts WorkOS hosted sign-in when development login is unavailable", async () => {
    const redirectUrl =
      "https://api.workos.com/user_management/authorize?client_id=client_123";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({ redirectUrl }));
    const navigateTo = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi({ navigateTo });
    await expect(api.getContext()).rejects.toThrow(
      "Redirecting to WorkOS sign in.",
    );
    await expect(api.getContext()).rejects.toThrow(
      "Redirecting to WorkOS sign in.",
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/context",
      "/v1/auth/development/login",
      "/v1/auth/login",
    ]);
    expect(navigateTo).toHaveBeenCalledWith(redirectUrl);
    expect(navigateTo).toHaveBeenCalledTimes(1);
  });

  it("uses the configured WorkOS provider without probing development login", async () => {
    const redirectUrl =
      "https://api.workos.com/user_management/authorize?client_id=client_123";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ redirectUrl }));
    const navigateTo = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi({
      authProvider: "workos",
      navigateTo,
    });
    await expect(api.getContext()).rejects.toThrow(
      "Redirecting to WorkOS sign in.",
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/context",
      "/v1/auth/refresh",
      "/v1/auth/login",
    ]);
    expect(navigateTo).toHaveBeenCalledWith(redirectUrl);
  });

  it("silently refreshes an expired WorkOS session and retries the request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ expiresAt: "2026-08-26" }))
      .mockResolvedValueOnce(
        jsonResponse({ ...CONTEXT, authProvider: "workos" }),
      );
    const navigateTo = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi({
      authProvider: "workos",
      navigateTo,
    });
    await expect(api.getContext()).resolves.toMatchObject({
      project: { id: PROJECT_ID },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/context",
      "/v1/auth/refresh",
      "/v1/context",
    ]);
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("shares one WorkOS refresh across concurrent expired requests", async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    let expiredResponses = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/v1/context")
        return jsonResponse({ ...CONTEXT, authProvider: "workos" });
      if (url === "/v1/auth/refresh") return refreshResponse;
      if (url.includes("/agents?") || url.includes("/skills?")) {
        expiredResponses += 1;
        if (expiredResponses <= 2) return jsonResponse({}, 401);
        return jsonResponse({
          data: [],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi({ authProvider: "workos" });

    await api.getContext();
    const requests = Promise.all([api.listAgents({}), api.listSkills({})]);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/v1/auth/refresh"),
      ).toHaveLength(1),
    );
    resolveRefresh?.(jsonResponse({ expiresAt: "2026-08-26" }));

    await expect(requests).resolves.toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/v1/auth/refresh"),
    ).toHaveLength(1);
  });

  it("retries a transient WorkOS refresh failure on the next request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Authentication provider is unavailable" },
          503,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ expiresAt: "2026-08-26" }))
      .mockResolvedValueOnce(
        jsonResponse({ ...CONTEXT, authProvider: "workos" }),
      );
    const navigateTo = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi({
      authProvider: "workos",
      navigateTo,
    });

    await expect(api.getContext()).rejects.toThrow(
      "Authentication provider is unavailable",
    );
    await expect(api.getContext()).resolves.toMatchObject({
      project: { id: PROJECT_ID },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/context",
      "/v1/auth/refresh",
      "/v1/context",
      "/v1/auth/refresh",
      "/v1/context",
    ]);
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("starts a fresh WorkOS login when a stale session has the wrong origin", async () => {
    const redirectUrl =
      "https://api.workos.com/user_management/authorize?client_id=client_123";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "forbidden",
              message: "Request origin is not allowed",
            },
          },
          403,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ redirectUrl }));
    const navigateTo = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi({
      authProvider: "workos",
      navigateTo,
    });
    await expect(api.getContext()).rejects.toThrow(
      "Redirecting to WorkOS sign in.",
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/context",
      "/v1/auth/login",
    ]);
    expect(navigateTo).toHaveBeenCalledWith(redirectUrl);
  });

  it("retries WorkOS login after a transient provider failure", async () => {
    const redirectUrl =
      "https://api.workos.com/user_management/authorize?client_id=client_123";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Authentication provider is unavailable" },
          503,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ redirectUrl }));
    const navigateTo = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi({
      authProvider: "workos",
      navigateTo,
    });
    await expect(api.getContext()).rejects.toThrow(
      "Authentication provider is unavailable",
    );
    await expect(api.getContext()).rejects.toThrow(
      "Redirecting to WorkOS sign in.",
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/context",
      "/v1/auth/refresh",
      "/v1/auth/login",
      "/v1/context",
      "/v1/auth/refresh",
      "/v1/auth/login",
    ]);
    expect(navigateTo).toHaveBeenCalledWith(redirectUrl);
  });

  it("does not turn an authorization failure into a new login", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "forbidden",
              message: "Principal lacks the required scope",
            },
          },
          403,
        ),
      );
    const navigateTo = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi({
      authProvider: "workos",
      navigateTo,
    });
    await expect(api.listAgents({})).rejects.toThrow(
      "Principal lacks the required scope",
    );
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("clears the local session and follows the WorkOS logout redirect", async () => {
    const redirectUrl = "https://authkit.example.test/logout";
    const fetchMock = vi.fn(async () => jsonResponse({ redirectUrl }));
    const navigateTo = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi({ navigateTo });
    await api.logout();

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          "idempotency-key": expect.any(String),
        }),
      }),
    );
    expect(navigateTo).toHaveBeenCalledWith(redirectUrl);
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
        harnessOperations: [
          {
            key: "verify_order",
            description: "Verify an extracted order against shared documents.",
            instructions:
              "Read the shared documents, verify each field, and return the validated result.",
            resultSchema: {
              type: "object",
              properties: { valid: { type: "boolean" } },
              required: ["valid"],
              additionalProperties: false,
            },
            timeoutMs: 120000,
          },
        ],
        sandbox: {
          enabled: false,
          provider: "local-fake",
          network: "none",
          capabilities: ["filesystem_read", "filesystem_write", "shell"],
        },
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
      config: {
        modelPreset: "local-default",
        harnessOperations: [
          expect.objectContaining({ key: "verify_order", timeoutMs: 120000 }),
        ],
      },
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/agents/${agent.id}`,
    );
  });

  it("lists storage objects with encoded prefix and cursor parameters", async () => {
    const listing = {
      providerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      prefix: "run-files/runs/run-1/",
      folders: [],
      objects: [
        {
          key: "run-files/runs/run-1/id-1/input.xlsx",
          sizeBytes: 12,
          lastModifiedAt: "2026-08-20T19:21:49.000Z",
        },
      ],
      truncated: false,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(jsonResponse(listing));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HttpConsoleApi().listStorageObjects(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      { prefix: "run-files/runs/run-1/", cursor: "cursor-1" },
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/storage-providers/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/objects?prefix=run-files%2Fruns%2Frun-1%2F&cursor=cursor-1`,
    );
    expect(result).toEqual(listing);
  });

  it("reads and creates project model presets through the public API", async () => {
    const preset = {
      id: "44444444-4444-4444-8444-444444444444",
      organizationId: CONTEXT.organization.id,
      projectId: PROJECT_ID,
      key: "claude-sonnet-4-6-zdr-v1",
      displayName: "Claude Sonnet 4.6 (zero retention)",
      origin: "project",
      providerId: "55555555-5555-4555-8555-555555555555",
      providerType: "openrouter",
      model: "openrouter/anthropic/claude-sonnet-4.6",
      routing: { zeroDataRetention: true },
      settings: null,
      hosted: true,
      available: true,
      createdByPrincipalId: CONTEXT.principal.id,
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(
        jsonResponse({ data: [preset], credentialEncryptionConfigured: true }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [],
          providerId: preset.providerId,
          providerType: "openrouter",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(preset));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi();

    await expect(api.listModelPresets()).resolves.toEqual({
      data: [preset],
      credentialEncryptionConfigured: true,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/model-presets?limit=200`,
    );

    await api.listModelCatalog(preset.providerId, "sonnet 4.6");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/model-catalog?limit=200&providerId=${preset.providerId}&search=sonnet%204.6`,
    );

    const input = {
      key: preset.key,
      displayName: preset.displayName,
      providerId: preset.providerId,
      model: preset.model,
      routing: { zeroDataRetention: true } as const,
    };
    await api.createModelPreset(input);
    const createInit = fetchMock.mock.calls[3]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/model-presets`,
    );
    expect(createInit.method).toBe("POST");
    expect(createInit.credentials).toBe("include");
    expect(createInit.headers).toEqual(
      expect.objectContaining({ "idempotency-key": expect.any(String) }),
    );
    expect(JSON.parse(String(createInit.body))).toEqual(input);
    // No provider credential is ever sent from the browser.
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(
      /OPENROUTER_API_KEY|apiKey/u,
    );
  });

  it("creates a project API key and keeps its one-time secret out of list state", async () => {
    const created = {
      id: "66666666-6666-4666-8666-666666666666",
      name: "Session integration",
      prefix: "a1b2c3d4e5f6",
      scopes: ["session:read", "session:write", "run:create", "run:read"],
      shown: true,
      secret: "oao_a1b2c3d4e5f6_one-time-secret-value",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(jsonResponse(created));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi();

    await expect(
      api.createApiKey({ name: created.name, scopes: created.scopes }),
    ).resolves.toEqual({ ...created, lastUsedAt: null });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/api-keys`,
    );
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(
      expect.objectContaining({ "idempotency-key": expect.any(String) }),
    );
    expect(JSON.parse(String(init.body))).toEqual({
      name: created.name,
      scopes: created.scopes,
    });
  });

  it("maps reasoning and full sandbox calls into transcript activity", async () => {
    const createdAt = "2026-08-20T19:21:48.150Z";
    const session = {
      id: "77777777-7777-4777-8777-777777777777",
      title: "File test",
      status: "completed",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentName: "Sandbox agent",
      agentVersion: 1,
      latestRunId: "88888888-8888-4888-8888-888888888888",
      createdAt,
      lastActivityAt: createdAt,
      runs: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          state: "completed",
          createdAt,
          settledAt: "2026-08-20T19:21:49.000Z",
        },
      ],
      transcript: [
        {
          id: "message-1",
          runId: "88888888-8888-4888-8888-888888888888",
          role: "user",
          redactedContent: "Create the file.",
          files: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
              name: "input.xlsx",
              contentType:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              sizeBytes: 12,
              sha256: "a".repeat(64),
              storageProviderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              objectKey:
                "run-files/runs/88888888-8888-4888-8888-888888888888/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab/input.xlsx",
            },
          ],
          createdAt: "2026-08-20T19:21:40.000Z",
        },
      ],
      timeline: [],
      debug: {
        productEvents: [
          {
            id: "harness-event-1",
            aggregateId: "88888888-8888-4888-8888-888888888888",
            eventKind: "harness.operation_completed",
            publicPayload: {
              operationKey: "extract_shipment",
              toolCallId: "tool-call-1",
              taskCharacters: 184,
              timeoutMs: 120000,
              durationMs: 842,
              resultValidated: true,
            },
            occurredAt: "2026-08-20T19:21:44.000Z",
          },
          {
            id: "model-event-2",
            aggregateId: "88888888-8888-4888-8888-888888888888",
            eventKind: "model.invocation_failed",
            publicPayload: {
              model: "openrouter/test",
              provider: "openrouter",
              inputTokens: 12,
              outputTokens: 3,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costMicrounits: 0,
              finishReason: "error",
              providerFinishReason: "content_filter",
              errorExplanation:
                "The provider stopped the response because its content filter was triggered, so OAO treated the partial response as incomplete and failed the run.",
            },
            occurredAt: "2026-08-20T19:21:45.300Z",
          },
        ],
        modelInvocations: [
          {
            id: "model-1",
            runId: "88888888-8888-4888-8888-888888888888",
            status: "completed",
            attempt: 1,
            modelKey: "openrouter/test",
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 6,
            cacheWriteTokens: 2,
            safeResponse: {
              finishReason: "toolUse",
              thinking: "I should create a CSV with three columns.",
            },
            startedAt: "2026-08-20T19:21:45.000Z",
            completedAt: "2026-08-20T19:21:45.000Z",
          },
          {
            id: "model-2",
            runId: "88888888-8888-4888-8888-888888888888",
            status: "failed",
            attempt: 2,
            modelKey: "openrouter/test",
            inputTokens: 12,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            safeResponse: {
              finishReason: "error",
              providerFinishReason: "content_filter",
              errorExplanation:
                "The provider stopped the response because its content filter was triggered, so OAO treated the partial response as incomplete and failed the run.",
            },
            startedAt: "2026-08-20T19:21:45.100Z",
            completedAt: "2026-08-20T19:21:45.300Z",
          },
        ],
        toolCalls: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac",
            runId: "88888888-8888-4888-8888-888888888888",
            toolName: "lookup_customer",
            owner: "platform",
            stage: "result_committed",
            safeArguments: { customerRef: "NW-4831" },
            safeResult: {
              version: 1,
              status: "success",
              value: { matches: 2, accountStatus: "active" },
            },
            createdAt: "2026-08-20T19:21:46.000Z",
            updatedAt: "2026-08-20T19:21:46.400Z",
          },
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad",
            runId: "88888888-8888-4888-8888-888888888888",
            toolName: "create_refund",
            owner: "caller",
            stage: "result_submitted",
            safeArguments: { chargeId: "charge-1" },
            safeResult: {
              version: 1,
              status: "failure",
              error: { code: "tool_failed", message: "Refund rejected" },
            },
            createdAt: "2026-08-20T19:21:47.000Z",
            updatedAt: "2026-08-20T19:21:47.300Z",
          },
        ],
        sandboxCommands: [
          {
            id: "99999999-9999-4999-8999-999999999999",
            runId: "88888888-8888-4888-8888-888888888888",
            state: "completed",
            toolName: "write",
            path: "/root/test.csv",
            safeCommand: {
              toolName: "write",
              arguments: {
                path: "/root/test.csv",
                content: "id,name\n1,Alice",
              },
            },
            safeResult: {
              exitCode: 0,
              output: { content: [{ type: "text", text: "Wrote 18 bytes" }] },
            },
            createdAt,
            startedAt: createdAt,
            completedAt: "2026-08-20T19:21:48.302Z",
          },
        ],
        workspaceBackups: [
          {
            storageProviderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            objectKey: "workspace-backups/thread/workspace.tar.gz",
            generation: 2,
            backedUpAt: "2026-08-20T19:21:49.000Z",
            manifestState: "available",
            files: [
              {
                name: "input.xlsx",
                path: ".oao/attachments/88888888-8888-4888-8888-888888888888/input.xlsx",
                sizeBytes: 12,
              },
              { name: "test.csv", path: "test.csv", sizeBytes: 18 },
            ],
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(jsonResponse(session));
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi();
    const detail = await api.getSession(session.id);
    expect(detail.events).toContainEqual(
      expect.objectContaining({
        id: "harness:tool-call-1",
        kind: "tool",
        source: "activity",
        title: "Harness · extract_shipment",
        summary: "validated result",
        durationMs: 842,
        status: "success",
        harness: expect.objectContaining({
          operationKey: "extract_shipment",
          toolCallId: "tool-call-1",
          phase: "completed",
          modelTurns: 0,
          toolSteps: 0,
          attribution: "complete",
          steps: [],
        }),
        payload: expect.objectContaining({
          rendered: expect.objectContaining({
            operationKey: "extract_shipment",
            phase: "completed",
            toolCallId: "tool-call-1",
            taskCharacters: 184,
            timeoutMs: 120000,
            durationMs: 842,
            resultValidated: true,
            modelTurns: 0,
            toolSteps: 0,
          }),
          raw: null,
          redacted: true,
        }),
      }),
    );
    expect(detail.events).toContainEqual(
      expect.objectContaining({
        kind: "reasoning",
        tokens: { input: 10, output: 4, cacheRead: 6, cacheWrite: 2 },
      }),
    );
    expect(detail.events).toContainEqual(
      expect.objectContaining({
        id: "debug:productEvents:model-event-2",
        kind: "error",
        source: "runtime",
        title: "model.invocation failed",
        summary:
          "The provider stopped the response because its content filter was triggered, so OAO treated the partial response as incomplete and failed the run.",
        status: "error",
        payload: expect.objectContaining({
          rendered: {
            model: "openrouter/test",
            provider: "openrouter",
            finishReason: "error",
            providerFinishReason: "content_filter",
            errorExplanation:
              "The provider stopped the response because its content filter was triggered, so OAO treated the partial response as incomplete and failed the run.",
          },
        }),
      }),
    );
    expect(detail.events).toContainEqual(
      expect.objectContaining({
        kind: "reasoning",
        status: "error",
        payload: expect.objectContaining({
          rendered: expect.objectContaining({
            finishReason: "error",
            providerFinishReason: "content_filter",
            errorExplanation:
              "The provider stopped the response because its content filter was triggered, so OAO treated the partial response as incomplete and failed the run.",
          }),
        }),
      }),
    );
    expect(detail.events).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        source: "activity",
        title: "write",
        summary: "/root/test.csv",
        status: "success",
        durationMs: 152,
        payload: expect.objectContaining({
          redacted: false,
          rendered: expect.objectContaining({
            arguments: expect.objectContaining({
              content: "id,name\n1,Alice",
            }),
            result: expect.any(Object),
          }),
        }),
      }),
    );
    expect(detail.events).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        source: "activity",
        title: "lookup customer",
        status: "success",
        payload: expect.objectContaining({
          rendered: expect.objectContaining({
            arguments: { customerRef: "NW-4831" },
            result: { matches: 2, accountStatus: "active" },
            resultStatus: "success",
          }),
        }),
      }),
    );
    expect(detail.events).toContainEqual(
      expect.objectContaining({
        title: "create refund",
        status: "error",
        payload: expect.objectContaining({
          rendered: expect.objectContaining({
            result: { code: "tool_failed", message: "Refund rejected" },
            resultStatus: "failure",
          }),
        }),
      }),
    );
    expect(detail.workspaceFiles).toEqual([
      {
        name: "input.xlsx",
        path: ".oao/attachments/88888888-8888-4888-8888-888888888888/input.xlsx",
        sizeBytes: 12,
        uploaded: true,
        backedUp: true,
        backedUpAt: "2026-08-20T19:21:49.000Z",
        storageProviderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        objectKey:
          "run-files/runs/88888888-8888-4888-8888-888888888888/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab/input.xlsx",
      },
      {
        name: "test.csv",
        path: "test.csv",
        sizeBytes: 18,
        backedUp: true,
        backedUpAt: "2026-08-20T19:21:49.000Z",
        storageProviderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        objectKey: "workspace-backups/thread/workspace.tar.gz",
      },
    ]);
    expect(detail.events).toContainEqual(
      expect.objectContaining({
        kind: "reasoning",
        source: "activity",
        title: "Reasoning",
        summary: "I should create a CSV with three columns.",
        durationMs: 5_000,
        payload: expect.objectContaining({ redacted: false }),
      }),
    );
  });

  it("orders ordinary session activity chronologically and treats a running sandbox as ready", async () => {
    const runId = "88888888-8888-4888-8888-888888888880";
    const session = {
      id: "77777777-7777-4777-8777-777777777770",
      title: "Ordered file test",
      status: "completed",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentName: "Sandbox agent",
      agentVersion: 1,
      latestRunId: runId,
      createdAt: "2026-08-20T10:00:00.000Z",
      lastActivityAt: "2026-08-20T10:00:05.000Z",
      runs: [
        {
          id: runId,
          state: "completed",
          createdAt: "2026-08-20T10:00:00.000Z",
          settledAt: "2026-08-20T10:00:05.000Z",
        },
      ],
      transcript: [
        {
          id: "message-user",
          runId,
          role: "user",
          redactedContent: "Create the file.",
          createdAt: "2026-08-20T10:00:00.000Z",
        },
        {
          id: "message-assistant",
          runId,
          role: "assistant",
          redactedContent: "The file is ready.",
          createdAt: "2026-08-20T10:00:05.000Z",
        },
      ],
      timeline: [],
      debug: {
        sandboxes: [
          {
            id: "sandbox-1",
            state: "running",
            createdAt: "2026-08-20T10:00:00.500Z",
            updatedAt: "2026-08-20T10:00:01.000Z",
          },
        ],
        modelInvocations: [
          {
            id: "model-1",
            runId,
            status: "completed",
            attempt: 1,
            modelKey: "openai/gpt-5.6-terra",
            startedAt: "2026-08-20T10:00:01.000Z",
            completedAt: "2026-08-20T10:00:02.000Z",
          },
        ],
        sandboxCommands: [
          {
            id: "command-1",
            runId,
            state: "completed",
            toolName: "write",
            safeCommand: {
              toolName: "write",
              arguments: { path: "/root/test.txt", content: "ready" },
            },
            safeResult: { exitCode: 0, output: "Wrote 5 bytes" },
            createdAt: "2026-08-20T10:00:03.000Z",
            startedAt: "2026-08-20T10:00:03.000Z",
            completedAt: "2026-08-20T10:00:04.000Z",
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(jsonResponse(session));
    vi.stubGlobal("fetch", fetchMock);

    const detail = await new HttpConsoleApi().getSession(session.id);

    expect(detail.events.map((event) => event.id)).toEqual([
      "message-user",
      "debug:sandboxes:sandbox-1",
      "debug:modelInvocations:model-1",
      "debug:sandboxCommands:command-1",
      "message-assistant",
    ]);
    expect(detail.events[1]).toEqual(
      expect.objectContaining({
        id: "debug:sandboxes:sandbox-1",
        status: "success",
      }),
    );
  });

  it("consolidates one Harness invocation and its internal turns into one event", async () => {
    const runId = "88888888-8888-4888-8888-888888888889";
    const session = {
      id: "77777777-7777-4777-8777-777777777779",
      title: "Harness test",
      status: "completed",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentName: "Harness agent",
      agentVersion: 1,
      latestRunId: runId,
      createdAt: "2026-08-20T10:00:00.000Z",
      lastActivityAt: "2026-08-20T10:00:05.000Z",
      runs: [
        {
          id: runId,
          state: "completed",
          createdAt: "2026-08-20T10:00:00.000Z",
          settledAt: "2026-08-20T10:00:05.000Z",
        },
      ],
      transcript: [],
      timeline: [],
      debug: {
        productEvents: [
          {
            id: "harness-start",
            eventKind: "harness.operation_started",
            publicPayload: {
              operationKey: "extract_shipment",
              toolCallId: "tool-call-harness",
              taskCharacters: 126,
              timeoutMs: 120_000,
            },
            occurredAt: "2026-08-20T10:00:01.000Z",
          },
          {
            id: "harness-complete",
            eventKind: "harness.operation_completed",
            publicPayload: {
              operationKey: "extract_shipment",
              toolCallId: "tool-call-harness",
              taskCharacters: 126,
              timeoutMs: 120_000,
              durationMs: 3_000,
              resultValidated: true,
            },
            occurredAt: "2026-08-20T10:00:04.000Z",
          },
        ],
        modelInvocations: [
          {
            id: "inner-model-1",
            runId,
            status: "completed",
            attempt: 1,
            modelKey: "openrouter/test",
            inputTokens: 30,
            outputTokens: 8,
            safeResponse: {
              finishReason: "toolUse",
              thinking: "Sensitive shipment content must not enter the modal.",
            },
            startedAt: "2026-08-20T10:00:01.100Z",
            completedAt: "2026-08-20T10:00:01.500Z",
          },
          {
            id: "inner-model-2",
            runId,
            status: "completed",
            attempt: 2,
            modelKey: "openrouter/test",
            inputTokens: 42,
            outputTokens: 12,
            safeResponse: { finishReason: "stop", thinking: "Private result." },
            startedAt: "2026-08-20T10:00:03.000Z",
            completedAt: "2026-08-20T10:00:03.700Z",
          },
        ],
        sandboxCommands: [
          {
            id: "inner-read",
            runId,
            state: "completed",
            toolName: "read",
            path: "/workspace/order.pdf",
            safeCommand: {
              toolName: "read",
              arguments: { path: "/workspace/order.pdf" },
            },
            safeResult: { output: "raw document contents" },
            startedAt: "2026-08-20T10:00:02.000Z",
            completedAt: "2026-08-20T10:00:02.200Z",
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(CONTEXT))
        .mockResolvedValueOnce(jsonResponse(session)),
    );

    const detail = await new HttpConsoleApi().getSession(session.id);
    const harnessEvents = detail.events.filter((event) => event.harness);
    expect(harnessEvents).toHaveLength(1);
    expect(harnessEvents[0]).toEqual(
      expect.objectContaining({
        id: "harness:tool-call-harness",
        summary: "2 model turns · 1 tool step · validated result",
        durationMs: 3_000,
        harness: expect.objectContaining({
          modelTurns: 2,
          toolSteps: 1,
          attribution: "complete",
          steps: [
            expect.objectContaining({
              id: "debug:modelInvocations:inner-model-1",
              title: "Requested read",
              summary: "Model turn 1. Raw scratch content remains private.",
              tokens: { input: 30, output: 8, cacheRead: 0, cacheWrite: 0 },
            }),
            expect.objectContaining({
              id: "debug:sandboxCommands:inner-read",
              title: "read",
              summary: "/workspace/order.pdf",
            }),
            expect.objectContaining({
              id: "debug:modelInvocations:inner-model-2",
              title: "Model turn 2",
            }),
          ],
        }),
      }),
    );
    expect(detail.events.map((event) => event.id)).not.toContain(
      "debug:modelInvocations:inner-model-1",
    );
    expect(JSON.stringify(harnessEvents[0])).not.toContain("Private result");
    expect(JSON.stringify(harnessEvents[0])).not.toContain(
      "raw document contents",
    );
  });

  it("marks overlapping Harness invocations as one parallel batch", async () => {
    const runId = "88888888-8888-4888-8888-888888888890";
    const lifecycle = (
      id: string,
      eventKind: string,
      operationKey: string,
      toolCallId: string,
      occurredAt: string,
    ) => ({
      id,
      eventKind,
      publicPayload: { operationKey, toolCallId, timeoutMs: 120_000 },
      occurredAt,
    });
    const session = {
      id: "77777777-7777-4777-8777-777777777780",
      title: "Parallel Harness test",
      status: "completed",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentName: "Harness agent",
      agentVersion: 1,
      latestRunId: runId,
      createdAt: "2026-08-20T10:00:00.000Z",
      lastActivityAt: "2026-08-20T10:00:05.000Z",
      runs: [{ id: runId, state: "completed" }],
      transcript: [],
      timeline: [],
      debug: {
        productEvents: [
          lifecycle(
            "start-extract",
            "harness.operation_started",
            "extract_shipment",
            "call-extract",
            "2026-08-20T10:00:01.000Z",
          ),
          lifecycle(
            "start-verify",
            "harness.operation_started",
            "verify_shipment",
            "call-verify",
            "2026-08-20T10:00:01.100Z",
          ),
          lifecycle(
            "complete-verify",
            "harness.operation_completed",
            "verify_shipment",
            "call-verify",
            "2026-08-20T10:00:03.000Z",
          ),
          lifecycle(
            "complete-extract",
            "harness.operation_completed",
            "extract_shipment",
            "call-extract",
            "2026-08-20T10:00:04.000Z",
          ),
        ],
        modelInvocations: [
          {
            id: "ambiguous-inner-turn",
            runId,
            status: "completed",
            attempt: 1,
            modelKey: "openrouter/test",
            inputTokens: 10,
            outputTokens: 2,
            safeResponse: { finishReason: "stop" },
            startedAt: "2026-08-20T10:00:02.000Z",
            completedAt: "2026-08-20T10:00:02.200Z",
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(CONTEXT))
        .mockResolvedValueOnce(jsonResponse(session)),
    );

    const detail = await new HttpConsoleApi().getSession(session.id);
    const harnessEvents = detail.events.filter((event) => event.harness);
    expect(harnessEvents).toHaveLength(2);
    expect(harnessEvents.map((event) => event.harness?.parallel)).toEqual([
      {
        groupId: "parallel:call-extract:call-verify",
        count: 2,
        index: 0,
      },
      {
        groupId: "parallel:call-extract:call-verify",
        count: 2,
        index: 1,
      },
    ]);
    expect(
      harnessEvents.every((event) => event.harness?.attribution === "partial"),
    ).toBe(true);
    expect(detail.events).toContainEqual(
      expect.objectContaining({
        id: "debug:modelInvocations:ambiguous-inner-turn",
      }),
    );
  });

  it("attributes concurrent inner turns and tool calls to the exact Harness invocation", async () => {
    const runId = "88888888-8888-4888-8888-888888888891";
    const lifecycle = (
      id: string,
      eventKind: string,
      operationKey: string,
      toolCallId: string,
      occurredAt: string,
    ) => ({
      id,
      eventKind,
      publicPayload: { operationKey, toolCallId, timeoutMs: 120_000 },
      occurredAt,
    });
    const step = (
      id: string,
      operationKey: string,
      harnessToolCallId: string,
      stepKind: "model" | "tool",
      stepId: string,
      stepIndex: number,
      occurredAt: string,
      toolName?: string,
    ) => ({
      id,
      eventKind: "harness.operation_step",
      publicPayload: {
        operationKey,
        harnessToolCallId,
        stepKind,
        stepId,
        stepIndex,
        status: "success",
        durationMs: 20,
        ...(toolName
          ? { toolName, summary: `${toolName} · ${operationKey}.txt` }
          : { inputTokens: 12, outputTokens: 3 }),
      },
      occurredAt,
    });
    const session = {
      id: "77777777-7777-4777-8777-777777777781",
      title: "Correlated parallel Harness test",
      status: "completed",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentName: "Harness agent",
      agentVersion: 1,
      latestRunId: runId,
      createdAt: "2026-08-20T10:00:00.000Z",
      lastActivityAt: "2026-08-20T10:00:05.000Z",
      runs: [{ id: runId, state: "completed" }],
      transcript: [],
      timeline: [],
      debug: {
        productEvents: [
          lifecycle(
            "start-extract",
            "harness.operation_started",
            "extract_shipment",
            "call-extract",
            "2026-08-20T10:00:01.000Z",
          ),
          lifecycle(
            "start-verify",
            "harness.operation_started",
            "verify_shipment",
            "call-verify",
            "2026-08-20T10:00:01.010Z",
          ),
          step(
            "extract-model-1-step",
            "extract_shipment",
            "call-extract",
            "model",
            "turn:extract-1",
            0,
            "2026-08-20T10:00:01.100Z",
          ),
          step(
            "verify-model-1-step",
            "verify_shipment",
            "call-verify",
            "model",
            "turn:verify-1",
            0,
            "2026-08-20T10:00:01.120Z",
          ),
          step(
            "extract-read-step",
            "extract_shipment",
            "call-extract",
            "tool",
            "tool:extract-read",
            1,
            "2026-08-20T10:00:01.500Z",
            "read",
          ),
          step(
            "verify-read-step",
            "verify_shipment",
            "call-verify",
            "tool",
            "tool:verify-read",
            1,
            "2026-08-20T10:00:01.520Z",
            "read",
          ),
          step(
            "extract-model-2-step",
            "extract_shipment",
            "call-extract",
            "model",
            "turn:extract-2",
            2,
            "2026-08-20T10:00:02.000Z",
          ),
          step(
            "verify-model-2-step",
            "verify_shipment",
            "call-verify",
            "model",
            "turn:verify-2",
            2,
            "2026-08-20T10:00:02.020Z",
          ),
          lifecycle(
            "complete-verify",
            "harness.operation_completed",
            "verify_shipment",
            "call-verify",
            "2026-08-20T10:00:03.000Z",
          ),
          lifecycle(
            "complete-extract",
            "harness.operation_completed",
            "extract_shipment",
            "call-extract",
            "2026-08-20T10:00:03.100Z",
          ),
        ],
        modelInvocations: [
          ...[
            ["extract-1", "call-extract", 0],
            ["verify-1", "call-verify", 0],
            ["extract-2", "call-extract", 2],
            ["verify-2", "call-verify", 2],
          ].map(([turnId, harnessToolCallId, harnessStepIndex], index) => ({
            id: `${turnId}-model`,
            runId,
            status: "completed",
            attempt: index + 1,
            modelKey: "openrouter/test",
            inputTokens: 12,
            outputTokens: 3,
            safeRequest: {
              harnessToolCallId,
              harnessStepId: `turn:${turnId}`,
              harnessStepIndex,
              harnessActionSummary: String(turnId).endsWith("-1")
                ? "Requested read."
                : "Returned the structured result for validation.",
            },
            safeResponse: { finishReason: "toolUse" },
            startedAt: `2026-08-20T10:00:0${index < 2 ? "1" : "2"}.${100 + index * 20}Z`,
            completedAt: `2026-08-20T10:00:0${index < 2 ? "1" : "2"}.${200 + index * 20}Z`,
          })),
        ],
        sandboxCommands: [
          {
            id: "extract-read-command",
            runId,
            commandKey: `sandbox-tool:${runId}:extract-read`,
            state: "completed",
            toolName: "read",
            path: "extract_shipment.txt",
            safeCommand: {
              toolName: "read",
              arguments: { path: "extract_shipment.txt" },
            },
            safeResult: { output: "redacted fixture" },
            startedAt: "2026-08-20T10:00:01.500Z",
            completedAt: "2026-08-20T10:00:01.550Z",
          },
          {
            id: "verify-read-command",
            runId,
            commandKey: `sandbox-tool:${runId}:verify-read`,
            state: "completed",
            toolName: "read",
            path: "verify_shipment.txt",
            safeCommand: {
              toolName: "read",
              arguments: { path: "verify_shipment.txt" },
            },
            safeResult: { output: "redacted fixture" },
            startedAt: "2026-08-20T10:00:01.520Z",
            completedAt: "2026-08-20T10:00:01.570Z",
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(CONTEXT))
        .mockResolvedValueOnce(jsonResponse(session)),
    );

    const detail = await new HttpConsoleApi().getSession(session.id);
    const harnessEvents = detail.events.filter((event) => event.harness);
    expect(harnessEvents).toHaveLength(2);
    const extract = harnessEvents.find(
      (event) => event.harness?.operationKey === "extract_shipment",
    )!;
    const verify = harnessEvents.find(
      (event) => event.harness?.operationKey === "verify_shipment",
    )!;
    expect(extract.harness).toEqual(
      expect.objectContaining({
        modelTurns: 2,
        toolSteps: 1,
        attribution: "complete",
      }),
    );
    expect(verify.harness).toEqual(
      expect.objectContaining({
        modelTurns: 2,
        toolSteps: 1,
        attribution: "complete",
      }),
    );
    expect(extract.harness?.steps.map((event) => event.summary)).toEqual([
      "Model turn 1. Raw scratch content remains private.",
      "extract_shipment.txt",
      "Model turn 2. Raw scratch content remains private.",
    ]);
    expect(verify.harness?.steps.map((event) => event.summary)).toEqual([
      "Model turn 1. Raw scratch content remains private.",
      "verify_shipment.txt",
      "Model turn 2. Raw scratch content remains private.",
    ]);
    expect(extract.harness?.steps.map((event) => event.title)).toEqual([
      "Requested read",
      "read",
      "Returned the structured result for validation",
    ]);
    expect(detail.events.map((event) => event.id)).not.toContain(
      "debug:sandboxCommands:extract-read-command",
    );
    expect(detail.events.map((event) => event.id)).not.toContain(
      "debug:modelInvocations:verify-2-model",
    );
    expect(JSON.stringify(harnessEvents)).not.toContain("redacted fixture");
  });

  it("ignores shell globs when inferring files for a legacy backup", async () => {
    const createdAt = "2026-08-20T19:21:48.150Z";
    const session = {
      id: "77777777-7777-4777-8777-777777777778",
      title: "Legacy backup",
      status: "completed",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentName: "Sandbox agent",
      latestRunId: "88888888-8888-4888-8888-888888888888",
      createdAt,
      lastActivityAt: createdAt,
      runs: [],
      transcript: [],
      timeline: [],
      debug: {
        sandboxCommands: [
          {
            state: "completed",
            safeCommand: {
              toolName: "bash",
              arguments: {
                command: "ls .oao/files/*.csv && cat .oao/files/result.csv",
              },
            },
            completedAt: createdAt,
          },
        ],
        workspaceBackups: [
          {
            manifestState: "missing",
            backedUpAt: "2026-08-20T19:21:49.000Z",
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(jsonResponse(session));
    vi.stubGlobal("fetch", fetchMock);

    const detail = await new HttpConsoleApi().getSession(session.id);
    expect(detail.workspaceFiles).toEqual([
      {
        name: "result.csv",
        path: ".oao/files/result.csv",
        backedUp: true,
        backedUpAt: "2026-08-20T19:21:49.000Z",
      },
    ]);
  });

  it("sends files when continuing a session", async () => {
    const sessionId = "77777777-7777-4777-8777-777777777777";
    const runId = "88888888-8888-4888-8888-888888888888";
    const createdAt = "2026-08-20T19:21:48.150Z";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(jsonResponse({ id: runId }, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          id: sessionId,
          title: "File test",
          status: "queued",
          agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          agentName: "File agent",
          agentVersion: 1,
          latestRunId: runId,
          createdAt,
          lastActivityAt: createdAt,
          runs: [{ id: runId, state: "queued", createdAt }],
          transcript: [],
          timeline: [],
          debug: {},
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi();
    const files = [
      {
        name: "context.txt",
        contentType: "text/plain",
        dataBase64: "aGVsbG8=",
      },
    ];

    await api.submitMessage(sessionId, { message: "Use this.", files });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/sessions/${sessionId}/runs`,
    );
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      message: "Use this.",
      files,
    });
  });

  it("uses project-scoped Skill package and lifecycle routes", async () => {
    const skillId = "44444444-4444-4444-8444-444444444444";
    const versionId = "55555555-5555-4555-8555-555555555555";
    const detail = {
      id: skillId,
      key: "shipment-intake",
      displayName: "Shipment Intake",
      latestVersionId: versionId,
      version: 1,
      name: "shipment-intake",
      description: "Process shipment intake.",
      contentHash: "4".repeat(64),
      status: "deprecated",
      fileCount: 0,
      versionIds: [versionId],
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      versions: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CONTEXT))
      .mockResolvedValueOnce(
        jsonResponse({ skillVersionId: versionId, status: "deprecated" }),
      )
      .mockResolvedValueOnce(jsonResponse(detail));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi();

    await api.updateSkillVersionLifecycle(skillId, versionId, "deprecated");

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/skills/${skillId}/versions/${versionId}/lifecycle`,
    );
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ status: "deprecated" });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/v1/projects/${PROJECT_ID}/skills/${skillId}`,
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
