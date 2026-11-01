import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  extractWWWAuthenticateParams,
  type FetchLike,
  type Tool,
} from "@modelcontextprotocol/client";
import { validateToolJsonSchema, validateToolJsonValue } from "@oao/contracts";
import {
  requestBody,
  requestedUrl,
  sendPinned,
  type McpEgressOptions,
} from "./egress.js";
import {
  McpRemoteError,
  McpTokenBroker,
  OAUTH_CLIENT_CREDENTIALS_EXTENSION,
  discoverMcpAuthorization,
  matchesPinnedAuthorization,
  sameMcpUrl,
  type McpAuthorizationDiscovery,
  type McpCredentialTestResult,
  type McpOAuthClientCredentialsMaterial,
} from "./oauth.js";

export {
  allowPrivateMcpNetwork,
  isPublicNetworkAddress,
  type McpEgressOptions,
} from "./egress.js";
export {
  McpRemoteError,
  McpTokenBroker,
  OAUTH_CLIENT_CREDENTIALS_EXTENSION,
  createBrokeredTokenFetch,
  discoverMcpAuthorization,
  matchesPinnedAuthorization,
  sameResource,
  type McpAuthorizationDiscovery,
  type McpAuthorizationServerDiscovery,
  type McpCredentialTestResult,
  type McpOAuthClientCredentialsMaterial,
  type McpRemoteErrorCode,
  type McpTokenEndpointAuthMethod,
} from "./oauth.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1_048_576;
const MAXIMUM_DISCOVERED_TOOLS = 256;
const MAXIMUM_DESCRIPTION_CHARACTERS = 2_000;
const FORBIDDEN_SECRET_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type McpTransport = "streamable_http" | "legacy_sse";
export type McpCredentialMaterial =
  | { readonly kind: "static_bearer"; readonly secret: string }
  | {
      readonly kind: "api_key_header";
      readonly headerName: string;
      readonly secret: string;
    }
  | McpOAuthClientCredentialsMaterial;

export interface McpCredentialDestination {
  readonly origin: string;
  readonly pathPrefix: string;
}

/**
 * OAO identity a policy opted in to forward. The broker sends the
 * organization and project on every request, and the call fields on the
 * requests made for one tool call.
 */
export interface McpCallContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly call?: {
    readonly sessionId: string;
    readonly runId: string;
    /** The deterministic OAO tool-call ID, stable across recovery. */
    readonly toolCallId: string;
    /** Lowercase hex SHA-256 of the run's idempotency key. */
    readonly runKeySha256: string;
  };
}

export interface McpConnectionDefinition {
  readonly endpointUrl: string;
  /** Credential-bearing requests may target only this origin and path prefix. */
  readonly exactOrigin?: string;
  readonly pathPrefix?: string;
  /**
   * The destination pinned on the credential version. Every credential-bearing
   * request must also lie inside it, on a path-segment boundary.
   */
  readonly credentialDestination?: McpCredentialDestination;
  readonly transport: McpTransport;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly credential?: McpCredentialMaterial;
  /** Absent unless the credential policy forwards call context. */
  readonly context?: McpCallContext;
}

export interface McpDiscoveredTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export interface McpToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly responseBytes: number;
}

export interface McpRemotePort {
  discover(
    connection: McpConnectionDefinition,
    signal?: AbortSignal,
  ): Promise<readonly McpDiscoveredTool[]>;
  call(
    connection: McpConnectionDefinition,
    input: {
      readonly tool: McpDiscoveredTool;
      readonly arguments: Readonly<Record<string, unknown>>;
    },
    signal?: AbortSignal,
  ): Promise<McpToolResult>;
  /** Credential-free authorization discovery for a new OAuth credential. */
  discoverAuthorization(
    endpointUrl: string,
    signal?: AbortSignal,
  ): Promise<McpAuthorizationDiscovery>;
  /**
   * Re-checks the pinned authorization metadata and requests a fresh token.
   * Returns only its lifetime and granted scope, never the token.
   */
  testCredential(
    credential: McpOAuthClientCredentialsMaterial,
    signal?: AbortSignal,
  ): Promise<McpCredentialTestResult>;
  /**
   * Obtains the access token a later call will use, so token failures are
   * known before a call attempt is recorded. A no-op for static credentials.
   */
  prepareCredential?(
    credential: McpCredentialMaterial,
    signal?: AbortSignal,
    /** The policy timeout the token request must also respect. */
    timeoutMs?: number,
  ): Promise<void>;
}

function canonicalEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password)
    throw new TypeError("MCP endpoint must not contain user information");
  if (endpoint.hash)
    throw new TypeError("MCP endpoint must not contain a fragment");
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
    throw new TypeError("MCP endpoint must use HTTPS");
  endpoint.hostname = endpoint.hostname.toLowerCase();
  return endpoint;
}

/**
 * True when `path` equals `prefix` or continues it after a "/" boundary:
 * "/mcp" contains "/mcp" and "/mcp/v2" but not "/mcpx".
 */
export function isPathWithin(path: string, prefix: string): boolean {
  return (
    path === prefix ||
    (path.startsWith(prefix) &&
      (prefix.endsWith("/") || path.charAt(prefix.length) === "/"))
  );
}

function withinDestination(
  url: URL,
  destination: McpCredentialDestination | undefined,
): boolean {
  if (!destination) return true;
  return (
    url.origin === new URL(destination.origin).origin &&
    isPathWithin(url.pathname, destination.pathPrefix)
  );
}

export function validateCredentialHeaderName(value: string): string {
  const header = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/u.test(header))
    throw new TypeError("MCP credential header name is invalid");
  if (FORBIDDEN_SECRET_HEADERS.has(header))
    throw new TypeError("MCP credential header is not allowed");
  if (header.startsWith(CALL_CONTEXT_HEADER_PREFIX))
    throw new TypeError("x-oao-* headers are reserved for OAO call context");
  return header;
}

const CALL_CONTEXT_HEADER_PREFIX = "x-oao-";
const CALL_CONTEXT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CALL_CONTEXT_SHA256 = /^[0-9a-f]{64}$/u;

/**
 * The X-OAO-* headers for a call context, validated so a malformed value
 * fails before any byte is sent.
 */
export function callContextHeaders(
  context: McpCallContext,
): readonly (readonly [string, string])[] {
  const identifiers: (readonly [string, string])[] = [
    ["x-oao-organization-id", context.organizationId],
    ["x-oao-project-id", context.projectId],
  ];
  if (context.call)
    identifiers.push(
      ["x-oao-session-id", context.call.sessionId],
      ["x-oao-run-id", context.call.runId],
      ["x-oao-tool-call-id", context.call.toolCallId],
    );
  for (const [, value] of identifiers)
    if (!CALL_CONTEXT_UUID.test(value))
      throw new TypeError("MCP call context identifier is invalid");
  if (!context.call) return identifiers;
  if (!CALL_CONTEXT_SHA256.test(context.call.runKeySha256))
    throw new TypeError("MCP call context run key hash is invalid");
  return [...identifiers, ["x-oao-run-key-sha256", context.call.runKeySha256]];
}

function cleanDescription(value: unknown): string {
  const text = [...(typeof value === "string" ? value : "Remote MCP tool")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint < 32 && ![9, 10, 13].includes(codePoint)) ||
        codePoint === 127
        ? " "
        : character;
    })
    .join("")
    .slice(0, MAXIMUM_DESCRIPTION_CHARACTERS)
    .trim();
  return text || "Remote MCP tool";
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const REMOTE_SCHEMA_ANNOTATIONS = new Set(["title", "description", "examples"]);

