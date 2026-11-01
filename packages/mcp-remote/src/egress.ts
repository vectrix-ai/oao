import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, Transform } from "node:stream";

const MAXIMUM_REQUEST_BYTES = 262_144;

/** An egress rule OAO enforced itself. Its message never carries a secret. */
export class McpEgressRefusal extends Error {
  override readonly name = "McpEgressRefusal";
}

export interface McpEgressOptions {
  /**
   * Test and local-development escape hatch; see `allowPrivateMcpNetwork`.
   * Production callers must leave this disabled.
   */
  readonly allowPrivateNetwork?: boolean;
  readonly resolve?: (
    hostname: string,
  ) => Promise<
    readonly { readonly address: string; readonly family: number }[]
  >;
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

/**
 * Reads `OAO_MCP_ALLOW_PRIVATE_NETWORK`. The escape hatch exists for MCP
 * servers on a developer's machine or private network, such as a tailnet, so
 * it is refused outside `NODE_ENV=development` instead of silently weakening
 * egress checks.
 */
export function allowPrivateMcpNetwork(env: NodeJS.ProcessEnv): boolean {
  const value = env.OAO_MCP_ALLOW_PRIVATE_NETWORK;
  if (value === undefined || value === "" || value === "false") return false;
  if (value !== "true")
    throw new Error("OAO_MCP_ALLOW_PRIVATE_NETWORK must be true or false");
  if ((env.NODE_ENV ?? "development") !== "development")
    throw new Error(
      "OAO_MCP_ALLOW_PRIVATE_NETWORK is only allowed with NODE_ENV=development",
    );
  return true;
}

export async function requestBody(
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
    throw new McpEgressRefusal("MCP request exceeds the configured size limit");
  return body;
}

/**
 * Resolves a destination and refuses it unless every address is public. The
 * caller pins the connection to the first address so a second lookup cannot
 * rebind the name to a private network.
 */
export async function resolvedAddresses(
  endpoint: URL,
  options: McpEgressOptions,
): Promise<readonly { readonly address: string; readonly family: number }[]> {
  if (endpoint.protocol !== "https:" && !options.allowPrivateNetwork)
    throw new McpEgressRefusal("MCP egress requires HTTPS");
  const addresses = options.resolve
    ? await options.resolve(endpoint.hostname)
    : await lookup(endpoint.hostname, { all: true, verbatim: true });
  if (addresses.length === 0)
    throw new McpEgressRefusal("MCP destination did not resolve");
  if (
    !options.allowPrivateNetwork &&
    addresses.some((entry) => !isPublicNetworkAddress(entry.address))
  )
    throw new McpEgressRefusal(
      "MCP destination resolves to a prohibited network address",
    );
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

export interface PinnedRequest {
  readonly method: string;
  readonly headers: Headers;
  readonly body: Buffer;
  readonly signal?: AbortSignal | null | undefined;
  readonly timeoutMs: number;
  readonly maximumResponseBytes: number;
}

/**
 * Sends one request to a DNS-pinned, public address and never follows a
 * redirect. The response body streams through a size limit; exceeding it
 * fails the stream.
 */
export async function sendPinned(
  url: URL,
  input: PinnedRequest,
  options: McpEgressOptions,
): Promise<Response> {
  if (input.signal?.aborted)
    throw input.signal.reason instanceof Error
      ? input.signal.reason
      : new Error("MCP request was cancelled");
  const addresses = await resolvedAddresses(url, options);
  const selected = addresses[0]!;
  const makeRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(new Error("MCP request timed out")),
      input.timeoutMs,
    );
    const onCallerAbort = () => abort.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onCallerAbort);
    };
    const outgoing = makeRequest(
      url,
      {
        method: input.method,
        headers: Object.fromEntries(input.headers.entries()),
        signal: abort.signal,
        lookup: pinnedLookup(selected),
        ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
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
            if (received > input.maximumResponseBytes) {
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
        limiter.once("close", () => {
          // A consumer that cancels the body ends the request too.
          if (!incoming.complete) abort.abort();
        });
        incoming.once("aborted", cleanup);
        incoming.once("error", (error) => {
          cleanup();
          limiter.destroy(error);
        });
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
    if (input.body.byteLength > 0) outgoing.write(input.body);
    outgoing.end();
  });
}

export function requestedUrl(input: string | URL | Request): URL {
  return input instanceof Request
    ? new URL(input.url)
    : input instanceof URL
      ? new URL(input.href)
      : new URL(String(input));
}
