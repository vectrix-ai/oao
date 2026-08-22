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
const servicePrincipal = "00000000-0000-4000-8000-000000000099" as PrincipalId;
const agentId = "00000000-0000-4000-8000-000000000004";
const agentVersionId = "00000000-0000-4000-8000-000000000005";
const threadId = "00000000-0000-4000-8000-000000000006";
const sessionId = "00000000-0000-4000-8000-000000000007";
const runId = "00000000-0000-4000-8000-000000000301" as RunId;

test(
  "caller waits for an immutable fenced result and platform replay executes once",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    const foundation = new PostgresFoundationRepository();
    const broker = new PostgresToolBroker(pool, {
      servicePrincipalId: servicePrincipal,
      pollMilliseconds: 1,
    });
    try {
      const config = {
        systemPrompt: "Execute deterministic tool-broker integration work.",
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
         VALUES ($1,'tool-broker','Tool broker integration')`,
        [tenant.organizationId],
      );
      await pool.query(
        `INSERT INTO oao.projects (organization_id,id,slug,name)
         VALUES ($1,$2,'tool-broker','Tool broker integration')`,
        [tenant.organizationId, tenant.projectId],
      );
      await pool.query(
        `INSERT INTO oao.principals (
           organization_id,project_id,id,kind,subject,scopes
         ) VALUES ($1,$2,$3,'human','tool-broker-human',ARRAY['*'])`,
        [tenant.organizationId, tenant.projectId, principal],
      );
      await pool.query(
        `INSERT INTO oao.agent_definitions (
           organization_id,project_id,id,agent_key,name
         ) VALUES ($1,$2,$3,'tool-broker-agent','Tool broker agent')`,
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
         VALUES ($1,$2,$3,'Tool broker thread')`,
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
            threadId,
            sessionId,
            agentVersionId,
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

      const retryOutcomes = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const retryObligation = {
          ...obligation,
          flueToolCallId: `caller-retry-${attempt}`,
          toolName: "caller.retry",
        };
        const retryToolCallId = await broker.publishCaller(retryObligation);
        const retryWaiting = broker.waitForCaller(retryObligation);
        const retryFence = await withTenantTransaction(
          pool,
          tenant,
          (transaction) =>
            foundation.claimToolCall(transaction, {
              ...tenant,
              toolCallId: retryToolCallId as ToolCallId,
              principalId: principal,
              leaseMilliseconds: 60_000,
            }),
        );
        const idempotencyKey = `caller-retry-result-${attempt}`;
        await withTenantTransaction(pool, tenant, (transaction) =>
          foundation.submitResult(transaction, {
            ...tenant,
            toolCallId: retryToolCallId as ToolCallId,
            principalId: principal,
            fence: retryFence,
            idempotencyKey,
            requestHash: createHash("sha256").update(idempotencyKey).digest(),
            safeResult: {
              version: 1,
              status: "failure",
              error: { code: "tool_failed", message: "private detail" },
            },
          }),
        );
        retryOutcomes.push(await retryWaiting);
      }
      assert.deepEqual(retryOutcomes, [
        {
          version: 1,
          status: "failure",
          error: {
            code: "tool_failed",
            message:
              "Tool execution failed. Retry the tool automatically; 2 retries remain",
          },
        },
        {
          version: 1,
          status: "failure",
          error: {
            code: "tool_failed",
            message:
              "Tool execution failed. Retry the tool automatically; 1 retry remains",
          },
        },
        {
          version: 1,
          status: "failure",
          error: {
            code: "tool_retry_exhausted",
            message: "Automatic retry limit reached after 3 attempts",
          },
        },
      ]);
      assert.deepEqual(
        await broker.retryAdmission({
          ...obligation,
          flueToolCallId: "caller-retry-4",
          toolName: "caller.retry",
        }),
        {
          version: 1,
          status: "failure",
          error: {
            code: "tool_retry_exhausted",
            message: "Automatic retry limit reached after 3 attempts",
          },
        },
      );

      const invalidObligation = {
        ...obligation,
        flueToolCallId: "caller-invalid-result-1",
        toolName: "caller.validated",
      };
      const invalidToolCallId = await broker.publishCaller(invalidObligation);
      const invalidWaiting = broker.waitForCaller(
        invalidObligation,
        undefined,
        () => ({ valid: false, message: "Invalid result value" }),
      );
      const invalidFence = await withTenantTransaction(
        pool,
        tenant,
        (transaction) =>
          foundation.claimToolCall(transaction, {
            ...tenant,
            toolCallId: invalidToolCallId as ToolCallId,
            principalId: principal,
            leaseMilliseconds: 60_000,
          }),
      );
      await withTenantTransaction(pool, tenant, (transaction) =>
        foundation.submitResult(transaction, {
          ...tenant,
          toolCallId: invalidToolCallId as ToolCallId,
          principalId: principal,
          fence: invalidFence,
          idempotencyKey: "caller-invalid-result-1",
          requestHash: createHash("sha256")
            .update("caller-invalid-result-1")
            .digest(),
          safeResult: {
            version: 1,
            status: "success",
            value: { invalid: true },
          },
        }),
      );
      assert.deepEqual(await invalidWaiting, {
        version: 1,
        status: "failure",
        error: {
          code: "invalid_tool_result",
          message:
            "Invalid result value. Retry the tool automatically; 2 retries remain",
        },
      });
      const invalidPersistence = await withTenantTransaction(
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
            [tenant.organizationId, tenant.projectId, invalidToolCallId],
          ),
      );
      assert.deepEqual(invalidPersistence.rows, [
        { stage: "result_submitted", committed_at: null },
      ]);

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
      const service = await withTenantTransaction(pool, tenant, (transaction) =>
        transaction.query(
          `SELECT kind::text,subject,scopes FROM oao.principals
             WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [tenant.organizationId, tenant.projectId, servicePrincipal],
        ),
      );
      assert.deepEqual(service.rows, [
        {
          kind: "service",
          subject: `oao-runtime-worker:${servicePrincipal}`,
          scopes: [],
        },
      ]);
    } finally {
      await pool.end();
    }
  },
);
