import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import test, { type TestContext } from "node:test";
import {
  McpRemoteClient,
  McpRemoteError,
  McpTokenBroker,
  OAUTH_CLIENT_CREDENTIALS_EXTENSION,
  createBrokeredMcpFetch,
  createBrokeredTokenFetch,
  discoverMcpAuthorization,
  type McpConnectionDefinition,
  type McpOAuthClientCredentialsMaterial,
} from "../src/index.js";

const CLIENT_ID = "client_oao_extraction";
const CLIENT_SECRET = "s3cr3t-client-value-that-must-stay-put";
const SCOPE = "extraction:mcp";

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

/**
 * A local authorization server and Streamable HTTP MCP server pair. The
 * authorization server lives on a loopback origin (the SDK refuses plain HTTP
 * token endpoints elsewhere) and the MCP server on another name.
 */
async function fixture(
  t: TestContext,
  options: {
    readonly expiresIn?: number;
    readonly grantTypes?: readonly string[];
    readonly issuer?: (base: string) => string;
    /** Serves the authorization server under this path instead of the root. */
    readonly issuerPath?: string;
  } = {},
) {
  const tokenRequests: Recorded[] = [];
  const authorizationRequests: Recorded[] = [];
  const mcpRequests: Recorded[] = [];
  const valid = new Set<string>();
  const control = {
    tokenStatus: 200,
    tokenLocation: "",
    rejectAll: false,
    forbidden: undefined as string | undefined,
    challengeMetadataUrl: undefined as string | undefined,
    challengeHeader: true,
    resource: undefined as string | undefined,
    tokenDelayMs: 0,
  };
  let issued = 0;
  const auth = await listen(t, (request, response) => {
    void (async () => {
      const text = await body(request);
      const recorded = {
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: text,
      };
      authorizationRequests.push(recorded);
      if (
        request.url ===
        `/.well-known/oauth-authorization-server${options.issuerPath ?? ""}`
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            issuer: options.issuer?.(authIssuer) ?? authIssuer,
            token_endpoint: `${authBase}/token`,
            token_endpoint_auth_methods_supported: [
              "none",
              "client_secret_post",
              "client_secret_basic",
            ],
            grant_types_supported: options.grantTypes ?? [
              "authorization_code",
              "refresh_token",
            ],
            scopes_supported: [SCOPE],
            response_types_supported: ["code"],
          }),
        );
        return;
      }
      if (request.url === "/token" && request.method === "POST") {
        tokenRequests.push(recorded);
        if (control.tokenDelayMs > 0)
          await new Promise((resolve) =>
            setTimeout(resolve, control.tokenDelayMs),
          );
        if (control.tokenStatus !== 200) {
          response.writeHead(control.tokenStatus, {
            ...(control.tokenLocation
              ? { location: control.tokenLocation }
              : {}),
            "content-type": "application/json",
          });
          response.end(JSON.stringify({ error: "invalid_client" }));
          return;
        }
        const form = new URLSearchParams(text);
        const basic = request.headers.authorization?.startsWith("Basic ")
          ? Buffer.from(request.headers.authorization.slice(6), "base64")
              .toString("utf8")
              .split(":")
              .map(decodeURIComponent)
          : undefined;
        const clientId = basic?.[0] ?? form.get("client_id");
        const clientSecret = basic?.[1] ?? form.get("client_secret");
        if (
          form.get("grant_type") !== "client_credentials" ||
          clientId !== CLIENT_ID ||
          clientSecret !== CLIENT_SECRET
        ) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_client" }));
          return;
        }
        issued += 1;
        const accessToken = `access-token-${issued}`;
        valid.add(accessToken);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: options.expiresIn ?? 3600,
            scope: form.get("scope"),
          }),
        );
        return;
      }
      response.writeHead(404).end();
    })();
  });
  const authBase = `http://localhost:${auth.port}`;
  const authIssuer = `${authBase}${options.issuerPath ?? ""}`;

  const mcp = await listen(t, (request, response) => {
    void (async () => {
      const text = await body(request);
      mcpRequests.push({
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: text,
      });
      if (request.url === "/.well-known/oauth-protected-resource/mcp") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            resource: control.resource ?? endpointUrl,
            authorization_servers: [authIssuer],
            scopes_supported: [SCOPE],
            bearer_methods_supported: ["header"],
          }),
        );
        return;
      }
      if (request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      const bearer = request.headers.authorization?.replace(/^Bearer /u, "");
      if (!bearer || !valid.has(bearer) || control.rejectAll) {
        response.writeHead(401, {
          ...(control.challengeHeader
            ? {
                "www-authenticate": `Bearer resource_metadata="${
                  control.challengeMetadataUrl ?? metadataUrl
                }", scope="${SCOPE}"`,
              }
            : {}),
        });
        response.end();
        return;
      }
      if (control.forbidden) {
        response.writeHead(403, {
          "www-authenticate": `Bearer error="${control.forbidden}", scope="${SCOPE}"`,
        });
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(text) as {
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
              serverInfo: { name: "oao-fake-extraction", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "extract_order",
                    description: "Extract an order.",
                    inputSchema: {
                      type: "object",
                      properties: { messageId: { type: "string" } },
                      required: ["messageId"],
                      additionalProperties: false,
                    },
                  },
                ],
              }
            : message.method === "tools/call"
              ? { content: [{ type: "text", text: '{"extracted":true}' }] }
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
    })();
  });
  const mcpOrigin = `http://mcp.test:${mcp.port}`;
  const endpointUrl = `${mcpOrigin}/mcp`;
  const metadataUrl = `${mcpOrigin}/.well-known/oauth-protected-resource/mcp`;
  const egress = {
    allowPrivateNetwork: true,
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  };
  const credential = (
    overrides: Partial<McpOAuthClientCredentialsMaterial> = {},
  ): McpOAuthClientCredentialsMaterial => ({
    kind: "oauth_client_credentials",
    organizationId: "00000000-0000-4000-8000-000000000001",
    credentialVersionId: "00000000-0000-4000-8000-000000000002",
    issuer: authBase,
    tokenEndpoint: `${authBase}/token`,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokenEndpointAuthMethod: "client_secret_post",
    scope: SCOPE,
    resource: endpointUrl,
    resourceMetadataUrl: metadataUrl,
    sendResource: true,
    ...overrides,
  });
  const connection = (
    material: McpOAuthClientCredentialsMaterial = credential(),
  ): McpConnectionDefinition => ({
    endpointUrl,
    exactOrigin: mcpOrigin,
    pathPrefix: "/mcp",
    credentialDestination: { origin: mcpOrigin, pathPrefix: "/mcp" },
    transport: "streamable_http",
    credential: material,
  });
  return {
    authBase,
    endpointUrl,
    metadataUrl,
    egress,
    control,
    valid,
    tokenRequests,
    authorizationRequests,
    mcpRequests,
    credential,
    connection,
  };
}

