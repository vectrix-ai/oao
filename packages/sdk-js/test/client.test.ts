import assert from "node:assert/strict";
import test from "node:test";

import {
  OaoApiError,
  OaoClient,
  createRoutes,
  parseEventStream,
} from "../src/index.ts";

test("route builders scope resources to a project and allow a custom prefix", () => {
  const routes = createRoutes("/platform/v2/");
  assert.equal(
    routes.claimToolCall("project/one", "call one"),
    "/platform/v2/projects/project%2Fone/tool-calls/call%20one/claim",
  );
});

test("client encodes pagination, authentication, and idempotency", async () => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({
      id: "run-1",
      state: "queued",
    });
  };
  const client = new OaoClient({
    baseUrl: "https://api.example.test/",
    apiPrefix: "/platform/v2",
    bearerToken: async () => "token-value",
    fetch,
  });

  await client.submitRun(
    "project one",
    "session/one",
    { redactedInput: "hello" },
    { idempotencyKey: "submit-1" },
  );
  assert.equal(
    requests[0]?.url,
    "https://api.example.test/platform/v2/projects/project%20one/sessions/session%2Fone/runs",
  );
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer token-value");
  assert.equal(requests[0]?.headers.get("idempotency-key"), "submit-1");
  assert.deepEqual(await requests[0]?.json(), { redactedInput: "hello" });
});

test("cursor pagination is encoded without exposing project scope in headers", async () => {
  let request: Request | undefined;
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        data: [],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    },
  });

  await client.listAgents("project/one", { cursor: "position/41", limit: 25 });
  assert.equal(
    request?.url,
    "https://api.example.test/v1/projects/project%2Fone/agents?cursor=position%2F41&limit=25",
  );
  assert.equal(request?.headers.has("x-organization-id"), false);
});

test("client surfaces the structured error envelope without response-body leakage", async () => {
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "idempotency_conflict",
            message: "The idempotency key was already used",
            requestId: "request-1",
          },
        },
        { status: 409 },
      ),
  });

  await assert.rejects(
    client.cancelRun("project-1", "run-1", { idempotencyKey: "cancel-1" }),
    (error: unknown) => {
      assert.ok(error instanceof OaoApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "idempotency_conflict");
      assert.equal(error.requestId, "request-1");
      return true;
    },
  );
});

test("event stream parser handles chunking, CRLF, comments, and multiline data", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(": keepalive\r\nid: 41\r\nevent: product"),
      );
      controller.enqueue(
        encoder.encode('_event\r\ndata: {"one":\r\ndata: 1}\r\n\r\n'),
      );
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseEventStream(body)) events.push(event);
  assert.deepEqual(events, [
    { id: "41", event: "product_event", data: '{"one":\n1}' },
  ]);
});

test("project SSE sends Last-Event-ID and yields the durable event", async () => {
  const encoder = new TextEncoder();
  let request: Request | undefined;
  const event = {
    id: "00000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-8000-000000000002",
    projectId: "00000000-0000-4000-8000-000000000003",
    aggregateType: "run",
    aggregateId: "00000000-0000-4000-8000-000000000004",
    aggregateSequence: 2,
    projectPosition: "42",
    kind: "run.state_changed",
    publicPayload: { state: "running" },
    occurredAt: "2026-08-20T00:00:00.000Z",
  } as const;
  const client = new OaoClient({
    baseUrl: "https://api.example.test",
    apiKey: "oao_test_key",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `id: 42\nevent: product_event\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const frames = [];
  for await (const frame of client.streamProjectEvents("project-1", {
    lastEventId: "40",
    reconnect: false,
  })) {
    frames.push(frame);
  }

  assert.equal(request?.headers.get("last-event-id"), "40");
  assert.equal(request?.headers.get("authorization"), "Bearer oao_test_key");
  assert.deepEqual(frames, [{ id: "42", event: "product_event", data: event }]);
});
