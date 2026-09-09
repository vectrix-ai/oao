import assert from "node:assert/strict";
import test from "node:test";
import type { FlueObservation } from "@flue/runtime";
import type { PgPool } from "@oao/db-postgres";
import { runtimeTesting } from "../src/index.js";

function admissionDatabase(maximum = 2) {
  const turns = new Set<string>();
  const counts = { lookups: 0, locks: 0, releases: 0 };
  let state = "admitted";
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("FOR UPDATE OF r")) {
        counts.locks++;
        return { rows: [{ max_turns: maximum }] };
      }
      if (sql.includes("bool_or"))
        return {
          rows: [
            {
              count: String(turns.size),
              reserved: turns.has(String(values[3])),
            },
          ],
        };
      if (
        sql.includes("INSERT INTO oao.run_model_turns") &&
        sql.includes("VALUES")
      )
        turns.add(String(values[3]));
      return { rows: [] };
    },
    release() {
      counts.releases++;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      counts.lookups++;
      return {
        rows: [
          {
            organization_id: "00000000-0000-4000-8000-000000000001",
            project_id: "00000000-0000-4000-8000-000000000002",
            run_id: "00000000-0000-4000-8000-000000000003",
            state,
          },
        ],
      };
    },
  } as unknown as PgPool;
  return {
    pool,
    counts,
    turns,
    settle() {
      state = "settled";
    },
  };
}

const context = { instanceId: "managed-instance", submissionId: "submission" };

test("stream reads share one durable admission, including concurrent reads", async () => {
  const db = admissionDatabase();
  const admit = runtimeTesting.createModelTurnAdmission(db.pool);
  // Flue 2.0.3 passes the same operation to stream creation, next(), and result().
  const operation = { type: "model" as const, turnId: "first-turn" };
  const pending = admit(operation, context);
  for (let chunk = 0; chunk < 100; chunk++)
    assert.equal(admit(operation, context), pending);
  await pending;
  for (let chunk = 0; chunk < 100; chunk++) await admit(operation, context);
  assert.deepEqual(db.counts, { lookups: 1, locks: 1, releases: 1 });
  assert.equal(db.turns.size, 1);

  // A retry is a distinct model operation and must still consume its own turn.
  await admit({ type: "model", turnId: "retry-turn" }, context);
  assert.equal(db.counts.locks, 2);
  assert.equal(db.turns.size, 2);
  await assert.rejects(
    admit({ type: "model", turnId: "over-budget" }, context),
    /Model turn limit exceeded/,
  );
});

test("recovery rechecks the durable ledger without double-counting a replayed turn", async () => {
  const db = admissionDatabase(1);
  const admit = runtimeTesting.createModelTurnAdmission(db.pool);
  await admit({ type: "model", turnId: "replayed-turn" }, context);
  await admit({ type: "model", turnId: "replayed-turn" }, context);
  const recovered = runtimeTesting.createModelTurnAdmission(db.pool);
  await recovered({ type: "model", turnId: "replayed-turn" }, context);
  assert.equal(db.counts.locks, 3);
  assert.equal(db.turns.size, 1);
  db.settle();
  await assert.rejects(
    recovered({ type: "model", turnId: "new-turn" }, context),
    /run identity is unavailable/,
  );
});

test("a rejected admission remains rejected on all reads and never admits the stream", async () => {
  const db = admissionDatabase(1);
  const admit = runtimeTesting.createModelTurnAdmission(db.pool);
  await admit({ type: "model", turnId: "last-allowed" }, context);
  const denied = { type: "model" as const, turnId: "denied" };
  const first = admit(denied, context);
  const reads = Array.from({ length: 100 }, () => admit(denied, context));
  for (const read of reads) assert.equal(read, first);
  await Promise.all(
    reads.map((read) => assert.rejects(read, /Model turn limit exceeded/)),
  );
  await assert.rejects(admit(denied, context), /Model turn limit exceeded/);
  assert.deepEqual(db.counts, { lookups: 2, locks: 2, releases: 2 });
});

test("non-model operations do not query the model budget", async () => {
  const db = admissionDatabase();
  await runtimeTesting.createModelTurnAdmission(db.pool)(
    { type: "tool", toolCallId: "call", toolName: "read" },
    context,
  );
  assert.equal(db.counts.lookups, 0);
});

test("projection drops stream deltas while retaining outcomes, tools, retries, and recovery", () => {
  const project = (type: FlueObservation["type"], message?: string) =>
    runtimeTesting.shouldProjectObservation({
      type,
      message,
    } as FlueObservation);
  for (const type of [
    "text_delta",
    "thinking_delta",
    "toolcall_delta",
    "turn_start",
    "message_start",
    "message_end",
  ] as const)
    assert.equal(project(type), false, type);
  assert.equal(project("log", "ordinary provider log"), false);
  for (const type of [
    "turn_request",
    "turn",
    "tool_start",
    "tool",
    "submission_recovery",
    "submission_settled",
  ] as const)
    assert.equal(project(type), true, type);
  assert.equal(
    project("log", "[flue:model-retry] Retrying transient model error"),
    true,
  );
});