/**
 * Canonicalizes schema shapes commonly emitted by MCP servers into OAO's
 * validation-only subset. Defaults and dialect declarations do not affect
 * validation. A simple `T | null` union is equivalent to JSON Schema's nullable
 * type array. Every other unknown keyword remains present and therefore fails
 * closed in validateToolJsonSchema.
 */
function normalizeRemoteToolSchema(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const anyOf = input.anyOf;
  const outerKeys = Object.keys(input).filter(
    (key) => !["anyOf", "$schema", "default"].includes(key),
  );
  if (
    Array.isArray(anyOf) &&
    anyOf.length === 2 &&
    outerKeys.every((key) => REMOTE_SCHEMA_ANNOTATIONS.has(key))
  ) {
    const variants = anyOf.filter(isSchemaRecord);
    const nullVariant = variants.find(
      (variant) => variant.type === "null" && Object.keys(variant).length === 1,
    );
    const valueVariant = variants.find((variant) => variant !== nullVariant);
    if (
      variants.length === 2 &&
      nullVariant &&
      valueVariant &&
      typeof valueVariant.type === "string" &&
      valueVariant.type !== "null"
    ) {
      return normalizeRemoteToolSchema({
        ...valueVariant,
        ...Object.fromEntries(
          outerKeys.map((key) => [key, input[key]] as const),
        ),
        type: [valueVariant.type, "null"],
      });
    }
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "$schema" || key === "default") continue;
    if (key === "properties" && isSchemaRecord(value)) {
      normalized.properties = Object.fromEntries(
        Object.entries(value).map(([property, schema]) => [
          property,
          isSchemaRecord(schema) ? normalizeRemoteToolSchema(schema) : schema,
        ]),
      );
      continue;
    }
    if (
      (key === "items" || key === "additionalProperties") &&
      isSchemaRecord(value)
    ) {
      normalized[key] = normalizeRemoteToolSchema(value);
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function toolDefinition(tool: McpDiscoveredTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  } as Tool;
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource") {
        const resource = block.resource;
        return "text" in resource ? resource.text : "[binary resource omitted]";
      }
      return `[${block.type} content omitted]`;
    })
    .join("\n");
  if (text) return text;
  if (result.structuredContent !== undefined)
    return JSON.stringify(result.structuredContent);
  return "";
}

/**
 * What one connection attempt sends and observes beyond the static
 * definition: the OAuth access token to inject, and a callback that sees each
 * response before the SDK does.
 */
export interface McpFetchSession {
  readonly accessToken?: string;
  readonly observe?: (response: Response) => void;
}

