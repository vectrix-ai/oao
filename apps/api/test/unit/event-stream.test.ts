import assert from "node:assert/strict";
import test from "node:test";
import { DEVELOPMENT_PRINCIPAL, DevelopmentAuthAdapter } from "@oao/auth-core";
import type { PgClient, PgPool, TenantContext } from "@oao/db-postgres";
import type { AuthorizationAction, Principal } from "@oao/domain";
import type { WakeOnlyNotifier, WakeSubscriptionScope } from "@oao/events";
import { decodeEventCursor } from "@oao/events";
import { createApiApp, type EventStreamTiming } from "../../src/app.js";
import type { RuntimeCommandPort } from "../../src/runtime-commands.js";
import { PostgresApiStore } from "../../src/store.js";

const unusedPool = {
  query: async () => ({ rowCount: 0, rows: [] }),
} as unknown as PgPool;
const unusedRuntimeCommands: RuntimeCommandPort = {
  enqueue: async () => {
    throw new Error("runtime commands are not expected in this unit test");
  },
};
const eventsPath = `/v1/projects/${DEVELOPMENT_PRINCIPAL.projectId}/events`;

function eventRow(position: number): Record<string, unknown> {
  return {
    organization_id: DEVELOPMENT_PRINCIPAL.organizationId,
    project_id: DEVELOPMENT_PRINCIPAL.projectId,
    project_position: String(position),
    id: `00000000-0000-4000-8000-${position.toString().padStart(12, "0")}`,
    aggregate_type: "run",
    aggregate_id: "00000000-0000-4000-8000-000000000999",
    aggregate_sequence: String(position),
    event_kind: "run.state_changed",
    public_payload: { state: "running" },
    occurred_at: "2026-09-29T12:00:00.000Z",
  };
}

/** Serves queued pages of product-event rows and records when each read happened. */
class EventPageStore extends PostgresApiStore {
  readonly readAt: number[] = [];
  readonly positions: string[] = [];

  constructor(private readonly pages: Record<string, unknown>[][]) {
    super(unusedPool, "unit-test-api-key-pepper");
  }

  override async transaction<T>(
    principal: Principal,
    _action: AuthorizationAction | readonly AuthorizationAction[] | undefined,
    callback: (transaction: PgClient, tenant: TenantContext) => Promise<T>,
  ): Promise<T> {
    const rows = this.pages.shift() ?? [];
    const transaction = {
      query: async (_text: string, values: readonly unknown[]) => {
        this.readAt.push(Date.now());
        this.positions.push(String(values[2]));
        return { rowCount: rows.length, rows };
      },
    } as unknown as PgClient;
    return callback(transaction, {
      organizationId: principal.organizationId,
      projectId: principal.projectId,
    });
  }
}

class RecordingNotifier implements WakeOnlyNotifier {
  readonly scopes: (WakeSubscriptionScope | undefined)[] = [];
  unsubscribed = 0;
  wake: (() => void) | undefined;

  async notifyProject(): Promise<void> {}

  async subscribe(
    onWake: () => void,
    scope?: WakeSubscriptionScope,
  ): Promise<() => Promise<void>> {
    this.scopes.push(scope);
    this.wake = onWake;
    return async () => {
      this.unsubscribed += 1;
    };
  }
}

