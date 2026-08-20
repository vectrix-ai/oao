import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { AuthenticationError, DEVELOPMENT_PRINCIPAL } from "@oao/auth-core";
import {
  InMemoryWorkOsWebhookLedger,
  WorkOsAuthAdapter,
  WorkOsHmacWebhookVerifier,
  WorkOsWebhookVerificationError,
  type WorkOsAuthTransport,
  type WorkOsIdentity,
  type WorkOsProviderSession,
  type WorkOsWebhookEvent,
} from "../src/index.ts";

const identity: WorkOsIdentity = {
  subject: "user_01",
  email: "developer@example.test",
  externalOrganizationId: "org_01",
};

const providerSession: WorkOsProviderSession = {
  sessionToken: "session-secret",
  refreshToken: "refresh-secret",
  expiresAt: new Date("2026-01-01T01:00:00.000Z"),
  identity,
};

class FakeTransport implements WorkOsAuthTransport {
  readonly calls: string[] = [];
  validSession = true;

  async authorizationUrl(input: {
    readonly redirectUri: string;
  }): Promise<string> {
    this.calls.push(`login:${input.redirectUri}`);
    return "https://auth.example.test/authorize";
  }

  async exchangeCode(input: {
    readonly code: string;
  }): Promise<WorkOsProviderSession> {
    this.calls.push(`callback:${input.code}`);
    return providerSession;
  }

  async refresh(input: {
    readonly refreshToken: string;
  }): Promise<WorkOsProviderSession> {
    this.calls.push(`refresh:${input.refreshToken}`);
    return providerSession;
  }

  async validateSession(token: string): Promise<WorkOsIdentity | undefined> {
    this.calls.push(`validate:${token}`);
    return this.validSession ? identity : undefined;
  }

  async logout(input: {
    readonly sessionToken: string;
  }): Promise<{ readonly redirectUrl: string }> {
    this.calls.push(`logout:${input.sessionToken}`);
    return { redirectUrl: "https://auth.example.test/logout" };
  }
}

function adapterFixture(overrides?: {
  readonly resolve?: boolean;
  readonly reconcile?: (event: WorkOsWebhookEvent) => Promise<void>;
}) {
  const transport = new FakeTransport();
  const ledger = new InMemoryWorkOsWebhookLedger();
  const reconciled: WorkOsWebhookEvent[] = [];
  const adapter = new WorkOsAuthAdapter({
    transport,
    tenants: {
      async resolvePrincipal() {
        return overrides?.resolve === false ? undefined : DEVELOPMENT_PRINCIPAL;
      },
    },
    webhookVerifier: {
      async verify() {
        return undefined;
      },
    },
    webhookLedger: ledger,
    reconciler: {
      async reconcile(event) {
        reconciled.push(event);
        await overrides?.reconcile?.(event);
      },
    },
  });
  return { adapter, transport, reconciled };
}

test("hosted lifecycle delegates to transport then resolves PostgreSQL principal", async () => {
  const { adapter, transport } = adapterFixture();
  assert.deepEqual(
    await adapter.login({ redirectUri: "https://app.test/callback" }),
    { redirectUrl: "https://auth.example.test/authorize" },
  );
  const callback = await adapter.callback({
    code: "code_01",
    redirectUri: "https://app.test/callback",
  });
  assert.equal(callback.principal, DEVELOPMENT_PRINCIPAL);
  assert.equal(callback.sessionToken, "session-secret");
  assert.equal(
    (await adapter.refresh({ refreshToken: "refresh-secret" })).principal,
    DEVELOPMENT_PRINCIPAL,
  );
  assert.deepEqual(await adapter.logout({ sessionToken: "session-secret" }), {
    redirectUrl: "https://auth.example.test/logout",
  });
  assert.deepEqual(transport.calls, [
    "login:https://app.test/callback",
    "callback:code_01",
    "refresh:refresh-secret",
    "logout:session-secret",
  ]);
});

