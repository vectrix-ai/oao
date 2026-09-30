import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createWebhookTransport,
  validateWebhookEndpoint,
  WebhookTransportError,
} from "../../src/index.js";

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/hooks` };
}

const request = (url: string) => ({
  url,
  headers: { "content-type": "application/json", "webhook-id": "batch-1" },
  body: '{"hello":"world"}',
});

test("delivers to an allowed endpoint and reports status and Retry-After without following redirects", async () => {
  const received: {
    method: string | undefined;
    body: string;
    headers: Record<string, unknown>;
  }[] = [];
  const { server, url } = await listen((incoming, response) => {
    let body = "";
    incoming.on("data", (chunk) => (body += chunk));
    incoming.on("end", () => {
      received.push({
        method: incoming.method,
        body,
        headers: incoming.headers,
      });
      if (received.length === 1) {
        response.writeHead(429, { "retry-after": "12" });
        response.end("slow down");
      } else {
        response.writeHead(302, { location: "http://169.254.169.254/" });
        response.end();
      }
    });
  });
  try {
    const transport = createWebhookTransport({ allowPrivateNetwork: true });
    assert.deepEqual(await transport(request(url)), {
      status: 429,
      retryAfterMs: 12_000,
    });
    assert.deepEqual(await transport(request(url)), { status: 302 });
    assert.equal(received.length, 2);
    assert.equal(received[0]?.method, "POST");
    assert.equal(received[0]?.body, '{"hello":"world"}');
    assert.equal(received[0]?.headers["webhook-id"], "batch-1");
  } finally {
    server.close();
  }
});

test("production transports refuse plain HTTP, private addresses, and private DNS answers", async () => {
  const transport = createWebhookTransport({
    resolve: async () => [{ address: "10.0.0.7", family: 4 }],
  });
  for (const url of [
    "http://receiver.example.com/hooks",
    "https://127.0.0.1/hooks",
    "https://[::1]/hooks",
    "https://localhost/hooks",
    "https://169.254.169.254/latest/meta-data",
    "https://rebinding.example.com/hooks",
  ])
    await assert.rejects(
      transport(request(url)),
      (error: unknown) =>
        error instanceof WebhookTransportError &&
        error.code === "destination_blocked",
      url,
    );
});

test("a silent endpoint times out", async () => {
  const { server, url } = await listen(() => undefined);
  try {
    const transport = createWebhookTransport({
      allowPrivateNetwork: true,
      timeoutMs: 100,
    });
    await assert.rejects(
      transport(request(url)),
      (error: unknown) =>
        error instanceof WebhookTransportError && error.code === "timeout",
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("endpoint validation rejects credentials, fragments, and non-HTTP schemes", () => {
  assert.equal(
    validateWebhookEndpoint("https://hooks.example.com/oao?x=1").host,
    "hooks.example.com",
  );
  for (const url of [
    "https://user:pass@hooks.example.com/",
    "https://hooks.example.com/#frag",
    "ftp://hooks.example.com/",
    "not a url",
  ])
    assert.throws(() => validateWebhookEndpoint(url), TypeError, url);
  assert.equal(
    validateWebhookEndpoint("http://127.0.0.1:3211/oao", {
      allowPrivateNetwork: true,
    }).port,
    "3211",
  );
});

test("the private-network escape hatch is development only", async () => {
  const { allowPrivateWebhookNetwork } = await import("../../src/index.js");
  assert.equal(allowPrivateWebhookNetwork({}), false);
  assert.equal(
    allowPrivateWebhookNetwork({
      OAO_EVENT_WEBHOOKS_ALLOW_PRIVATE_NETWORK: "false",
    }),
    false,
  );
  assert.equal(
    allowPrivateWebhookNetwork({
      OAO_EVENT_WEBHOOKS_ALLOW_PRIVATE_NETWORK: "true",
      NODE_ENV: "development",
    }),
    true,
  );
  assert.throws(() =>
    allowPrivateWebhookNetwork({
      OAO_EVENT_WEBHOOKS_ALLOW_PRIVATE_NETWORK: "true",
      NODE_ENV: "production",
    }),
  );
  assert.throws(() =>
    allowPrivateWebhookNetwork({
      OAO_EVENT_WEBHOOKS_ALLOW_PRIVATE_NETWORK: "yes",
    }),
  );
});

test("a response body that never ends is abandoned after the status arrives", async () => {
  let closed = false;
  const { server, url } = await listen((_incoming, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("partial");
    response.on("close", () => (closed = true));
  });
  try {
    const transport = createWebhookTransport({ allowPrivateNetwork: true });
    const started = Date.now();
    assert.deepEqual(await transport(request(url)), { status: 200 });
    assert.ok(
      Date.now() - started < 1_000,
      "status resolves without waiting for the body",
    );
    const deadline = Date.now() + 8_000;
    while (!closed && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, true, "the stalled body is destroyed");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
