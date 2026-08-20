import {
  brandedId,
  type AuthorizationScope,
  type OrganizationId,
  type Principal,
  type PrincipalId,
  type ProjectId,
} from "@oao/domain";

export interface AuthLoginInput {
  readonly redirectUri: string;
  readonly state?: string;
  readonly organizationHint?: string;
}

export interface AuthLoginResult {
  readonly redirectUrl: string;
}

export interface AuthCallbackInput {
  readonly code: string;
  readonly redirectUri: string;
}

export interface AuthRefreshInput {
  readonly refreshToken: string;
}

export interface AuthLogoutInput {
  readonly sessionToken: string;
  readonly returnTo?: string;
}

export interface AuthLogoutResult {
  readonly redirectUrl?: string;
}

export interface AuthSession {
  /** Opaque provider token. API surfaces must keep this in an HttpOnly cookie. */
  readonly sessionToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: Date;
  readonly principal: Principal;
}

/** Provider-neutral authentication boundary consumed by the HTTP API. */
export interface AuthTenantAdapter {
  authenticate(request: Request): Promise<Principal | undefined>;
  login(input: AuthLoginInput): Promise<AuthLoginResult>;
  callback(input: AuthCallbackInput): Promise<AuthSession>;
  refresh(input: AuthRefreshInput): Promise<AuthSession>;
  logout(input: AuthLogoutInput): Promise<AuthLogoutResult>;
}

export type AuthenticationErrorCode =
  | "invalid_callback"
  | "invalid_session"
  | "principal_not_found"
  | "provider_unavailable";

/** Safe, public error. Provider payloads and tokens must remain on the adapter side. */
export class AuthenticationError extends Error {
  constructor(readonly code: AuthenticationErrorCode) {
    super(code.replaceAll("_", " "));
    this.name = "AuthenticationError";
  }
}

export const DEVELOPMENT_SESSION_TOKEN = "oao-development-session";
export const DEVELOPMENT_REFRESH_TOKEN = "oao-development-refresh";

export const DEVELOPMENT_PRINCIPAL: Principal = Object.freeze({
  id: brandedId<PrincipalId>("00000000-0000-4000-8000-000000000003"),
  organizationId: brandedId<OrganizationId>(
    "00000000-0000-4000-8000-000000000001",
  ),
  projectId: brandedId<ProjectId>("00000000-0000-4000-8000-000000000002"),
  kind: "human",
  subject: "development-user",
  scopes: new Set<AuthorizationScope>(["*"]),
});

export interface DevelopmentAuthOptions {
  readonly principal?: Principal;
  readonly now?: () => Date;
  /** When set, authenticate requires this bearer token instead of trusting local requests. */
  readonly bearerToken?: string;
}

/** Deterministic default for local development and credential-free tests. */
export class DevelopmentAuthAdapter implements AuthTenantAdapter {
  readonly #principal: Principal;
  readonly #now: () => Date;
  readonly #bearerToken: string | undefined;

  constructor(options: DevelopmentAuthOptions = {}) {
    this.#principal = options.principal ?? DEVELOPMENT_PRINCIPAL;
    this.#now = options.now ?? (() => new Date("2026-01-01T00:00:00.000Z"));
    this.#bearerToken = options.bearerToken;
  }

  async authenticate(request: Request): Promise<Principal | undefined> {
    if (this.#bearerToken === undefined) return this.#principal;
    return readBearerToken(request) === this.#bearerToken
      ? this.#principal
      : undefined;
  }

  async login(input: AuthLoginInput): Promise<AuthLoginResult> {
    return { redirectUrl: input.redirectUri };
  }

  async callback(input: AuthCallbackInput): Promise<AuthSession> {
    void input;
    return this.#session();
  }

  async refresh(input: AuthRefreshInput): Promise<AuthSession> {
    if (input.refreshToken !== DEVELOPMENT_REFRESH_TOKEN) {
      throw new AuthenticationError("invalid_session");
    }
    return this.#session();
  }

  async logout(input: AuthLogoutInput): Promise<AuthLogoutResult> {
    void input;
    return {};
  }

  #session(): AuthSession {
    return {
      sessionToken: DEVELOPMENT_SESSION_TOKEN,
      refreshToken: DEVELOPMENT_REFRESH_TOKEN,
      expiresAt: new Date(this.#now().getTime() + 24 * 60 * 60 * 1000),
      principal: this.#principal,
    };
  }
}

export function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return undefined;
  const match = /^Bearer[\t ]+([^\s]+)$/iu.exec(authorization);
  return match?.[1];
}

export function readCookie(
  request: Request,
  cookieName: string,
): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== cookieName) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
