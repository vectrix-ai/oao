import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthenticationError,
  DEVELOPMENT_PRINCIPAL,
  DEVELOPMENT_REFRESH_TOKEN,
  DevelopmentAuthAdapter,
  readBearerToken,
  readCookie,
} from "../src/index.ts";

test("development auth is deterministic and trusted by default", async () => {
  const adapter = new DevelopmentAuthAdapter({
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const request = new Request("http://localhost/api");

  assert.equal(await adapter.authenticate(request), DEVELOPMENT_PRINCIPAL);
  const session = await adapter.callback({ code: "ignored", redirectUri: "/" });
  assert.equal(session.principal, DEVELOPMENT_PRINCIPAL);
  assert.equal(session.expiresAt.toISOString(), "2026-01-02T00:00:00.000Z");
  assert.equal(
    (await adapter.refresh({ refreshToken: DEVELOPMENT_REFRESH_TOKEN }))
      .principal,
    DEVELOPMENT_PRINCIPAL,
  );
});

test("development auth uses a live clock unless a test clock is injected", async () => {
  const before = Date.now();
  const session = await new DevelopmentAuthAdapter().callback({
    code: "ignored",
    redirectUri: "/",
  });
  const after = Date.now();

  assert.ok(session.expiresAt.getTime() >= before + 24 * 60 * 60 * 1000);
  assert.ok(session.expiresAt.getTime() <= after + 24 * 60 * 60 * 1000);
});

test("development auth can require an explicit bearer token", async () => {
  const adapter = new DevelopmentAuthAdapter({ bearerToken: "local-secret" });
  assert.equal(
    await adapter.authenticate(new Request("http://localhost/api")),
    undefined,
  );
  assert.equal(
    await adapter.authenticate(
      new Request("http://localhost/api", {
        headers: { authorization: "Bearer local-secret" },
      }),
    ),
    DEVELOPMENT_PRINCIPAL,
  );
});

test("invalid development refresh is rejected with a safe error", async () => {
  const adapter = new DevelopmentAuthAdapter();
  await assert.rejects(
    adapter.refresh({ refreshToken: "wrong" }),
    (error: unknown) =>
      error instanceof AuthenticationError && error.code === "invalid_session",
  );
});

test("request token parsers are strict and tolerate malformed cookies", () => {
  assert.equal(
    readBearerToken(
      new Request("http://localhost", {
        headers: { authorization: "bearer abc" },
      }),
    ),
    "abc",
  );
  assert.equal(
    readBearerToken(
      new Request("http://localhost", {
        headers: { authorization: "Basic abc" },
      }),
    ),
    undefined,
  );
  assert.equal(
    readCookie(
      new Request("http://localhost", {
        headers: { cookie: "a=1; oao_session=hello%20world" },
      }),
      "oao_session",
    ),
    "hello world",
  );
  assert.equal(
    readCookie(
      new Request("http://localhost", {
        headers: { cookie: "oao_session=%zz" },
      }),
      "oao_session",
    ),
    undefined,
  );
});
