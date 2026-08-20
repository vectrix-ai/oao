import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "@oao/db-postgres";
import {
  buildRuntimeWake,
  PostgresRuntimeCommandPort,
} from "../../src/runtime-commands.js";

test("runtime command adapter exactly matches migration 0004 wake contract", async () => {
  let sql = "";
  let parameters: readonly unknown[] = [];
  const transaction = {
    async query(text: string, values?: readonly unknown[]) {
      sql = text;
      parameters = values ?? [];
      return { rowCount: 1, rows: [{}] };
    },
  } as Queryable;
  const availableAt = new Date("2026-08-20T12:00:00.000Z");
  const command = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    runId: "00000000-0000-4000-8000-000000000003",
    kind: "admit" as const,
    payload: { reason: "api_submit" },
  };
  await new PostgresRuntimeCommandPort(() => availableAt).enqueue(
    transaction,
    command,
  );
  const wake = buildRuntimeWake(command);
  assert.equal(
    sql,
    "SELECT oao.enqueue_runtime_wake($1,$2,$3,$4,$5,$6,$7,$8,$9)",
  );
  assert.deepEqual(parameters, [
    command.organizationId,
    command.projectId,
    wake.id,
    command.runId,
    `admit:${command.runId}`,
    wake.requestHash,
    "admit",
    command.payload,
    availableAt,
  ]);
  assert.equal(wake.requestHash.byteLength, 32);
  assert.equal(buildRuntimeWake(command).id, wake.id);
});
