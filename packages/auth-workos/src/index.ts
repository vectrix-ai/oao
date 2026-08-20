import { createHmac, timingSafeEqual } from "node:crypto";
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
  }): Promise<void>;
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
    await this.#webhookVerifier.verify({
      rawBody,
      signature: input.signature,
    });
    const event = parseWebhookEvent(rawBody);
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
  constructor(readonly reason: "invalid_signature" | "stale_signature") {
    super("webhook verification failed");
    this.name = "WorkOsWebhookVerificationError";
  }
}

export interface WorkOsHmacWebhookVerifierOptions {
  readonly secret: string;
  readonly toleranceSeconds?: number;
  readonly now?: () => Date;
}

/** Verifies WorkOS `t=..., v1=...` signatures over the unmodified request bytes. */
export class WorkOsHmacWebhookVerifier implements WorkOsWebhookVerifier {
  readonly #secret: string;
  readonly #toleranceSeconds: number;
  readonly #now: () => Date;

  constructor(options: WorkOsHmacWebhookVerifierOptions) {
    if (options.secret.length === 0) throw new TypeError("secret is required");
    this.#secret = options.secret;
    this.#toleranceSeconds = options.toleranceSeconds ?? 300;
    this.#now = options.now ?? (() => new Date());
  }

  async verify(input: {
    readonly rawBody: Uint8Array;
    readonly signature: string;
  }): Promise<void> {
    const parsed = parseSignature(input.signature);
    const nowMilliseconds = this.#now().getTime();
    if (
      Math.abs(nowMilliseconds - parsed.timestamp) >
      this.#toleranceSeconds * 1000
    ) {
      throw new WorkOsWebhookVerificationError("stale_signature");
    }
    const prefix = new TextEncoder().encode(`${parsed.timestamp}.`);
    const signedPayload = new Uint8Array(prefix.length + input.rawBody.length);
    signedPayload.set(prefix);
    signedPayload.set(input.rawBody, prefix.length);
    const expected = createHmac("sha256", this.#secret)
      .update(signedPayload)
      .digest();
    const valid = parsed.signatures.some((signature) => {
      if (!/^[0-9a-f]{64}$/iu.test(signature)) return false;
      const candidate = Buffer.from(signature, "hex");
      return (
        candidate.length === expected.length &&
        timingSafeEqual(candidate, expected)
      );
    });
    if (!valid) {
      throw new WorkOsWebhookVerificationError("invalid_signature");
    }
  }
}

function parseSignature(header: string): {
  readonly timestamp: number;
  readonly signatures: readonly string[];
} {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const segment of header.split(",")) {
    const [key, value] = segment.trim().split("=", 2);
    if (key === "t" && value !== undefined && /^\d+$/u.test(value)) {
      timestamp = Number(value);
    }
    if (key === "v1" && value !== undefined) signatures.push(value);
  }
  if (
    timestamp === undefined ||
    !Number.isSafeInteger(timestamp) ||
    signatures.length === 0
  ) {
    throw new WorkOsWebhookVerificationError("invalid_signature");
  }
  return { timestamp, signatures };
}

function parseWebhookEvent(rawBody: Uint8Array): WorkOsWebhookEvent {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
    );
  } catch {
    throw new WorkOsWebhookVerificationError("invalid_signature");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkOsWebhookVerificationError("invalid_signature");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.event !== "string" ||
    record.event.length === 0 ||
    !("data" in record)
  ) {
    throw new WorkOsWebhookVerificationError("invalid_signature");
  }
  return {
    id: record.id,
    type: record.event,
    ...(typeof record.created_at === "string"
      ? { createdAt: record.created_at }
      : {}),
    data: record.data,
  };
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
