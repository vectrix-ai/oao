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
import type { PlatformToolHandler } from "@oao/runtime-flue";
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
  organizationId: uuid("assistant-text-e2e-org") as OrganizationId,
  projectId: uuid("assistant-text-e2e-project") as ProjectId,
};
const human = uuid("assistant-text-e2e-human") as PrincipalId;
const service = uuid("assistant-text-e2e-service") as PrincipalId;
const skillVersionId = uuid("assistant-text-e2e-skill-version");

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const lookupTool = {
  schemaVersion: 1,
  name: "platform.lookup",
  description: "Look up a customer.",
  owner: "platform",
  approval: "never",
  inputSchema: objectSchema({ customer: { type: "string" } }),
  outputSchema: objectSchema({ found: { type: "boolean" } }),
};

/**
 * One script for every agent here: a Skill activation, a sandbox write, a
 * platform tool and a sandbox read in parallel, a silent sandbox read, then
 * the final answer. Each tool-calling turn but the silent one says first what
 * it is about to do.
 */
function narratorStep(results: number) {
  switch (results) {
    case 0:
      return fauxAssistantMessage(
        [
          { type: "text" as const, text: "narration:skill" },
          fauxToolCall("activate_skill", { name: "order-reading" }),
        ],
        { stopReason: "toolUse" },
      );
    case 1:
      return fauxAssistantMessage(
        [
          { type: "text" as const, text: "narration:write" },
          fauxToolCall("write", { path: "order.txt", content: "order=42" }),
        ],
        { stopReason: "toolUse" },
      );
    case 2:
      return fauxAssistantMessage(
        [
          { type: "text" as const, text: "narration:parallel" },
          fauxToolCall("platform.lookup", { customer: "C-1" }),
          fauxToolCall("read", { path: "order.txt" }),
        ],
        { stopReason: "toolUse" },
      );
    case 4:
      return fauxAssistantMessage(
        [fauxToolCall("read", { path: "order.txt" })],
        {
          stopReason: "toolUse",
        },
      );
    case 5:
      return fauxAssistantMessage("narration:done");
    default:
      throw new Error(`Unexpected narrator step after ${results} results`);
  }
}

const respond: FauxResponseStep = (context) => {
  const transcript = JSON.stringify(context.messages);
  const results = context.messages.filter(
    (message) => message.role === "toolResult",
  ).length;
  // The coordinator's transcript also holds the child's prompt and reply.
  if (transcript.includes("coordinate-parent"))
    return results === 0
      ? fauxAssistantMessage(
          [
            { type: "text" as const, text: "coordinator:delegating" },
            fauxToolCall("delegate_agent", {
              agent: "narrator",
              prompt: "narrate-child",
            }),
          ],
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage("coordinator:done");
  if (
    ["narrate-direct", "quiet-direct", "narrate-child"].some((marker) =>
      transcript.includes(marker),
    )
  )
    return narratorStep(results);
  throw new Error(`Unexpected fake-model context: ${transcript}`);
};

const sandbox = {
  enabled: true,
  provider: "test-daytona",
  snapshotId: uuid("assistant-text-e2e-snapshot"),
  network: "none",
  capabilities: ["filesystem_read", "filesystem_write"],
};

async function seedBase(pool: PgPool): Promise<void> {
  await pool.query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'assistant-text-e2e','Assistant text e2e')",
    [tenant.organizationId],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'assistant-text-e2e','Assistant text e2e')",
    [tenant.organizationId, tenant.projectId],
  );
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'human','assistant-text-e2e-human',ARRAY['*']),
            ($1,$2,$4,'service','assistant-text-e2e-service',ARRAY['*'])`,
    [tenant.organizationId, tenant.projectId, human, service],
  );
  const skillId = uuid("assistant-text-e2e-skill");
  const instructions = "Read the order file before answering.";
  // The registry verifies this hash of the canonical package.
  const canonical = {
    schemaVersion: 1,
    name: "order-reading",
    description: "Read an order file.",
    instructions,
    metadata: {},
    files: [],
  };
  await pool.query(
    `INSERT INTO oao.skills (
       organization_id,project_id,id,skill_key,display_name,created_by_principal_id
     ) VALUES ($1,$2,$3,'order-reading','Order reading',$4)`,
    [tenant.organizationId, tenant.projectId, skillId, human],
  );
  await pool.query(
    `INSERT INTO oao.skill_versions (
       organization_id,project_id,id,skill_id,version,skill_name,description,
       instructions,metadata,content_hash,total_bytes,created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,'order-reading','Read an order file.',$5,'{}'::jsonb,$6,$7,$8)`,
    [
      tenant.organizationId,
      tenant.projectId,
      skillVersionId,
      skillId,
      instructions,
      createHash("sha256").update(stableJson(canonical)).digest(),
      Buffer.byteLength(instructions),
      human,
    ],
  );
  await pool.query(
    `INSERT INTO oao.skill_version_lifecycle (
       organization_id,project_id,skill_version_id,status,updated_by_principal_id
     ) VALUES ($1,$2,$3,'active',$4)`,
    [tenant.organizationId, tenant.projectId, skillVersionId, human],
  );
  await pool.query(
    "UPDATE oao.skills SET latest_version_id=$4 WHERE organization_id=$1 AND project_id=$2 AND id=$3",
    [tenant.organizationId, tenant.projectId, skillId, skillVersionId],
  );
}

/** Publishes one agent version; the narrator and the quiet agent bind the Skill. */
async function seedAgent(
  pool: PgPool,
  label: string,
  options: {
    readonly publishText: boolean;
    readonly delegateVersionId?: string;
  },
): Promise<string> {
  const agentId = uuid(`${label}:agent`);
  const versionId = uuid(`${label}:version`);
  const config = {
    systemPrompt: "Say what you are about to do before each tool call.",
    modelPreset: "local-default",
    tools: options.delegateVersionId ? [] : [lookupTool],
    skillVersionIds: options.delegateVersionId ? [] : [skillVersionId],
    delegates: options.delegateVersionId
      ? [
          {
            key: "narrator",
            description: "Reads orders and narrates its work.",
            agentVersionId: options.delegateVersionId,
            maxParallel: 1,
          },
        ]
      : [],
    ...(options.publishText ? { publishTextBeforeToolCalls: true } : {}),
    sandbox,
    limits: { maxTurns: 16, timeoutMs: 30_000 },
  };
  await pool.query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,$4,$4)`,
    [tenant.organizationId, tenant.projectId, agentId, label],
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
      human,
    ],
  );
  if (!options.delegateVersionId)
    await pool.query(
      `INSERT INTO oao.agent_version_skill_bindings (
         organization_id,project_id,agent_version_id,skill_version_id,skill_name
       ) VALUES ($1,$2,$3,$4,'order-reading')`,
      [tenant.organizationId, tenant.projectId, versionId, skillVersionId],
    );
  return versionId;
}

