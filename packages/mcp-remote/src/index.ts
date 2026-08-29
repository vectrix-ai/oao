import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, Transform } from "node:stream";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type FetchLike,
  type Tool,
} from "@modelcontextprotocol/client";
import { validateToolJsonSchema, validateToolJsonValue } from "@oao/contracts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1_048_576;
const MAXIMUM_DISCOVERED_TOOLS = 256;
const MAXIMUM_DESCRIPTION_CHARACTERS = 2_000;
const MAXIMUM_REQUEST_BYTES = 262_144;
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
    };

export interface McpConnectionDefinition {
  readonly endpointUrl: string;
  /** Credential-bearing requests may target only this origin and path prefix. */
  readonly exactOrigin?: string;
  readonly pathPrefix?: string;
  readonly transport: McpTransport;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly credential?: McpCredentialMaterial;
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
}

export interface McpEgressOptions {
  /** Test-only escape hatch. Production callers must leave this disabled. */
  readonly allowPrivateNetwork?: boolean;
  readonly resolve?: (
    hostname: string,
  ) => Promise<
    readonly { readonly address: string; readonly family: number }[]
  >;
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

function isBlockedIpv4(address: string): boolean {
  const bytes = address.split(".").map(Number);
  if (bytes.length !== 4 || bytes.some((part) => !Number.isInteger(part)))
    return true;
  const [a = 0, b = 0] = bytes;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && bytes[2] === 100) ||
    (a === 203 && b === 0 && bytes[2] === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("::ffff:") ||
    normalized.includes(".") ||
    normalized.startsWith("64:ff9b:") ||
    normalized.startsWith("100:") ||
    normalized.startsWith("2001:2:") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2002:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith("ff") ||
    !/^[23]/u.test(normalized)
  )
    return true;
  return false;
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isBlockedIpv4(address);
  if (family === 6) return !isBlockedIpv6(address);
  return false;
}

export function validateCredentialHeaderName(value: string): string {
  const header = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/u.test(header))
    throw new TypeError("MCP credential header name is invalid");
  if (FORBIDDEN_SECRET_HEADERS.has(header))
    throw new TypeError("MCP credential header is not allowed");
  return header;
}

