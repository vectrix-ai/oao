import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { mountConsoleStatic } from "../../src/console-static.js";

function createApp(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.notFound((c) => c.json({ error: { code: "not_found" } }, 404));
  mountConsoleStatic(app, "test/fixtures/console");
  return app;
}

test("serves the console index at the root and for client-side routes", async () => {
  const app = createApp();

  for (const path of ["/", "/settings/members"]) {
    const response = await app.request(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OAO console test fixture/u);
  }
});

test("serves static console assets without replacing API routes", async () => {
  const app = createApp();

  const asset = await app.request("/asset.txt");
  assert.equal(asset.status, 200);
  assert.equal((await asset.text()).trim(), "static asset");

  const health = await app.request("/healthz");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
});

test("keeps unknown API and non-GET requests on the JSON 404 boundary", async () => {
  const app = createApp();

  for (const [path, method] of [
    ["/v1/missing", "GET"],
    ["/settings/members", "POST"],
  ] as const) {
    const response = await app.request(path, { method });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "not_found" },
    });
  }
});
