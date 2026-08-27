import assert from "node:assert/strict";
import test from "node:test";

import {
  OaoApiError,
  OaoClient,
  createRoutes,
  parseEventStream,
} from "../src/index.ts";

test("route builders scope resources to a project and allow a custom prefix", () => {
  const routes = createRoutes("/platform/v2/");
  assert.equal(
    routes.claimToolCall("project/one", "call one"),
    "/platform/v2/projects/project%2Fone/tool-calls/call%20one/claim",
  );
  assert.equal(
    routes.skillVersionExport("project/one", "skill one", "version/one"),
    "/platform/v2/projects/project%2Fone/skills/skill%20one/versions/version%2Fone/export",
  );
  assert.equal(
    routes.skillDraftFiles("project/one", "draft one"),
    "/platform/v2/projects/project%2Fone/skill-drafts/draft%20one/files",
  );
  assert.equal(
    routes.delegationMessages("project/one", "delegation one"),
    "/platform/v2/projects/project%2Fone/delegations/delegation%20one/messages",
  );
  assert.equal(
    routes.mcpServerDiscovery("project/one", "server one"),
    "/platform/v2/projects/project%2Fone/mcp-servers/server%20one/discover",
  );
  assert.equal(
    routes.agentVersion("project/one", "agent one", "version/one"),
    "/platform/v2/projects/project%2Fone/agents/agent%20one/versions/version%2Fone",
  );
  assert.equal(routes.context, "/platform/v2/context");
});

test("client reads project context", async () => {
  const requests: Request[] = [];
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        principal: {
          id: "principal-1",
          organizationId: "organization-1",
          projectId: "project-1",
          kind: "human",
          subject: "development-user",
          scopes: ["*"],
        },
        organization: { id: "organization-1", name: "Development" },
        project: { id: "project-1", name: "Default" },
        organizations: [{ id: "organization-1", name: "Development" }],
        projects: [{ id: "project-1", name: "Default" }],
        activeModelPresets: [],
        authProvider: "development",
      });
    },
  });

  const context = await client.getContext();
  assert.equal(context.project.id, "project-1");
  assert.equal(requests[0]?.url, "https://api.example.test/v1/context");
});

test("client waits until a run reaches a terminal state", async () => {
  const states = ["queued", "running", "completed"] as const;
  let requestCount = 0;
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async () => {
      const state = states[Math.min(requestCount, states.length - 1)];
      requestCount += 1;
      return Response.json({ id: "run-1", state });
    },
  });

  const run = await client.waitForRunSettled("project-1", "run-1", {
    timeoutMs: 1_000,
    pollIntervalMs: 1,
  });
  assert.equal(run.state, "completed");
  assert.equal(requestCount, 3);
});

test("client returns the provider logout redirect and includes browser credentials", async () => {
  const requests: Request[] = [];
  const redirectUrl = "https://authkit.example.test/logout";
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    credentials: "include",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ redirectUrl });
    },
  });

  assert.deepEqual(await client.logout(), { redirectUrl });
  assert.equal(requests[0]?.url, "https://api.example.test/v1/auth/logout");
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.credentials, "include");
});

test("client manages project membership with exact project-scoped writes", async () => {
  const requests: Request[] = [];
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        id: "member-1",
        role: "member",
        data: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });
    },
  });

  await client.addMember(
    "project-1",
    {
      subject: "reviewer@example.test",
      role: "viewer",
      scopes: ["agent:read"],
    },
    { idempotencyKey: "member-create-1" },
  );
  await client.updateMember(
    "project-1",
    "member-1",
    { role: "member" },
    { idempotencyKey: "member-update-1" },
  );
  await client.removeMember("project-1", "member-1", {
    idempotencyKey: "member-remove-1",
  });

  assert.equal(
    requests[0]?.url,
    "https://api.example.test/v1/projects/project-1/members",
  );
  assert.equal(requests[0]?.method, "POST");
  assert.deepEqual(await requests[0]?.json(), {
    subject: "reviewer@example.test",
    role: "viewer",
    scopes: ["agent:read"],
  });
  assert.equal(requests[1]?.method, "PATCH");
  assert.deepEqual(await requests[1]?.json(), { role: "member" });
  assert.equal(requests[2]?.method, "DELETE");
  assert.equal(requests[2]?.headers.get("idempotency-key"), "member-remove-1");
});