async function seedRun(
  pool: PgPool,
  label: string,
  versionId: string,
  message: string,
  bindsSkill: boolean,
): Promise<RunId> {
  const threadId = uuid(`${label}:thread`) as ThreadId;
  const sessionId = uuid(`${label}:session`);
  const runId = uuid(`${label}:run`) as RunId;
  await pool.query(
    "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,$4)",
    [tenant.organizationId, tenant.projectId, threadId, label],
  );
  await pool.query(
    `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenant.organizationId, tenant.projectId, sessionId, threadId, versionId],
  );
  if (bindsSkill)
    await pool.query(
      `INSERT INTO oao.session_skill_bindings (
         organization_id,project_id,session_id,agent_version_id,
         skill_version_id,skill_name
       ) VALUES ($1,$2,$3,$4,$5,'order-reading')`,
      [
        tenant.organizationId,
        tenant.projectId,
        sessionId,
        versionId,
        skillVersionId,
      ],
    );
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
      `assistant-text-e2e:${label}`,
      { message },
    ],
  );
  return runId;
}

async function runToCompletion(
  worker: RuntimeWorkerHandle,
  pool: PgPool,
  runId: RunId,
): Promise<void> {
  await worker.orchestrator.handleWake({
    ...tenant,
    id: uuid(`assistant-text-e2e-wake:${runId}`),
    runId,
    dispatchKey: `admit:${runId}`,
    kind: "admit",
    payload: { reason: "integration_test" },
    attempts: 1,
    fence: 1n,
  });
  const deadline = Date.now() + 45_000;
  for (;;) {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM oao.runs WHERE id=$1",
      [runId],
    );
    const state = result.rows[0]?.state ?? "missing";
    if (["completed", "failed", "cancelled", "timed_out"].includes(state)) {
      assert.equal(state, "completed");
      return;
    }
    if (Date.now() >= deadline) throw new Error(`The run stayed in ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function assistantMessages(
  pool: PgPool,
  runId: string,
): Promise<string[]> {
  const result = await pool.query<{ content: string }>(
    `SELECT redacted_content AS content FROM oao.messages
      WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND role='assistant'
      ORDER BY created_at,id`,
    [tenant.organizationId, tenant.projectId, runId],
  );
  return result.rows.map((row) => row.content);
}

/**
 * The run's messages and tool activity in event order: each assistant
 * message, Skill activation, platform tool call, and sandbox command start.
 */
async function activity(pool: PgPool, runId: string): Promise<string[]> {
  const result = await pool.query<{ label: string }>(
    `SELECT CASE event.event_kind
              WHEN 'message.created' THEN 'message:' || message.redacted_content
              WHEN 'skill.activated' THEN 'skill'
              WHEN 'tool_call.requested' THEN 'tool:' || (event.public_payload->>'toolName')
              ELSE 'sandbox:' || (command.safe_command->>'toolName')
            END AS label
       FROM oao.product_events event
       LEFT JOIN oao.messages message
         ON message.organization_id=event.organization_id
        AND message.project_id=event.project_id
        AND message.id::text=event.public_payload->>'messageId'
       LEFT JOIN oao.sandbox_commands command
         ON command.organization_id=event.organization_id
        AND command.project_id=event.project_id
        AND command.id::text=event.public_payload->>'commandId'
      WHERE event.organization_id=$1 AND event.project_id=$2
        AND (
          (event.aggregate_id=$3 AND event.event_kind IN
            ('message.created','skill.activated','tool_call.requested'))
          OR (event.event_kind='sandbox.command_started' AND command.run_id=$3)
        )
      ORDER BY event.project_position`,
    [tenant.organizationId, tenant.projectId, runId],
  );
  return result.rows.map((row) => row.label);
}

const narration = [
  "narration:skill",
  "narration:write",
  "narration:parallel",
  "narration:done",
];

test(
  "an agent version that publishes text commits each turn's text before the turn's tool calls",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 180_000 },
  async () => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const pool = createPool(testAdminDatabaseUrl);
    const lookups: string[] = [];
    const platformTools = new Map<string, PlatformToolHandler>([
      [
        "platform.lookup",
        async (input) => {
          lookups.push(String(input.customer));
          return { found: true };
        },
      ],
    ]);
    let worker: RuntimeWorkerHandle | undefined;
    try {
      worker = await startRuntimeWorker({
        databaseUrl,
        listen: false,
        env: {
          ...process.env,
          OAO_RUNTIME_SERVICE_PRINCIPAL_ID: service,
        },
        daytonaProvider: new FakeSandboxProvider(),
        fakeResponses: Array.from({ length: 64 }, () => respond),
        platformTools,
      });
      await seedBase(pool);
      const narrator = await seedAgent(pool, "narrator", { publishText: true });
      const quiet = await seedAgent(pool, "quiet", { publishText: false });
      const coordinator = await seedAgent(pool, "coordinator", {
        publishText: false,
        delegateVersionId: narrator,
      });

      // With the setting on, every tool-calling turn with text is its own
      // message, committed before any event of that turn's tool calls.
      const narrated = await seedRun(
        pool,
        "narrated",
        narrator,
        "narrate-direct",
        true,
      );
      await runToCompletion(worker, pool, narrated);
      assert.deepEqual(await assistantMessages(pool, narrated), narration);
      const events = await activity(pool, narrated);
      const parallel = events.indexOf("message:narration:parallel");
      assert.deepEqual(events.slice(0, parallel + 1), [
        "message:narration:skill",
        "skill",
        "message:narration:write",
        "sandbox:write",
        "message:narration:parallel",
      ]);
      // The parallel calls follow their shared message in either order.
      assert.deepEqual(events.slice(parallel + 1, parallel + 3).sort(), [
        "sandbox:read",
        "tool:platform.lookup",
      ]);
      // A turn without text adds no message.
      assert.deepEqual(events.slice(parallel + 3), [
        "sandbox:read",
        "message:narration:done",
      ]);

      // With the setting off, the same script keeps today's single reply.
      const quietRun = await seedRun(
        pool,
        "quiet",
        quiet,
        "quiet-direct",
        true,
      );
      await runToCompletion(worker, pool, quietRun);
      assert.deepEqual(await assistantMessages(pool, quietRun), [
        narration.join("\n\n"),
      ]);

      // A delegated child follows its own agent version: the child publishes
      // its text, the coordinator does not, and the coordinator still reads
      // the child's whole reply.
      const coordinated = await seedRun(
        pool,
        "coordinated",
        coordinator,
        "coordinate-parent",
        false,
      );
      await runToCompletion(worker, pool, coordinated);
      assert.deepEqual(await assistantMessages(pool, coordinated), [
        "coordinator:delegating\n\ncoordinator:done",
      ]);
      const child = await pool.query<{ child_run_id: string }>(
        `SELECT child_run_id FROM oao.delegation_runs
          WHERE organization_id=$1 AND project_id=$2 AND requested_by_run_id=$3`,
        [tenant.organizationId, tenant.projectId, coordinated],
      );
      const childRunId = child.rows[0]?.child_run_id;
      assert.ok(childRunId);
      assert.deepEqual(await assistantMessages(pool, childRunId), narration);
      const delegation = await pool.query<{ response: string }>(
        `SELECT result.safe_result->'value'->>'response' AS response
           FROM oao.tool_calls call JOIN oao.tool_call_results result
             ON result.organization_id=call.organization_id
            AND result.project_id=call.project_id AND result.tool_call_id=call.id
          WHERE call.organization_id=$1 AND call.project_id=$2 AND call.run_id=$3
            AND call.tool_name='delegate_agent'`,
        [tenant.organizationId, tenant.projectId, coordinated],
      );
      assert.equal(delegation.rows[0]?.response, narration.join("\n\n"));
      assert.deepEqual(lookups, ["C-1", "C-1", "C-1"]);
    } finally {
      await worker?.stop();
      await pool.end();
    }
  },
);