export function createBrokeredMcpFetch(
  definition: McpConnectionDefinition,
  options: McpEgressOptions = {},
  session: McpFetchSession = {},
): FetchLike {
  const endpoint = canonicalEndpoint(definition.endpointUrl);
  const exactOrigin = definition.exactOrigin
    ? new URL(definition.exactOrigin).origin
    : endpoint.origin;
  const pathPrefix = definition.pathPrefix ?? endpoint.pathname;
  if (
    endpoint.origin !== exactOrigin ||
    !pathPrefix.startsWith("/") ||
    !endpoint.pathname.startsWith(pathPrefix) ||
    (definition.credential &&
      !withinDestination(endpoint, definition.credentialDestination))
  )
    throw new TypeError("MCP endpoint is outside the credential policy");
  const maximumResponseBytes =
    definition.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1_024 ||
    maximumResponseBytes > 10_485_760
  )
    throw new TypeError("MCP response limit must be between 1 KiB and 10 MiB");
  const credential = definition.credential;
  // The client secret never travels to the MCP server; only the access token
  // obtained from the pinned token endpoint does.
  if (credential?.kind === "oauth_client_credentials" && !session.accessToken)
    throw new TypeError("An OAuth MCP connection requires an access token");
  const contextHeaders = definition.context
    ? callContextHeaders(definition.context)
    : [];

  return async (input, init = {}) => {
    if (init.signal?.aborted)
      throw init.signal.reason instanceof Error
        ? init.signal.reason
        : new Error("MCP request was cancelled");
    const requested = requestedUrl(input);
    if (
      (requested.protocol !== "https:" && !options.allowPrivateNetwork) ||
      requested.origin !== exactOrigin ||
      !requested.pathname.startsWith(pathPrefix) ||
      (credential &&
        !withinDestination(requested, definition.credentialDestination))
    )
      throw new Error(
        "MCP request destination is outside the credential policy",
      );
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init.headers).forEach((value, name) =>
      headers.set(name, value),
    );
    for (const name of FORBIDDEN_SECRET_HEADERS) headers.delete(name);
    headers.delete("authorization");
    // Only the broker sets OAO call identity; nothing upstream may.
    for (const name of [...headers.keys()])
      if (name.startsWith(CALL_CONTEXT_HEADER_PREFIX)) headers.delete(name);
    if (credential?.kind === "static_bearer")
      headers.set("authorization", `Bearer ${credential.secret}`);
    else if (credential?.kind === "api_key_header")
      headers.set(
        validateCredentialHeaderName(credential.headerName),
        credential.secret,
      );
    else if (credential?.kind === "oauth_client_credentials")
      headers.set("authorization", `Bearer ${session.accessToken!}`);
    for (const [name, value] of contextHeaders) headers.set(name, value);
    const method =
      init.method ?? (input instanceof Request ? input.method : "GET");
    const inheritedBody =
      input instanceof Request && method !== "GET" && method !== "HEAD"
        ? await input.arrayBuffer()
        : undefined;
    const response = await sendPinned(
      requested,
      {
        method,
        headers,
        body: await requestBody(init.body ?? inheritedBody),
        signal: init.signal,
        timeoutMs: definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maximumResponseBytes,
      },
      options,
    );
    session.observe?.(response);
    return response;
  };
}

/** What the brokered fetch saw of the server's authorization decisions. */
interface AuthorizationObservation {
  unauthorized?: { readonly resourceMetadataUrl: string | undefined };
  forbidden?: { readonly error: string | undefined };
}

function observeAuthorization(
  observation: AuthorizationObservation,
): (response: Response) => void {
  return (response) => {
    if (response.status === 401 && !observation.unauthorized)
      observation.unauthorized = {
        resourceMetadataUrl:
          extractWWWAuthenticateParams(response).resourceMetadataUrl?.href,
      };
    else if (response.status === 403 && !observation.forbidden)
      observation.forbidden = {
        error: extractWWWAuthenticateParams(response).error,
      };
  };
}

/** Replaces a failure the server explained with a safe, coded error. */
function authorizationFailure(
  observation: AuthorizationObservation,
  error: unknown,
): unknown {
  if (error instanceof McpRemoteError) return error;
  if (observation.unauthorized)
    return new McpRemoteError(
      "credential_rejected",
      "The MCP server rejected the credential",
    );
  if (observation.forbidden?.error === "insufficient_scope")
    return new McpRemoteError(
      "insufficient_scope",
      "The MCP server requires a scope the credential was not granted",
    );
  if (observation.forbidden)
    return new McpRemoteError(
      "remote_forbidden",
      "The MCP server refused the request",
    );
  return error;
}

export class McpRemoteClient implements McpRemotePort {
  readonly #tokens: McpTokenBroker;

  constructor(private readonly egressOptions: McpEgressOptions = {}) {
    this.#tokens = new McpTokenBroker(egressOptions);
  }

