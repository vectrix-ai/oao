import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVELOPMENT_PRINCIPAL,
  DevelopmentAuthAdapter,
  type AuthCallbackInput,
  type AuthLoginInput,
  type AuthLogoutInput,
  type AuthTenantAdapter,
} from "@oao/auth-core";
import type { PgPool } from "@oao/db-postgres";
import { createApiApp } from "../../src/app.js";
import {
  apiErrorLogFields,
  apiLogLevel,
  HttpApiError,
} from "../../src/errors.js";
import { PostgresApiStore } from "../../src/store.js";
import type { RuntimeCommandPort } from "../../src/runtime-commands.js";

const unusedPool = {
  query: async () => ({ rowCount: 0, rows: [] }),
} as unknown as PgPool;
const unusedRuntimeCommands: RuntimeCommandPort = {
  enqueue: async () => {
    throw new Error("runtime commands are not expected in this unit test");
  },
};

class RecordingAuth implements AuthTenantAdapter {
  readonly delegate = new DevelopmentAuthAdapter();
  loginInput: AuthLoginInput | undefined;
  callbackInput: AuthCallbackInput | undefined;
  logoutInput: AuthLogoutInput | undefined;

  authenticate(request: Request) {
    return this.delegate.authenticate(request);
  }

  login(input: AuthLoginInput) {
    this.loginInput = input;
    return this.delegate.login(input);
  }

  callback(input: AuthCallbackInput) {
    this.callbackInput = input;
    return this.delegate.callback(input);
  }

  refresh(input: { readonly refreshToken: string }) {
    return this.delegate.refresh(input);
  }

  logout(input: AuthLogoutInput) {
    this.logoutInput = input;
    return this.delegate.logout(input);
  }
}

class RecordingWorkOsAuth extends RecordingAuth {
  override login(input: AuthLoginInput) {
    this.loginInput = input;
    return Promise.resolve({
      redirectUrl: "https://authkit.example.test/authorize",
    });
  }
}

