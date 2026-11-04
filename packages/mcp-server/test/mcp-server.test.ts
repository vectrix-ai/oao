import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  AUTHORIZATION_SCOPE_CATALOG,
  OAO_MCP_TOOL_CATALOG,
} from "@oao/contracts";
import { OaoClient } from "@oao/sdk-js";

import {
  OAO_TOOLS,
  availableOaoTools,
  createOaoMcpHandler,
  type OaoMcpCaller,
} from "../src/index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const ENDPOINT = `https://oao.example.test/v1/projects/${PROJECT}/mcp`;

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

function run(state: string) {
  return {
    id: RUN,
    organizationId: "44444444-4444-4444-8444-444444444444",
    projectId: PROJECT,
    threadId: "55555555-5555-4555-8555-555555555555",
    sessionId: SESSION,
    agentVersionId: "66666666-6666-4666-8666-666666666666",
    createdByPrincipalId: "77777777-7777-4777-8777-777777777777",
    state,
    cancellationRequestedAt: null,
    admittedAt: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:01.000Z",
  };
}

/** A stand-in for the OAO API that records what the tools sent. */
function fakeApi() {
  const requests: Recorded[] = [];
  let runReads = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push({
      method: request.method,
      path,
      authorization: request.headers.get("authorization"),
      idempotencyKey: request.headers.get("idempotency-key"),
      body: request.body ? await request.json() : undefined,
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const project = `/v1/projects/${PROJECT}`;
    if (path === `${project}/agents`)
      return json({
        data: [{ id: "a1", name: "Extraction" }],
        pageInfo: { hasMore: false, nextCursor: null },
      });
    if (path === `${project}/sessions/${SESSION}/runs`)
      return json(run("queued"), 202);
    if (path === `${project}/runs/${RUN}`) {
      runReads += 1;
      return json(run(runReads > 1 ? "completed" : "running"));
    }
    if (path === `${project}/runs/${RUN}/messages`)
      return json({
        data: [
          {
            id: "m2",
            role: "assistant",
            redactedContent: "The invoice total was 1200 EUR.",
            createdAt: "2026-11-01T10:00:03.000Z",
          },
          {
            id: "m1",
            role: "user",
            redactedContent: "What was the total?",
            createdAt: "2026-11-01T10:00:00.000Z",
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      });
    if (path === `${project}/sessions/${SESSION}`)
      return json({
        id: SESSION,
        transcript: [],
        debug: { modelInvocations: [] },
      });
    if (path === `${project}/runs/${RUN}/cancel`)
      return json(
        {
          error: {
            code: "conflict",
            message: "The run has already settled",
            requestId: "req-1",
          },
        },
        409,
      );
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  };
  return { fetch, requests };
}

async function connect(scopes: readonly string[], projectRestricted = false) {
  const api = fakeApi();
  const handler = createOaoMcpHandler();
  const caller: OaoMcpCaller = {
    client: new OaoClient({
      baseUrl: "https://oao.example.test",
      fetch: api.fetch,
      bearerToken: "oao_caller_secret",
    }),
    projectId: PROJECT,
    scopes: new Set(scopes),
    projectRestricted,
  };
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      fetch: (input, init) => handler.fetch(new Request(input, init), caller),
    }),
  );
  return { client, api };
}

function text(result: { readonly content?: unknown }): string {
  const content = result.content as readonly { type: string; text: string }[];
  return content[0]?.text ?? "";
}

test("every catalog entry is implemented, in catalog order", () => {
  assert.deepEqual(
    OAO_TOOLS.map((tool) => tool.name),
    OAO_MCP_TOOL_CATALOG.map((tool) => tool.name),
  );
});

