import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PostgresFoundationRepository,
  createPool,
  withTenantTransaction,
  type PgPool,
  type ProjectWakeWaiter,
  type ProjectWakeWatch,
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
  organizationId: "00000000-0000-4000-8000-00000000c001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-00000000c002" as ProjectId,
};
const principal = "00000000-0000-4000-8000-00000000c003" as PrincipalId;
const servicePrincipal = "00000000-0000-4000-8000-00000000c099" as PrincipalId;
const agentId = "00000000-0000-4000-8000-00000000c004";
const agentVersionId = "00000000-0000-4000-8000-00000000c005";
const threadId = "00000000-0000-4000-8000-00000000c006";
const sessionId = "00000000-0000-4000-8000-00000000c007";
const runId = "00000000-0000-4000-8000-00000000c008" as RunId;

async function seed(pool: PgPool): Promise<void> {
  const config = {
    systemPrompt: "Project wake integration.",
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
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'project-wakes','Project wakes')",
    [tenant.organizationId],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'project-wakes','Project wakes')",
    [tenant.organizationId, tenant.projectId],
  );
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'human','project-wakes-human',ARRAY['*'])`,
    [tenant.organizationId, tenant.projectId, principal],
  );
  await pool.query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,'project-wakes','Project wakes')`,
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
    "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'Project wakes')",
    [tenant.organizationId, tenant.projectId, threadId],
  );
  await pool.query(
    `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
     VALUES ($1,$2,$3,$4,$5)`,
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
         created_by_principal_id,idempotency_key,state
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'project-wakes','queued')`,
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
  await pool.query("UPDATE oao.runs SET state='running' WHERE id=$1", [runId]);
}

/** A waiter the test wakes by hand; its fallback never fires. */
function manualWaiter() {
  const watches = new Set<{ wake: () => void }>();
  let nexts = 0;
  const waiter: ProjectWakeWaiter = {
    async watch() {
      let pending = false;
      let resolveNext: (() => void) | undefined;
      const entry = {
        wake: () => {
          pending = true;
          resolveNext?.();
        },
      };
      watches.add(entry);
      const watch: ProjectWakeWatch = {
        wake: entry.wake,
        next: () => {
          nexts += 1;
          if (pending) {
            pending = false;
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            resolveNext = () => {
              resolveNext = undefined;
              pending = false;
              resolve();
            };
          });
        },
        close: async () => {
          watches.delete(entry);
        },
      };
      return watch;
    },
  };
  return {
    waiter,
    wakeAll: () => {
      for (const watch of watches) watch.wake();
    },
    get open() {
      return watches.size;
    },
    get nexts() {
      return nexts;
    },
  };
}

test(
  "tool waits re-check on project wakes and approvals expire on one timer",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 60_000 },
  async (t) => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    const foundation = new PostgresFoundationRepository();
    const wakes = manualWaiter();
    const broker = new PostgresToolBroker(pool, {
      servicePrincipalId: servicePrincipal,
      projectWakes: wakes.waiter,
      approvalExpiryMilliseconds: 50,
    });
    t.after(() => pool.end());
    await seed(pool);

    await t.test("a caller result is read after the project wake", async () => {
      const obligation = {
        ...tenant,
        runId,
        flueToolCallId: "wake-call-1",
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
          idempotencyKey: "wake-result-1",
          requestHash: createHash("sha256").update("wake-result-1").digest(),
          safeResult: { version: 1, status: "success", value: { found: 1 } },
        }),
      );
      // Without a wake the wait does not poll on its own.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = wakes.nexts;
      wakes.wakeAll();
      assert.deepEqual(await waiting, {
        version: 1,
        status: "success",
        value: { found: 1 },
      });
      assert.equal(wakes.nexts, before);
      assert.equal(wakes.open, 0);
    });

    await t.test(
      "an approval that expires wakes its wait without a product event",
      async () => {
        const obligation = {
          ...tenant,
          runId,
          flueToolCallId: "wake-call-2",
          toolName: "caller.approved",
          safeArguments: { query: "public" },
          approval: "always" as const,
        };
        const toolCallId = await broker.publishCaller(obligation);
        const waiting = broker.waitForCaller(obligation);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await pool.query(
          "UPDATE oao.approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE tool_call_id=$1",
          [toolCallId],
        );
        const outcome = await waiting;
        assert.equal(outcome.status, "failure");
        if (outcome.status === "failure")
          assert.equal(outcome.error.code, "approval_expired");
        assert.equal(wakes.open, 0);
      },
    );
  },
);