test("client manages redacted MCP resources", async () => {
  const requests: Request[] = [];
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ id: "mcp-1", credentialConfigured: true });
    },
  });
  await client.createMcpCredential(
    "project-1",
    {
      key: "langsmith-proxy",
      displayName: "LangSmith proxy",
      kind: "static_bearer",
      headerName: null,
      secret: "secret-value",
    },
    { idempotencyKey: "credential-1" },
  );
  await client.discoverMcpServer(
    "project-1",
    "server-1",
    { credentialPolicyVersionId: "policy-version-1" },
    { idempotencyKey: "discover-1" },
  );
  assert.equal(requests[0]?.url.endsWith("/mcp-credentials"), true);
  assert.equal(requests[0]?.headers.get("idempotency-key"), "credential-1");
  assert.deepEqual(await requests[0]?.json(), {
    key: "langsmith-proxy",
    displayName: "LangSmith proxy",
    kind: "static_bearer",
    headerName: null,
    secret: "secret-value",
  });
  assert.equal(
    requests[1]?.url.endsWith("/mcp-servers/server-1/discover"),
    true,
  );
});

test("client follows up with and cancels a persistent child delegation", async () => {
  const requests: Request[] = [];
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        delegationId: "delegation-1",
        state: "cancelled",
      });
    },
  });
  await client.messageDelegation(
    "project-1",
    "delegation-1",
    "Re-check the approved shipment exception.",
    { idempotencyKey: "delegation-message-1" },
  );
  await client.cancelDelegation("project-1", "delegation-1", {
    idempotencyKey: "delegation-cancel-1",
  });
  assert.equal(
    requests[0]?.url,
    "https://api.example.test/v1/projects/project-1/delegations/delegation-1/messages",
  );
  assert.deepEqual(await requests[0]?.json(), {
    message: "Re-check the approved shipment exception.",
  });
  assert.equal(requests[1]?.url.endsWith("/delegation-1/cancel"), true);
  assert.equal(
    requests[1]?.headers.get("idempotency-key"),
    "delegation-cancel-1",
  );
});

test("client publishes and manages exact Skill versions", async () => {
  const requests: Request[] = [];
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ id: "skill-version-1", status: "active" });
    },
  });
  const input = {
    key: "business-rules",
    displayName: "Business rules",
    name: "business-rules",
    description: "Apply approved operating rules.",
    instructions: "Activate only when operating rules are relevant.",
    files: [
      {
        path: "references/rules.md",
        contentType: "text/markdown",
        dataBase64: "IyBSdWxlcw==",
      },
    ],
  };

  await client.createSkill("project-1", input, {
    idempotencyKey: "skill-create-1",
  });
  await client.updateSkillVersionLifecycle(
    "project-1",
    "skill-1",
    "skill-version-1",
    "revoked",
    { idempotencyKey: "skill-revoke-1" },
  );

  assert.equal(
    requests[0]?.url,
    "https://api.example.test/v1/projects/project-1/skills",
  );
  assert.equal(requests[0]?.headers.get("idempotency-key"), "skill-create-1");
  assert.deepEqual(await requests[0]?.json(), input);
  assert.equal(requests[1]?.method, "PATCH");
  assert.equal(
    requests[1]?.url,
    "https://api.example.test/v1/projects/project-1/skills/skill-1/versions/skill-version-1/lifecycle",
  );
  assert.deepEqual(await requests[1]?.json(), { status: "revoked" });
});

test("client authors nested Skill draft resources before publication", async () => {
  const requests: Request[] = [];
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/publish"))
        return Response.json({
          skillId: "skill-1",
          version: { id: "version-1" },
        });
      return Response.json({
        id: "draft-1",
        skillId: null,
        sourceSkillVersionId: null,
        key: "",
        displayName: "",
        name: "",
        description: "",
        instructions: "",
        revision: requests.length,
        status: "editing",
        publishedSkillVersionId: null,
        entries: [],
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
      });
    },
  });

  await client.createSkillDraft(
    "project-1",
    {},
    {
      idempotencyKey: "draft-create-1",
    },
  );
  await client.createSkillDraftDirectory(
    "project-1",
    "draft-1",
    "references/customers",
    { idempotencyKey: "draft-directory-1" },
  );
  await client.putSkillDraftFile(
    "project-1",
    "draft-1",
    {
      path: "references/customers/acme.md",
      contentType: "text/markdown",
      dataBase64: "IyBBY21l",
    },
    { idempotencyKey: "draft-file-1" },
  );
  await client.publishSkillDraft("project-1", "draft-1", {
    idempotencyKey: "draft-publish-1",
  });

  assert.equal(requests[0]?.url.endsWith("/skill-drafts"), true);
  assert.equal(requests[1]?.url.endsWith("/draft-1/directories"), true);
  assert.equal(requests[2]?.method, "PUT");
  assert.deepEqual(await requests[2]?.json(), {
    path: "references/customers/acme.md",
    contentType: "text/markdown",
    dataBase64: "IyBBY21l",
  });
  assert.equal(requests[3]?.url.endsWith("/draft-1/publish"), true);
});