test("every tool names real scopes and has a unique name", () => {
  const known = new Set<string>(
    AUTHORIZATION_SCOPE_CATALOG.map(([scope]) => scope),
  );
  const names = new Set<string>();
  for (const tool of OAO_TOOLS) {
    assert.ok(!names.has(tool.name), tool.name);
    names.add(tool.name);
    assert.match(tool.name, /^[a-z][a-z_]{2,63}$/u);
    for (const scope of tool.scopes) assert.ok(known.has(scope), scope);
    // A write a caller retries must be able to name its own key.
    if (!tool.readOnly)
      assert.ok("idempotencyKey" in tool.input.entries, tool.name);
  }
});

test("the rights table in the docs lists every tool with its scopes", async () => {
  const docs = await readFile(
    new URL("../../../docs/integrations/oao-mcp-server.mdx", import.meta.url),
    "utf8",
  );
  for (const tool of OAO_TOOLS) {
    const row = docs
      .split("\n")
      .find(
        (line) => line.startsWith("|") && line.includes(`\`${tool.name}\``),
      );
    assert.ok(row, `${tool.name} is missing from the docs`);
    const scopes = row.split("|")[2] ?? "";
    for (const scope of tool.scopes)
      assert.ok(scopes.includes(`\`${scope}\``), `${tool.name} ${scope}`);
  }
});

test("tools are offered only to callers holding all their scopes", () => {
  const names = (scopes: readonly string[], projectRestricted = false) =>
    availableOaoTools(new Set(scopes), { projectRestricted }).map(
      (tool) => tool.name,
    );
  const reader = names(["agent:read", "session:read", "run:read"]);
  assert.ok(reader.includes("list_agents"));
  assert.ok(reader.includes("get_session"));
  assert.ok(reader.includes("get_run_messages"));
  assert.ok(!reader.includes("send_message"));
  assert.ok(!reader.includes("create_agent"));
  assert.ok(!names(["session:write"]).includes("start_session"));
  // Waiting for the answer reads the run.
  assert.ok(!names(["session:write", "run:create"]).includes("start_session"));
  assert.ok(!names(["run:create"]).includes("send_message"));
  assert.ok(
    names(["session:write", "run:create", "run:read"]).includes(
      "start_session",
    ),
  );
  assert.equal(names(["*"]).length, OAO_TOOLS.length);
  // A project-restricted caller cannot change organization-shared resources.
  const restricted = names(["*"], true);
  assert.ok(!restricted.includes("create_mcp_server"));
  assert.ok(restricted.includes("create_mcp_toolset"));
});

test("an MCP client lists only its tools, each with a JSON Schema input", async () => {
  const { client } = await connect(["agent:read", "run:read"]);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.ok(names.includes("get_context"));
  assert.ok(names.includes("wait_for_run"));
  assert.ok(!names.includes("send_message"));
  for (const tool of tools) assert.equal(tool.inputSchema.type, "object");
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /send_message/u);
  await client.close();
});

