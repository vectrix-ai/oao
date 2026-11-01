import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import test, { type TestContext } from "node:test";
import {
  McpRemoteClient,
  callContextHeaders,
  createBrokeredMcpFetch,
  validateCredentialHeaderName,
  type McpCallContext,
  type McpConnectionDefinition,
} from "../src/index.js";

const context: Required<McpCallContext> = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  call: {
    sessionId: "00000000-0000-4000-8000-000000000003",
    runId: "00000000-0000-4000-8000-000000000004",
    toolCallId: "00000000-0000-4000-8000-000000000005",
    runKeySha256: "a".repeat(64),
  },
};

const tool = {
  name: "lookup_trace",
  description: "Look up a trace.",
  inputSchema: {
    type: "object",
    properties: { traceId: { type: "string" } },
    required: ["traceId"],
    additionalProperties: false,
  },
};

/** A Streamable HTTP MCP server that records every request's headers. */
async function server(t: TestContext): Promise<{
  readonly endpointUrl: string;
  readonly headers: IncomingHttpHeaders[];
}> {
  const headers: IncomingHttpHeaders[] = [];
  const http = createServer(async (request, response) => {
    headers.push(request.headers);
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 204 : 405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      readonly id?: number | string;
      readonly method: string;
      readonly params?: { readonly protocolVersion?: string };
    };
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "oao-context-mcp", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? { tools: [tool] }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: "ok" }] }
            : undefined;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        result
          ? { jsonrpc: "2.0", id: message.id, result }
          : {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Method not found" },
            },
      ),
    );
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  return {
    endpointUrl: `http://context-mcp.test:${address.port}/mcp`,
    headers,
  };
}

const egress = {
  allowPrivateNetwork: true,
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
};

function callContext(headers: IncomingHttpHeaders): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.startsWith("x-oao-")),
  );
}

test("a tool call sends the full call context on every request", async (t) => {
  const mcp = await server(t);
  const connection: McpConnectionDefinition = {
    endpointUrl: mcp.endpointUrl,
    transport: "streamable_http",
    credential: { kind: "static_bearer", secret: "context-secret" },
    context,
  };
  await new McpRemoteClient(egress).call(connection, {
    tool,
    arguments: { traceId: "trace-1" },
  });
  assert.ok(mcp.headers.length >= 2);
  for (const headers of mcp.headers) {
    assert.deepEqual(callContext(headers), {
      "x-oao-organization-id": context.organizationId,
      "x-oao-project-id": context.projectId,
      "x-oao-session-id": context.call.sessionId,
      "x-oao-run-id": context.call.runId,
      "x-oao-tool-call-id": context.call.toolCallId,
      "x-oao-run-key-sha256": context.call.runKeySha256,
    });
    assert.equal(headers.authorization, "Bearer context-secret");
  }
});

test("discovery sends only the organization and project", async (t) => {
  const mcp = await server(t);
  await new McpRemoteClient(egress).discover({
    endpointUrl: mcp.endpointUrl,
    transport: "streamable_http",
    context: {
      organizationId: context.organizationId,
      projectId: context.projectId,
    },
  });
  for (const headers of mcp.headers)
    assert.deepEqual(callContext(headers), {
      "x-oao-organization-id": context.organizationId,
      "x-oao-project-id": context.projectId,
    });
});

test("without a context no x-oao-* header is sent, and inbound ones are stripped", async (t) => {
  const mcp = await server(t);
  await new McpRemoteClient(egress).discover({
    endpointUrl: mcp.endpointUrl,
    transport: "streamable_http",
  });
  for (const headers of mcp.headers) assert.deepEqual(callContext(headers), {});

  // A caller-supplied x-oao-* header never survives the broker, with or
  // without a context of its own.
  for (const own of [undefined, context]) {
    const before = mcp.headers.length;
    const fetch = createBrokeredMcpFetch(
      {
        endpointUrl: mcp.endpointUrl,
        transport: "streamable_http",
        ...(own ? { context: own } : {}),
      },
      egress,
    );
    const response = await fetch(mcp.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-OAO-Run-Id": "00000000-0000-4000-8000-00000000dead",
        "x-oao-impersonate": "admin",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" }),
    });
    await response.body?.cancel();
    const sent = callContext(mcp.headers[before]!);
    assert.equal(sent["x-oao-impersonate"], undefined);
    assert.equal(sent["x-oao-run-id"], own ? context.call.runId : undefined);
  }
});

test("a malformed context fails before anything is sent", async (t) => {
  const mcp = await server(t);
  for (const bad of [
    { ...context, organizationId: "not-a-uuid" },
    { ...context, call: { ...context.call, toolCallId: "flue-call-1" } },
    { ...context, call: { ...context.call, runKeySha256: "A".repeat(64) } },
    { ...context, call: { ...context.call, runKeySha256: "a\r\nx: y" } },
  ]) {
    assert.throws(() => callContextHeaders(bad), /call context/u);
    await assert.rejects(
      new McpRemoteClient(egress).call(
        {
          endpointUrl: mcp.endpointUrl,
          transport: "streamable_http",
          context: bad,
        },
        { tool, arguments: { traceId: "trace-1" } },
      ),
      /call context/u,
    );
  }
  assert.equal(mcp.headers.length, 0);
});

test("x-oao-* names cannot be used as credential headers", async () => {
  assert.throws(
    () => validateCredentialHeaderName("X-OAO-Session-Id"),
    /reserved/u,
  );
  await assert.rejects(
    createBrokeredMcpFetch({
      endpointUrl: "https://mcp.example.test/mcp",
      transport: "streamable_http",
      credential: {
        kind: "api_key_header",
        headerName: "x-oao-project-id",
        secret: "spoofed-project",
      },
    })("https://mcp.example.test/mcp"),
    /reserved/u,
  );
});