test("client encodes pagination, authentication, and idempotency", async () => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({
      id: "run-1",
      state: "queued",
    });
  };
  const client = new OaoClient({
    baseUrl: "https://api.example.test/",
    apiPrefix: "/platform/v2",
    bearerToken: async () => "token-value",
    fetch,
  });

  await client.submitRun(
    "project one",
    "session/one",
    {
      redactedInput: "hello",
      files: [
        {
          name: "note.txt",
          contentType: "text/plain",
          dataBase64: "aGVsbG8=",
        },
      ],
    },
    { idempotencyKey: "submit-1" },
  );
  assert.equal(
    requests[0]?.url,
    "https://api.example.test/platform/v2/projects/project%20one/sessions/session%2Fone/runs",
  );
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer token-value");
  assert.equal(requests[0]?.headers.get("idempotency-key"), "submit-1");
  assert.deepEqual(await requests[0]?.json(), {
    redactedInput: "hello",
    files: [
      {
        name: "note.txt",
        contentType: "text/plain",
        dataBase64: "aGVsbG8=",
      },
    ],
  });
});

test("client creates a session together with its initial durable run", async () => {
  let request: Request | undefined;
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    apiKey: "oao_test_key",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        id: "session-1",
        latestRunId: "run-1",
        status: "queued",
        run: { id: "run-1", state: "queued" },
      });
    },
  });

  await client.createSession(
    "project-1",
    {
      agentId: "agent-1",
      title: "Repository review",
      initialMessage: "Review the repository entry point.",
      files: [
        {
          name: "entry.ts",
          contentType: "application/typescript",
          dataBase64: "ZXhwb3J0IHt9Ow==",
        },
      ],
    },
    { idempotencyKey: "session-1" },
  );

  assert.equal(
    request?.url,
    "https://api.example.test/v1/projects/project-1/sessions",
  );
  assert.deepEqual(await request?.json(), {
    agentId: "agent-1",
    title: "Repository review",
    initialMessage: "Review the repository entry point.",
    files: [
      {
        name: "entry.ts",
        contentType: "application/typescript",
        dataBase64: "ZXhwb3J0IHt9Ow==",
      },
    ],
  });
  assert.equal(request?.headers.get("idempotency-key"), "session-1");
});

test("client publishes the exact managed-agent configuration contract", async () => {
  let request: Request | undefined;
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ id: "version-2", version: 2 });
    },
  });
  const config = {
    systemPrompt: "Review code without exposing secrets.",
    modelPreset: "project-model-v1",
    tools: [
      {
        name: "read_repository_file",
        description: "Read one allowlisted repository file.",
        owner: "caller" as const,
        approval: "never" as const,
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
          additionalProperties: false,
        },
      },
    ],
    skillVersionIds: ["00000000-0000-4000-8000-000000000042"],
    harnessOperations: [
      {
        key: "review_changes",
        description: "Review a focused set of repository changes.",
        instructions:
          "Inspect the requested files and return a structured review.",
        resultSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            approved: { type: "boolean" },
          },
          required: ["summary", "approved"],
          additionalProperties: false,
        },
        timeoutMs: 45_000,
      },
    ],
    sandbox: {
      enabled: false,
      provider: "daytona-primary",
      network: "none" as const,
    },
    limits: { maxTurns: 32 as const, timeoutMs: 60_000 },
  };

  await client.publishAgentVersion("project-1", "agent-1", config, {
    idempotencyKey: "version-2",
  });

  assert.deepEqual(await request?.json(), config);
});