async function requestBody(
  value: BodyInit | null | undefined,
): Promise<Buffer> {
  if (value === null || value === undefined) return Buffer.alloc(0);
  let body: Buffer;
  if (typeof value === "string") body = Buffer.from(value);
  else if (value instanceof URLSearchParams)
    body = Buffer.from(value.toString());
  else if (value instanceof ArrayBuffer) body = Buffer.from(value);
  else if (ArrayBuffer.isView(value))
    body = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else if (value instanceof Blob) body = Buffer.from(await value.arrayBuffer());
  else throw new TypeError("Streaming MCP request bodies are not supported");
  if (body.byteLength > MAXIMUM_REQUEST_BYTES)
    throw new Error("MCP request exceeds the configured size limit");
  return body;
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

async function resolvedAddresses(
  endpoint: URL,
  options: McpEgressOptions,
): Promise<readonly { readonly address: string; readonly family: number }[]> {
  if (endpoint.protocol !== "https:" && !options.allowPrivateNetwork)
    throw new Error("MCP egress requires HTTPS");
  const addresses = options.resolve
    ? await options.resolve(endpoint.hostname)
    : await lookup(endpoint.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("MCP endpoint did not resolve");
  if (
    !options.allowPrivateNetwork &&
    addresses.some((entry) => !isPublicNetworkAddress(entry.address))
  )
    throw new Error("MCP endpoint resolves to a prohibited network address");
  return addresses;
}

function pinnedLookup(
  selected: Readonly<{ address: string; family: number }>,
): LookupFunction {
  return (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [selected]);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

export function createBrokeredMcpFetch(
  definition: McpConnectionDefinition,
  options: McpEgressOptions = {},
): FetchLike {
  const endpoint = canonicalEndpoint(definition.endpointUrl);
  const exactOrigin = definition.exactOrigin
    ? new URL(definition.exactOrigin).origin
    : endpoint.origin;
  const pathPrefix = definition.pathPrefix ?? endpoint.pathname;
  if (
    endpoint.origin !== exactOrigin ||
    !pathPrefix.startsWith("/") ||
    !endpoint.pathname.startsWith(pathPrefix)
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

  return async (input, init = {}) => {
    if (init.signal?.aborted)
      throw init.signal.reason instanceof Error
        ? init.signal.reason
        : new Error("MCP request was cancelled");
    const requested =
      input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? new URL(input.href)
          : new URL(String(input));
    if (
      (requested.protocol !== "https:" && !options.allowPrivateNetwork) ||
      requested.origin !== exactOrigin ||
      !requested.pathname.startsWith(pathPrefix)
    )
      throw new Error(
        "MCP request destination is outside the credential policy",
      );
    const addresses = await resolvedAddresses(requested, options);
    const selected = addresses[0]!;
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init.headers).forEach((value, name) =>
      headers.set(name, value),
    );
    for (const name of FORBIDDEN_SECRET_HEADERS) headers.delete(name);
    headers.delete("authorization");
    if (definition.credential?.kind === "static_bearer")
      headers.set("authorization", `Bearer ${definition.credential.secret}`);
    else if (definition.credential?.kind === "api_key_header")
      headers.set(
        validateCredentialHeaderName(definition.credential.headerName),
        definition.credential.secret,
      );
    const method =
      init.method ?? (input instanceof Request ? input.method : "GET");
    const inheritedBody =
      input instanceof Request && method !== "GET" && method !== "HEAD"
        ? await input.arrayBuffer()
        : undefined;
    const body = await requestBody(init.body ?? inheritedBody);
    const makeRequest =
      requested.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const abort = new AbortController();
      const timeout = setTimeout(
        () => abort.abort(new Error("MCP request timed out")),
        definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const onCallerAbort = () => abort.abort(init.signal?.reason);
      init.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timeout);
        init.signal?.removeEventListener("abort", onCallerAbort);
      };
      const outgoing = makeRequest(
        requested,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
          signal: abort.signal,
          lookup: pinnedLookup(selected),
          ...(requested.protocol === "https:"
            ? { servername: requested.hostname }
            : {}),
        },
        (incoming) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value))
              for (const item of value) responseHeaders.append(name, item);
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          let received = 0;
          const limiter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              received += chunk.byteLength;
              if (received > maximumResponseBytes) {
                callback(
                  new Error("MCP response exceeds the configured size limit"),
                );
                return;
              }
              callback(null, chunk);
            },
          });
          limiter.once("end", cleanup);
          limiter.once("error", cleanup);
          incoming.once("aborted", cleanup);
          incoming.pipe(limiter);
          const status = incoming.statusCode ?? 502;
          resolve(
            new Response(
              status === 204 || status === 304
                ? null
                : (Readable.toWeb(limiter) as ReadableStream<Uint8Array>),
              {
                status,
                ...(incoming.statusMessage
                  ? { statusText: incoming.statusMessage }
                  : {}),
                headers: responseHeaders,
              },
            ),
          );
        },
      );
      outgoing.once("error", (error: Error) => {
        cleanup();
        reject(error);
      });
      if (body.byteLength > 0) outgoing.write(body);
      outgoing.end();
    });
  };
}

export class McpRemoteClient implements McpRemotePort {
  constructor(private readonly egressOptions: McpEgressOptions = {}) {}

  private client(connection: McpConnectionDefinition): {
    readonly client: Client;
    readonly transport: StreamableHTTPClientTransport | SSEClientTransport;
  } {
    const fetch = createBrokeredMcpFetch(connection, this.egressOptions);
    const endpoint = canonicalEndpoint(connection.endpointUrl);
    const transport =
      connection.transport === "legacy_sse"
        ? new SSEClientTransport(endpoint, { fetch })
        : new StreamableHTTPClientTransport(endpoint, {
            fetch,
            onInsufficientScope: "throw",
          });
    const client = new Client(
      { name: "oao", version: "0.1.0" }, // x-release-please-version
      {
        capabilities: {},
        versionNegotiation: { mode: "auto", probe: { maxRetries: 0 } },
      },
    );
    return { client, transport };
  }

  async discover(
    connection: McpConnectionDefinition,
    signal?: AbortSignal,
  ): Promise<readonly McpDiscoveredTool[]> {
    const { client, transport } = this.client(connection);
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
    const { client, transport } = this.client(connection);
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
