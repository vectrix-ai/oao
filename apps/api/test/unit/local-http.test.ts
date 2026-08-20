import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { serve } from "@hono/node-server";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import type { PgPool } from "@oao/db-postgres";
import { createApiApp } from "../../src/app.js";
import { PostgresApiStore } from "../../src/store.js";

test("localhost HTTP accepts the development session cookie", async (t) => {
  const pool = {
    async query() {
      return { rowCount: 0, rows: [] };
    },
  } as unknown as PgPool;
  const app = createApiApp({
    store: new PostgresApiStore(pool, "local-http-test-pepper"),
    auth: new DevelopmentAuthAdapter(),
    runtimeCommands: {
      async enqueue() {
        throw new Error("runtime command is not expected");
      },
    },
    authConfiguration: {
      provider: "development",
      appOrigins: ["http://localhost:5173"],
      appOrigin: "http://localhost:5173",
      callbackUri: "http://localhost:5173/v1/auth/callback",
      cookieSecure: false,
    },
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${baseUrl}/v1/auth/development/login`, {
    method: "POST",
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.doesNotMatch(setCookie, /; Secure/u);
  const refresh = /(?:^|,\s*)oao_refresh=([^;]+)/u.exec(setCookie)?.[1];
  assert.ok(refresh);
  const refreshed = await fetch(`${baseUrl}/v1/auth/refresh`, {
    method: "POST",
    headers: {
      cookie: `oao_refresh=${refresh}`,
      origin: "http://localhost:5173",
    },
  });
  assert.equal(refreshed.status, 200);
});