test("client manages project Daytona connections without a credential read path", async () => {
  const requests: Request[] = [];
  const provider = {
    id: "sandbox-provider-1",
    providerType: "daytona",
    credentialConfigured: true,
  };
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(provider);
    },
  });

  await client.createSandboxProvider(
    "project-1",
    {
      key: "daytona-primary",
      displayName: "Daytona primary",
      providerType: "daytona",
      apiKey: "daytona-secret",
      target: null,
      restrictedEgress: {
        allowedDomains: ["api.example.com"],
        allowedCidrs: [],
      },
    },
    { idempotencyKey: "sandbox-create-1" },
  );
  await client.updateSandboxProviderConfiguration(
    "project-1",
    "sandbox-provider-1",
    {
      target: "us",
      restrictedEgress: {
        allowedDomains: ["*.example.com"],
        allowedCidrs: [],
      },
    },
    { idempotencyKey: "sandbox-config-1" },
  );
  await client.rotateSandboxProviderCredential(
    "project-1",
    "sandbox-provider-1",
    { apiKey: "daytona-rotated" },
    { idempotencyKey: "sandbox-rotate-1" },
  );

  assert.equal(
    requests[0]?.url,
    "https://api.example.test/v1/projects/project-1/sandbox-providers",
  );
  assert.match(requests[1]?.url ?? "", /\/configuration$/u);
  assert.match(requests[2]?.url ?? "", /\/credential$/u);
  assert.equal(requests[0]?.headers.get("idempotency-key"), "sandbox-create-1");
});

test("client manages S3-compatible workspace storage without a credential read path", async () => {
  const requests: Request[] = [];
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        id: "storage-provider-1",
        providerType: "s3",
        credentialConfigured: true,
      });
    },
  });

  await client.listStorageProviders("project-1");
  await client.createStorageProvider(
    "project-1",
    {
      key: "workspace-archive",
      displayName: "Workspace archive",
      providerType: "s3",
      endpoint: "https://objects.example.test",
      region: "eu-test-1",
      bucket: "oao-workspaces",
      prefix: "sessions",
      forcePathStyle: true,
      setDefault: true,
      accessKeyId: "access-key",
      secretAccessKey: "secret-access-key",
    },
    { idempotencyKey: "storage-create-1" },
  );
  await client.rotateStorageProviderCredential(
    "project-1",
    "storage-provider-1",
    {
      accessKeyId: "rotated-access-key",
      secretAccessKey: "rotated-secret-access-key",
    },
    { idempotencyKey: "storage-rotate-1" },
  );
  await client.setDefaultStorageProvider("project-1", "storage-provider-1", {
    idempotencyKey: "storage-default-1",
  });
  await client.listStorageObjects("project-1", "storage-provider-1", {
    prefix: "run-files/runs/run-1/",
    cursor: "cursor-1",
  });

  assert.match(requests[0]?.url ?? "", /\/storage-providers$/u);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[1]?.headers.get("idempotency-key"), "storage-create-1");
  assert.match(requests[2]?.url ?? "", /\/credential$/u);
  assert.match(requests[3]?.url ?? "", /\/default$/u);
  assert.deepEqual(await requests[3]?.json(), {});
  assert.equal(requests[4]?.method, "GET");
  assert.equal(
    requests[4]?.url,
    "https://api.example.test/v1/projects/project-1/storage-providers/storage-provider-1/objects?prefix=run-files%2Fruns%2Frun-1%2F&cursor=cursor-1",
  );
});

test("client retrieves snapshots through the selected Daytona connection", async () => {
  let request: Request | undefined;
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        data: [],
        providerId: "sandbox/provider",
        providerType: "daytona",
      });
    },
  });

  await client.listSandboxSnapshots("project/one", "sandbox/provider");
  assert.equal(
    request?.url,
    "https://api.example.test/v1/projects/project%2Fone/sandbox-providers/sandbox%2Fprovider/snapshots",
  );
  assert.equal(request?.method, "GET");
});

test("cursor pagination is encoded without exposing project scope in headers", async () => {
  let request: Request | undefined;
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        data: [],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    },
  });

  await client.listAgents("project/one", { cursor: "position/41", limit: 25 });
  assert.equal(
    request?.url,
    "https://api.example.test/v1/projects/project%2Fone/agents?cursor=position%2F41&limit=25",
  );
  assert.equal(request?.headers.has("x-organization-id"), false);
});

