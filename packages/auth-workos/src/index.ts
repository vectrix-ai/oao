import {
  AuthenticationError,
  readBearerToken,
  readCookie,
  type AuthCallbackInput,
  type AuthLoginInput,
  type AuthLoginResult,
  type AuthLogoutInput,
  type AuthLogoutResult,
  type AuthRefreshInput,
  type AuthSession,
  type AuthTenantAdapter,
} from "@oao/auth-core";
import type { Principal } from "@oao/domain";
import {
  WorkOS,
  type AuthenticationResponse,
  type Event,
} from "@workos-inc/node";

export interface WorkOsIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly externalOrganizationId?: string;
}

export interface WorkOsProviderSession {
  readonly sessionToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: Date;
  readonly identity: WorkOsIdentity;
}

/** Narrow AuthKit transport. Production code can wrap the WorkOS SDK here. */
export interface WorkOsAuthTransport {
  authorizationUrl(input: {
    readonly redirectUri: string;
    readonly state?: string;
    readonly organizationHint?: string;
  }): Promise<string>;
  exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
  }): Promise<WorkOsProviderSession>;
  refresh(input: {
    readonly refreshToken: string;
  }): Promise<WorkOsProviderSession>;
  validateSession(sessionToken: string): Promise<WorkOsIdentity | undefined>;
  logout(input: {
    readonly sessionToken: string;
    readonly returnTo?: string;
  }): Promise<{ readonly redirectUrl?: string }>;
}

/** PostgreSQL-backed in the API: WorkOS identity never grants tenant access alone. */
export interface WorkOsTenantResolver {
  resolvePrincipal(
    identity: WorkOsIdentity,
    request?: Request,
  ): Promise<Principal | undefined>;
}

export interface WorkOsWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly createdAt?: string;
  readonly data: unknown;
}

export interface WorkOsWebhookVerifier {
  verify(input: {
    readonly rawBody: Uint8Array;
    readonly signature: string;
  }): Promise<WorkOsWebhookEvent>;
}

/** Durable implementation must atomically claim an event ID before reconciliation. */
export interface WorkOsWebhookLedger {
  claim(
    event: WorkOsWebhookEvent,
    rawBody: Uint8Array,
  ): Promise<"claimed" | "duplicate">;
  complete(
    eventId: string,
    event: WorkOsWebhookEvent,
    rawBody: Uint8Array,
  ): Promise<void>;
  release(
    eventId: string,
    event: WorkOsWebhookEvent,
    rawBody: Uint8Array,
  ): Promise<void>;
}

/** Reconciles provider identities into PostgreSQL memberships and principals. */
export interface WorkOsReconciler {
  reconcile(event: WorkOsWebhookEvent): Promise<void>;
  /** Optional periodic full reconciliation for missed or out-of-order webhooks. */
  reconcileAll?(): Promise<void>;
}

export interface WorkOsAuthAdapterOptions {
  readonly transport: WorkOsAuthTransport;
  readonly tenants: WorkOsTenantResolver;
  readonly webhookVerifier: WorkOsWebhookVerifier;
  readonly webhookLedger: WorkOsWebhookLedger;
  readonly reconciler: WorkOsReconciler;
  readonly sessionCookieName?: string;
}

export type WorkOsWebhookResult =
  | { readonly status: "processed"; readonly eventId: string }
  | { readonly status: "duplicate"; readonly eventId: string };

export class WorkOsAuthAdapter implements AuthTenantAdapter {
  readonly #transport: WorkOsAuthTransport;
  readonly #tenants: WorkOsTenantResolver;
  readonly #webhookVerifier: WorkOsWebhookVerifier;
  readonly #webhookLedger: WorkOsWebhookLedger;
  readonly #reconciler: WorkOsReconciler;
  readonly #sessionCookieName: string;

  constructor(options: WorkOsAuthAdapterOptions) {
    this.#transport = options.transport;
    this.#tenants = options.tenants;
    this.#webhookVerifier = options.webhookVerifier;
    this.#webhookLedger = options.webhookLedger;
    this.#reconciler = options.reconciler;
    this.#sessionCookieName = options.sessionCookieName ?? "oao_session";
  }

