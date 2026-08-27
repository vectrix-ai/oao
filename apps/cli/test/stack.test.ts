import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { stackIsReady } from "../src/stack.js";

async function serve(
  body: string,
  contentType: string,
): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": contentType });
    response.end(body);
  });
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test server has no TCP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      ),
  };
}

test("stack readiness accepts only the complete OAO service signatures", async () => {
  const api = await serve('{"status":"ready"}', "application/json");
  const runtime = await serve(
    '{"status":"ready","profile":"project-providers"}',
    "application/json",
  );
  const consoleServer = await serve(
    "<!doctype html><title>OAO Console</title>",
    "text/html",
  );
  try {
    assert.equal(
      await stackIsReady({
        apiOrigin: api.origin,
        runtimeOrigin: runtime.origin,
        consoleOrigin: consoleServer.origin,
      }),
      true,
    );
    assert.equal(
      await stackIsReady({
        apiOrigin: consoleServer.origin,
        runtimeOrigin: runtime.origin,
        consoleOrigin: consoleServer.origin,
      }),
      false,
    );
  } finally {
    await Promise.all([api.close(), runtime.close(), consoleServer.close()]);
  }
});