test("client surfaces the structured error envelope without response-body leakage", async () => {
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "idempotency_conflict",
            message: "The idempotency key was already used",
            requestId: "request-1",
          },
        },
        { status: 409 },
      ),
  });

  await assert.rejects(
    client.cancelRun("project-1", "run-1", { idempotencyKey: "cancel-1" }),
    (error: unknown) => {
      assert.ok(error instanceof OaoApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "idempotency_conflict");
      assert.equal(error.requestId, "request-1");
      return true;
    },
  );
});

test("event stream parser handles chunking, CRLF, comments, and multiline data", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(": keepalive\r\nid: 41\r\nevent: product"),
      );
      controller.enqueue(
        encoder.encode('_event\r\ndata: {"one":\r\ndata: 1}\r\n\r\n'),
      );
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseEventStream(body)) events.push(event);
  assert.deepEqual(events, [
    { id: "41", event: "product_event", data: '{"one":\n1}' },
  ]);
});

test("project SSE sends Last-Event-ID and yields the durable event", async () => {
  const encoder = new TextEncoder();
  let request: Request | undefined;
  const event = {
    id: "00000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-8000-000000000002",
    projectId: "00000000-0000-4000-8000-000000000003",
    aggregateType: "run",
    aggregateId: "00000000-0000-4000-8000-000000000004",
    aggregateSequence: 2,
    projectPosition: "42",
    kind: "run.state_changed",
    publicPayload: { state: "running" },
    occurredAt: "2026-08-20T00:00:00.000Z",
  } as const;
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    apiKey: "oao_test_key",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `id: 42\nevent: product_event\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const frames = [];
  for await (const frame of client.streamProjectEvents("project-1", {
    lastEventId: "40",
    reconnect: false,
  })) {
    frames.push(frame);
  }

  assert.equal(request?.headers.get("last-event-id"), "40");
  assert.equal(request?.headers.get("authorization"), "Bearer oao_test_key");
  assert.deepEqual(frames, [{ id: "42", event: "product_event", data: event }]);
});

test("client reads and approves model presets over HTTP", async () => {
  const requests: Request[] = [];
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    apiKey: "oao_test_key",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(
        request.method === "POST"
          ? { id: "preset-1", key: "claude-sonnet-4-6-zdr-v1" }
          : {
              data: [],
              pageInfo: { hasMore: false, nextCursor: null },
              credentialEncryptionConfigured: true,
            },
      );
    },
  });

  const presets = await client.listModelPresets("project-1", { limit: 100 });
  assert.equal(presets.credentialEncryptionConfigured, true);
  assert.equal(
    requests[0]?.url,
    "https://api.example.test/v1/projects/project-1/model-presets?limit=100",
  );

  await client.listModelCatalog("project-1", {
    providerId: "provider-1",
    search: "sonnet",
    limit: 20,
  });
  assert.equal(
    requests[1]?.url,
    "https://api.example.test/v1/projects/project-1/model-catalog?providerId=provider-1&search=sonnet&limit=20",
  );

  const input = {
    key: "gpt-5-6-terra-v1",
    displayName: "GPT-5.6 Terra",
    providerId: "provider-1",
    model: "openai/gpt-5.6-terra",
    routing: {},
    settings: {
      textFormat: "text" as const,
      mode: "standard" as const,
      effort: "medium" as const,
      verbosity: "medium" as const,
      summary: "auto" as const,
    },
  };
  await client.createModelPreset("project-1", input, {
    idempotencyKey: "preset-1",
  });
  assert.equal(requests[2]?.method, "POST");
  assert.equal(
    requests[2]?.url,
    "https://api.example.test/v1/projects/project-1/model-presets",
  );
  assert.equal(requests[2]?.headers.get("idempotency-key"), "preset-1");
  assert.deepEqual(await requests[2]?.json(), input);
  // The platform bearer credential is sent only as an authorization header.
  for (const request of requests)
    assert.equal(request.headers.get("authorization"), "Bearer oao_test_key");
});

test("model preset writes require an idempotency key", async () => {
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async () => Response.json({}),
  });
  await assert.rejects(
    client.createModelPreset(
      "project-1",
      {
        key: "claude-sonnet-4-6-zdr-v1",
        displayName: "Claude Sonnet 4.6",
        providerId: "provider-1",
        model: "openrouter/anthropic/claude-sonnet-4.6",
      },
      { idempotencyKey: "  " },
    ),
    /idempotencyKey/u,
  );
});
