import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPool, withTenantTransaction } from "@oao/db-postgres";
import type { OrganizationId, ProjectId, RunId } from "@oao/domain";
import {
  FakeSandboxProvider,
  ManagedSandboxLifecycle,
  PostgresSandboxRepository,
} from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
};
const runId = "00000000-0000-4000-8000-000000000302" as RunId;

test(
  "sandbox lifecycle persists fenced commands, artifacts, and safe status events",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    try {
      await withTenantTransaction(pool, tenant, (transaction) =>
        transaction.query(
          `INSERT INTO oao.runs (
            organization_id,project_id,id,thread_id,session_id,agent_version_id,
            created_by_principal_id,idempotency_key
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'sandbox-integration')`,
          [
            tenant.organizationId,
            tenant.projectId,
            runId,
            "00000000-0000-4000-8000-000000000006",
            "00000000-0000-4000-8000-000000000007",
            "00000000-0000-4000-8000-000000000005",
            "00000000-0000-4000-8000-000000000003",
          ],
        ),
      );
      const manager = new ManagedSandboxLifecycle(
        new PostgresSandboxRepository(pool),
        new FakeSandboxProvider(),
      );
      const instance = await manager.ensure({
        ...tenant,
        sandboxId: "00000000-0000-4000-8000-000000000303",
        runId,
        creationKey: `sandbox:${runId}`,
        image: "fake/local",
        egress: { mode: "none" },
      });
      const command = {
        commandId: "00000000-0000-4000-8000-000000000304",
        commandKey: `command:${runId}:1`,
        command: "printf safe",
        timeoutMs: 1_000,
      };
      assert.equal((await manager.execute(instance, command)).exitCode, 0);
      assert.equal((await manager.execute(instance, command)).exitCode, 0);
      await manager.recordArtifact(instance, {
        artifactId: "00000000-0000-4000-8000-000000000305",
        commandId: command.commandId,
        artifactKey: `artifact:${runId}:1`,
        artifactRef: "s3://safe-bucket/result.txt",
        contentType: "text/plain",
        sizeBytes: 4,
        sha256: createHash("sha256").update("safe").digest(),
      });
      await manager.stop(instance);
      const events = await pool.query<{ event_kind: string }>(
        "SELECT event_kind FROM oao.product_events WHERE aggregate_id=$1 ORDER BY project_position",
        [runId],
      );
      assert.deepEqual(
        events.rows.map((row) => row.event_kind),
        [
          "sandbox.created",
          "sandbox.started",
          "sandbox.command_started",
          "sandbox.command_completed",
          "sandbox.stopped",
        ],
      );
      const artifacts = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM oao.sandbox_artifacts WHERE run_id=$1",
        [runId],
      );
      assert.equal(artifacts.rows[0]?.count, "1");
    } finally {
      await pool.end();
    }
  },
);