  private client(
    connection: McpConnectionDefinition,
    session: McpFetchSession,
  ): {
    readonly client: Client;
    readonly transport: StreamableHTTPClientTransport | SSEClientTransport;
  } {
    const fetch = createBrokeredMcpFetch(
      connection,
      this.egressOptions,
      session,
    );
    const endpoint = canonicalEndpoint(connection.endpointUrl);
    // No authProvider: the SDK would send OAuth traffic through the MCP
    // broker. OAO obtains tokens itself and the broker only injects them.
    const transport =
      connection.transport === "legacy_sse"
        ? new SSEClientTransport(endpoint, { fetch })
        : new StreamableHTTPClientTransport(endpoint, {
            fetch,
            onInsufficientScope: "throw",
          });
    const client = new Client(
      { name: "oao", version: "0.10.0" }, // x-release-please-version
      {
        capabilities:
          connection.credential?.kind === "oauth_client_credentials"
            ? { extensions: { [OAUTH_CLIENT_CREDENTIALS_EXTENSION]: {} } }
            : {},
        versionNegotiation: { mode: "auto", probe: { maxRetries: 0 } },
      },
    );
    return { client, transport };
  }

  /**
   * Runs one connection attempt with the credential's authorization. For an
   * OAuth credential a 401 drops the cached token and retries once with a new
   * one, unless the challenge names other resource metadata than the pinned
   * one; a second 401 fails as credential_rejected.
   */
  private async authorized<T>(
    connection: McpConnectionDefinition,
    signal: AbortSignal | undefined,
    attempt: (session: McpFetchSession) => Promise<T>,
  ): Promise<T> {
    const credential = connection.credential;
    if (credential?.kind !== "oauth_client_credentials") {
      const observation: AuthorizationObservation = {};
      try {
        return await attempt({ observe: observeAuthorization(observation) });
      } catch (error) {
        throw authorizationFailure(observation, error);
      }
    }
    for (let retry = 0; ; retry += 1) {
      const token = await this.#tokens.token(credential, {
        ...(signal ? { signal } : {}),
        timeoutMs: connection.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const observation: AuthorizationObservation = {};
      try {
        return await attempt({
          accessToken: token.accessToken,
          observe: observeAuthorization(observation),
        });
      } catch (error) {
        if (!observation.unauthorized)
          throw authorizationFailure(observation, error);
        const advertised = observation.unauthorized.resourceMetadataUrl;
        if (
          advertised &&
          !sameMcpUrl(advertised, credential.resourceMetadataUrl)
        )
          throw new McpRemoteError(
            "authorization_server_changed",
            "The MCP server now names different authorization metadata than the credential pinned",
          );
        this.#tokens.invalidate(credential, token.accessToken);
        if (retry >= 1) throw authorizationFailure(observation, error);
      }
    }
  }

  discoverAuthorization(
    endpointUrl: string,
    signal?: AbortSignal,
  ): Promise<McpAuthorizationDiscovery> {
    return discoverMcpAuthorization(endpointUrl, {
      ...this.egressOptions,
      ...(signal ? { signal } : {}),
    });
  }