  async authenticate(request: Request): Promise<Principal | undefined> {
    const token =
      readBearerToken(request) ?? readCookie(request, this.#sessionCookieName);
    if (token === undefined) return undefined;
    let identity: WorkOsIdentity | undefined;
    try {
      identity = await this.#transport.validateSession(token);
    } catch {
      return undefined;
    }
    if (identity === undefined) return undefined;
    return this.#tenants.resolvePrincipal(identity, request);
  }

  async login(input: AuthLoginInput): Promise<AuthLoginResult> {
    try {
      const redirectUrl = await this.#transport.authorizationUrl({
        redirectUri: input.redirectUri,
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.organizationHint === undefined
          ? {}
          : { organizationHint: input.organizationHint }),
      });
      return { redirectUrl };
    } catch {
      throw new AuthenticationError("provider_unavailable");
    }
  }

  async callback(input: AuthCallbackInput): Promise<AuthSession> {
    let providerSession: WorkOsProviderSession;
    try {
      providerSession = await this.#transport.exchangeCode(input);
    } catch {
      throw new AuthenticationError("invalid_callback");
    }
    return this.#resolveSession(providerSession);
  }

  async refresh(input: AuthRefreshInput): Promise<AuthSession> {
    let providerSession: WorkOsProviderSession;
    try {
      providerSession = await this.#transport.refresh(input);
    } catch {
      throw new AuthenticationError("invalid_session");
    }
    return this.#resolveSession(providerSession);
  }

  async logout(input: AuthLogoutInput): Promise<AuthLogoutResult> {
    try {
      return await this.#transport.logout(input);
    } catch {
      throw new AuthenticationError("provider_unavailable");
    }
  }

  async handleWebhook(input: {
    readonly rawBody: Uint8Array | string;
    readonly signature: string;
  }): Promise<WorkOsWebhookResult> {
    const rawBody =
      typeof input.rawBody === "string"
        ? new TextEncoder().encode(input.rawBody)
        : input.rawBody;
    const event = await this.#webhookVerifier.verify({
      rawBody,
      signature: input.signature,
    });
    if ((await this.#webhookLedger.claim(event, rawBody)) === "duplicate") {
      return { status: "duplicate", eventId: event.id };
    }
    try {
      await this.#reconciler.reconcile(event);
      await this.#webhookLedger.complete(event.id, event, rawBody);
      return { status: "processed", eventId: event.id };
    } catch (error) {
      await this.#webhookLedger.release(event.id, event, rawBody);
      throw error;
    }
  }

  async reconcileAll(): Promise<void> {
    await this.#reconciler.reconcileAll?.();
  }

  async #resolveSession(
    providerSession: WorkOsProviderSession,
  ): Promise<AuthSession> {
    const principal = await this.#tenants.resolvePrincipal(
      providerSession.identity,
    );
    if (principal === undefined) {
      throw new AuthenticationError("principal_not_found");
    }
    return {
      sessionToken: providerSession.sessionToken,
      ...(providerSession.refreshToken === undefined
        ? {}
        : { refreshToken: providerSession.refreshToken }),
      expiresAt: providerSession.expiresAt,
      principal,
    };
  }
}

export class WorkOsWebhookVerificationError extends Error {
  constructor() {
    super("webhook verification failed");
    this.name = "WorkOsWebhookVerificationError";
  }
}

export interface WorkOsNodeAuthTransportOptions {
  readonly apiKey: string;
  readonly clientId: string;
  readonly cookiePassword: string;
  readonly workos?: WorkOS;
  readonly now?: () => Date;
  readonly sessionLifetimeSeconds?: number;
}

/** Concrete AuthKit transport backed by the official WorkOS Node SDK. */
export class WorkOsNodeAuthTransport implements WorkOsAuthTransport {
  readonly #workos: WorkOS;
  readonly #clientId: string;
  readonly #cookiePassword: string;
  readonly #now: () => Date;
  readonly #sessionLifetimeSeconds: number;

  constructor(options: WorkOsNodeAuthTransportOptions) {
    if (options.apiKey.length === 0) throw new TypeError("apiKey is required");
    if (options.clientId.length === 0)
      throw new TypeError("clientId is required");
    if (options.cookiePassword.length < 32)
      throw new TypeError("cookiePassword must contain at least 32 characters");
    this.#workos =
      options.workos ??
      new WorkOS({ apiKey: options.apiKey, clientId: options.clientId });
    this.#clientId = options.clientId;
    this.#cookiePassword = options.cookiePassword;
    this.#now = options.now ?? (() => new Date());
    this.#sessionLifetimeSeconds = options.sessionLifetimeSeconds ?? 3_600;
  }

