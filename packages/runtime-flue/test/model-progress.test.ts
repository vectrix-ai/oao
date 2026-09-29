import assert from "node:assert/strict";
import test from "node:test";
import type { FlueObservation } from "@flue/runtime";
import type { PgPool } from "@oao/db-postgres";
import { PostgresWakeQueue } from "@oao/queue-postgres";
import { RuntimeProjection } from "../src/index.js";

function projectionDatabase() {
  let admitted = false;
  const events = new Map<
    string,
    { kind: string; payload: unknown; occurredAt: Date }
  >();
  const invocations = new Set<string>();
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("SELECT 1 FROM oao.product_events"))
        return { rows: [], rowCount: events.has(String(values[2])) ? 1 : 0 };
      if (sql.includes("oao.append_product_event"))
        events.set(String(values[2]), {
          kind: String(values[4]),
          payload: values[5],
          occurredAt: values[6] as Date,
        });
      if (sql.includes("MAX(attempt)")) return { rows: [{ attempt: 1 }] };
      if (sql.includes("INSERT INTO oao.model_invocations")) {
        const id = String(values[2]);
        if (invocations.has(id)) return { rows: [], rowCount: 0 };
        invocations.add(id);
        return { rows: [{ attempt: invocations.size }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      return {
        rows: admitted
          ? [{ organization_id: "org", project_id: "project", run_id: "run" }]
          : [],
      };
    },
  } as unknown as PgPool;
  return {
    projection: new RuntimeProjection(pool, new PostgresWakeQueue(pool)),
    events,
    admit() {
      admitted = true;
    },
    starts() {
      return [...events.values()].filter(
        (event) => event.kind === "model.invocation_started",
      );
    },
  };
}

const request = {
  v: 3,
  type: "turn_request",
  eventIndex: 1,
  timestamp: "2026-09-11T00:00:00.500Z",
  conversationId: "conversation",
  submissionId: "submission",
  turnId: "turn-1",
  purpose: "agent",
  request: {
    requestedModel: "test-model",
    providerId: "test-provider",
    providerName: "Test provider",
    api: "openai-completions",
    input: { systemPrompt: "PRIVATE PROMPT", messages: [], tools: [] },
  },
} as Extract<FlueObservation, { type: "turn_request" }>;

for (const isError of [false, true]) {
  for (const early of [false, true]) {
    test(`model progress repairs early=${early} starts on error=${isError} without duplicating retries`, async () => {
      const db = projectionDatabase();
      if (!early) db.admit();
      // Simulate the request observation preceding the committed dispatch.
      await db.projection["project"](request);
      assert.equal(db.starts().length, early ? 0 : 1);
      db.admit();
      const outcome = {
        ...request,
        type: "turn",
        eventIndex: 2,
        timestamp: "2026-09-11T00:00:03.000Z",
        durationMs: 2_000,
        isError,
        response: { finishReason: isError ? "error" : "stop" },
      } as Extract<FlueObservation, { type: "turn" }>;
      await db.projection["project"](outcome);
      assert.equal(db.starts().length, 1);
      assert.equal(
        db.starts()[0]?.occurredAt.toISOString(),
        early ? "2026-09-11T00:00:01.000Z" : request.timestamp,
      );
      assert.deepEqual(db.starts()[0]?.payload, {
        turnId: "turn-1",
        model: "test-model",
        provider: "test-provider",
        timeoutMs: 300_000,
      });
      // A late request and a replayed outcome must keep the same stable ID.
      await db.projection["project"](request);
      await db.projection["project"](outcome);
      assert.equal(db.starts().length, 1);
      await db.projection["project"]({ ...outcome, turnId: "retry-turn" });
      assert.equal(db.starts().length, 2);
      assert.ok(
        !JSON.stringify([...db.events.values()]).includes("PRIVATE PROMPT"),
      );
    });
  }
}
