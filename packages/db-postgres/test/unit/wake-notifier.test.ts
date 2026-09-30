import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { OrganizationId, ProjectId } from "@oao/domain";
import type pg from "pg";
import { PostgresWakeNotifier, type PgPool } from "../../src/index.js";

const organizationId = "00000000-0000-4000-8000-000000000001" as OrganizationId;
const projectA = "00000000-0000-4000-8000-000000000002" as ProjectId;
const projectB = "00000000-0000-4000-8000-000000000003" as ProjectId;
const unusedPool = {} as PgPool;

class FakeListenerClient extends EventEmitter {
  readonly queries: string[] = [];
  ended = false;

  constructor(private readonly connectError?: Error) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
  }

  async query(text: string): Promise<{ rows: [] }> {
    this.queries.push(text);
    return { rows: [] };
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.emit("end");
  }

  notify(payload: string | undefined, channel = "oao_product_events"): void {
    this.emit("notification", { processId: 1, channel, payload });
  }

  get listening(): boolean {
    return this.queries.includes("LISTEN oao_product_events");
  }
}

function harness(
  options: {
    readonly connectErrors?: readonly (Error | undefined)[];
    readonly idleReleaseMs?: number;
  } = {},
) {
  const clients: FakeListenerClient[] = [];
  const errors: unknown[] = [];
  const connectErrors = [...(options.connectErrors ?? [])];
  const notifier = new PostgresWakeNotifier(unusedPool, {
    createListenerClient: () => {
      const client = new FakeListenerClient(connectErrors.shift());
      clients.push(client);
      return client as unknown as pg.Client;
    },
    reconnectDelayMs: 5,
    maxReconnectDelayMs: 20,
    idleReleaseMs: options.idleReleaseMs ?? 60_000,
    onListenerError: (error) => errors.push(error),
  });
  return { notifier, clients, errors };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("subscribers share one LISTEN connection and receive only their project's wakes", async () => {
  const { notifier, clients } = harness();
  const wakes = { a: 0, b: 0, all: 0 };
  const scopeA = { organizationId, projectId: projectA };
  const scopeB = { organizationId, projectId: projectB };
  const unsubscribes = [
    await notifier.subscribe(() => wakes.a++, scopeA),
    await notifier.subscribe(() => wakes.b++, scopeB),
    await notifier.subscribe(() => wakes.all++),
  ];
  await waitFor(() => clients[0]?.listening === true, "LISTEN");
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0]?.queries, ["LISTEN oao_product_events"]);

  clients[0]?.notify(`${organizationId}/${projectA}`);
  assert.deepEqual(wakes, { a: 1, b: 0, all: 1 });

  // A payload that cannot be attributed to a project wakes everyone.
  clients[0]?.notify(undefined);
  assert.deepEqual(wakes, { a: 2, b: 1, all: 2 });

  clients[0]?.notify(`${organizationId}/${projectA}`, "other_channel");
  assert.deepEqual(wakes, { a: 2, b: 1, all: 2 });

  for (const unsubscribe of unsubscribes) await unsubscribe();
  await notifier.close();
  assert.equal(clients[0]?.ended, true);
});

test("a failing subscriber does not starve the others", async () => {
  const { notifier, clients } = harness();
  let delivered = 0;
  await notifier.subscribe(() => {
    throw new Error("subscriber failure");
  });
  await notifier.subscribe(() => delivered++);
  await waitFor(() => clients[0]?.listening === true, "LISTEN");
  clients[0]?.notify(`${organizationId}/${projectA}`);
  assert.equal(delivered, 1);
  await notifier.close();
});

test("a lost listener wakes subscribers, reports the error, and reconnects", async () => {
  const { notifier, clients, errors } = harness({
    connectErrors: [new Error("connection refused")],
  });
  let wakes = 0;
  // An unavailable channel must not fail the subscription; streams keep polling.
  const unsubscribe = await notifier.subscribe(() => wakes++);
  await waitFor(() => clients[1]?.listening === true, "reconnected LISTEN");
  assert.equal(errors.length, 1);
  assert.equal(clients[0]?.ended, true);
  const wakesAfterRecovery = wakes;
  assert.ok(
    wakesAfterRecovery >= 1,
    "recovery wakes subscribers to re-read missed events",
  );

  clients[1]?.emit("error", new Error("terminating connection"));
  assert.equal(errors.length, 2);
  assert.equal(clients[1]?.ended, true);
  assert.ok(wakes > wakesAfterRecovery, "a lost listener wakes subscribers");
  await waitFor(() => clients[2]?.listening === true, "second reconnect");

  // A retired connection's late events are ignored.
  clients[1]?.emit("error", new Error("late socket error"));
  clients[1]?.notify(undefined);
  assert.equal(errors.length, 2);

  await unsubscribe();
  await notifier.close();
  assert.equal(clients[2]?.ended, true);
});

test("the listener is released only after the idle grace period", async () => {
  const { notifier, clients } = harness({ idleReleaseMs: 30 });
  const first = await notifier.subscribe(() => undefined);
  await waitFor(() => clients[0]?.listening === true, "LISTEN");
  await first();
  // A quick reconnect, like an SSE client after a normal close, reuses the connection.
  const second = await notifier.subscribe(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clients.length, 1);
  assert.equal(clients[0]?.ended, false);

  await second();
  await waitFor(() => clients[0]?.ended === true, "idle release");
  const third = await notifier.subscribe(() => undefined);
  await waitFor(() => clients[1]?.listening === true, "fresh LISTEN");
  await third();
  await notifier.close();
});

test("closing releases the listener and later subscriptions stay inert", async () => {
  const { notifier, clients } = harness();
  await notifier.subscribe(() => undefined);
  await notifier.close();
  assert.equal(clients.length, 1);
  assert.equal(clients[0]?.ended, true);
  const unsubscribe = await notifier.subscribe(() => assert.fail("woken"));
  await unsubscribe();
  assert.equal(clients.length, 1);
});
