import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  McpRemoteClient,
  createBrokeredMcpFetch,
  isPublicNetworkAddress,
  validateCredentialHeaderName,
} from "../src/index.js";

test("pinned MCP client discovers and calls a deterministic Streamable HTTP server", async (t) => {
  const authorization: string[] = [];
  const server = createServer(async (request, response) => {
    authorization.push(request.headers.authorization ?? "");
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      readonly id?: string | number;
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
            serverInfo: { name: "oao-fake-mcp", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "lookup_trace",
                  description: "Look up a deterministic trace.",
                  inputSchema: {
                    $schema: "https://json-schema.org/draft/2020-12/schema",
                    type: "object",
                    properties: {
                      traceId: { type: "string" },
                      assignee: {
                        description: 'User ID, name, email, or "me"',
                        anyOf: [{ type: "string" }, { type: "null" }],
                      },
                      limit: {
                        type: "number",
                        maximum: 250,
                        default: 50,
                      },
                    },
                    required: ["traceId"],
                    additionalProperties: false,
                  },
                },
              ],
            }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: '{"found":true}' }] }
            : undefined;
    response.writeHead(result ? 200 : 404, {
      "content-type": "application/json",
      "mcp-session-id": "deterministic-session",
    });
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
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new McpRemoteClient({
    allowPrivateNetwork: true,
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  const connection = {
    endpointUrl: `http://deterministic-mcp.test:${address.port}/mcp`,
    transport: "streamable_http" as const,
    credential: { kind: "static_bearer" as const, secret: "fake-secret" },
  };
  const tools = await client.discover(connection);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["lookup_trace"],
  );
  assert.deepEqual(tools[0]?.inputSchema, {
    type: "object",
    properties: {
      traceId: { type: "string" },
      assignee: {
        description: 'User ID, name, email, or "me"',
        type: ["string", "null"],
      },
      limit: { type: "number", maximum: 250 },
    },
    required: ["traceId"],
    additionalProperties: false,
  });
  const result = await client.call(connection, {
    tool: tools[0]!,
    arguments: { traceId: "trace-1" },
  });
  assert.equal(result.content, '{"found":true}');
  assert.ok(authorization.every((value) => value === "Bearer fake-secret"));
});

test("blocks private and special-purpose network addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "2001:db8::1",
    "2002:7f00:1::",
    "fd00::1",
    "fe80::1",
  ])
    assert.equal(isPublicNetworkAddress(address), false, address);
  assert.equal(isPublicNetworkAddress("1.1.1.1"), true);
  assert.equal(isPublicNetworkAddress("2606:4700:4700::1111"), true);
});

test("rejects sensitive or malformed secret header names", () => {
  assert.equal(validateCredentialHeaderName("X-API-Key"), "x-api-key");
  assert.throws(() => validateCredentialHeaderName("Host"));
  assert.throws(() => validateCredentialHeaderName("bad header"));
});

test("rejects requests outside the exact configured endpoint", async () => {
  const fetch = createBrokeredMcpFetch(
    {
      endpointUrl: "https://mcp.example.test/rpc",
      transport: "streamable_http",
      credential: { kind: "static_bearer", secret: "super-secret" },
    },
    {
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
    },
  );
  await assert.rejects(
    fetch("https://redirect.example.test/rpc"),
    /outside the credential policy/u,
  );
});

test("permits only the credential policy origin and path prefix", async () => {
  const fetch = createBrokeredMcpFetch(
    {
      endpointUrl: "https://mcp.example.test/rpc",
      exactOrigin: "https://mcp.example.test",
      pathPrefix: "/rpc",
      transport: "legacy_sse",
      credential: { kind: "static_bearer", secret: "super-secret" },
    },
    { resolve: async () => [{ address: "1.1.1.1", family: 4 }] },
  );
  await assert.rejects(
    fetch("https://mcp.example.test/messages"),
    /outside the credential policy/u,
  );
  await assert.rejects(
    fetch("https://mcp.example.test.evil.test/rpc/messages"),
    /outside the credential policy/u,
  );
});