test("a tool call reaches the API with the caller's own credential", async () => {
  const { client, api } = await connect(["agent:read"]);
  const result = await client.callTool({
    name: "list_agents",
    arguments: { limit: 5 },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(text(result)).data, [
    { id: "a1", name: "Extraction" },
  ]);
  assert.equal(api.requests[0]?.path, `/v1/projects/${PROJECT}/agents`);
  assert.equal(api.requests[0]?.authorization, "Bearer oao_caller_secret");
  await client.close();
});

test("prices and usage reach their API routes", async () => {
  const { client, api } = await connect([
    "agent:read",
    "project:admin",
    "session:read",
  ]);
  const presetId = "66666666-6666-4666-8666-666666666666";
  const price = {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteUsdPerMillion: 2.5,
    outputUsdPerMillion: 10,
    validFrom: "2026-11-22T00:00:00.000Z",
  };
  await client.callTool({
    name: "set_model_preset_price",
    arguments: { presetId, ...price },
  });
  await client.callTool({
    name: "list_model_preset_prices",
    arguments: { presetId },
  });
  await client.callTool({
    name: "get_session_usage",
    arguments: { sessionId: SESSION },
  });
  await client.callTool({
    name: "get_project_usage",
    arguments: { groupBy: "model" },
  });
  const [set, list, session, project] = api.requests;
  assert.equal(set?.method, "POST");
  assert.equal(
    set?.path,
    `/v1/projects/${PROJECT}/model-presets/${presetId}/prices`,
  );
  assert.ok(set?.idempotencyKey);
  assert.deepEqual(set?.body, { ...price, longContext: null });
  assert.match(
    list?.path ?? "",
    new RegExp(`/model-presets/${presetId}/prices`, "u"),
  );
  assert.equal(
    session?.path,
    `/v1/projects/${PROJECT}/sessions/${SESSION}/usage`,
  );
  assert.match(
    project?.path ?? "",
    new RegExp(`/v1/projects/${PROJECT}/usage`, "u"),
  );
  await client.close();
});

test("send_message asks the agent in its session and returns its answer", async () => {
  const { client, api } = await connect(["run:create", "run:read"]);
  const result = await client.callTool({
    name: "send_message",
    arguments: {
      sessionId: SESSION,
      message: "What was the total?",
      waitSeconds: 5,
      idempotencyKey: "ask-1",
    },
  });
  const body = JSON.parse(text(result)) as {
    settled: boolean;
    answer: string;
    run: { state: string };
  };
  assert.equal(body.settled, true);
  assert.equal(body.run.state, "completed");
  assert.equal(body.answer, "The invoice total was 1200 EUR.");
  const submitted = api.requests.find((request) =>
    request.path.endsWith("/runs"),
  );
  assert.deepEqual(submitted?.body, { message: "What was the total?" });
  assert.equal(submitted?.idempotencyKey, "mcp:ask-1:send_message");
  await client.close();
});

test("a write without its own key still sends a fresh Idempotency-Key", async () => {
  const { client, api } = await connect(["run:create", "run:read"]);
  for (let attempt = 0; attempt < 2; attempt += 1)
    await client.callTool({
      name: "send_message",
      arguments: { sessionId: SESSION, message: "Hello", waitSeconds: 0 },
    });
  const keys = api.requests
    .filter((request) => request.method === "POST")
    .map((request) => request.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.ok(keys.every((key) => key?.startsWith("mcp:")));
  assert.notEqual(keys[0], keys[1]);
  await client.close();
});

test("get_session leaves out the debug block unless asked", async () => {
  const { client } = await connect(["session:read"]);
  const plain = JSON.parse(
    text(
      await client.callTool({
        name: "get_session",
        arguments: { sessionId: SESSION },
      }),
    ),
  ) as Record<string, unknown>;
  assert.equal(plain.debug, undefined);
  const full = JSON.parse(
    text(
      await client.callTool({
        name: "get_session",
        arguments: { sessionId: SESSION, includeDebug: true },
      }),
    ),
  ) as Record<string, unknown>;
  assert.ok(full.debug);
  await client.close();
});

test("API errors come back as tool errors with their code", async () => {
  const { client } = await connect(["run:cancel"]);
  const result = await client.callTool({
    name: "cancel_run",
    arguments: { runId: RUN },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(text(result)), {
    error: {
      status: 409,
      code: "conflict",
      message: "The run has already settled",
      requestId: "req-1",
    },
  });
  await client.close();
});

test("invalid arguments never reach the API", async () => {
  const { client, api } = await connect(["run:read"]);
  const result = await client
    .callTool({ name: "get_run", arguments: { runId: "not-a-uuid" } })
    .catch((error: unknown) => ({ isError: true, error }));
  assert.equal(result.isError, true);
  assert.equal(api.requests.length, 0);
  await client.close();
});

test("a tool the caller lacks is not callable", async () => {
  const { client, api } = await connect(["agent:read"]);
  const result = await client
    .callTool({
      name: "send_message",
      arguments: { sessionId: SESSION, message: "Hi" },
    })
    .catch((error: unknown) => ({ isError: true, error }));
  assert.equal(result.isError, true);
  assert.equal(api.requests.length, 0);
  await client.close();
});