test("authentication accepts bearer or configured cookie and rejects invalid sessions", async () => {
  const { adapter, transport } = adapterFixture();
  assert.equal(
    await adapter.authenticate(new Request("https://app.test/api")),
    undefined,
  );
  assert.equal(
    await adapter.authenticate(
      new Request("https://app.test/api", {
        headers: { authorization: "Bearer bearer-token" },
      }),
    ),
    DEVELOPMENT_PRINCIPAL,
  );
  assert.equal(
    await adapter.authenticate(
      new Request("https://app.test/api", {
        headers: { cookie: "oao_session=cookie-token" },
      }),
    ),
    DEVELOPMENT_PRINCIPAL,
  );
  transport.validSession = false;
  assert.equal(
    await adapter.authenticate(
      new Request("https://app.test/api", {
        headers: { cookie: "oao_session=invalid" },
      }),
    ),
    undefined,
  );
  assert.deepEqual(transport.calls, [
    "validate:bearer-token",
    "validate:cookie-token",
    "validate:invalid",
  ]);
});

test("identity without a PostgreSQL principal cannot create a session", async () => {
  const { adapter } = adapterFixture({ resolve: false });
  await assert.rejects(
    adapter.callback({ code: "code", redirectUri: "https://app.test" }),
    (error: unknown) =>
      error instanceof AuthenticationError &&
      error.code === "principal_not_found",
  );
});

test("verified webhooks reconcile once and replay from durable event ID seam", async () => {
  const { adapter, reconciled } = adapterFixture();
  const rawBody = JSON.stringify({
    id: "event_01",
    event: "user.updated",
    created_at: "2026-01-01T00:00:00.000Z",
    data: { id: "user_01", email: "private@example.test" },
  });
  assert.deepEqual(
    await adapter.handleWebhook({ rawBody, signature: "test" }),
    { status: "processed", eventId: "event_01" },
  );
  assert.deepEqual(
    await adapter.handleWebhook({ rawBody, signature: "test" }),
    { status: "duplicate", eventId: "event_01" },
  );
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.type, "user.updated");
});

test("failed reconciliation releases the claim for a later retry", async () => {
  let attempts = 0;
  const { adapter } = adapterFixture({
    async reconcile() {
      attempts += 1;
      if (attempts === 1) throw new Error("database unavailable");
    },
  });
  const rawBody = JSON.stringify({
    id: "event_retry",
    event: "organization.updated",
    data: {},
  });
  await assert.rejects(
    adapter.handleWebhook({ rawBody, signature: "test" }),
    /database unavailable/u,
  );
  assert.deepEqual(
    await adapter.handleWebhook({ rawBody, signature: "test" }),
    { status: "processed", eventId: "event_retry" },
  );
  assert.equal(attempts, 2);
});

test("HMAC verifier authenticates exact raw bytes and rejects tampering and staleness", async () => {
  const rawBody = new TextEncoder().encode(
    '{"id":"event_01","event":"user.created","data":{}}',
  );
  const timestamp = 1_767_225_600_000;
  const secret = "webhook-secret";
  const digest = createHmac("sha256", secret)
    .update(new TextEncoder().encode(`${timestamp}.`))
    .update(rawBody)
    .digest("hex");
  const verifier = new WorkOsHmacWebhookVerifier({
    secret,
    now: () => new Date(timestamp),
  });
  await verifier.verify({
    rawBody,
    signature: `t=${timestamp}, v1=bad, v1=${digest}`,
  });
  await assert.rejects(
    verifier.verify({
      rawBody: new TextEncoder().encode("tampered"),
      signature: `t=${timestamp}, v1=${digest}`,
    }),
    (error: unknown) =>
      error instanceof WorkOsWebhookVerificationError &&
      error.reason === "invalid_signature",
  );
  const staleVerifier = new WorkOsHmacWebhookVerifier({
    secret,
    now: () => new Date(timestamp + 301_000),
  });
  await assert.rejects(
    staleVerifier.verify({
      rawBody,
      signature: `t=${timestamp}, v1=${digest}`,
    }),
    (error: unknown) =>
      error instanceof WorkOsWebhookVerificationError &&
      error.reason === "stale_signature",
  );
});
