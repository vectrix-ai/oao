import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, withTenantTransaction } from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
} from "@oao/domain";
import { PostgresToolBroker } from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
// Fresh ids per run, so the test reruns against one database.
const tenant = {
  organizationId: randomUUID() as OrganizationId,
  projectId: randomUUID() as ProjectId,
};
const principal = randomUUID() as PrincipalId;
const agentId = randomUUID();
const agentVersionId = randomUUID();
const threadId = randomUUID();
const sessionId = randomUUID();
const runId = randomUUID() as RunId;
const slug = `assistant-text-${tenant.organizationId.slice(0, 8)}`;

test(
  "assistant text is committed once per turn, before the turn's tool calls, and not after settlement",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    const broker = new PostgresToolBroker(pool, {
      servicePrincipalId: principal,
      pollMilliseconds: 1,
    });
    try {
      const config = {
        systemPrompt: "Say what you are doing before each tool call.",
        modelPreset: "integration-model",
        tools: [],
        publishTextBeforeToolCalls: true,
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
         VALUES ($1,$2,'Assistant text integration')`,
        [tenant.organizationId, slug],
      );
      await pool.query(
        `INSERT INTO oao.projects (organization_id,id,slug,name)
         VALUES ($1,$2,$3,'Assistant text integration')`,
        [tenant.organizationId, tenant.projectId, slug],
      );
      await pool.query(
        `INSERT INTO oao.principals (
           organization_id,project_id,id,kind,subject,scopes
         ) VALUES ($1,$2,$3,'human','assistant-text-human',ARRAY['*'])`,
        [tenant.organizationId, tenant.projectId, principal],
      );
      await pool.query(
        `INSERT INTO oao.agent_definitions (
           organization_id,project_id,id,agent_key,name
         ) VALUES ($1,$2,$3,'assistant-text-agent','Assistant text agent')`,
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
         VALUES ($1,$2,$3,'Assistant text thread')`,
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
      await withTenantTransaction(pool, tenant, async (transaction) => {
        await transaction.query(
          `INSERT INTO oao.runs (
            organization_id,project_id,id,thread_id,session_id,agent_version_id,
            created_by_principal_id,idempotency_key
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'assistant-text-integration')`,
          [
            tenant.organizationId,
            tenant.projectId,
            runId,
            threadId,
            sessionId,
            agentVersionId,
            principal,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.runtime_thread_instances (
            organization_id,project_id,thread_id,session_id,agent_version_id,
            snapshot_hash,flue_instance_id
          ) VALUES ($1,$2,$3,$4,$5,digest('assistant-text','sha256'),$6)`,
          [
            tenant.organizationId,
            tenant.projectId,
            threadId,
            sessionId,
            agentVersionId,
            `assistant-text:${runId}`,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.runtime_dispatches (
            organization_id,project_id,run_id,thread_id,admission_key,
            request_hash,snapshot_hash,state,fence,flue_conversation_id,deadline_at
          ) VALUES ($1,$2,$3,$4,$5,digest('request','sha256'),
            digest('snapshot','sha256'),'admitted',1,$5,clock_timestamp()+interval '1 minute')`,
          [
            tenant.organizationId,
            tenant.projectId,
            runId,
            threadId,
            `assistant-text:${runId}`,
          ],
        );
      });
      await pool.query(
        "UPDATE oao.runs SET state='running' WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [tenant.organizationId, tenant.projectId, runId],
      );

      const run = { ...tenant, runId };
      const segments = [
        { toolCallId: "turn-1-call", text: "Reading the order email." },
        // A turn without text commits nothing.
        { toolCallId: "turn-2-call", text: " \n " },
        { toolCallId: "turn-3-call", text: "\nLooking up the customer.\n" },
      ];
      // Parallel calls of one turn commit the same turns, and a projection
      // may still be committing an earlier turn; each turn is saved once,
      // in turn order, without the commits waiting on each other in a cycle.
      assert.deepEqual(
        await Promise.all([
          broker.commitAssistantText({ ...run, segments }),
          broker.commitAssistantText({ ...run, segments }),
          broker.commitAssistantText({
            ...run,
            segments: segments.slice(0, 1),
          }),
        ]),
        [true, true, true],
      );
      const callId = await broker.publishCaller({
        ...run,
        flueToolCallId: "turn-3-call",
        toolName: "caller.lookup",
        safeArguments: { customer: "C-1" },
        approval: "never",
      });
      assert.ok(callId);

      const messages = () =>
        pool.query<{ id: string; content: string }>(
          `SELECT id,redacted_content AS content FROM oao.messages
            WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
            ORDER BY created_at,id`,
          [tenant.organizationId, tenant.projectId, runId],
        );
      const committed = await messages();
      assert.deepEqual(
        committed.rows.map((row) => row.content),
        ["Reading the order email.", "Looking up the customer."],
      );
      // Each message has one event that names it, ahead of the tool call.
      const events = await pool.query<{ kind: string; message_id: string }>(
        `SELECT event_kind AS kind,public_payload->>'messageId' AS message_id
           FROM oao.product_events
          WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
          ORDER BY project_position`,
        [tenant.organizationId, tenant.projectId, runId],
      );
      assert.deepEqual(
        events.rows.map((row) => row.kind),
        [
          "message.created",
          "message.created",
          "tool_call.requested",
          "run.state_changed",
        ],
      );
      assert.deepEqual(
        events.rows.slice(0, 2).map((row) => row.message_id),
        committed.rows.map((row) => row.id),
      );

      // A settled run's reply already holds any text left uncommitted.
      await pool.query(
        `UPDATE oao.runtime_dispatches SET state='settled'
          WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [tenant.organizationId, tenant.projectId, runId],
      );
      assert.equal(
        await broker.commitAssistantText({
          ...run,
          segments: [{ toolCallId: "late-call", text: "Too late." }],
        }),
        false,
      );
      assert.equal((await messages()).rowCount, 2);
    } finally {
      await pool.end();
    }
  },
);
