import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@oao/db-postgres";
import { composeAuthentication } from "../../src/composition.js";
import { loadServerConfiguration } from "../../src/config.js";

const databaseUrl = "postgresql://example.invalid/oao";

test("development configuration permits explicit localhost HTTP only", () => {
  const configuration = loadServerConfiguration({
    AUTH_PROVIDER: "development",
    APP_ORIGIN: "http://localhost:5173",
    DATABASE_URL: databaseUrl,
    NODE_ENV: "development",
  });
  assert.equal(configuration.cookieSecure, false);
  assert.equal(configuration.refreshCookieMaxAgeSeconds, 86_400);
  assert.equal(
    configuration.callbackUri,
    "http://localhost:5173/v1/auth/callback",
  );
  assert.equal(configuration.workos, undefined);
  assert.throws(
    () =>
      loadServerConfiguration({
        AUTH_PROVIDER: "development",
        APP_ORIGIN: "http://localhost:5173",
        DATABASE_URL: databaseUrl,
        NODE_ENV: "production",
        API_KEY_PEPPER: "production-pepper",
      }),
    /HTTP cookies/u,
  );
});

test("WorkOS configuration requires an allowed fixed callback and secrets", () => {
  const configuration = loadServerConfiguration({
    AUTH_PROVIDER: "workos",
    APP_ORIGIN: "https://app.example.test,https://api.example.test",
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
    API_KEY_PEPPER: "pepper",
    WORKOS_API_KEY: "sk_not-real",
    WORKOS_CLIENT_ID: "client_not-real",
    WORKOS_COOKIE_PASSWORD: "cookie-password-at-least-32-characters",
    WORKOS_WEBHOOK_SECRET: "whsec_not-real",
    WORKOS_CALLBACK_URL: "https://app.example.test/v1/auth/callback",
  });
  assert.equal(configuration.cookieSecure, true);
  assert.equal(configuration.refreshCookieMaxAgeSeconds, 34_560_000);
  assert.equal(configuration.workos?.clientId, "client_not-real");
  assert.throws(
    () =>
      loadServerConfiguration({
        AUTH_PROVIDER: "workos",
        APP_ORIGIN: "https://app.example.test",
        DATABASE_URL: databaseUrl,
        NODE_ENV: "production",
        API_KEY_PEPPER: "pepper",
        WORKOS_API_KEY: "sk_not-real",
        WORKOS_CLIENT_ID: "client_not-real",
        WORKOS_COOKIE_PASSWORD: "cookie-password-at-least-32-characters",
        WORKOS_WEBHOOK_SECRET: "whsec_not-real",
        WORKOS_CALLBACK_URL: "https://evil.example/v1/auth/callback",
      }),
    /APP_ORIGIN/u,
  );
});

test("server composition seeds only development and selects hosted WorkOS", async () => {
  const calls: string[] = [];
  const pool = {
    async query(text: string) {
      calls.push(text);
      return { rowCount: 0, rows: [] };
    },
  } as unknown as PgPool;
  const development = loadServerConfiguration({
    AUTH_PROVIDER: "development",
    APP_ORIGIN: "http://localhost:5173",
    DATABASE_URL: databaseUrl,
    NODE_ENV: "development",
  });
  const developmentComposition = await composeAuthentication(development, pool);
  assert.equal(developmentComposition.webhookAuth, undefined);
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /bootstrap_project/u);

  calls.length = 0;
  const workos = loadServerConfiguration({
    AUTH_PROVIDER: "workos",
    APP_ORIGIN: "https://app.example.test",
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
    API_KEY_PEPPER: "pepper",
    WORKOS_API_KEY: "sk_not-real",
    WORKOS_CLIENT_ID: "client_not-real",
    WORKOS_COOKIE_PASSWORD: "cookie-password-at-least-32-characters",
    WORKOS_WEBHOOK_SECRET: "whsec_not-real",
    WORKOS_CALLBACK_URL: "https://app.example.test/v1/auth/callback",
  });
  const workosComposition = await composeAuthentication(workos, pool);
  assert.ok(workosComposition.webhookAuth);
  assert.equal(calls.length, 0);
});
