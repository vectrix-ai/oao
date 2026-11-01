import {
  OAuthError,
  buildDiscoveryUrls,
  extractWWWAuthenticateParams,
  fetchToken,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import {
  McpEgressRefusal,
  requestBody,
  requestedUrl,
  resolvedAddresses,
  sendPinned,
  type McpEgressOptions,
} from "./egress.js";

/** The MCP extension OAO declares on connections that use client credentials. */
export const OAUTH_CLIENT_CREDENTIALS_EXTENSION =
  "io.modelcontextprotocol/oauth-client-credentials";

const DEFAULT_TIMEOUT_MS = 30_000;
const METADATA_RESPONSE_BYTES = 65_536;
const PROBE_RESPONSE_BYTES = 65_536;
const TOKEN_RESPONSE_BYTES = 65_536;
/** Used when the authorization server omits `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;
const MAXIMUM_TOKEN_LIFETIME_SECONDS = 86_400;
const MAXIMUM_CACHED_TOKENS = 1_024;
const MAXIMUM_AUTHORIZATION_SERVERS = 8;
const MAXIMUM_METADATA_LIST_ENTRIES = 64;
const MAXIMUM_URL_CHARACTERS = 2_048;

export type McpTokenEndpointAuthMethod =
  "client_secret_post" | "client_secret_basic";

/**
 * A decrypted OAuth client-credentials credential version. The client secret
 * goes only to the pinned token endpoint; the access token it yields goes
 * only to the MCP destination.
 */
export interface McpOAuthClientCredentialsMaterial {
  readonly kind: "oauth_client_credentials";
  /** Tokens are cached per organization and credential version, never shared. */
  readonly organizationId: string;
  readonly credentialVersionId: string;
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenEndpointAuthMethod: McpTokenEndpointAuthMethod;
  readonly scope: string;
  readonly resource: string;
  readonly resourceMetadataUrl: string;
  /** False omits the RFC 8707 `resource` parameter from token requests. */
  readonly sendResource: boolean;
}

export type McpRemoteErrorCode =
  | "authorization_discovery_failed"
  | "resource_mismatch"
  | "authorization_server_changed"
  | "credential_token_failed"
  | "credential_rejected"
  | "insufficient_scope"
  | "remote_forbidden";

/** A remote MCP failure with a code that is safe to store and show. */
export class McpRemoteError extends Error {
  override readonly name = "McpRemoteError";

  constructor(
    readonly code: McpRemoteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface McpAuthorizationServerDiscovery {
  readonly issuer: string;
  readonly tokenEndpoint: string | null;
  readonly metadataSource: "oauth" | "oidc" | null;
  readonly tokenEndpointAuthMethodsSupported: readonly string[] | null;
  /** Reported only. AuthKit's RFC 8414 document omits client_credentials. */
  readonly grantTypesSupported: readonly string[] | null;
  readonly scopesSupported: readonly string[] | null;
  /** Null when OAO can request tokens from this server. */
  readonly problem:
    | "metadata_unavailable"
    | "issuer_mismatch"
    | "token_endpoint_missing"
    | "token_endpoint_insecure"
    | "token_endpoint_unreachable"
    | null;
}

export interface McpAuthorizationDiscovery {
  readonly endpointUrl: string;
  /** The protected resource metadata `resource`, verbatim. */
  readonly resource: string;
  readonly resourceName: string | null;
  readonly resourceMetadataUrl: string;
  readonly resourceMetadataSource: "www_authenticate" | "well_known";
  /** The `scope` of the unauthenticated challenge, if the server sent one. */
  readonly challengeScope: string | null;
  readonly scopesSupported: readonly string[];
  readonly authorizationServers: readonly McpAuthorizationServerDiscovery[];
}

export interface McpCredentialTestResult {
  readonly expiresIn: number | null;
  readonly grantedScope: string | null;
}

interface CachedToken {
  readonly accessToken: string;
  /** Absolute expiry in epoch milliseconds. */
  readonly expiresAt: number;
  /** When a later request fetches a new token instead of reusing this one. */
  readonly refreshAt: number;
  readonly expiresIn: number | null;
  readonly grantedScope: string | null;
}

function httpsUrl(value: unknown, options: McpEgressOptions): URL | undefined {
  if (typeof value !== "string" || value.length > MAXIMUM_URL_CHARACTERS)
    return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && !options.allowPrivateNetwork)
    return undefined;
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.hash) return undefined;
  return url;
}

/** Canonical form for comparing resource identifiers (RFC 9728 §3.3). */
function resourceKey(value: string | URL): string {
  const url = new URL(value);
  const path =
    url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
  return `${url.origin}${path}${url.search}`;
}

export function sameResource(left: string, right: string): boolean {
  try {
    return resourceKey(left) === resourceKey(right);
  } catch {
    return false;
  }
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

function stringList(
  value: unknown,
  maximumLength = 200,
): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(
      (entry): entry is string =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= maximumLength,
    )
    .slice(0, MAXIMUM_METADATA_LIST_ENTRIES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Drops a response body by reading it to the end, which the response size
 * limit bounds. Cancelling it instead trips a Node 22 stream bug: a body
 * cancelled while data still arrives throws an uncaught exception.
 */
async function discard(response: Response): Promise<void> {
  await response.arrayBuffer().catch(() => undefined);
}

/**
 * A fetch that only POSTs to one pinned token endpoint, over HTTPS, to a
 * DNS-pinned public address, without following redirects. It forwards only
 * the headers a token request needs, so no OAO call context or MCP header
 * ever reaches the authorization server.
 */
export function createBrokeredTokenFetch(
  tokenEndpoint: string,
  options: McpEgressOptions = {},
  limits: { readonly timeoutMs?: number } = {},
): FetchLike {
  const pinned = httpsUrl(tokenEndpoint, options);
  if (!pinned) throw new TypeError("OAuth token endpoint must be an HTTPS URL");
  return async (input, init = {}) => {
    const requested = requestedUrl(input);
    const method = (
      init.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method !== "POST" || requested.href !== pinned.href)
      throw new McpEgressRefusal(
        "OAuth request destination is outside the pinned token endpoint",
      );
    const source = new Headers(init.headers);
    const headers = new Headers();
    for (const name of ["accept", "content-type", "authorization"]) {
      const value = source.get(name);
      if (value !== null) headers.set(name, value);
    }
    const response = await sendPinned(
      requested,
      {
        method: "POST",
        headers,
        body: await requestBody(init.body),
        signal: init.signal,
        timeoutMs: limits.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maximumResponseBytes: TOKEN_RESPONSE_BYTES,
      },
      options,
    );
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      throw new McpEgressRefusal(
        "OAuth token endpoint redirects are not followed",
      );
    }
    return response;
  };
}

function formEncoded(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

/**
 * The minimal SDK provider for a pre-registered confidential client. It
 * applies the pinned client authentication method itself: the SDK would
 * otherwise prefer HTTP Basic whenever a secret is present.
 */
function clientCredentialsProvider(
  credential: McpOAuthClientCredentialsMaterial,
): OAuthClientProvider {
  const information = {
    client_id: credential.clientId,
    client_secret: credential.clientSecret,
    token_endpoint_auth_method: credential.tokenEndpointAuthMethod,
  };
  return {
    redirectUrl: undefined,
    clientMetadata: {
      redirect_uris: [],
      grant_types: ["client_credentials"],
      token_endpoint_auth_method: credential.tokenEndpointAuthMethod,
    },
    clientInformation: () => information,
    tokens: () => undefined,
    saveTokens: () => undefined,
    redirectToAuthorization: () => {
      throw new Error("Client credentials never redirect");
    },
    saveCodeVerifier: () => undefined,
    codeVerifier: () => {
      throw new Error("Client credentials use no code verifier");
    },
    prepareTokenRequest: (scope) => {
      const params = new URLSearchParams({ grant_type: "client_credentials" });
      if (scope) params.set("scope", scope);
      return params;
    },
    addClientAuthentication: (headers, params) => {
      if (credential.tokenEndpointAuthMethod === "client_secret_basic")
        headers.set(
          "authorization",
          `Basic ${Buffer.from(
            `${formEncoded(credential.clientId)}:${formEncoded(credential.clientSecret)}`,
          ).toString("base64")}`,
        );
      else {
        params.set("client_id", credential.clientId);
        params.set("client_secret", credential.clientSecret);
      }
    },
  };
}

function tokenFailure(error: unknown): McpRemoteError {
  if (error instanceof McpRemoteError) return error;
  if (error instanceof OAuthError && /^[a-z_]{1,64}$/u.test(error.code))
    return new McpRemoteError(
      "credential_token_failed",
      `The authorization server refused the token request (${error.code})`,
    );
  if (error instanceof McpEgressRefusal)
    return new McpRemoteError("credential_token_failed", error.message);
  return new McpRemoteError(
    "credential_token_failed",
    "The OAuth token request failed",
  );
}

/**
 * Waits for a shared token request on one caller's own terms: its
 * cancellation and its timeout, which may be shorter than the timeout of the
 * caller that started the request.
 */
async function waitForToken<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("MCP request was cancelled");
  return new Promise<T>((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      settle();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("MCP request was cancelled"),
      );
    };
    const timer = setTimeout(() => {
      settle();
      reject(
        new McpRemoteError(
          "credential_token_failed",
          "The OAuth token request timed out",
        ),
      );
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Obtains and caches client-credentials access tokens in process memory.
 *
 * Tokens are keyed by organization, credential version, scope, and resource,
 * store an absolute expiry, and are refreshed early: at the expiry minus the
 * larger of 60 seconds and 10% of the lifetime, but never later than half of
 * it. Concurrent requests for one key share a single token request.
 */
export class McpTokenBroker {
  readonly #tokens = new Map<string, CachedToken>();
  readonly #pending = new Map<string, Promise<CachedToken>>();

  constructor(
    private readonly egressOptions: McpEgressOptions = {},
    private readonly now: () => number = Date.now,
  ) {}

  static key(credential: McpOAuthClientCredentialsMaterial): string {
    return JSON.stringify([
      credential.organizationId,
      credential.credentialVersionId,
      credential.scope,
      credential.resource,
    ]);
  }

  /** The cached token, or a fresh one when it is due for refresh. */
  async token(
    credential: McpOAuthClientCredentialsMaterial,
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
      /** Skip the cache, as the credential test does. */
      readonly fresh?: boolean;
    } = {},
  ): Promise<CachedToken> {
    const key = McpTokenBroker.key(credential);
    if (!options.fresh) {
      const cached = this.#tokens.get(key);
      if (cached && cached.refreshAt > this.now()) return cached;
    }
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = this.#request(credential, options.timeoutMs)
        .then((token) => {
          this.#store(key, token);
          return token;
        })
        .finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    return waitForToken(
      pending,
      options.signal,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }

  /** Drops a rejected token unless another request already replaced it. */
  invalidate(
    credential: McpOAuthClientCredentialsMaterial,
    accessToken: string,
  ): void {
    const key = McpTokenBroker.key(credential);
    if (this.#tokens.get(key)?.accessToken === accessToken)
      this.#tokens.delete(key);
  }

  #store(key: string, token: CachedToken): void {
    const now = this.now();
    for (const [entry, cached] of this.#tokens)
      if (cached.expiresAt <= now) this.#tokens.delete(entry);
    this.#tokens.delete(key);
    while (this.#tokens.size >= MAXIMUM_CACHED_TOKENS) {
      const oldest = this.#tokens.keys().next().value;
      if (oldest === undefined) break;
      this.#tokens.delete(oldest);
    }
    this.#tokens.set(key, token);
  }

  async #request(
    credential: McpOAuthClientCredentialsMaterial,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<CachedToken> {
    const requestedAt = this.now();
    let tokens: Awaited<ReturnType<typeof fetchToken>>;
    try {
      tokens = await fetchToken(
        clientCredentialsProvider(credential),
        credential.issuer,
        {
          metadata: {
            issuer: credential.issuer,
            token_endpoint: credential.tokenEndpoint,
            token_endpoint_auth_methods_supported: [
              credential.tokenEndpointAuthMethod,
            ],
            response_types_supported: [],
          } as unknown as AuthorizationServerMetadata,
          // The SDK sends a string resource verbatim (RFC 8707).
          ...(credential.sendResource ? { resource: credential.resource } : {}),
          scope: credential.scope,
          fetchFn: createBrokeredTokenFetch(
            credential.tokenEndpoint,
            this.egressOptions,
            { timeoutMs },
          ),
        },
      );
    } catch (error) {
      throw tokenFailure(error);
    }
    if (
      typeof tokens.access_token !== "string" ||
      tokens.access_token.length === 0 ||
      tokens.token_type.toLowerCase() !== "bearer"
    )
      throw new McpRemoteError(
        "credential_token_failed",
        "The authorization server did not issue a bearer access token",
      );
    const expiresIn =
      typeof tokens.expires_in === "number" &&
      Number.isFinite(tokens.expires_in) &&
      tokens.expires_in > 0
        ? Math.min(
            Math.floor(tokens.expires_in),
            MAXIMUM_TOKEN_LIFETIME_SECONDS,
          )
        : null;
    const lifetimeMs = (expiresIn ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1_000;
    const margin = Math.min(Math.max(60_000, lifetimeMs / 10), lifetimeMs / 2);
    return {
      accessToken: tokens.access_token,
      expiresAt: requestedAt + lifetimeMs,
      refreshAt: requestedAt + lifetimeMs - margin,
      expiresIn,
      grantedScope: typeof tokens.scope === "string" ? tokens.scope : null,
    };
  }
}

interface DiscoveryContext {
  readonly options: McpEgressOptions;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

/** A credential-free GET of authorization metadata. Redirects are refused. */
async function metadataRequest(
  url: URL,
  context: DiscoveryContext,
): Promise<Response | undefined> {
  try {
    const response = await sendPinned(
      url,
      {
        method: "GET",
        headers: new Headers({ accept: "application/json" }),
        body: Buffer.alloc(0),
        signal: context.signal,
        timeoutMs: context.timeoutMs,
        maximumResponseBytes: METADATA_RESPONSE_BYTES,
      },
      context.options,
    );
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      return undefined;
    }
    return response;
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return undefined;
  }
}

/**
 * One unauthenticated POST to the MCP endpoint, read only for its
 * `WWW-Authenticate` challenge.
 */
async function challenge(
  endpoint: URL,
  context: DiscoveryContext,
): Promise<{ readonly resourceMetadataUrl?: URL; readonly scope?: string }> {
  let response: Response;
  try {
    response = await sendPinned(
      endpoint,
      {
        method: "POST",
        headers: new Headers({
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        }),
        body: Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "oao-authorization-discovery",
            method: "server/discover",
            params: {},
          }),
        ),
        signal: context.signal,
        timeoutMs: context.timeoutMs,
        maximumResponseBytes: PROBE_RESPONSE_BYTES,
      },
      context.options,
    );
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return {};
  }
  const parameters =
    response.status === 401 ? extractWWWAuthenticateParams(response) : {};
  await discard(response);
  return {
    ...(parameters.resourceMetadataUrl
      ? { resourceMetadataUrl: parameters.resourceMetadataUrl }
      : {}),
    ...(parameters.scope ? { scope: parameters.scope } : {}),
  };
}

function wellKnownResourceMetadataUrls(endpoint: URL): readonly URL[] {
  const path =
    endpoint.pathname.length > 1 && endpoint.pathname.endsWith("/")
      ? endpoint.pathname.slice(0, -1)
      : endpoint.pathname;
  const root = new URL("/.well-known/oauth-protected-resource", endpoint);
  if (path === "/") return [root];
  return [
    new URL(`/.well-known/oauth-protected-resource${path}`, endpoint),
    root,
  ];
}

async function authorizationServer(
  issuer: string,
  context: DiscoveryContext,
): Promise<McpAuthorizationServerDiscovery> {
  const unavailable = {
    issuer,
    tokenEndpoint: null,
    metadataSource: null,
    tokenEndpointAuthMethodsSupported: null,
    grantTypesSupported: null,
    scopesSupported: null,
  } as const;
  if (!httpsUrl(issuer, context.options))
    return { ...unavailable, problem: "metadata_unavailable" };
  // RFC 8414 first, then OpenID Connect discovery.
  for (const candidate of buildDiscoveryUrls(issuer)) {
    const response = await metadataRequest(candidate.url, context);
    if (!response) continue;
    if (!response.ok) {
      await discard(response);
      if (response.status >= 500 && response.status !== 502)
        return { ...unavailable, problem: "metadata_unavailable" };
      continue;
    }
    const metadata = await readJson(response);
    if (!isRecord(metadata)) continue;
    const listed = {
      issuer,
      metadataSource: candidate.type,
      tokenEndpointAuthMethodsSupported: stringList(
        metadata.token_endpoint_auth_methods_supported,
      ),
      grantTypesSupported: stringList(metadata.grant_types_supported),
      scopesSupported: stringList(metadata.scopes_supported),
    };
    // RFC 8414 §3.3: the issuer must be identical to the one requested.
    if (metadata.issuer !== issuer)
      return { ...listed, tokenEndpoint: null, problem: "issuer_mismatch" };
    if (typeof metadata.token_endpoint !== "string")
      return {
        ...listed,
        tokenEndpoint: null,
        problem: "token_endpoint_missing",
      };
    const tokenEndpoint = httpsUrl(metadata.token_endpoint, context.options);
    if (!tokenEndpoint)
      return {
        ...listed,
        tokenEndpoint: metadata.token_endpoint.slice(0, MAXIMUM_URL_CHARACTERS),
        problem: "token_endpoint_insecure",
      };
    try {
      await resolvedAddresses(tokenEndpoint, context.options);
    } catch {
      return {
        ...listed,
        tokenEndpoint: tokenEndpoint.href,
        problem: "token_endpoint_unreachable",
      };
    }
    return { ...listed, tokenEndpoint: tokenEndpoint.href, problem: null };
  }
  return { ...unavailable, problem: "metadata_unavailable" };
}

/**
 * Discovers how an MCP server expects OAuth clients to authorize, without
 * sending any credential: the `WWW-Authenticate` challenge of one
 * unauthenticated request, else the RFC 9728 well-known URIs, then the
 * RFC 8414 (or OpenID Connect) metadata of each listed authorization server.
 *
 * The protected resource metadata `resource` must identify the endpoint. Each
 * authorization server's `issuer` must match exactly and its token endpoint
 * must be HTTPS on a public address; servers that fail carry a `problem`.
 * `grant_types_supported` is reported but not enforced.
 */
export async function discoverMcpAuthorization(
  endpointUrl: string,
  options: McpEgressOptions & {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<McpAuthorizationDiscovery> {
  const endpoint = httpsUrl(endpointUrl, options);
  if (!endpoint) throw new TypeError("MCP endpoint must be an HTTPS URL");
  const context: DiscoveryContext = {
    options,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
  };
  const challenged = await challenge(endpoint, context);
  const advertised = challenged.resourceMetadataUrl
    ? httpsUrl(challenged.resourceMetadataUrl.href, options)
    : undefined;
  const candidates: readonly {
    readonly url: URL;
    readonly source: McpAuthorizationDiscovery["resourceMetadataSource"];
  }[] = advertised
    ? [{ url: advertised, source: "www_authenticate" }]
    : wellKnownResourceMetadataUrls(endpoint).map((url) => ({
        url,
        source: "well_known" as const,
      }));
  let found:
    | {
        readonly url: URL;
        readonly source: McpAuthorizationDiscovery["resourceMetadataSource"];
        readonly metadata: Record<string, unknown>;
      }
    | undefined;
  for (const candidate of candidates) {
    const response = await metadataRequest(candidate.url, context);
    if (!response) continue;
    if (!response.ok) {
      await discard(response);
      continue;
    }
    const metadata = await readJson(response);
    if (!isRecord(metadata))
      throw new McpRemoteError(
        "authorization_discovery_failed",
        "The MCP server's protected resource metadata is not a JSON object",
      );
    found = { ...candidate, metadata };
    break;
  }
  if (!found)
    throw new McpRemoteError(
      "authorization_discovery_failed",
      "The MCP server publishes no OAuth protected resource metadata",
    );
  const resource = found.metadata.resource;
  if (typeof resource !== "string" || !httpsUrl(resource, options))
    throw new McpRemoteError(
      "authorization_discovery_failed",
      "The protected resource metadata has no valid resource",
    );
  if (!sameResource(resource, endpoint.href))
    throw new McpRemoteError(
      "resource_mismatch",
      "The protected resource metadata identifies a different resource than the MCP endpoint",
    );
  const bearerMethods = stringList(found.metadata.bearer_methods_supported);
  if (
    bearerMethods &&
    bearerMethods.length > 0 &&
    !bearerMethods.includes("header")
  )
    throw new McpRemoteError(
      "authorization_discovery_failed",
      "The MCP server does not accept bearer tokens in the Authorization header",
    );
  // Issuers are URLs and may be long, for example with a tenant path.
  const issuers = (
    stringList(found.metadata.authorization_servers, MAXIMUM_URL_CHARACTERS) ??
    []
  ).slice(0, MAXIMUM_AUTHORIZATION_SERVERS);
  if (issuers.length === 0)
    throw new McpRemoteError(
      "authorization_discovery_failed",
      "The protected resource metadata lists no authorization server",
    );
  const authorizationServers: McpAuthorizationServerDiscovery[] = [];
  for (const issuer of new Set(issuers))
    authorizationServers.push(await authorizationServer(issuer, context));
  return {
    endpointUrl: endpoint.href,
    resource,
    resourceName:
      typeof found.metadata.resource_name === "string"
        ? found.metadata.resource_name.slice(0, 200)
        : null,
    resourceMetadataUrl: found.url.href,
    resourceMetadataSource: found.source,
    challengeScope: challenged.scope?.slice(0, 1_024) ?? null,
    scopesSupported: stringList(found.metadata.scopes_supported) ?? [],
    authorizationServers,
  };
}

/**
 * Checks that the discovery a credential version pinned still describes the
 * server: same metadata URL, same resource, and the pinned issuer still
 * listed with the same token endpoint.
 */
export function matchesPinnedAuthorization(
  discovery: McpAuthorizationDiscovery,
  pinned: Pick<
    McpOAuthClientCredentialsMaterial,
    "resource" | "resourceMetadataUrl" | "issuer" | "tokenEndpoint"
  >,
): boolean {
  const server = discovery.authorizationServers.find(
    (entry) => entry.issuer === pinned.issuer,
  );
  return (
    sameUrl(discovery.resourceMetadataUrl, pinned.resourceMetadataUrl) &&
    discovery.resource === pinned.resource &&
    server?.problem === null &&
    server.tokenEndpoint !== null &&
    sameUrl(server.tokenEndpoint, pinned.tokenEndpoint)
  );
}

export { sameUrl as sameMcpUrl };
