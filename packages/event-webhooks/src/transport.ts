import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isPublicNetworkAddress } from "@oao/mcp-remote";
import { parseRetryAfter } from "./policy.js";
import { WebhookTransportError, type WebhookTransport } from "./types.js";

/** The most one delivery request may take, DNS resolution included. */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 15_000;
/**
 * After a reconfiguration invalidates a lease, the old holder may still have a
 * request in flight. Keeping the lease this much longer than the request
 * timeout stops another worker from sending an overlapping batch.
 */
export const WEBHOOK_RECONFIGURE_DRAIN_MS = WEBHOOK_REQUEST_TIMEOUT_MS + 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DRAIN_TIMEOUT_MS = 5_000;

export interface WebhookEndpointOptions {
  /**
   * Development only: allows `http://` URLs and loopback or private-network
   * destinations, such as a local Convex backend.
   */
  readonly allowPrivateNetwork?: boolean;
}

export interface WebhookTransportOptions extends WebhookEndpointOptions {
  readonly timeoutMs?: number;
  /** Test hook for DNS resolution. */
  readonly resolve?: (
    hostname: string,
  ) => Promise<
    readonly { readonly address: string; readonly family: number }[]
  >;
}

function hostAddress(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/u, "$1");
}

/**
 * Validates a webhook endpoint URL. Production endpoints must use HTTPS and a
 * public host. The transport re-checks resolved addresses on every delivery.
 */
export function validateWebhookEndpoint(
  value: string,
  options: WebhookEndpointOptions = {},
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Webhook endpoint must be an absolute URL");
  }
  if (url.username || url.password)
    throw new TypeError("Webhook endpoint must not contain user information");
  if (url.hash)
    throw new TypeError("Webhook endpoint must not contain a fragment");
  if (
    url.protocol !== "https:" &&
    !(options.allowPrivateNetwork && url.protocol === "http:")
  )
    throw new TypeError("Webhook endpoint must use HTTPS");
  const host = hostAddress(url);
  if (!host) throw new TypeError("Webhook endpoint must include a host");
  if (!options.allowPrivateNetwork) {
    if (host === "localhost" || host.endsWith(".localhost"))
      throw new TypeError("Webhook endpoint must not target a private network");
    if (isIP(host) && !isPublicNetworkAddress(host))
      throw new TypeError("Webhook endpoint must not target a private network");
  }
  return url;
}

function timeoutError(timeoutMs: number): WebhookTransportError {
  return new WebhookTransportError(
    "timeout",
    `Webhook endpoint did not respond within ${timeoutMs} ms`,
  );
}

/** Rejects with a timeout at the deadline; the abandoned work is ignored. */
async function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(timeoutError(timeoutMs)),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function pinnedLookup(selected: {
  readonly address: string;
  readonly family: number;
}): LookupFunction {
  return (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [selected]);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

/**
 * POSTs one webhook request. The destination is resolved once, every resolved
 * address must be public, and the connection is pinned to the checked address
 * so DNS rebinding cannot redirect it. Redirects are not followed.
 */
export function createWebhookTransport(
  options: WebhookTransportOptions = {},
): WebhookTransport {
  const timeoutMs = options.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS;
  return async (request) => {
    // One deadline covers resolution and the request, so the timeout is a
    // strict bound that lease draining can rely on.
    const deadline = Date.now() + timeoutMs;
    let url: URL;
    try {
      url = validateWebhookEndpoint(request.url, options);
    } catch (error) {
      throw new WebhookTransportError(
        "destination_blocked",
        error instanceof Error
          ? error.message
          : "Webhook endpoint is not allowed",
      );
    }
    const host = hostAddress(url);
    const family = isIP(host);
    let addresses: readonly {
      readonly address: string;
      readonly family: number;
    }[];
    try {
      addresses = family
        ? [{ address: host, family }]
        : await beforeDeadline(
            options.resolve
              ? options.resolve(host)
              : lookup(host, { all: true, verbatim: true }),
            deadline,
            timeoutMs,
          );
    } catch (error) {
      if (error instanceof WebhookTransportError) throw error;
      throw new WebhookTransportError(
        "connection_failed",
        "Webhook endpoint host did not resolve",
      );
    }
    const selected = addresses[0];
    if (!selected)
      throw new WebhookTransportError(
        "connection_failed",
        "Webhook endpoint host did not resolve",
      );
    if (
      !options.allowPrivateNetwork &&
      addresses.some((entry) => !isPublicNetworkAddress(entry.address))
    )
      throw new WebhookTransportError(
        "destination_blocked",
        "Webhook endpoint resolves to a prohibited network address",
      );

    const client = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: WebhookTransportError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const outgoing = client.request(
        url,
        {
          method: "POST",
          agent: false,
          lookup: pinnedLookup(selected),
          headers: {
            ...request.headers,
            "content-length": String(Buffer.byteLength(request.body)),
          },
        },
        (response) => {
          if (settled) {
            response.destroy();
            return;
          }
          settled = true;
          clearTimeout(timer);
          // Drain a bounded amount of the body for a bounded time; its content
          // is never used, and a stalled body must not pin the socket.
          let received = 0;
          const drainTimer = setTimeout(
            () => response.destroy(),
            DRAIN_TIMEOUT_MS,
          );
          drainTimer.unref();
          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) response.destroy();
          });
          response.on("close", () => clearTimeout(drainTimer));
          response.on("error", () => undefined);
          const retryAfter = response.headers["retry-after"];
          const retryAfterMs = parseRetryAfter(
            Array.isArray(retryAfter) ? retryAfter[0] : retryAfter,
          );
          resolve({
            status: response.statusCode ?? 0,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          });
        },
      );
      const timer = setTimeout(
        () => {
          fail(timeoutError(timeoutMs));
          outgoing.destroy();
        },
        Math.max(0, deadline - Date.now()),
      );
      outgoing.on("error", () =>
        fail(
          new WebhookTransportError(
            "connection_failed",
            "Webhook endpoint connection failed",
          ),
        ),
      );
      outgoing.end(request.body);
    });
  };
}

/**
 * Reads `OAO_EVENT_WEBHOOKS_ALLOW_PRIVATE_NETWORK`. The escape hatch exists for
 * local receivers such as a development Convex backend, so it is refused
 * outside `NODE_ENV=development` instead of silently weakening egress checks.
 */
export function allowPrivateWebhookNetwork(env: NodeJS.ProcessEnv): boolean {
  const value = env.OAO_EVENT_WEBHOOKS_ALLOW_PRIVATE_NETWORK;
  if (value === undefined || value === "" || value === "false") return false;
  if (value !== "true")
    throw new Error(
      "OAO_EVENT_WEBHOOKS_ALLOW_PRIVATE_NETWORK must be true or false",
    );
  if ((env.NODE_ENV ?? "development") !== "development")
    throw new Error(
      "OAO_EVENT_WEBHOOKS_ALLOW_PRIVATE_NETWORK is only allowed with NODE_ENV=development",
    );
  return true;
}
