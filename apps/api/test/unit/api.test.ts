import assert from "node:assert/strict";
import test from "node:test";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import type { PgPool } from "@oao/db-postgres";
import { createApiApp } from "../../src/app.js";
import { PostgresApiStore } from "../../src/store.js";

const unusedPool = {
  query: async () => ({ rowCount: 0, rows: [] }),
} as unknown as PgPool;

test("health is public and deterministic", async () => {
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter(),
  });
  const response = await app.request("/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.ok(response.headers.get("x-request-id"));
});

test("route tenant scope is checked before database access", async () => {
  const app = createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter(),
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

test("error envelopes never return internal exception messages", async () => {
  const failingPool = {
    query: async () => {
      throw new Error("authorization=Bearer secret-value rawPayload=private");
    },
  } as unknown as PgPool;
  const app = createApiApp({
    store: new PostgresApiStore(failingPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter(),
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
  });
  const callback = await app.request(
    "/v1/auth/callback?code=development&redirectUri=http%3A%2F%2Flocalhost%2Fcallback",
  );
  assert.equal(callback.status, 200);
  assert.match(callback.headers.get("set-cookie") ?? "", /HttpOnly/u);
  assert.doesNotMatch(await callback.text(), /oao-development-session/u);
});