  async authorizationUrl(input: {
    readonly redirectUri: string;
    readonly state?: string;
    readonly organizationHint?: string;
  }): Promise<string> {
    return this.#workos.userManagement.getAuthorizationUrl({
      clientId: this.#clientId,
      provider: "authkit",
      redirectUri: input.redirectUri,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.organizationHint === undefined
        ? {}
        : { organizationId: input.organizationHint }),
    });
  }

  async exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
  }): Promise<WorkOsProviderSession> {
    void input.redirectUri;
    const response = await this.#workos.userManagement.authenticateWithCode({
      clientId: this.#clientId,
      code: input.code,
      session: {
        sealSession: true,
        cookiePassword: this.#cookiePassword,
      },
    });
    return this.#providerSession(response);
  }

  async refresh(input: {
    readonly refreshToken: string;
  }): Promise<WorkOsProviderSession> {
    const session = this.#workos.userManagement.loadSealedSession({
      sessionData: input.refreshToken,
      cookiePassword: this.#cookiePassword,
    });
    const response = await session.refresh();
    if (!response.authenticated || !response.sealedSession) {
      throw new AuthenticationError("invalid_session");
    }
    return {
      sessionToken: response.sealedSession,
      refreshToken: response.sealedSession,
      expiresAt: this.#expiresAt(),
      identity: identityFromUser(response.user, response.organizationId),
    };
  }

  async validateSession(
    sessionToken: string,
  ): Promise<WorkOsIdentity | undefined> {
    const session = this.#workos.userManagement.loadSealedSession({
      sessionData: sessionToken,
      cookiePassword: this.#cookiePassword,
    });
    const result = await session.authenticate();
    return result.authenticated
      ? identityFromUser(result.user, result.organizationId)
      : undefined;
  }

  async logout(input: {
    readonly sessionToken: string;
    readonly returnTo?: string;
  }): Promise<{ readonly redirectUrl?: string }> {
    const session = this.#workos.userManagement.loadSealedSession({
      sessionData: input.sessionToken,
      cookiePassword: this.#cookiePassword,
    });
    return {
      redirectUrl: await session.getLogoutUrl(
        input.returnTo === undefined ? {} : { returnTo: input.returnTo },
      ),
    };
  }

  #providerSession(response: AuthenticationResponse): WorkOsProviderSession {
    if (!response.sealedSession)
      throw new AuthenticationError("provider_unavailable");
    return {
      sessionToken: response.sealedSession,
      refreshToken: response.sealedSession,
      expiresAt:
        expiresAtFromAccessToken(response.accessToken) ?? this.#expiresAt(),
      identity: identityFromUser(response.user, response.organizationId),
    };
  }

  #expiresAt(): Date {
    return new Date(
      this.#now().getTime() + this.#sessionLifetimeSeconds * 1_000,
    );
  }
}

export interface WorkOsNodeWebhookVerifierOptions {
  readonly secret: string;
  readonly workos?: WorkOS;
  readonly clientId?: string;
  /** Official SDK tolerance in milliseconds. */
  readonly toleranceMilliseconds?: number;
}

/** Exact raw-body verification through the official WorkOS helper. */
export class WorkOsNodeWebhookVerifier implements WorkOsWebhookVerifier {
  readonly #secret: string;
  readonly #workos: WorkOS;
  readonly #toleranceMilliseconds: number | undefined;

  constructor(options: WorkOsNodeWebhookVerifierOptions) {
    if (options.secret.length === 0) throw new TypeError("secret is required");
    this.#secret = options.secret;
    this.#workos =
      options.workos ??
      new WorkOS({ clientId: options.clientId ?? "client_webhook_verifier" });
    this.#toleranceMilliseconds = options.toleranceMilliseconds;
  }

  async verify(input: {
    readonly rawBody: Uint8Array;
    readonly signature: string;
  }): Promise<WorkOsWebhookEvent> {
    let event: Event;
    try {
      event = await this.#workos.webhooks.constructEvent({
        payload: Buffer.from(input.rawBody),
        sigHeader: input.signature,
        secret: this.#secret,
        ...(this.#toleranceMilliseconds === undefined
          ? {}
          : { tolerance: this.#toleranceMilliseconds }),
      });
    } catch {
      throw new WorkOsWebhookVerificationError();
    }
    return {
      id: event.id,
      type: event.event,
      createdAt: event.createdAt,
      data: event.data,
    };
  }
}

function identityFromUser(
  user: AuthenticationResponse["user"],
  organizationId?: string,
): WorkOsIdentity {
  const displayName =
    user.name?.trim() ||
    [user.firstName, user.lastName]
      .filter((part): part is string => Boolean(part?.trim()))
      .map((part) => part.trim())
      .join(" ");
  return {
    subject: user.id,
    email: user.email,
    ...(displayName ? { displayName } : {}),
    ...(organizationId === undefined
      ? {}
      : { externalOrganizationId: organizationId }),
  };
}

function expiresAtFromAccessToken(accessToken: string): Date | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      readonly exp?: unknown;
    };
    if (typeof value.exp !== "number" || !Number.isSafeInteger(value.exp))
      return undefined;
    const expiresAt = new Date(value.exp * 1_000);
    return Number.isNaN(expiresAt.getTime()) ? undefined : expiresAt;
  } catch {
    return undefined;
  }
}

/** Test/local ledger only. Hosted deployments must use the PostgreSQL seam. */
export class InMemoryWorkOsWebhookLedger implements WorkOsWebhookLedger {
  readonly #claimed = new Set<string>();
  readonly #completed = new Set<string>();

  async claim(event: WorkOsWebhookEvent): Promise<"claimed" | "duplicate"> {
    if (this.#claimed.has(event.id) || this.#completed.has(event.id)) {
      return "duplicate";
    }
    this.#claimed.add(event.id);
    return "claimed";
  }

  async complete(eventId: string): Promise<void> {
    this.#claimed.delete(eventId);
    this.#completed.add(eventId);
  }

  async release(eventId: string): Promise<void> {
    this.#claimed.delete(eventId);
  }
}

/** Explicit AuthKit name retained for API composition/readability. */
export { WorkOsAuthAdapter as WorkOsAuthKitAdapter };