function cookieFrom(header: string, name: string): string {
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`, "u").exec(header);
  assert.ok(match?.[1]);
  return `${name}=${match[1]}`;
}

test("health is public and deterministic", async () => {
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter(),
    runtimeCommands: unusedRuntimeCommands,
  });
  const response = await app.request("/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.ok(response.headers.get("x-request-id"));
});

test("expected authentication boundaries are informational in server logs", () => {
  assert.equal(
    apiLogLevel(
      new HttpApiError("unauthenticated", "Authentication is required"),
    ),
    "info",
  );
  assert.equal(
    apiLogLevel(new HttpApiError("not_found", "Route not found")),
    "error",
  );
  assert.equal(apiLogLevel(new Error("database unavailable")), "error");
});

test("unexpected errors retain their type and message in server log fields", () => {
  const error = new Error("The request signature does not match");
  error.name = "SignatureDoesNotMatch";
  assert.deepEqual(apiErrorLogFields(error), {
    level: "error",
    errorType: "SignatureDoesNotMatch",
    errorMessage: "The request signature does not match",
  });
});

test("route tenant scope is checked before database access", async () => {
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter(),
    runtimeCommands: unusedRuntimeCommands,
  });
  const response = await app.request(
    "/v1/projects/00000000-0000-4000-8000-000000000099/agents",
  );
  assert.equal(response.status, 403);
  assert.deepEqual(Object.keys((await response.json()).error).sort(), [
    "code",
    "message",
    "requestId",
  ]);
});

test("organization routes authenticate before reading principal context", async () => {
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter({ bearerToken: "valid-session" }),
    runtimeCommands: unusedRuntimeCommands,
  });

  for (const path of [
    "/v1/organizations",
    "/v1/organizations/00000000-0000-4000-8000-000000000001",
  ]) {
    const response = await app.request(path);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "unauthenticated");
  }
});

test("project lifecycle routes authenticate before any database access", async () => {
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter({ bearerToken: "valid-session" }),
    runtimeCommands: unusedRuntimeCommands,
  });
  const created = await app.request("/v1/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "unit-project-create",
    },
    body: JSON.stringify({ slug: "unit-project", name: "Unit project" }),
  });
  assert.equal(created.status, 401);
  assert.equal((await created.json()).error.code, "unauthenticated");
  const deleted = await app.request(
    "/v1/projects/00000000-0000-4000-8000-000000000099",
    {
      method: "DELETE",
      headers: { "idempotency-key": "unit-project-delete" },
    },
  );
  assert.equal(deleted.status, 401);
  assert.equal((await deleted.json()).error.code, "unauthenticated");
});

test("error envelopes never return internal exception messages", async () => {
  const failingPool = {
    query: async () => {
      throw new Error("authorization=Bearer secret-value rawPayload=private");
    },
  } as unknown as PgPool;
  const app = createApiApp({
    store: new PostgresApiStore(failingPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter(),
    runtimeCommands: unusedRuntimeCommands,
  });
  const response = await app.request("/readyz");
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.doesNotMatch(text, /secret-value|rawPayload|authorization/iu);
});

test("development auth lifecycle keeps tokens in HttpOnly cookies", async () => {
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter(),
    runtimeCommands: unusedRuntimeCommands,
  });
  const login = await app.request("/v1/auth/development/login", {
    method: "POST",
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/u);
  assert.doesNotMatch(setCookie, /; Secure/u);
  assert.doesNotMatch(await login.text(), /oao-development-session/u);
});

test("authentication responses expose optional provider display metadata", async () => {
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter({
      principal: {
        ...DEVELOPMENT_PRINCIPAL,
        displayName: "Ben Selleslagh",
      },
    }),
    runtimeCommands: unusedRuntimeCommands,
  });
  const response = await app.request("/v1/auth/development/login", {
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).principal.displayName, "Ben Selleslagh");
});

test("cookie-authenticated writes enforce APP_ORIGIN", async () => {
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter(),
    runtimeCommands: unusedRuntimeCommands,
    authConfiguration: {
      provider: "development",
      appOrigins: ["http://localhost:5173"],
      appOrigin: "http://localhost:5173",
      callbackUri: "http://localhost:5173/v1/auth/callback",
      cookieSecure: false,
      refreshCookieMaxAgeSeconds: 604_800,
    },
  });
  const login = await app.request("/v1/auth/development/login", {
    method: "POST",
  });
  const refreshCookie = cookieFrom(
    login.headers.get("set-cookie") ?? "",
    "oao_refresh",
  );
  assert.match(
    login.headers.get("set-cookie") ?? "",
    /oao_refresh=.*Max-Age=604800/u,
  );
  const rejectedMissing = await app.request("/v1/auth/refresh", {
    method: "POST",
    headers: { cookie: refreshCookie },
  });
  assert.equal(rejectedMissing.status, 403);
  const rejectedForeign = await app.request("/v1/auth/refresh", {
    method: "POST",
    headers: { cookie: refreshCookie, origin: "https://evil.example" },
  });
  assert.equal(rejectedForeign.status, 403);
  const accepted = await app.request("/v1/auth/refresh", {
    method: "POST",
    headers: { cookie: refreshCookie, origin: "http://localhost:5173" },
  });
  assert.equal(accepted.status, 200);
  const bearerDoesNotBypassPublicCookieAuth = await app.request(
    "/v1/auth/refresh",
    {
      method: "POST",
      headers: {
        authorization: "Bearer oao_key-credential",
        cookie: refreshCookie,
      },
    },
  );
  assert.equal(bearerDoesNotBypassPublicCookieAuth.status, 403);
});

test("login uses configured callback, binds state, and rejects caller redirects", async () => {
  const auth = new RecordingAuth();
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth,
    runtimeCommands: unusedRuntimeCommands,
    authConfiguration: {
      provider: "development",
      appOrigins: ["https://app.example.test"],
      appOrigin: "https://app.example.test",
      callbackUri: "https://app.example.test/v1/auth/callback",
      cookieSecure: true,
    },
  });
  const openRedirect = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirectUri: "https://evil.example/callback" }),
  });
  assert.equal(openRedirect.status, 400);

  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "oao_session=stale-session; oao_refresh=stale-refresh",
      origin: "https://stale-origin.example.test",
    },
    body: "{}",
  });
  assert.equal(login.status, 200);
  assert.equal(
    auth.loginInput?.redirectUri,
    "https://app.example.test/v1/auth/callback",
  );
  assert.ok(auth.loginInput?.state);
  const stateCookie = cookieFrom(
    login.headers.get("set-cookie") ?? "",
    "oao_auth_state",
  );
  assert.match(
    login.headers.get("set-cookie") ?? "",
    /oao_auth_state=[^;]+;[^,]*HttpOnly; Secure/u,
  );

  const mismatch = await app.request(
    "/v1/auth/callback?code=development&state=wrong",
    { headers: { cookie: stateCookie } },
  );
  assert.equal(mismatch.status, 400);
  assert.equal(auth.callbackInput, undefined);

  const callback = await app.request(
    `/v1/auth/callback?code=development&state=${encodeURIComponent(auth.loginInput?.state ?? "")}&returnTo=https%3A%2F%2Fevil.example`,
    { headers: { cookie: stateCookie } },
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "https://app.example.test");
  assert.equal(
    (auth.callbackInput as AuthCallbackInput | undefined)?.redirectUri,
    "https://app.example.test/v1/auth/callback",
  );
  const sessionCookie = cookieFrom(
    callback.headers.get("set-cookie") ?? "",
    "oao_session",
  );
  const logout = await app.request("/v1/auth/logout", {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      origin: "https://app.example.test",
    },
  });
  assert.equal(logout.status, 200);
  assert.equal(auth.logoutInput?.returnTo, "https://app.example.test");
  assert.match(logout.headers.get("set-cookie") ?? "", /; Secure/u);
});

test("WorkOS mode does not expose deterministic development login", async () => {
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter(),
    runtimeCommands: unusedRuntimeCommands,
    authConfiguration: {
      provider: "workos",
      appOrigins: ["https://app.example.test"],
      appOrigin: "https://app.example.test",
      callbackUri: "https://app.example.test/v1/auth/callback",
      cookieSecure: true,
    },
  });
  const response = await app.request("/v1/auth/development/login", {
    method: "POST",
  });
  assert.equal(response.status, 404);
});

test("WorkOS callback with stale state starts a fresh hosted login", async () => {
  const auth = new RecordingWorkOsAuth();
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth,
    runtimeCommands: unusedRuntimeCommands,
    authConfiguration: {
      provider: "workos",
      appOrigins: ["https://app.example.test"],
      appOrigin: "https://app.example.test",
      callbackUri: "https://app.example.test/v1/auth/callback",
      cookieSecure: true,
    },
  });

  const response = await app.request(
    "/v1/auth/callback?code=stale-code&state=stale-state",
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://authkit.example.test/authorize",
  );
  assert.equal(auth.callbackInput, undefined);
  assert.ok(auth.loginInput?.state);
  assert.match(
    response.headers.get("set-cookie") ?? "",
    /oao_auth_state=[^;]+;[^,]*HttpOnly; Secure/u,
  );
});