  async testCredential(
    credential: McpOAuthClientCredentialsMaterial,
    signal?: AbortSignal,
  ): Promise<McpCredentialTestResult> {
    let discovery: McpAuthorizationDiscovery;
    try {
      discovery = await this.discoverAuthorization(credential.resource, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new McpRemoteError(
        "authorization_server_changed",
        "The MCP server's authorization metadata could not be confirmed",
      );
    }
    if (!matchesPinnedAuthorization(discovery, credential))
      throw new McpRemoteError(
        "authorization_server_changed",
        "The MCP server's authorization metadata no longer matches the credential",
      );
    const token = await this.#tokens.token(credential, {
      ...(signal ? { signal } : {}),
      fresh: true,
    });
    return { expiresIn: token.expiresIn, grantedScope: token.grantedScope };
  }

  async prepareCredential(
    credential: McpCredentialMaterial,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<void> {
    if (credential.kind !== "oauth_client_credentials") return;
    await this.#tokens.token(credential, {
      ...(signal ? { signal } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  discover(
    connection: McpConnectionDefinition,
    signal?: AbortSignal,
  ): Promise<readonly McpDiscoveredTool[]> {
    return this.authorized(connection, signal, (session) =>
      this.discoverOnce(connection, session, signal),
    );
  }

  private async discoverOnce(
    connection: McpConnectionDefinition,
    session: McpFetchSession,
    signal: AbortSignal | undefined,
  ): Promise<readonly McpDiscoveredTool[]> {
    const { client, transport } = this.client(connection, session);
    try {
      await client.connect(transport, {
        timeout: connection.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      const tools: McpDiscoveredTool[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: connection.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
          cacheMode: "bypass",
        });
        for (const tool of page.tools) {
          if (tools.length >= MAXIMUM_DISCOVERED_TOOLS)
            throw new Error("MCP server exposes too many tools");
          if (
            typeof tool.name !== "string" ||
            tool.name.length < 1 ||
            tool.name.length > 200 ||
            [...tool.name].some((character) => {
              const codePoint = character.codePointAt(0) ?? 0;
              return codePoint < 32 || codePoint === 127;
            })
          )
            throw new Error("MCP server returned an invalid tool name");
          const inputSchema = normalizeRemoteToolSchema(
            tool.inputSchema as Readonly<Record<string, unknown>>,
          );
          const outputSchema = tool.outputSchema
            ? normalizeRemoteToolSchema(
                tool.outputSchema as Readonly<Record<string, unknown>>,
              )
            : undefined;
          if (
            !validateToolJsonSchema(inputSchema, {
              requireObjectRoot: true,
            }).valid
          )
            throw new Error(
              `MCP tool ${tool.name} uses an unsupported input schema`,
            );
          if (
            outputSchema !== undefined &&
            !validateToolJsonSchema(outputSchema, {
              requireObjectRoot: true,
            }).valid
          )
            throw new Error(
              `MCP tool ${tool.name} uses an unsupported output schema`,
            );
          if (tools.some((entry) => entry.name === tool.name))
            throw new Error(`MCP server returned duplicate tool ${tool.name}`);
          tools.push({
            name: tool.name,
            ...(tool.title
              ? { title: cleanDescription(tool.title).slice(0, 200) }
              : {}),
            description: cleanDescription(tool.description),
            inputSchema,
            ...(outputSchema
              ? {
                  outputSchema,
                }
              : {}),
          });
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error("MCP discovery returned a repeated cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return tools;
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async call(
    connection: McpConnectionDefinition,
    input: {
      readonly tool: McpDiscoveredTool;
      readonly arguments: Readonly<Record<string, unknown>>;
    },
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const validation = validateToolJsonValue(
      input.tool.inputSchema,
      input.arguments,
    );
    if (!validation.valid)
      throw new TypeError("MCP tool arguments are invalid");
    // A 401 is answered before the server runs the tool, so retrying the
    // call once with a new token cannot repeat it.
    return this.authorized(connection, signal, (session) =>
      this.callOnce(connection, input, session, signal),
    );
  }

  private async callOnce(
    connection: McpConnectionDefinition,
    input: {
      readonly tool: McpDiscoveredTool;
      readonly arguments: Readonly<Record<string, unknown>>;
    },
    session: McpFetchSession,
    signal: AbortSignal | undefined,
  ): Promise<McpToolResult> {
    const { client, transport } = this.client(connection, session);
    try {
      await client.connect(transport, {
        timeout: connection.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      const result = await client.callTool(
        { name: input.tool.name, arguments: input.arguments },
        {
          timeout: connection.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
          toolDefinition: toolDefinition(input.tool),
        },
      );
      const content = resultText(result);
      const responseBytes = Buffer.byteLength(content);
      if (
        responseBytes >
        (connection.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES)
      )
        throw new Error("MCP tool result exceeds the configured size limit");
      return { content, isError: result.isError === true, responseBytes };
    } finally {
      await transport.close().catch(() => undefined);
    }
  }
}