const tool = {
  name: "extract_order",
  description: "Extract an order.",
  inputSchema: {
    type: "object",
    properties: { messageId: { type: "string" } },
    required: ["messageId"],
    additionalProperties: false,
  },
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpRemoteError) return error.code;
    throw error;
  }
  throw new Error("expected the request to fail");
}

test("the client secret reaches only the token endpoint and the access token only the MCP server", async (t) => {
  const server = await fixture(t);
  const client = new McpRemoteClient(server.egress);
  const context = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
  };
  const tools = await client.discover({ ...server.connection(), context });
  assert.deepEqual(
    tools.map((entry) => entry.name),
    ["extract_order"],
  );
  const result = await client.call(server.connection(), {
    tool: tools[0]!,
    arguments: { messageId: "message-1" },
  });
  assert.equal(result.content, '{"extracted":true}');

  // One token served discovery and the call.
  assert.equal(server.tokenRequests.length, 1);
  const form = new URLSearchParams(server.tokenRequests[0]!.body);
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("client_id"), CLIENT_ID);
  assert.equal(form.get("client_secret"), CLIENT_SECRET);
  assert.equal(form.get("scope"), SCOPE);
  assert.equal(form.get("resource"), server.endpointUrl);
  assert.equal(server.tokenRequests[0]!.headers.authorization, undefined);
  // Call context goes to the MCP server and never to the token endpoint.
  for (const request of server.authorizationRequests)
    assert.ok(
      Object.keys(request.headers).every((name) => !name.startsWith("x-oao-")),
    );
  assert.equal(
    server.mcpRequests[0]!.headers["x-oao-project-id"],
    context.projectId,
  );

  const mcpTraffic = JSON.stringify(server.mcpRequests);
  assert.doesNotMatch(mcpTraffic, new RegExp(CLIENT_SECRET, "u"));
  assert.doesNotMatch(mcpTraffic, new RegExp(CLIENT_ID, "u"));
  assert.ok(
    server.mcpRequests.every(
      (request) => request.headers.authorization === "Bearer access-token-1",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(server.authorizationRequests),
    /access-token-1/u,
  );

  // The extension is declared in the client capabilities the MCP server saw.
  assert.match(
    mcpTraffic,
    new RegExp(
      OAUTH_CLIENT_CREDENTIALS_EXTENSION.replaceAll(/[./]/gu, "\\$&"),
      "u",
    ),
  );
});

