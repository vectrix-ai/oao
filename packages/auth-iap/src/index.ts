import {
  AuthenticationError,
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
import { OAuth2Client } from "google-auth-library";

const IAP_ASSERTION_HEADER = "x-goog-iap-jwt-assertion";
const IAP_ISSUER = "https://cloud.google.com/iap";
const IAP_KEY_CACHE_MILLISECONDS = 5 * 60 * 1_000;
type IapPublicKeys = Parameters<
  OAuth2Client["verifySignedJwtWithCertsAsync"]
>[1];

export interface IapIdentity {
  readonly subject: string;
  readonly email: string;
}

export interface IapAssertionVerifier {
  verify(assertion: string): Promise<IapIdentity | undefined>;
}

export interface IapTenantResolver {
  resolvePrincipal(
    identity: IapIdentity,
    request?: Request,
  ): Promise<Principal | undefined>;
}

/** Verifies the signed assertion injected by Google IAP, including its exact audience. */
export class GoogleIapAssertionVerifier implements IapAssertionVerifier {
  readonly #expectedAudience: string;
  readonly #client: OAuth2Client;
  readonly #now: () => number;
  #cachedKeys: IapPublicKeys | undefined;
  #cachedKeysExpireAt = 0;
  #keysPromise: Promise<IapPublicKeys> | undefined;

  constructor(input: {
    readonly expectedAudience: string;
    readonly client?: OAuth2Client;
    readonly now?: () => number;
  }) {
    if (!input.expectedAudience.startsWith("/projects/"))
      throw new TypeError("expectedAudience must be an IAP resource audience");
    this.#expectedAudience = input.expectedAudience;
    this.#client = input.client ?? new OAuth2Client();
    this.#now = input.now ?? Date.now;
  }

  async verify(assertion: string): Promise<IapIdentity | undefined> {
    if (!assertion) return undefined;
    try {
      const ticket = await this.#client.verifySignedJwtWithCertsAsync(
        assertion,
        await this.#publicKeys(),
        this.#expectedAudience,
        [IAP_ISSUER],
      );
      const payload = ticket.getPayload();
      const subject = payload?.sub?.trim();
      const email = payload?.email?.trim().toLowerCase();
      if (!subject || !email) return undefined;
      return { subject, email };
    } catch {
      return undefined;
    }
  }

  async #publicKeys(): Promise<IapPublicKeys> {
    if (this.#cachedKeys && this.#cachedKeysExpireAt > this.#now())
      return this.#cachedKeys;
    this.#keysPromise ??= this.#client
      .getIapPublicKeys()
      .then(({ pubkeys }) => {
        this.#cachedKeys = pubkeys;
        this.#cachedKeysExpireAt = this.#now() + IAP_KEY_CACHE_MILLISECONDS;
        return pubkeys;
      })
      .finally(() => {
        this.#keysPromise = undefined;
      });
    return this.#keysPromise;
  }
}

export class IapAuthAdapter implements AuthTenantAdapter {
  readonly #verifier: IapAssertionVerifier;
  readonly #tenants: IapTenantResolver;

  constructor(input: {
    readonly verifier: IapAssertionVerifier;
    readonly tenants: IapTenantResolver;
  }) {
    this.#verifier = input.verifier;
    this.#tenants = input.tenants;
  }

  async authenticate(request: Request): Promise<Principal | undefined> {
    const assertion = request.headers.get(IAP_ASSERTION_HEADER);
    if (!assertion) return undefined;
    const identity = await this.#verifier.verify(assertion);
    return identity
      ? this.#tenants.resolvePrincipal(identity, request)
      : undefined;
  }

  async login(input: AuthLoginInput): Promise<AuthLoginResult> {
    void input;
    throw new AuthenticationError("provider_unavailable");
  }

  async callback(input: AuthCallbackInput): Promise<AuthSession> {
    void input;
    throw new AuthenticationError("invalid_callback");
  }

  async refresh(input: AuthRefreshInput): Promise<AuthSession> {
    void input;
    throw new AuthenticationError("invalid_session");
  }

  async logout(input: AuthLogoutInput): Promise<AuthLogoutResult> {
    void input;
    return {};
  }
}
