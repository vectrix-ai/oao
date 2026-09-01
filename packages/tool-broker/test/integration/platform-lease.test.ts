import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPool, withTenantTransaction } from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  PublicValue,
  RunId,
} from "@oao/domain";
import { PostgresToolBroker, toolBrokerTesting } from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000011" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000012" as ProjectId,
};
const principal = "00000000-0000-4000-8000-000000000013" as PrincipalId;
const servicePrincipal = "00000000-0000-4000-8000-000000000099" as PrincipalId;
const agentId = "00000000-0000-4000-8000-000000000014";
const agentVersionId = "00000000-0000-4000-8000-000000000015";
const threadId = "00000000-0000-4000-8000-000000000016";
const sessionId = "00000000-0000-4000-8000-000000000017";
const renewedRunId = "00000000-0000-4000-8000-000000000311" as RunId;
const supersededRunId = "00000000-0000-4000-8000-000000000312" as RunId;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test(
  "platform lease heartbeats outlive the claim and a superseded executor stands down",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    try {
      const config = {
        systemPrompt: "Execute deterministic platform-lease integration work.",
        modelPreset: "integration-model",
        tools: [],
        sandbox: {
          enabled: false,
          provider: "integration-daytona",
          network: "none",
          capabilities: [],
        },
        limits: { maxTurns: 32, timeoutMs: 60_000 },
      };
      await pool.query(
        `INSERT INTO oao.organizations (id,slug,name)
         VALUES ($1,'platform-lease','Platform lease integration')`,
        [tenant.organizationId],
      );
      await pool.query(
        `INSERT INTO oao.projects (organization_id,id,slug,name)
         VALUES ($1,$2,'platform-lease','Platform lease integration')`,
        [tenant.organizationId, tenant.projectId],
      );
      await pool.query(
        `INSERT INTO oao.principals (
           organization_id,project_id,id,kind,subject,scopes
         ) VALUES ($1,$2,$3,'human','platform-lease-human',ARRAY['*'])`,
        [tenant.organizationId, tenant.projectId, principal],
      );
      await pool.query(
        `INSERT INTO oao.agent_definitions (
           organization_id,project_id,id,agent_key,name
         ) VALUES ($1,$2,$3,'platform-lease-agent','Platform lease agent')`,
        [tenant.organizationId, tenant.projectId, agentId],
      );
      await pool.query(
        `INSERT INTO oao.agent_versions (
           organization_id,project_id,id,agent_definition_id,version,config,
           content_hash,created_by_principal_id
         ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
        [
          tenant.organizationId,
          tenant.projectId,
          agentVersionId,
          agentId,
          config,
          createHash("sha256").update(JSON.stringify(config)).digest(),
          principal,
        ],
      );
      await pool.query(
        `INSERT INTO oao.threads (organization_id,project_id,id,title)
         VALUES ($1,$2,$3,'Platform lease thread')`,
        [tenant.organizationId, tenant.projectId, threadId],
      );
      await pool.query(
        `INSERT INTO oao.sessions (
           organization_id,project_id,id,thread_id,agent_version_id
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          tenant.organizationId,
          tenant.projectId,
          sessionId,
          threadId,
          agentVersionId,
        ],
      );
      for (const [runId, idempotencyKey] of [
        [renewedRunId, "platform-lease-renewed"],
        [supersededRunId, "platform-lease-superseded"],
      ] as const) {
        await withTenantTransaction(pool, tenant, (transaction) =>
          transaction.query(
            `INSERT INTO oao.runs (
              organization_id,project_id,id,thread_id,session_id,agent_version_id,
              created_by_principal_id,idempotency_key
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              tenant.organizationId,
              tenant.projectId,
              runId,
              threadId,
              sessionId,
              agentVersionId,
              principal,
              idempotencyKey,
            ],
          ),
        );
      }

      // A platform execution that runs far longer than the claim lease still
      // commits its result because the heartbeat keeps the lease alive.
      const renewingBroker = new PostgresToolBroker(pool, {
        servicePrincipalId: servicePrincipal,
        pollMilliseconds: 1,
        platformLeaseMilliseconds: 400,
        platformLeaseRenewMilliseconds: 80,
      });
      const outliving = {
        ...tenant,
        runId: renewedRunId,
        flueToolCallId: "platform-outlive-1",
        toolName: "platform.outlive",
        safeArguments: {},
        approval: "never" as const,
      };
      assert.deepEqual(
        await renewingBroker.executePlatform(outliving, async () => {
          await delay(1_200);
          return { echoed: true } as const;
        }),
        { version: 1, status: "success", value: { echoed: true } },
      );
      const outlivingToolCallId = toolBrokerTesting.stableUuid(
        `tool:${renewedRunId}:platform-outlive-1`,
      );
      const renewedRow = await withTenantTransaction(
        pool,
        tenant,
        (transaction) =>
          transaction.query<{ stage: string; committed_at: Date | null }>(
            `SELECT call.stage,result.committed_at
             FROM oao.tool_calls call
             JOIN oao.tool_call_results result
               ON result.organization_id=call.organization_id
              AND result.project_id=call.project_id
              AND result.tool_call_id=call.id
             WHERE call.organization_id=$1 AND call.project_id=$2 AND call.id=$3`,
            [tenant.organizationId, tenant.projectId, outlivingToolCallId],
          ),
      );
      assert.equal(renewedRow.rows[0]?.stage, "result_committed");
      assert.ok(renewedRow.rows[0]?.committed_at);

      // A takeover bumps the fence; the losing executor aborts its in-flight
      // wait, submits nothing, and the new claim epoch can still complete.
      const supersededErrors: string[] = [];
      const supersededBroker = new PostgresToolBroker(pool, {
        servicePrincipalId: servicePrincipal,
        pollMilliseconds: 1,
        platformLeaseMilliseconds: 60_000,
        platformLeaseRenewMilliseconds: 50,
        onPlatformToolError: (error) => {
          supersededErrors.push(
            error instanceof Error ? error.message : String(error),
          );
        },
      });
      const superseded = {
        ...tenant,
        runId: supersededRunId,
        flueToolCallId: "platform-supersede-1",
        toolName: "platform.supersede",
        safeArguments: {},
        approval: "never" as const,
      };
      const supersededToolCallId = toolBrokerTesting.stableUuid(
        `tool:${supersededRunId}:platform-supersede-1`,
      );
      const losing = supersededBroker.executePlatform(
        superseded,
        (executeSignal) =>
          new Promise<PublicValue>((_resolve, reject) => {
            assert.ok(executeSignal, "execute must receive an abort signal");
            const abort = () =>
              reject(
                executeSignal.reason instanceof Error
                  ? executeSignal.reason
                  : new Error("aborted"),
              );
            if (executeSignal.aborted) {
              abort();
              return;
            }
            executeSignal.addEventListener("abort", abort, { once: true });
          }),
      );
      let leaseHolder: string | undefined;
      for (let attempt = 0; attempt < 500 && !leaseHolder; attempt += 1) {
        const row = await withTenantTransaction(pool, tenant, (transaction) =>
          transaction.query<{
            stage: string;
            lease_holder_principal_id: string | null;
          }>(
            `SELECT stage,lease_holder_principal_id FROM oao.tool_calls
             WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
            [tenant.organizationId, tenant.projectId, supersededToolCallId],
          ),
        );
        const candidate = row.rows[0];
        if (
          candidate?.stage === "platform_executing" &&
          candidate.lease_holder_principal_id
        ) {
          leaseHolder = candidate.lease_holder_principal_id;
          break;
        }
        await delay(10);
      }
      assert.ok(leaseHolder, "first claim epoch must reach platform_executing");
      const takeover = await withTenantTransaction(
        pool,
        tenant,
        (transaction) =>
          transaction.query<{ fence: string }>(
            `SELECT oao.begin_platform_tool_execution(
               $1,$2,$3,$4,interval '60 seconds'
             ) AS fence`,
            [
              tenant.organizationId,
              tenant.projectId,
              supersededToolCallId,
              leaseHolder,
            ],
          ),
      );
      const takeoverFence = takeover.rows[0]?.fence;
      assert.equal(takeoverFence, "2");
      assert.deepEqual(await losing, {
        version: 1,
        status: "failure",
        error: {
          code: "run_cancelled",
          message: "Platform tool execution was superseded",
        },
      });
      assert.ok(
        supersededErrors.some((message) =>
          message.includes("stale tool execution fence"),
        ),
      );
      const untouched = await withTenantTransaction(
        pool,
        tenant,
        (transaction) =>
          transaction.query<{ stage: string; claim_fence: string }>(
            `SELECT call.stage,call.claim_fence
             FROM oao.tool_calls call
             LEFT JOIN oao.tool_call_results result
               ON result.organization_id=call.organization_id
              AND result.project_id=call.project_id
              AND result.tool_call_id=call.id
             WHERE call.organization_id=$1 AND call.project_id=$2 AND call.id=$3
               AND result.tool_call_id IS NULL`,
            [tenant.organizationId, tenant.projectId, supersededToolCallId],
          ),
      );
      assert.deepEqual(untouched.rows, [
        { stage: "platform_executing", claim_fence: "2" },
      ]);
      await withTenantTransaction(pool, tenant, async (transaction) => {
        await transaction.query(
          "SELECT oao.submit_tool_result($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            tenant.organizationId,
            tenant.projectId,
            supersededToolCallId,
            leaseHolder,
            takeoverFence,
            "platform-supersede-takeover-1",
            createHash("sha256")
              .update("platform-supersede-takeover-1")
              .digest(),
            { version: 1, status: "success", value: { tookOver: true } },
          ],
        );
        await transaction.query(
          "SELECT oao.commit_tool_result($1,$2,$3,$4,$5)",
          [
            tenant.organizationId,
            tenant.projectId,
            supersededToolCallId,
            takeoverFence,
            "platform-supersede-takeover-1",
          ],
        );
      });
      const takeoverRow = await withTenantTransaction(
        pool,
        tenant,
        (transaction) =>
          transaction.query<{ stage: string }>(
            `SELECT stage FROM oao.tool_calls
             WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
            [tenant.organizationId, tenant.projectId, supersededToolCallId],
          ),
      );
      assert.equal(takeoverRow.rows[0]?.stage, "result_committed");
    } finally {
      await pool.end();
    }
  },
);
