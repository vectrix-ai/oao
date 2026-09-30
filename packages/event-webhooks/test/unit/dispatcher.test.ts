import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationId, ProjectId } from "@oao/domain";
import { decodeEventCursor } from "@oao/events";
import {
  EventWebhookDispatcher,
  WebhookTransportError,
  generateWebhookSecret,
  matchesEventKinds,
  parseRetryAfter,
  retryDelayMs,
  verifyWebhookSignature,
  type ClaimedEventWebhook,
  type DeliveryOutcome,
  type EncryptedSigningKey,
  type EventWebhookStore,
  type EventWebhookWork,
  type PendingBatch,
  type WebhookProductEvent,
  type WebhookRequest,
  type WebhookResponse,
} from "../../src/index.js";

const claim: ClaimedEventWebhook = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
  webhookId: "00000000-0000-4000-8000-0000000000aa",
  leaseFence: 7n,
};
const currentSecret = generateWebhookSecret();
const previousSecret = generateWebhookSecret();
const keyFor = (secret: string): EncryptedSigningKey => ({
  ciphertext: Buffer.from(secret),
  nonce: Buffer.alloc(12),
  tag: Buffer.alloc(16),
  keyVersion: 1,
});

function event(
  position: number,
  kind = "run.state_changed",
  size = 0,
): WebhookProductEvent {
  return {
    id: `event-${position}`,
    organizationId: claim.organizationId,
    projectId: claim.projectId,
    aggregateType: "run",
    aggregateId: "run-1",
    aggregateSequence: position,
    projectPosition: String(position),
    kind,
    publicPayload: size ? { padding: "x".repeat(size) } : { state: "running" },
    occurredAt: "2026-09-29T12:00:00.000Z",
  };
}

class FakeStore implements EventWebhookStore {
  work: EventWebhookWork | undefined;
  claims: ClaimedEventWebhook[][] = [[claim]];
  readonly batches: PendingBatch[] = [];
  readonly skips: bigint[] = [];
  readonly outcomes: DeliveryOutcome[] = [];

  constructor(work: Partial<EventWebhookWork>) {
    this.work = {
      endpointUrl: "https://receiver.example.com/oao",
      eventKinds: null,
      includeMessageContent: false,
      signingKeys: [keyFor(currentSecret)],
      deliveredPosition: 10n,
      consecutiveFailures: 0,
      batch: null,
      events: [],
      ...work,
    };
  }
  async claim() {
    return this.claims.shift() ?? [];
  }
  async load() {
    return this.work;
  }
  async startBatch(
    _claim: ClaimedEventWebhook,
    _worker: string,
    batch: PendingBatch,
  ) {
    this.batches.push(batch);
    return true;
  }
  async skip(_claim: ClaimedEventWebhook, _worker: string, through: bigint) {
    this.skips.push(through);
    return true;
  }
  async finish(
    _claim: ClaimedEventWebhook,
    _worker: string,
    outcome: DeliveryOutcome,
  ) {
    this.outcomes.push(outcome);
    return true;
  }
}

function dispatcher(
  store: FakeStore,
  respond: (
    request: WebhookRequest,
  ) => Promise<WebhookResponse> | WebhookResponse,
  requests: WebhookRequest[] = [],
) {
  return new EventWebhookDispatcher({
    store,
    workerId: "worker-1",
    transport: async (request) => {
      requests.push(request);
      return respond(request);
    },
    decryptSigningKey: (key) => key.ciphertext.toString(),
    retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 60_000, random: () => 0.5 },
    now: () => new Date("2026-09-29T12:00:00.000Z"),
    maxBatchBytes: 2_000,
  });
}

test("a new batch is filtered, recorded before sending, and signed with every active key", async () => {
  const store = new FakeStore({
    eventKinds: ["run.*", "message.created"],
    signingKeys: [keyFor(currentSecret), keyFor(previousSecret)],
    events: [
      event(11),
      event(12, "tool_call.requested"),
      event(13, "message.created"),
    ],
  });
  const requests: WebhookRequest[] = [];
  assert.equal(
    await dispatcher(store, () => ({ status: 204 }), requests).runOnce(),
    1,
  );

  assert.equal(store.batches.length, 1);
  const batch = store.batches[0];
  assert.equal(batch?.throughPosition, 13n);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request && batch);
  assert.equal(request.headers["webhook-id"], batch.id);
  const body = JSON.parse(request.body);
  assert.equal(body.type, "oao.events");
  assert.equal(body.data.fromPosition, "10");
  assert.equal(body.data.throughPosition, "13");
  assert.equal(decodeEventCursor(body.data.cursor), 13n);
  assert.deepEqual(
    body.data.events.map((item: WebhookProductEvent) => item.projectPosition),
    ["11", "13"],
  );
  for (const secret of [currentSecret, previousSecret])
    assert.equal(
      verifyWebhookSignature({
        webhookId: batch.id,
        timestamp: Number(request.headers["webhook-timestamp"]),
        body: request.body,
        signatureHeader: request.headers["webhook-signature"] ?? "",
        secret,
        now: Number(request.headers["webhook-timestamp"]),
      }),
      true,
    );
  assert.deepEqual(store.outcomes, [
    { kind: "delivered", batchId: batch.id, responseStatus: 204 },
  ]);
});

test("a pending batch is resent under the same id", async () => {
  const pending = {
    id: "11111111-1111-4111-8111-111111111111",
    throughPosition: 12n,
  };
  const store = new FakeStore({
    batch: pending,
    events: [event(11), event(12)],
    consecutiveFailures: 2,
  });
  const requests: WebhookRequest[] = [];
  await dispatcher(store, () => ({ status: 200 }), requests).runOnce();
  assert.equal(store.batches.length, 0);
  assert.equal(requests[0]?.headers["webhook-id"], pending.id);
  assert.equal(JSON.parse(requests[0]?.body ?? "{}").data.events.length, 2);
  assert.equal(store.outcomes[0]?.kind, "delivered");
});

