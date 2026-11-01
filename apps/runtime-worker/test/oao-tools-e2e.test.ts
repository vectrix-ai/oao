import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPool, type PgPool } from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
  ThreadId,
} from "@oao/domain";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@oao/models-openrouter";
import { FakeSandboxProvider } from "@oao/sandbox-daytona";
import { startRuntimeWorker, type RuntimeWorkerHandle } from "../src/main.js";

const databaseUrl = process.env.DATABASE_URL;
const testAdminDatabaseUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? databaseUrl;

function uuid(label: string): string {
  const bytes = createHash("sha256").update(label).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const tenant = {
  organizationId: uuid("oao-tools-e2e-org") as OrganizationId,
  projectId: uuid("oao-tools-e2e-project") as ProjectId,
};
const creator = uuid("oao-tools-e2e-creator") as PrincipalId;
const service = uuid("oao-tools-e2e-service") as PrincipalId;

/** Seeds an agent granted OAO tools and one queued run of it. */
async function seedRun(pool: PgPool): Promise<RunId> {
  const agentId = uuid("oao-tools-e2e-agent");
  const versionId = uuid("oao-tools-e2e-version");
  const threadId = uuid("oao-tools-e2e-thread") as ThreadId;
  const sessionId = uuid("oao-tools-e2e-session");
  const runId = uuid("oao-tools-e2e-run") as RunId;
  await pool.query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'oao-tools-e2e','OAO tools e2e')",
    [tenant.organizationId],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'oao-tools-e2e','OAO tools e2e')",
    [tenant.organizationId, tenant.projectId],
  );
  // The run's creator holds session:read but not run:create.
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'service','oao-tools-e2e-creator',ARRAY['session:read','run:read']),
            ($1,$2,$4,'service','oao-tools-e2e-service',ARRAY['*'])`,
    [tenant.organizationId, tenant.projectId, creator, service],
  );
  const config = {
    systemPrompt: "Check what the other agents did.",
    modelPreset: "local-default",
    tools: [],
    oaoTools: { scopes: ["session:read", "run:create"], approval: "never" },
    sandbox: {
      enabled: true,
      provider: "test-daytona",
      snapshotId: uuid("oao-tools-e2e-snapshot"),
      network: "none",
      capabilities: ["filesystem_read"],
    },
    limits: { maxTurns: 8, timeoutMs: 20_000 },
  };
  await pool.query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,'coordinator','Coordinator')`,
    [tenant.organizationId, tenant.projectId, agentId],
  );
  await pool.query(
    `INSERT INTO oao.agent_versions (
       organization_id,project_id,id,agent_definition_id,version,config,content_hash,
       created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
    [
      tenant.organizationId,
      tenant.projectId,
      versionId,
      agentId,
      config,
      createHash("sha256").update(JSON.stringify(config)).digest(),
      creator,
    ],
  );
  await pool.query(
    "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'OAO tools')",
    [tenant.organizationId, tenant.projectId, threadId],
  );
  await pool.query(
    `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenant.organizationId, tenant.projectId, sessionId, threadId, versionId],
  );
  await pool.query(
    `INSERT INTO oao.runs (
       organization_id,project_id,id,thread_id,session_id,agent_version_id,
       created_by_principal_id,idempotency_key,input_public
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'oao-tools-e2e',$8)`,
    [
      tenant.organizationId,
      tenant.projectId,
      runId,
      threadId,
      sessionId,
      versionId,
      creator,
      { message: "Who am I acting for?" },
    ],
  );
  return runId;
}

async function waitForSettled(pool: PgPool, runId: RunId): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM oao.runs WHERE id=$1",
      [runId],
    );
    const state = result.rows[0]?.state ?? "missing";
    if (["completed", "failed", "cancelled", "timed_out"].includes(state))
      return state;
    if (Date.now() >= deadline) throw new Error(`The run stayed in ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test(
  "an agent's model calls an OAO tool that acts as the run's creator",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 60_000 },
  async () => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const pool = createPool(testAdminDatabaseUrl);
    const apiCalls: { path: string; scopes: string[]; principal: string }[] =
      [];
    // Stands in for the API: it authenticates the run token through the
    // real SQL function and answers GET /v1/context.
    const oaoApiFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const token = /^Bearer (oao_run_\S+)$/u.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      assert.ok(token);
      const resolved = await pool.query<{
        principal_id: string;
        scopes: string[];
      }>("SELECT principal_id,scopes FROM oao.authenticate_run_token($1)", [
        createHash("sha256").update(token).digest(),
      ]);
      const row = resolved.rows[0];
      assert.ok(row, "the run token authenticates while the run is going");
      apiCalls.push({
        path: new URL(request.url).pathname,
        scopes: row.scopes,
        principal: row.principal_id,
      });
      return Response.json({
        principal: { id: row.principal_id, scopes: row.scopes },
      });
    };
    let toolResult = "";
    const respond: FauxResponseStep = (context) => {
      const result = context.messages.findLast(
        (message) => message.role === "toolResult",
      );
      if (!result)
        return fauxAssistantMessage([fauxToolCall("oao__get_context", {})], {
          stopReason: "toolUse",
        });
      toolResult = JSON.stringify(result.content);
      return fauxAssistantMessage("Checked who I act for.");
    };
    let worker: RuntimeWorkerHandle | undefined;
    try {
      worker = await startRuntimeWorker({
        databaseUrl,
        listen: false,
        env: {
          ...process.env,
          OAO_RUNTIME_SERVICE_PRINCIPAL_ID: service,
          OAO_API_URL: "http://oao.test",
        },
        daytonaProvider: new FakeSandboxProvider(),
        fakeResponses: Array.from({ length: 4 }, () => respond),
        oaoApiFetch,
        backgroundWakes: false,
      });
      const runId = await seedRun(pool);
      await worker.orchestrator.handleWake({
        ...tenant,
        id: uuid(`oao-tools-e2e-wake:${runId}`),
        runId,
        dispatchKey: `admit:${runId}`,
        kind: "admit",
        payload: { reason: "integration_test" },
        attempts: 1,
        fence: 1n,
      });
      assert.equal(await waitForSettled(pool, runId), "completed");

      // The grant was narrowed to what the creator holds.
      assert.deepEqual(apiCalls, [
        { path: "/v1/context", scopes: ["session:read"], principal: creator },
      ]);
      assert.match(toolResult, new RegExp(creator, "u"));
      const call = await pool.query<{ tool_name: string; stage: string }>(
        "SELECT tool_name,stage FROM oao.tool_calls WHERE run_id=$1",
        [runId],
      );
      assert.deepEqual(call.rows, [
        { tool_name: "oao__get_context", stage: "result_committed" },
      ]);
      const tokens = await pool.query<{ count: string }>(
        "SELECT count(*) FROM oao.run_access_tokens WHERE run_id=$1",
        [runId],
      );
      assert.equal(tokens.rows[0]?.count, "0");
    } finally {
      await worker?.stop();
      await pool.end();
    }
  },
);
