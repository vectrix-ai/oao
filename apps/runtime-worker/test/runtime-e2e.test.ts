import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createPool,
  withTenantTransaction,
  type PgPool,
} from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
  ThreadId,
  ToolCallId,
} from "@oao/domain";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@oao/models-openrouter";
import { PostgresWakeQueue, type RuntimeWakeJob } from "@oao/queue-postgres";
import type { PlatformToolHandler } from "@oao/runtime-flue";
import { FakeSandboxProvider } from "@oao/sandbox-daytona";
import { startRuntimeWorker, type RuntimeWorkerHandle } from "../src/main.js";

const databaseUrl = process.env.DATABASE_URL;
const testAdminDatabaseUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? databaseUrl;

async function startRuntimeChild(url: string): Promise<ChildProcess> {
  const child = fork(
    fileURLToPath(new URL("./runtime-child.ts", import.meta.url)),
    [],
    {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Runtime child did not become ready")),
      10_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Runtime child exited before ready (${code})`));
    });
    child.on("message", (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "ready"
      ) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}

async function stopRuntimeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Runtime child did not stop"));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function uuid(label: string): string {
  const bytes = createHash("sha256").update(label).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const tenant = {
  organizationId: uuid("runtime-e2e-org") as OrganizationId,
  projectId: uuid("runtime-e2e-project") as ProjectId,
};
const human = uuid("runtime-e2e-human") as PrincipalId;
const service = "00000000-0000-4000-8000-000000000099" as PrincipalId;

const objectSchema = (properties: Record<string, Record<string, unknown>>) => ({
  type: "object" as const,
  properties,
  required: Object.keys(properties).sort(),
  additionalProperties: false as const,
});

const fakeResponse: FauxResponseStep = (context) => {
  const transcript = JSON.stringify(context.messages);
  if (transcript.includes("harness-sequence exact")) {
    if (transcript.includes("Execute the Harness Operation")) {
      if (!transcript.includes("SKILL-ACTIVATED-TOKEN"))
        return fauxAssistantMessage(
          [fauxToolCall("activate_skill", { name: "shipment-extraction" })],
          { stopReason: "toolUse" },
        );
      if (!transcript.includes("shipment_reference=SHP-4815"))
        return fauxAssistantMessage(
          [fauxToolCall("read", { path: "shipment.txt" })],
          { stopReason: "toolUse" },
        );
      if (!transcript.includes("sandbox-multi-turn-ok"))
        return fauxAssistantMessage(
          [fauxToolCall("bash", { command: "printf sandbox-multi-turn-ok" })],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(
        [
          fauxToolCall("finish", {
            shipmentReference: "SHP-4815",
            skillActivated: true,
            sequentialToolTurns: 3,
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    if (!transcript.includes("shipment_reference=SHP-4815"))
      return fauxAssistantMessage(
        [
          fauxToolCall("write", {
            path: "shipment.txt",
            content: "shipment_reference=SHP-4815",
          }),
        ],
        { stopReason: "toolUse" },
      );
    if (!transcript.includes('"shipmentReference":"SHP-4815"'))
      return fauxAssistantMessage(
        [
          fauxToolCall("extract_shipment", {
            task: "harness-sequence exact: read shipment.txt using the shipment-extraction Skill and verify it with a second sandbox tool turn.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage("harness-sequence:completed");
  }
  if (transcript.includes("turn-two: recall alpha")) {
    if (!transcript.includes("memory:alpha"))
      throw new Error("Second run did not receive first-turn history");
    return fauxAssistantMessage("continuity:alpha");
  }
  if (transcript.includes("turn-one: alpha"))
    return fauxAssistantMessage("memory:alpha");
  if (transcript.includes("daytona exact"))
    return fauxAssistantMessage("daytona:ok");
  if (transcript.includes("content-filter exact"))
    return fauxAssistantMessage("filtered partial response", {
      stopReason: "error",
      errorMessage: "Provider finish_reason: content_filter",
    });

  const toolResult = context.messages.some(
    (message) => message.role === "toolResult",
  );
  const scenarios = [
    ["caller-tool exact", "caller.lookup"],
    ["approval-deny exact", "caller.approved"],
    ["approval-expire exact", "caller.approved"],
    ["platform-tool exact", "platform.echo"],
    ["deadline exact", "caller.lookup"],
    ["corruption exact", "caller.lookup"],
  ] as const;
  for (const [marker, tool] of scenarios) {
    if (!transcript.includes(marker)) continue;
    if (!toolResult)
      return fauxAssistantMessage([fauxToolCall(tool, { query: marker })], {
        stopReason: "toolUse",
      });
    return fauxAssistantMessage(`finished:${marker}`);
  }
  throw new Error(`Unexpected fake-model context: ${transcript}`);
};

const fakeResponses = Array.from({ length: 64 }, () => fakeResponse);

interface Fixture {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly versionId: string;
  readonly input: string;
}

async function seedBase(pool: PgPool): Promise<void> {
  await pool.query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'runtime-e2e','Runtime E2E')",
    [tenant.organizationId],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'runtime','Runtime')",
    [tenant.organizationId, tenant.projectId],
  );
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'human','runtime-e2e-human',ARRAY['*']),
            ($1,$2,$4,'service','runtime-e2e-service',ARRAY['*'])`,
    [tenant.organizationId, tenant.projectId, human, service],
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

async function seedHarnessSkill(pool: PgPool, label: string): Promise<string> {
  const skillId = uuid(`${label}:skill`);
  const versionId = uuid(`${label}:skill-version`);
  const instructions =
    "SKILL-ACTIVATED-TOKEN: read the shipment fixture from the shared sandbox and verify it with another sandbox tool before returning the result.";
  const canonical = {
    schemaVersion: 1,
    name: "shipment-extraction",
    description: "Extract shipment references from materialized documents.",
    instructions,
    metadata: {},
    files: [],
  };
  const contentHash = createHash("sha256")
    .update(stableJson(canonical))
    .digest();
  await pool.query(
    `INSERT INTO oao.skills (
       organization_id,project_id,id,skill_key,display_name,created_by_principal_id
     ) VALUES ($1,$2,$3,'shipment-extraction','Shipment extraction',$4)`,
    [tenant.organizationId, tenant.projectId, skillId, human],
  );
  await pool.query(
    `INSERT INTO oao.skill_versions (
       organization_id,project_id,id,skill_id,version,skill_name,description,
       instructions,metadata,content_hash,total_bytes,created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,'shipment-extraction',$5,$6,'{}'::jsonb,$7,$8,$9)`,
    [
      tenant.organizationId,
      tenant.projectId,
      versionId,
      skillId,
      canonical.description,
      instructions,
      contentHash,
      Buffer.byteLength(instructions),
      human,
    ],
  );
  await pool.query(
    `INSERT INTO oao.skill_version_lifecycle (
       organization_id,project_id,skill_version_id,status,updated_by_principal_id
     ) VALUES ($1,$2,$3,'active',$4)`,
    [tenant.organizationId, tenant.projectId, versionId, human],
  );
  await pool.query(
    `UPDATE oao.skills SET latest_version_id=$4
      WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
    [tenant.organizationId, tenant.projectId, skillId, versionId],
  );
  return versionId;
}

async function seedFixture(
  pool: PgPool,
  label: string,
  input: string,
  tools: readonly Record<string, unknown>[],
  options: {
    readonly existing?: Fixture;
    readonly timeoutMs?: number;
    readonly sandboxEnabled?: boolean;
    readonly sandboxProvider?: string;
    readonly harnessOperations?: readonly Record<string, unknown>[];
    readonly skillVersionIds?: readonly string[];
  } = {},
): Promise<Fixture> {
  const runId = uuid(`${label}:run`) as RunId;
  const existing = options.existing;
  const threadId = existing?.threadId ?? (uuid(`${label}:thread`) as ThreadId);
  const sessionId = existing?.sessionId ?? uuid(`${label}:session`);
  const versionId = existing?.versionId ?? uuid(`${label}:version`);
  if (!existing) {
    const agentId = uuid(`${label}:agent`);
    const config = {
      systemPrompt: "Execute the deterministic scenario.",
      modelPreset: "local-default",
      tools,
      harnessOperations: options.harnessOperations ?? [],
      skillVersionIds: options.skillVersionIds ?? [],
      sandbox: {
        enabled: options.sandboxEnabled ?? false,
        provider: options.sandboxProvider ?? "test-daytona",
        ...((options.sandboxEnabled ?? false)
          ? { snapshotId: uuid(`${label}:snapshot`) }
          : {}),
        network: "none",
        capabilities: ["filesystem_read", "filesystem_write", "shell"],
      },
      limits: { maxTurns: 32, timeoutMs: options.timeoutMs ?? 20_000 },
    };
    const encoded = JSON.stringify(config);
    await pool.query(
      `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
       VALUES ($1,$2,$3,$4,$5)`,
      [tenant.organizationId, tenant.projectId, agentId, label, label],
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
        createHash("sha256").update(encoded).digest(),
        human,
      ],
    );
    for (const skillVersionId of options.skillVersionIds ?? [])
      await pool.query(
        `INSERT INTO oao.agent_version_skill_bindings (
           organization_id,project_id,agent_version_id,skill_version_id,skill_name
         )
         SELECT $1,$2,$3,id,skill_name FROM oao.skill_versions
          WHERE organization_id=$1 AND project_id=$2 AND id=$4`,
        [tenant.organizationId, tenant.projectId, versionId, skillVersionId],
      );
    await pool.query(
      "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,$4)",
      [tenant.organizationId, tenant.projectId, threadId, label],
    );
    await pool.query(
      `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [tenant.organizationId, tenant.projectId, sessionId, threadId, versionId],
    );
    for (const skillVersionId of options.skillVersionIds ?? [])
      await pool.query(
        `INSERT INTO oao.session_skill_bindings (
           organization_id,project_id,session_id,agent_version_id,
           skill_version_id,skill_name
         )
         SELECT $1,$2,$3,$4,id,skill_name FROM oao.skill_versions
          WHERE organization_id=$1 AND project_id=$2 AND id=$5`,
        [
          tenant.organizationId,
          tenant.projectId,
          sessionId,
          versionId,
          skillVersionId,
        ],
      );
  }
  await pool.query(
    `INSERT INTO oao.runs (
       organization_id,project_id,id,thread_id,session_id,agent_version_id,
       created_by_principal_id,idempotency_key,input_public
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tenant.organizationId,
      tenant.projectId,
      runId,
      threadId,
      sessionId,
      versionId,
      human,
      `e2e:${label}`,
      { message: input },
    ],
  );
  await pool.query(
    `INSERT INTO oao.messages (
       organization_id,project_id,id,thread_id,run_id,role,redacted_content
     ) VALUES ($1,$2,$3,$4,$5,'user',$6)`,
    [
      tenant.organizationId,
      tenant.projectId,
      uuid(`${label}:api-user-message`),
      threadId,
      runId,
      input,
    ],
  );
  await pool.query(
    "SELECT oao.append_product_event($1,$2,$3,'run',$4,'message.created',$5,clock_timestamp())",
    [
      tenant.organizationId,
      tenant.projectId,
      uuid(`${label}:api-user-event`),
      runId,
      { role: "user" },
    ],
  );
  return { runId, threadId, sessionId, versionId, input };
}

async function enqueue(
  worker: RuntimeWorkerHandle,
  fixture: Fixture,
): Promise<void> {
  await worker.orchestrator.handleWake({
    ...tenant,
    id: uuid(`wake:${fixture.runId}`),
    runId: fixture.runId,
    dispatchKey: `admit:${fixture.runId}`,
    kind: "admit",
    payload: { reason: "integration_test" },
    attempts: 1,
    fence: 1n,
  });
}

async function waitFor(
  pool: PgPool,
  query: string,
  values: readonly unknown[],
  predicate: (rows: readonly Record<string, unknown>[]) => boolean,
  timeoutMs = 20_000,
): Promise<readonly Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  let lastRows: readonly Record<string, unknown>[];
  for (;;) {
    const result = await pool.query<Record<string, unknown>>(query, [
      ...values,
    ]);
    lastRows = result.rows;
    if (predicate(result.rows)) return result.rows;
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for: ${query}; last rows: ${JSON.stringify(lastRows)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitRun(
  pool: PgPool,
  runId: RunId,
  state: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    pool,
    "SELECT state FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND id=$3",
    [tenant.organizationId, tenant.projectId, runId],
    (rows) => rows[0]?.state === state,
    timeoutMs,
  );
}

const callerTool = {
  name: "caller.lookup",
  description: "Look up a public value",
  owner: "caller",
  approval: "never",
  inputSchema: objectSchema({ query: { type: "string" } }),
  outputSchema: objectSchema({ found: { type: "boolean" } }),
};
const approvedTool = {
  ...callerTool,
  name: "caller.approved",
  approval: "always",
};
const platformTool = {
  ...callerTool,
  name: "platform.echo",
  owner: "platform",
};

test(
  "thread continuity, fenced tool recovery, approvals, platform replay, deadline and transcript invariants",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 180_000 },
  async () => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const admin = createPool(testAdminDatabaseUrl);
    let worker: RuntimeWorkerHandle | undefined;
    let runtimeChild: ChildProcess | undefined;
    let platformEffects = 0;
    let releasePlatform: (() => void) | undefined;
    const platformTools = new Map<string, PlatformToolHandler>([
      [
        "platform.echo",
        async () => {
          platformEffects += 1;
          await new Promise<void>((resolve) => {
            releasePlatform = resolve;
          });
          return { echoed: true };
        },
      ],
    ]);
    const start = () =>
      startRuntimeWorker({
        databaseUrl,
        listen: false,
        env: {
          ...process.env,
          OAO_RUNTIME_SERVICE_PRINCIPAL_ID: service,
        },
        fakeResponses,
        platformTools,
      });
    try {
      worker = await start();
      await seedBase(admin);

      const first = await seedFixture(
        admin,
        "continuity-one",
        "turn-one: alpha",
        [],
      );
      await enqueue(worker, first);
      await waitRun(admin, first.runId, "completed");
      const second = await seedFixture(
        admin,
        "continuity-two",
        "turn-two: recall alpha",
        [],
        { existing: first },
      );
      await enqueue(worker, second);
      await waitRun(admin, second.runId, "completed");

      const continuity = await admin.query<{
        flue_conversation_id: string;
        flue_instance_uid: string;
      }>(
        `SELECT flue_conversation_id,flue_instance_uid FROM oao.runtime_dispatches
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3 ORDER BY created_at`,
        [tenant.organizationId, tenant.projectId, first.threadId],
      );
      assert.equal(continuity.rowCount, 2);
      assert.equal(
        continuity.rows[0]?.flue_conversation_id,
        continuity.rows[1]?.flue_conversation_id,
      );
      assert.equal(
        continuity.rows[0]?.flue_instance_uid,
        continuity.rows[1]?.flue_instance_uid,
      );
      for (const fixture of [first, second]) {
        const messages = await admin.query<{
          role: string;
          redacted_content: string;
        }>(
          `SELECT role,redacted_content FROM oao.messages
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 ORDER BY created_at`,
          [tenant.organizationId, tenant.projectId, fixture.runId],
        );
        assert.equal(
          messages.rows.filter((row) => row.role === "user").length,
          1,
        );
        assert.equal(
          messages.rows.filter((row) => row.role === "assistant").length,
          1,
        );
        assert.equal(
          messages.rows.find((row) => row.role === "user")?.redacted_content,
          fixture.input,
        );
      }
      const filtered = await seedFixture(
        admin,
        "content-filter",
        "content-filter exact",
        [],
      );
      await enqueue(worker, filtered);
      await waitRun(admin, filtered.runId, "failed");
      const filteredProjection = await admin.query<{
        invocation_finish_reason: string;
        invocation_provider_finish_reason: string;
        invocation_error_explanation: string;
        timeline_provider_finish_reason: string;
        event_provider_finish_reason: string;
        event_error_explanation: string;
      }>(
        `SELECT m.safe_response->>'finishReason' AS invocation_finish_reason,
                m.safe_response->>'providerFinishReason' AS invocation_provider_finish_reason,
                m.safe_response->>'errorExplanation' AS invocation_error_explanation,
                t.safe_detail->>'providerFinishReason' AS timeline_provider_finish_reason,
                e.public_payload->>'providerFinishReason' AS event_provider_finish_reason,
                e.public_payload->>'errorExplanation' AS event_error_explanation
           FROM oao.model_invocations m
           JOIN oao.timeline_entries t
             ON t.organization_id=m.organization_id
            AND t.project_id=m.project_id
            AND t.run_id=m.run_id
            AND t.entry_type='model_invocation'
           JOIN oao.product_events e
             ON e.organization_id=m.organization_id
            AND e.project_id=m.project_id
            AND e.aggregate_id=m.run_id
            AND e.event_kind='model.invocation_failed'
          WHERE m.organization_id=$1 AND m.project_id=$2 AND m.run_id=$3`,
        [tenant.organizationId, tenant.projectId, filtered.runId],
      );
      const contentFilterExplanation =
        "The provider stopped the response because its content filter was triggered, so OAO treated the partial response as incomplete and failed the run.";
      assert.deepEqual(filteredProjection.rows[0], {
        invocation_finish_reason: "error",
        invocation_provider_finish_reason: "content_filter",
        invocation_error_explanation: contentFilterExplanation,
        timeline_provider_finish_reason: "content_filter",
        event_provider_finish_reason: "content_filter",
        event_error_explanation: contentFilterExplanation,
      });
      const projectionState = async () => {
        const [invocations, timeline, summary] = await Promise.all([
          admin.query<{ count: string }>(
            "SELECT COUNT(*) AS count FROM oao.model_invocations WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
            [tenant.organizationId, tenant.projectId, first.runId],
          ),
          admin.query<{ count: string }>(
            "SELECT COUNT(*) AS count FROM oao.timeline_entries WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND entry_type='model_invocation'",
            [tenant.organizationId, tenant.projectId, first.runId],
          ),
          admin.query<{
            summary_version: string;
            input_tokens: string;
            output_tokens: string;
            cache_read_tokens: string;
            cache_write_tokens: string;
            cost_microunits: string;
          }>(
            "SELECT summary_version,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_microunits FROM oao.session_summaries WHERE organization_id=$1 AND project_id=$2 AND session_id=$3",
            [tenant.organizationId, tenant.projectId, first.sessionId],
          ),
        ]);
        return {
          invocations: invocations.rows[0]?.count,
          timeline: timeline.rows[0]?.count,
          summary: summary.rows[0],
        };
      };
      const beforeReplay = await projectionState();
      const invocationUsage = await admin.query<{
        cache_read_tokens: string;
        cache_write_tokens: string;
      }>(
        `SELECT COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens
           FROM oao.model_invocations m
           JOIN oao.runs r
             ON r.organization_id=m.organization_id
            AND r.project_id=m.project_id
            AND r.id=m.run_id
          WHERE m.organization_id=$1 AND m.project_id=$2 AND r.session_id=$3`,
        [tenant.organizationId, tenant.projectId, first.sessionId],
      );
      assert.equal(
        beforeReplay.summary?.cache_read_tokens,
        invocationUsage.rows[0]?.cache_read_tokens,
      );
      assert.equal(
        beforeReplay.summary?.cache_write_tokens,
        invocationUsage.rows[0]?.cache_write_tokens,
      );
      assert.ok(
        Number(beforeReplay.summary?.cache_read_tokens ?? 0) +
          Number(beforeReplay.summary?.cache_write_tokens ?? 0) >
          0,
        "the provider cache usage should survive runtime projection",
      );
      assert.equal(await worker.projection.replayLastTurn(first.runId), true);
      assert.deepEqual(await projectionState(), beforeReplay);

      const caller = await seedFixture(
        admin,
        "caller-restart",
        "caller-tool exact",
        [callerTool],
        { timeoutMs: 90_000 },
      );
      await worker.dispose();
      worker = undefined;
      runtimeChild = await startRuntimeChild(databaseUrl);
      const recoveryQueue = new PostgresWakeQueue(admin);
      await withTenantTransaction(admin, tenant, (transaction) =>
        recoveryQueue.enqueue(transaction, {
          ...tenant,
          id: uuid(`wake:${caller.runId}`),
          runId: caller.runId,
          dispatchKey: `admit:${caller.runId}`,
          kind: "admit",
          payload: { reason: "integration_test" },
        }),
      );
      const pending = await waitFor(
        admin,
        `SELECT id,stage FROM oao.tool_calls
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [tenant.organizationId, tenant.projectId, caller.runId],
        (rows) => rows[0]?.stage === "caller_pending",
      );
      const callerToolId = pending[0]?.id as ToolCallId;
      const beforeHandoff = await admin.query<{
        flue_submission_id: string;
        flue_instance_uid: string;
      }>(
        "SELECT flue_submission_id,flue_instance_uid FROM oao.runtime_dispatches WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
        [tenant.organizationId, tenant.projectId, caller.runId],
      );
      await stopRuntimeChild(runtimeChild);
      assert.equal(runtimeChild.exitCode, 0);
      runtimeChild = undefined;
      const fence = await withTenantTransaction(
        admin,
        tenant,
        async (transaction) => {
          const result = await transaction.query<{ fence: string }>(
            "SELECT oao.claim_tool_call($1,$2,$3,$4,interval '1 minute') AS fence",
            [tenant.organizationId, tenant.projectId, callerToolId, human],
          );
          return result.rows[0]?.fence ?? "0";
        },
      );
      const safeResult = {
        version: 1,
        status: "success",
        value: { found: true },
      };
      await withTenantTransaction(admin, tenant, (transaction) =>
        transaction.query(
          "SELECT oao.submit_tool_result($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            tenant.organizationId,
            tenant.projectId,
            callerToolId,
            human,
            fence,
            `result:${caller.runId}`,
            createHash("sha256").update(JSON.stringify(safeResult)).digest(),
            safeResult,
          ],
        ),
      );
      const recoveryStartedAt = Date.now();
      runtimeChild = await startRuntimeChild(databaseUrl);
      await waitRun(admin, caller.runId, "completed", 40_000);
      const recoveryElapsedMs = Date.now() - recoveryStartedAt;
      assert.ok(
        recoveryElapsedMs <= 35_000,
        `Flue recovery exceeded its lease bound: ${recoveryElapsedMs}ms`,
      );
      const obligation = await admin.query<{
        stage: string;
        committed_at: Date | null;
      }>(
        `SELECT c.stage,r.committed_at FROM oao.tool_calls c
         JOIN oao.tool_call_results r ON r.organization_id=c.organization_id
           AND r.project_id=c.project_id AND r.tool_call_id=c.id
         WHERE c.organization_id=$1 AND c.project_id=$2 AND c.id=$3`,
        [tenant.organizationId, tenant.projectId, callerToolId],
      );
      assert.equal(obligation.rows[0]?.stage, "result_committed");
      assert.ok(obligation.rows[0]?.committed_at);
      const recoveryWake = await admin.query<{
        state: string;
        attempts: number;
        safe_error: unknown;
      }>(
        "SELECT state,attempts,safe_error FROM oao.runtime_wake_jobs WHERE organization_id=$1 AND project_id=$2 AND dispatch_key=$3",
        [tenant.organizationId, tenant.projectId, `reconcile:${caller.runId}`],
      );
      assert.deepEqual(recoveryWake.rows[0], {
        state: "completed",
        attempts: 1,
        safe_error: null,
      });
      const afterRecovery = await admin.query<{
        flue_submission_id: string;
        flue_instance_uid: string;
      }>(
        "SELECT flue_submission_id,flue_instance_uid FROM oao.runtime_dispatches WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
        [tenant.organizationId, tenant.projectId, caller.runId],
      );
      assert.deepEqual(afterRecovery.rows[0], beforeHandoff.rows[0]);
      const flueRecovery = await admin.query<{
        status: string;
        attempt_count: number;
        outcome: string;
      }>(
        `SELECT status,attempt_count,settlement_record::jsonb->>'outcome' AS outcome
         FROM public.flue_agent_submissions WHERE submission_id=$1`,
        [beforeHandoff.rows[0]?.flue_submission_id],
      );
      assert.deepEqual(flueRecovery.rows[0], {
        status: "settled",
        attempt_count: 2,
        outcome: "completed",
      });
      await stopRuntimeChild(runtimeChild);
      assert.equal(runtimeChild.exitCode, 0);
      runtimeChild = undefined;
      worker = await start();

      for (const [label, input, resolution] of [
        ["approval-deny", "approval-deny exact", "denied"],
        ["approval-expire", "approval-expire exact", "expired"],
      ] as const) {
        const fixture = await seedFixture(admin, label, input, [approvedTool]);
        await enqueue(worker, fixture);
        const approvals = await waitFor(
          admin,
          `SELECT id,status FROM oao.approvals
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
          [tenant.organizationId, tenant.projectId, fixture.runId],
          (rows) => rows[0]?.status === "pending",
        );
        if (resolution === "denied") {
          await withTenantTransaction(admin, tenant, (transaction) =>
            transaction.query(
              "SELECT oao.resolve_approval($1,$2,$3,'denied',$4,'integration denial')",
              [
                tenant.organizationId,
                tenant.projectId,
                approvals[0]?.id,
                human,
              ],
            ),
          );
        } else {
          await admin.query(
            "UPDATE oao.approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND project_id=$2 AND id=$3",
            [tenant.organizationId, tenant.projectId, approvals[0]?.id],
          );
        }
        await waitRun(admin, fixture.runId, "completed");
        const obligation = await admin.query<{ stage: string }>(
          "SELECT stage FROM oao.tool_calls WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
          [tenant.organizationId, tenant.projectId, fixture.runId],
        );
        assert.equal(
          obligation.rows[0]?.stage,
          resolution === "denied" ? "approval_denied" : "approval_expired",
        );
      }

      const platform = await seedFixture(
        admin,
        "platform-replay",
        "platform-tool exact",
        [platformTool],
      );
      await enqueue(worker, platform);
      await waitFor(
        admin,
        "SELECT stage FROM oao.tool_calls WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
        [tenant.organizationId, tenant.projectId, platform.runId],
        (rows) => rows[0]?.stage === "platform_executing",
      );
      const duplicate: RuntimeWakeJob = {
        ...tenant,
        id: uuid("platform-duplicate-wake"),
        runId: platform.runId,
        dispatchKey: `reconcile:${platform.runId}`,
        kind: "reconcile",
        payload: { reason: "duplicate_delivery" },
        attempts: 1,
        fence: 1n,
      };
      await worker.orchestrator.handleWake(duplicate);
      releasePlatform?.();
      await waitRun(admin, platform.runId, "completed");
      assert.equal(platformEffects, 1);

      const corrupt = await seedFixture(
        admin,
        "uid-corruption",
        "corruption exact",
        [callerTool],
        { timeoutMs: 120_000 },
      );
      await enqueue(worker, corrupt);
      await waitFor(
        admin,
        "SELECT stage FROM oao.tool_calls WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
        [tenant.organizationId, tenant.projectId, corrupt.runId],
        (rows) => rows[0]?.stage === "caller_pending",
      );
      const wrongUid = "00000000-0000-4000-8000-00000000c0de";
      await admin.query(
        `UPDATE oao.runtime_thread_instances SET flue_instance_uid=$4
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3`,
        [tenant.organizationId, tenant.projectId, corrupt.threadId, wrongUid],
      );
      await admin.query(
        `UPDATE oao.runtime_dispatches SET flue_instance_uid=$4
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [tenant.organizationId, tenant.projectId, corrupt.runId, wrongUid],
      );
      await admin.query(
        `UPDATE oao.runs SET cancellation_requested_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
        [tenant.organizationId, tenant.projectId, corrupt.runId],
      );
      await worker.orchestrator.handleWake({
        ...tenant,
        id: uuid("uid-corruption-cancel"),
        runId: corrupt.runId,
        dispatchKey: `cancel:${corrupt.runId}`,
        kind: "cancel",
        payload: { reason: "integration_uid_mismatch" },
        attempts: 1,
        fence: 1n,
      });
      await waitRun(admin, corrupt.runId, "failed");
      const blockedHead = await admin.query<{
        run_id: string;
        state: string;
        draining_at: Date | null;
      }>(
        "SELECT run_id,state,draining_at FROM oao.thread_admission_heads WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3",
        [tenant.organizationId, tenant.projectId, corrupt.threadId],
      );
      assert.equal(blockedHead.rows[0]?.run_id, corrupt.runId);
      assert.equal(blockedHead.rows[0]?.state, "ambiguous");
      assert.ok(blockedHead.rows[0]?.draining_at);
      const blockedSuccessor = await seedFixture(
        admin,
        "uid-corruption-successor",
        "corruption exact successor",
        [callerTool],
        { existing: corrupt },
      );
      await waitFor(
        admin,
        "SELECT state FROM oao.runtime_dispatches WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
        [tenant.organizationId, tenant.projectId, corrupt.runId],
        (rows) => rows[0]?.state === "settled",
        30_000,
      );
      const corruptProjection = await admin.query<{
        run_state: string;
        timeline_state: string;
        run_event_state: string;
        summary_event_state: string;
        assistant_count: string;
      }>(
        `SELECT r.state AS run_state,
           t.safe_detail->>'status' AS timeline_state,
           re.public_payload->>'state' AS run_event_state,
           se.public_payload->>'state' AS summary_event_state,
           (SELECT COUNT(*) FROM oao.messages m WHERE m.organization_id=r.organization_id
             AND m.project_id=r.project_id AND m.run_id=r.id AND m.role='assistant') AS assistant_count
         FROM oao.runs r
         JOIN oao.timeline_entries t ON t.organization_id=r.organization_id
           AND t.project_id=r.project_id AND t.run_id=r.id AND t.entry_sequence=1
         JOIN oao.product_events re ON re.organization_id=r.organization_id
           AND re.project_id=r.project_id AND re.id=$4
         JOIN oao.product_events se ON se.organization_id=r.organization_id
           AND se.project_id=r.project_id AND se.id=$5
         WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=$3`,
        [
          tenant.organizationId,
          tenant.projectId,
          corrupt.runId,
          uuid(`event:${corrupt.runId}:run-settled`),
          uuid(`event:${corrupt.runId}:session-summary`),
        ],
      );
      assert.deepEqual(corruptProjection.rows[0], {
        run_state: "failed",
        timeline_state: "failed",
        run_event_state: "failed",
        summary_event_state: "failed",
        assistant_count: "0",
      });
      const successorState = await admin.query<{ state: string }>(
        "SELECT state FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [tenant.organizationId, tenant.projectId, blockedSuccessor.runId],
      );
      assert.equal(successorState.rows[0]?.state, "queued");
      const successorWakes = await admin.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM oao.runtime_wake_jobs WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND kind='admit'",
        [tenant.organizationId, tenant.projectId, blockedSuccessor.runId],
      );
      assert.equal(successorWakes.rows[0]?.count, "0");
      const stillBlocked = await admin.query<{ run_id: string }>(
        "SELECT run_id FROM oao.thread_admission_heads WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3",
        [tenant.organizationId, tenant.projectId, corrupt.threadId],
      );
      assert.equal(stillBlocked.rows[0]?.run_id, corrupt.runId);
      await enqueue(worker, blockedSuccessor);
      const manuallyBlocked = await admin.query<{ state: string }>(
        "SELECT state FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [tenant.organizationId, tenant.projectId, blockedSuccessor.runId],
      );
      assert.equal(manuallyBlocked.rows[0]?.state, "queued");

      const deadline = await seedFixture(
        admin,
        "deadline",
        "deadline exact",
        [callerTool],
        { timeoutMs: 1_000 },
      );
      await enqueue(worker, deadline);
      await waitRun(admin, deadline.runId, "timed_out");
      const closed = await admin.query<{ stage: string }>(
        "SELECT stage FROM oao.tool_calls WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
        [tenant.organizationId, tenant.projectId, deadline.runId],
      );
      assert.equal(closed.rows[0]?.stage, "cancelled");

      await worker.stop();
      worker = undefined;
      const fakeDaytona = new FakeSandboxProvider();
      worker = await startRuntimeWorker({
        databaseUrl,
        listen: false,
        env: {
          ...process.env,
          OAO_RUNTIME_SERVICE_PRINCIPAL_ID: service,
        },
        daytonaProvider: fakeDaytona,
        fakeResponses,
        platformTools,
      });
      const harnessSkillVersionId = await seedHarnessSkill(
        admin,
        "harness-sequence",
      );
      const harness = await seedFixture(
        admin,
        "harness-sequence",
        "harness-sequence exact",
        [],
        {
          sandboxEnabled: true,
          sandboxProvider: "test-daytona",
          skillVersionIds: [harnessSkillVersionId],
          harnessOperations: [
            {
              key: "extract_shipment",
              description:
                "Extract and verify one shipment document when a structured shipment result is required.",
              instructions:
                "Activate the shipment-extraction Skill, read the already-materialized shipment.txt fixture from the shared sandbox, verify it with another sandbox tool turn, and return the structured extraction.",
              resultSchema: objectSchema({
                shipmentReference: { type: "string" },
                skillActivated: { type: "boolean" },
                sequentialToolTurns: { type: "integer" },
              }),
              timeoutMs: 10_000,
            },
          ],
        },
      );
      await enqueue(worker, harness);
      await waitRun(admin, harness.runId, "completed");
      const harnessEvidence = await admin.query<{
        assistant_reply: string;
        skill_events: string;
        harness_started: string;
        harness_completed: string;
        sandbox_tools: string;
      }>(
        `SELECT
           (SELECT redacted_content FROM oao.messages
             WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
               AND role='assistant' ORDER BY created_at DESC LIMIT 1) AS assistant_reply,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='skill.activated') AS skill_events,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_started') AS harness_started,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_completed') AS harness_completed,
           (SELECT COUNT(*) FROM oao.sandbox_commands
             WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
               AND safe_command->>'toolName' IN ('write','read','bash')) AS sandbox_tools`,
        [tenant.organizationId, tenant.projectId, harness.runId],
      );
      assert.deepEqual(harnessEvidence.rows[0], {
        assistant_reply: "harness-sequence:completed",
        skill_events: "1",
        harness_started: "1",
        harness_completed: "1",
        sandbox_tools: "3",
      });
      const daytona = await seedFixture(
        admin,
        "daytona-composition-one",
        "daytona exact one",
        [],
        { sandboxEnabled: true, sandboxProvider: "test-daytona" },
      );
      await enqueue(worker, daytona);
      await waitRun(admin, daytona.runId, "completed");
      const daytonaSecond = await seedFixture(
        admin,
        "daytona-composition-two",
        "daytona exact two",
        [],
        {
          existing: daytona,
          sandboxEnabled: true,
          sandboxProvider: "test-daytona",
        },
      );
      await enqueue(worker, daytonaSecond);
      await waitRun(admin, daytonaSecond.runId, "completed");
      assert.equal(
        fakeDaytona.calls.filter((call) =>
          call.startsWith("create:oao-sandbox-v1:"),
        ).length,
        1,
      );
      const workspaces = await admin.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM oao.sandbox_instances WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3",
        [tenant.organizationId, tenant.projectId, daytona.threadId],
      );
      assert.equal(workspaces.rows[0]?.count, "1");
    } finally {
      if (runtimeChild) await stopRuntimeChild(runtimeChild);
      await worker?.stop();
      await admin.end();
    }
  },
);