/** Reads the stream until `done` holds, then disconnects like a client closing a tab. */
async function readUntil(
  response: Response,
  done: (body: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let body = "";
  try {
    while (!done(body)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(
            () => resolve("timeout"),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
      clearTimeout(timer);
      if (chunk === "timeout" || chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  assert.ok(
    done(body),
    `stream never matched; received ${JSON.stringify(body)}`,
  );
  return body;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const countLines = (body: string, pattern: RegExp): number =>
  body.match(pattern)?.length ?? 0;
const LONG_WAIT_MS = 60_000;

function eventApp(
  store: EventPageStore,
  timing: Partial<EventStreamTiming>,
  notifier?: WakeOnlyNotifier,
) {
  return createApiApp({
    store,
    auth: new DevelopmentAuthAdapter(),
    runtimeCommands: unusedRuntimeCommands,
    eventStreamTiming: timing,
    ...(notifier ? { notifier } : {}),
  });
}

test("event stream flushes a comment at once, keeps quiet streams alive, and disables proxy buffering", async () => {
  const store = new EventPageStore([]);
  const notifier = new RecordingNotifier();
  const app = eventApp(
    store,
    {
      maxConnectionMs: LONG_WAIT_MS,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 40,
    },
    notifier,
  );
  const response = await app.request(eventsPath);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  const body = await readUntil(
    response,
    (text) => countLines(text, /^: keepalive$/gmu) >= 2,
  );
  assert.ok(body.startsWith(": connected\n\n"), body);
  assert.doesNotMatch(body, /^data:/mu);
  assert.deepEqual(notifier.scopes, [
    {
      organizationId: DEVELOPMENT_PRINCIPAL.organizationId,
      projectId: DEVELOPMENT_PRINCIPAL.projectId,
    },
  ]);
  await waitFor(() => notifier.unsubscribed === 1, "unsubscribe");
});

test("event stream skips keepalives while events keep flowing", async () => {
  const pages = Array.from({ length: 5_000 }, (_, index) => [
    eventRow(index + 1),
  ]);
  const store = new EventPageStore(pages);
  const app = eventApp(store, {
    maxConnectionMs: 30_000,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 250,
  });
  // Events arrive every poll for well past the heartbeat interval.
  const started = Date.now();
  const body = await readUntil(
    await app.request(eventsPath),
    () => Date.now() - started >= 750,
  );
  assert.ok((body.match(/^event: run\.state_changed$/gmu)?.length ?? 0) > 10);
  assert.doesNotMatch(body, /^: keepalive$/mu);
});

test("one-page event reads stay comment-free and do not subscribe to wakes", async () => {
  const store = new EventPageStore([[eventRow(1), eventRow(2)]]);
  const notifier = new RecordingNotifier();
  const app = eventApp(store, {}, notifier);
  const body = await (await app.request(`${eventsPath}?once=true`)).text();
  assert.ok(body.startsWith("event: run.state_changed\n"), body);
  assert.doesNotMatch(body, /^:/mu);
  const ids = [...body.matchAll(/^id: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(
    ids.map((id) => decodeEventCursor(id ?? "")),
    [1n, 2n],
  );
  assert.deepEqual(notifier.scopes, []);
});

test("event stream drains a full page without waiting for the poll interval", async () => {
  const fullPage = Array.from({ length: 200 }, (_, index) =>
    eventRow(index + 1),
  );
  const store = new EventPageStore([fullPage, [eventRow(201)]]);
  const notifier = new RecordingNotifier();
  const app = eventApp(
    store,
    {
      maxConnectionMs: LONG_WAIT_MS,
      pollIntervalMs: LONG_WAIT_MS,
      heartbeatIntervalMs: LONG_WAIT_MS,
    },
    notifier,
  );
  const body = await readUntil(
    await app.request(eventsPath),
    (text) => countLines(text, /^data:/gmu) === 201,
  );
  assert.equal(countLines(body, /^data:/gmu), 201);
  assert.deepEqual(store.positions.slice(0, 2), ["0", "200"]);
  // The stream is now waiting on a one-minute poll; disconnecting must end it at once.
  await waitFor(() => notifier.unsubscribed === 1, "disconnect cleanup");
});

test("a wake notification triggers a read before the poll interval", async () => {
  const store = new EventPageStore([[], [eventRow(1)]]);
  const notifier = new RecordingNotifier();
  const app = eventApp(
    store,
    {
      maxConnectionMs: LONG_WAIT_MS,
      pollIntervalMs: LONG_WAIT_MS,
      heartbeatIntervalMs: LONG_WAIT_MS,
    },
    notifier,
  );
  const reading = readUntil(await app.request(eventsPath), (text) =>
    /^event: run\.state_changed$/mu.test(text),
  );
  await waitFor(() => store.readAt.length === 1, "first read");
  notifier.wake?.();
  await reading;
  assert.equal(store.readAt.length, 2);
  await waitFor(() => notifier.unsubscribed === 1, "unsubscribe");
});
