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
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Authentication provider is unavailable" },
          503,
        ),
      )
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
      "/v1/auth/login",
      "/v1/context",
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
      config: { modelPreset: "local-default" },
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
        modelInvocations: [
          {
            id: "model-1",
            runId: "88888888-8888-4888-8888-888888888888",
            status: "completed",
            attempt: 1,
            modelKey: "openrouter/test",
            inputTokens: 10,
            outputTokens: 4,
            safeResponse: {
              finishReason: "toolUse",
              thinking: "I should create a CSV with three columns.",
            },
            startedAt: "2026-08-20T19:21:45.000Z",
            completedAt: "2026-08-20T19:21:45.000Z",
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
