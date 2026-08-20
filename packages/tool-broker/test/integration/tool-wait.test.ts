import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PostgresFoundationRepository,
  createPool,
  withTenantTransaction,
} from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
  ToolCallId,
} from "@oao/domain";
import { PostgresToolBroker } from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
};
const principal = "00000000-0000-4000-8000-000000000003" as PrincipalId;
const runId = "00000000-0000-4000-8000-000000000301" as RunId;

test(
  "caller waits for an immutable fenced result and platform replay executes once",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    const foundation = new PostgresFoundationRepository();
    const broker = new PostgresToolBroker(pool, {
      servicePrincipalId: principal,
      pollMilliseconds: 1,
    });
    try {
      await withTenantTransaction(pool, tenant, (transaction) =>
        transaction.query(
          `INSERT INTO oao.runs (
            organization_id,project_id,id,thread_id,session_id,agent_version_id,
            created_by_principal_id,idempotency_key
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'tool-broker-integration')`,
          [
            tenant.organizationId,
            tenant.projectId,
            runId,
            "00000000-0000-4000-8000-000000000006",
            "00000000-0000-4000-8000-000000000007",
            "00000000-0000-4000-8000-000000000005",
            principal,
          ],
        ),
      );
      const obligation = {
        ...tenant,
        runId,
        flueToolCallId: "caller-call-1",
        toolName: "caller.lookup",
        safeArguments: { query: "public" },
        approval: "never" as const,
      };
      const toolCallId = await broker.publishCaller(obligation);
      const waiting = broker.waitForCaller(obligation);
      const fence = await withTenantTransaction(pool, tenant, (transaction) =>
        foundation.claimToolCall(transaction, {
          ...tenant,
          toolCallId: toolCallId as ToolCallId,
          principalId: principal,
          leaseMilliseconds: 60_000,
        }),
      );
      await withTenantTransaction(pool, tenant, (transaction) =>
        foundation.submitResult(transaction, {
          ...tenant,
          toolCallId: toolCallId as ToolCallId,
          principalId: principal,
          fence,
          idempotencyKey: "caller-result-1",
          requestHash: createHash("sha256").update("caller-result-1").digest(),
          safeResult: { version: 1, status: "success", value: { found: true } },
        }),
      );
      assert.deepEqual(await waiting, {
        version: 1,
        status: "success",
        value: { found: true },
      });

      let executions = 0;
      const platform = {
        ...obligation,
        flueToolCallId: "platform-call-1",
        toolName: "platform.echo",
      };
      const execute = async () => {
        executions += 1;
        return { echoed: true } as const;
      };
      assert.deepEqual(await broker.executePlatform(platform, execute), {
        version: 1,
        status: "success",
        value: { echoed: true },
      });
      assert.deepEqual(await broker.executePlatform(platform, execute), {
        version: 1,
        status: "success",
        value: { echoed: true },
      });
      assert.equal(executions, 1);
    } finally {
      await pool.end();
    }
  },
);