test("filtered-out events advance the cursor without a request", async () => {
  const store = new FakeStore({
    eventKinds: ["message.created"],
    events: [event(11), event(12, "tool_call.requested")],
  });
  const requests: WebhookRequest[] = [];
  await dispatcher(store, () => ({ status: 200 }), requests).runOnce();
  assert.deepEqual(store.skips, [12n]);
  assert.equal(requests.length, 0);
  assert.equal(store.outcomes.length, 0);
});

test("the byte budget ends a batch before the event that would overflow it", async () => {
  const store = new FakeStore({
    events: [
      event(11, "run.state_changed", 1_500),
      event(12, "run.state_changed", 1_500),
    ],
  });
  await dispatcher(store, () => ({ status: 200 })).runOnce();
  assert.equal(store.batches[0]?.throughPosition, 11n);
});

test("failures back off, honor Retry-After, and 410 disables the endpoint", async () => {
  const cases: [WebhookResponse | Error, Partial<DeliveryOutcome>][] = [
    [
      { status: 500 },
      {
        errorCode: "http_status",
        responseStatus: 500,
        retryAfterMs: 4_000,
        disable: false,
      },
    ],
    [
      { status: 429, retryAfterMs: 30_000 },
      { errorCode: "http_status", retryAfterMs: 30_000 },
    ],
    [{ status: 410 }, { errorCode: "endpoint_gone", disable: true }],
    [
      new WebhookTransportError("timeout", "slow"),
      { errorCode: "timeout", retryAfterMs: 4_000 },
    ],
    [
      new WebhookTransportError("destination_blocked", "private"),
      { errorCode: "destination_blocked" },
    ],
  ];
  for (const [response, expected] of cases) {
    const store = new FakeStore({
      events: [event(11)],
      consecutiveFailures: 2,
    });
    await dispatcher(store, () => {
      if (response instanceof Error) throw response;
      return response;
    }).runOnce();
    const outcome = store.outcomes[0];
    assert.equal(outcome?.kind, "failed");
    for (const [key, value] of Object.entries(expected))
      assert.deepEqual(
        (outcome as unknown as Record<string, unknown>)[key],
        value,
        key,
      );
  }
});

test("an undecryptable signing key is recorded without sending", async () => {
  const store = new FakeStore({ events: [event(11)] });
  const errors: unknown[] = [];
  const requests: WebhookRequest[] = [];
  const instance = new EventWebhookDispatcher({
    store,
    workerId: "worker-1",
    transport: async (request) => {
      requests.push(request);
      return { status: 200 };
    },
    decryptSigningKey: () => {
      throw new Error("Provider credential could not be decrypted");
    },
    onError: (error) => errors.push(error),
  });
  await instance.runOnce();
  assert.equal(requests.length, 0);
  assert.equal(store.outcomes[0]?.kind, "failed");
  assert.equal(
    (store.outcomes[0] as { errorCode: string }).errorCode,
    "signing_key_unavailable",
  );
  assert.equal(errors.length, 1);
});

test("a lost lease ends the attempt without writes", async () => {
  const store = new FakeStore({ events: [event(11)] });
  store.work = undefined;
  await dispatcher(store, () => ({ status: 200 })).runOnce();
  assert.equal(
    store.batches.length + store.skips.length + store.outcomes.length,
    0,
  );
});

test("the loop survives store errors, wakes early, and stops cleanly", async () => {
  const store = new FakeStore({ events: [event(11)] });
  let claims = 0;
  store.claim = async () => {
    claims += 1;
    if (claims === 1) throw new Error("database unavailable");
    return claims === 3 ? [claim] : [];
  };
  let wake: (() => void) | undefined;
  let unsubscribed = false;
  const errors: unknown[] = [];
  const instance = new EventWebhookDispatcher({
    store,
    workerId: "worker-1",
    transport: async () => ({ status: 200 }),
    decryptSigningKey: (key) => key.ciphertext.toString(),
    pollIntervalMs: 60_000,
    subscribeToWakes: async (onWake) => {
      wake = onWake;
      return async () => {
        unsubscribed = true;
      };
    },
    onError: (error) => errors.push(error),
  });
  instance.start();
  // The first claim fails and the loop backs off; a wake cuts the wait short.
  while (!wake || claims < 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  wake();
  while (claims < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  wake();
  while (store.outcomes.length < 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  await instance.stop();
  assert.equal(errors.length, 1);
  assert.equal(unsubscribed, true);
  assert.equal(store.outcomes[0]?.kind, "delivered");
});

test("event-kind filters, backoff, and Retry-After parsing", () => {
  assert.equal(matchesEventKinds("run.state_changed", null), true);
  assert.equal(matchesEventKinds("run.state_changed", ["run.*"]), true);
  assert.equal(
    matchesEventKinds("runtime.recovery_completed", ["run.*"]),
    false,
  );
  assert.equal(matchesEventKinds("message.created", ["message.created"]), true);
  const policy = { baseDelayMs: 2_000, maxDelayMs: 300_000, random: () => 0.5 };
  assert.deepEqual(
    [0, 1, 2, 10].map((failures) => retryDelayMs(failures, policy)),
    [2_000, 4_000, 8_000, 300_000],
  );
  assert.equal(parseRetryAfter("7"), 7_000);
  assert.equal(
    parseRetryAfter(
      "Tue, 29 Sep 2026 12:00:10 GMT",
      Date.parse("2026-09-29T12:00:00Z"),
    ),
    10_000,
  );
  assert.equal(parseRetryAfter("soon"), undefined);
});