test("client_secret_basic authenticates in the Authorization header and the resource can be omitted", async (t) => {
  const server = await fixture(t);
  const client = new McpRemoteClient(server.egress);
  await client.discover(
    server.connection(
      server.credential({
        tokenEndpointAuthMethod: "client_secret_basic",
        sendResource: false,
      }),
    ),
  );
  const request = server.tokenRequests[0]!;
  const form = new URLSearchParams(request.body);
  assert.equal(form.get("client_id"), null);
  assert.equal(form.get("client_secret"), null);
  assert.equal(form.get("resource"), null);
  assert.equal(
    request.headers.authorization,
    `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
  );
});

test("a 401 refetches the token once and then fails as credential_rejected", async (t) => {
  const server = await fixture(t);
  const client = new McpRemoteClient(server.egress);
  await client.discover(server.connection());
  assert.equal(server.tokenRequests.length, 1);

  // The cached token expired early on the server: one retry recovers.
  server.valid.clear();
  const tools = await client.discover(server.connection());
  assert.equal(tools.length, 1);
  assert.equal(server.tokenRequests.length, 2);
  assert.equal(
    server.mcpRequests.at(-1)?.headers.authorization,
    "Bearer access-token-2",
  );

  // A credential the server keeps rejecting costs exactly one more token.
  server.control.rejectAll = true;
  assert.equal(
    await codeOf(
      client.call(server.connection(), {
        tool,
        arguments: { messageId: "message-1" },
      }),
    ),
    "credential_rejected",
  );
  assert.equal(server.tokenRequests.length, 3);
});

test("a challenge naming other resource metadata fails as authorization_server_changed", async (t) => {
  const server = await fixture(t);
  const client = new McpRemoteClient(server.egress);
  await client.discover(server.connection());
  server.valid.clear();
  server.control.challengeMetadataUrl =
    "https://elsewhere.example.test/.well-known/oauth-protected-resource";
  assert.equal(
    await codeOf(client.discover(server.connection())),
    "authorization_server_changed",
  );
  // No new token was requested for a server that may have moved.
  assert.equal(server.tokenRequests.length, 1);
});

test("a 403 fails without refetching the token", async (t) => {
  const server = await fixture(t);
  const client = new McpRemoteClient(server.egress);
  await client.discover(server.connection());
  server.control.forbidden = "insufficient_scope";
  assert.equal(
    await codeOf(client.discover(server.connection())),
    "insufficient_scope",
  );
  server.control.forbidden = "job_binding_refused";
  assert.equal(
    await codeOf(client.discover(server.connection())),
    "remote_forbidden",
  );
  assert.equal(server.tokenRequests.length, 1);
});

test("tokens are cached per credential version and organization", async (t) => {
  const server = await fixture(t);
  const client = new McpRemoteClient(server.egress);
  await client.discover(server.connection());
  await client.discover(server.connection());
  assert.equal(server.tokenRequests.length, 1);
  await client.discover(
    server.connection(
      server.credential({
        credentialVersionId: "00000000-0000-4000-8000-000000000003",
      }),
    ),
  );
  assert.equal(server.tokenRequests.length, 2);
  await client.discover(
    server.connection(
      server.credential({
        organizationId: "00000000-0000-4000-8000-000000000009",
      }),
    ),
  );
  assert.equal(server.tokenRequests.length, 3);
  assert.equal(
    server.mcpRequests.at(-1)?.headers.authorization,
    "Bearer access-token-3",
  );
});

test("tokens refresh early and concurrent requests share one token request", async (t) => {
  const server = await fixture(t, { expiresIn: 3600 });
  let now = 1_000_000;
  const broker = new McpTokenBroker(server.egress, () => now);
  const credential = server.credential();
  const [first, second] = await Promise.all([
    broker.token(credential),
    broker.token(credential),
  ]);
  assert.equal(first.accessToken, second.accessToken);
  assert.equal(server.tokenRequests.length, 1);
  assert.equal(first.expiresAt, 1_000_000 + 3_600_000);
  assert.equal(first.expiresIn, 3600);
  assert.equal(first.grantedScope, SCOPE);
  // Refreshed at the expiry minus 10% of a one-hour lifetime.
  now += 3_239_000;
  assert.equal((await broker.token(credential)).accessToken, "access-token-1");
  now += 2_000;
  assert.equal((await broker.token(credential)).accessToken, "access-token-2");
  assert.equal(server.tokenRequests.length, 2);
});

test("a caller waiting on a shared token request keeps its own timeout", async (t) => {
  const server = await fixture(t);
  server.control.tokenDelayMs = 400;
  const broker = new McpTokenBroker(server.egress);
  const credential = server.credential();
  const slow = broker.token(credential, { timeoutMs: 5_000 });
  const started = Date.now();
  await assert.rejects(
    broker.token(credential, { timeoutMs: 50 }),
    (error: unknown) =>
      error instanceof McpRemoteError &&
      error.code === "credential_token_failed" &&
      /timed out/u.test(error.message),
  );
  assert.ok(Date.now() - started < 300);
  // The shared request itself still completes for the patient caller.
  assert.equal((await slow).accessToken, "access-token-1");
  assert.equal(server.tokenRequests.length, 1);
});

test("token requests refuse redirects, private addresses, and other destinations", async (t) => {
  const server = await fixture(t);
  server.control.tokenStatus = 307;
  server.control.tokenLocation = "https://attacker.example.test/token";
  const client = new McpRemoteClient(server.egress);
  assert.equal(
    await codeOf(client.discover(server.connection())),
    "credential_token_failed",
  );
  assert.equal(server.tokenRequests.length, 1);
  assert.equal(server.mcpRequests.length, 0);

  const privateBroker = new McpTokenBroker({
    resolve: async () => [{ address: "10.0.0.7", family: 4 }],
  });
  await assert.rejects(
    privateBroker.token(
      server.credential({
        issuer: "https://auth.example.test",
        tokenEndpoint: "https://auth.example.test/token",
      }),
    ),
    (error: unknown) =>
      error instanceof McpRemoteError &&
      error.code === "credential_token_failed" &&
      /prohibited network address/u.test(error.message),
  );

  const fetch = createBrokeredTokenFetch("https://auth.example.test/token", {
    resolve: async () => [{ address: "1.1.1.1", family: 4 }],
  });
  await assert.rejects(
    fetch("https://auth.example.test/other", { method: "POST" }),
    /outside the pinned token endpoint/u,
  );
  await assert.rejects(
    fetch("https://auth.example.test/token", { method: "GET" }),
    /outside the pinned token endpoint/u,
  );
  assert.throws(() =>
    createBrokeredTokenFetch("http://auth.example.test/token"),
  );
});

test("the token endpoint never receives OAO or MCP request headers", async (t) => {
  const server = await fixture(t);
  const fetch = createBrokeredTokenFetch(
    `${server.authBase}/token`,
    server.egress,
  );
  await fetch(`${server.authBase}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-oao-run-id": "00000000-0000-4000-8000-000000000001",
      "mcp-session-id": "session",
      cookie: "a=b",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const headers = server.tokenRequests[0]!.headers;
  assert.equal(headers["x-oao-run-id"], undefined);
  assert.equal(headers["mcp-session-id"], undefined);
  assert.equal(headers.cookie, undefined);
});

test("an OAuth connection needs a token and stays inside the pinned destination", () => {
  const material: McpOAuthClientCredentialsMaterial = {
    kind: "oauth_client_credentials",
    organizationId: "00000000-0000-4000-8000-000000000001",
    credentialVersionId: "00000000-0000-4000-8000-000000000002",
    issuer: "https://auth.example.test",
    tokenEndpoint: "https://auth.example.test/token",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokenEndpointAuthMethod: "client_secret_post",
    scope: SCOPE,
    resource: "https://mcp.example.test/mcp",
    resourceMetadataUrl:
      "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
    sendResource: true,
  };
  const definition: McpConnectionDefinition = {
    endpointUrl: "https://mcp.example.test/mcp",
    exactOrigin: "https://mcp.example.test",
    pathPrefix: "/mcp",
    credentialDestination: {
      origin: "https://mcp.example.test",
      pathPrefix: "/mcp",
    },
    transport: "streamable_http",
    credential: material,
  };
  assert.throws(
    () => createBrokeredMcpFetch(definition),
    /requires an access token/u,
  );
  assert.throws(
    () =>
      createBrokeredMcpFetch(
        {
          ...definition,
          endpointUrl: "https://attacker.example.test/mcp",
          exactOrigin: "https://attacker.example.test",
        },
        {},
        { accessToken: "token" },
      ),
    /outside the credential policy/u,
  );
});

test("authorization discovery follows the challenge to protected resource and server metadata", async (t) => {
  const server = await fixture(t, { grantTypes: ["authorization_code"] });
  const discovery = await discoverMcpAuthorization(
    server.endpointUrl,
    server.egress,
  );
  assert.equal(discovery.resource, server.endpointUrl);
  assert.equal(discovery.resourceMetadataUrl, server.metadataUrl);
  assert.equal(discovery.resourceMetadataSource, "www_authenticate");
  assert.equal(discovery.challengeScope, SCOPE);
  assert.deepEqual(discovery.scopesSupported, [SCOPE]);
  assert.deepEqual(discovery.authorizationServers, [
    {
      issuer: server.authBase,
      metadataSource: "oauth",
      tokenEndpoint: `${server.authBase}/token`,
      tokenEndpointAuthMethodsSupported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      // Reported, not enforced: it omits client_credentials here.
      grantTypesSupported: ["authorization_code"],
      scopesSupported: [SCOPE],
      problem: null,
    },
  ]);
  // Discovery sent no credential anywhere.
  for (const request of [
    ...server.mcpRequests,
    ...server.authorizationRequests,
  ])
    assert.equal(request.headers.authorization, undefined);
  assert.equal(server.tokenRequests.length, 0);

  server.control.challengeHeader = false;
  const fallback = await discoverMcpAuthorization(
    server.endpointUrl,
    server.egress,
  );
  assert.equal(fallback.resourceMetadataSource, "well_known");
  assert.equal(fallback.resourceMetadataUrl, server.metadataUrl);
});

test("authorization discovery keeps a long issuer URL", async (t) => {
  const issuerPath = `/tenants/${"t".repeat(240)}`;
  const server = await fixture(t, { issuerPath });
  const discovery = await discoverMcpAuthorization(
    server.endpointUrl,
    server.egress,
  );
  assert.equal(
    discovery.authorizationServers[0]?.issuer,
    `${server.authBase}${issuerPath}`,
  );
  assert.equal(discovery.authorizationServers[0]?.problem, null);
});

test("authorization discovery refuses a foreign resource and flags a mismatched issuer", async (t) => {
  const mismatched = await fixture(t, { issuer: (base) => `${base}/other` });
  const discovery = await discoverMcpAuthorization(
    mismatched.endpointUrl,
    mismatched.egress,
  );
  assert.equal(discovery.authorizationServers[0]?.problem, "issuer_mismatch");
  assert.equal(discovery.authorizationServers[0]?.tokenEndpoint, null);

  // A server without protected resource metadata cannot be configured.
  await assert.rejects(
    discoverMcpAuthorization(
      `${mismatched.endpointUrl}/elsewhere`,
      mismatched.egress,
    ),
    (error: unknown) =>
      error instanceof McpRemoteError &&
      error.code === "authorization_discovery_failed",
  );
  // Metadata for another resource is never accepted for this endpoint.
  mismatched.control.resource = `${mismatched.endpointUrl}-other`;
  await assert.rejects(
    discoverMcpAuthorization(mismatched.endpointUrl, mismatched.egress),
    (error: unknown) =>
      error instanceof McpRemoteError && error.code === "resource_mismatch",
  );
});

test("testing a credential re-checks the pinned metadata and returns only the token's lifetime", async (t) => {
  const server = await fixture(t, { expiresIn: 900 });
  const client = new McpRemoteClient(server.egress);
  assert.deepEqual(await client.testCredential(server.credential()), {
    expiresIn: 900,
    grantedScope: SCOPE,
  });
  assert.equal(
    await codeOf(
      client.testCredential(
        server.credential({
          resourceMetadataUrl:
            "https://elsewhere.example.test/.well-known/oauth-protected-resource",
        }),
      ),
    ),
    "authorization_server_changed",
  );
  server.control.tokenStatus = 401;
  assert.equal(
    await codeOf(client.testCredential(server.credential())),
    "credential_token_failed",
  );
});
