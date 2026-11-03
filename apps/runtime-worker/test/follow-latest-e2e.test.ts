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
  organizationId: uuid("follow-latest-e2e-org") as OrganizationId,
  projectId: uuid("follow-latest-e2e-project") as ProjectId,
};
const human = uuid("follow-latest-e2e-human") as PrincipalId;
const service = uuid("follow-latest-e2e-service") as PrincipalId;
const scope = [tenant.organizationId, tenant.projectId] as const;
const sandbox = {
  enabled: false,
  provider: "test-daytona",
  network: "none",
  capabilities: ["filesystem_read"],
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

/** Publishes a Skill version as the API would and makes it the latest. */
async function publishSkillVersion(
  pool: PgPool,
  skillId: string,
  version: number,
): Promise<string> {
  const versionId = uuid(`follow-latest-e2e-skill-v${version}`);
  const instructions = `Validate drafts the version ${version} way.`;
  const canonical = {
    schemaVersion: 1,
    name: "import-contract",
    description: "Validate bulk-import drafts.",
    instructions,
    metadata: {},
    files: [],
  };
  await pool.query(
    `INSERT INTO oao.skill_versions (
       organization_id,project_id,id,skill_id,version,skill_name,description,
       instructions,metadata,content_hash,total_bytes,created_by_principal_id
     ) VALUES ($1,$2,$3,$4,$5,'import-contract',$6,$7,'{}'::jsonb,$8,$9,$10)`,
    [
      ...scope,
      versionId,
      skillId,
      version,
      canonical.description,
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
    [...scope, versionId, human],
  );
  await pool.query(
    "UPDATE oao.skills SET latest_version_id=$4 WHERE organization_id=$1 AND project_id=$2 AND id=$3",
    [...scope, skillId, versionId],
  );
  return versionId;
}

/** Publishes an agent version as the API would and makes it the latest. */
async function publishAgentVersion(
  pool: PgPool,
  agentId: string,
  version: number,
  config: Readonly<Record<string, unknown>>,
): Promise<string> {
  const versionId = uuid(`follow-latest-e2e-${agentId}-v${version}`);
  await pool.query(
    `INSERT INTO oao.agent_versions (
       organization_id,project_id,id,agent_definition_id,version,config,content_hash,
       created_by_principal_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ...scope,
      versionId,
      agentId,
      version,
      config,
      createHash("sha256").update(JSON.stringify(config)).digest(),
      human,
    ],
  );
  await pool.query(
    "UPDATE oao.agent_definitions SET latest_version_id=$4 WHERE organization_id=$1 AND project_id=$2 AND id=$3",
    [...scope, agentId, versionId],
  );
  return versionId;
}

function agentConfig(
  prompt: string,
  links: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    systemPrompt: prompt,
    modelPreset: "local-default",
    tools: [],
    ...links,
    sandbox,
    limits: { maxTurns: 8, timeoutMs: 20_000 },
  };
}

async function waitForSettled(pool: PgPool, runId: string): Promise<string> {
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

async function waitForDelegation(
  pool: PgPool,
  parentSessionId: string,
): Promise<{
  child_agent_version_id: string;
  child_session_id: string;
  child_run_id: string;
}> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await pool.query<{
      child_agent_version_id: string;
      child_session_id: string;
      child_run_id: string;
    }>(
      `SELECT delegation.child_agent_version_id,delegation.child_session_id,
              link.child_run_id
         FROM oao.agent_delegations delegation
         JOIN oao.delegation_runs link
           ON link.organization_id=delegation.organization_id
          AND link.project_id=delegation.project_id
          AND link.delegation_id=delegation.id
        WHERE delegation.parent_session_id=$1`,
      [parentSessionId],
    );
    if (result.rows.length > 1)
      throw new Error("Expected exactly one delegation");
    const row = result.rows[0];
    if (row) return row;
    if (Date.now() >= deadline) throw new Error("No delegation was created");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test(
  "a delegation runs the child version its session resolved at start",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 60_000 },
  async () => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const pool = createPool(testAdminDatabaseUrl);
    const respond: FauxResponseStep = (context) => {
      const transcript = JSON.stringify(context.messages);
      if (transcript.includes("follow-parent exact"))
        return context.messages.some((message) => message.role === "toolResult")
          ? fauxAssistantMessage("parent:done")
          : fauxAssistantMessage(
              [
                fauxToolCall("delegate_agent", {
                  agent: "validator",
                  prompt: "follow-child exact",
                }),
              ],
              { stopReason: "toolUse" },
            );
      if (transcript.includes("follow-child exact"))
        return fauxAssistantMessage("child:done");
      throw new Error(`Unexpected fake-model context: ${transcript}`);
    };
    let worker: RuntimeWorkerHandle | undefined;
    try {
      worker = await startRuntimeWorker({
        databaseUrl,
        listen: false,
        env: { ...process.env, OAO_RUNTIME_SERVICE_PRINCIPAL_ID: service },
        fakeResponses: Array.from({ length: 6 }, () => respond),
        backgroundWakes: false,
      });
      await pool.query(
        "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'follow-latest-e2e','Follow latest e2e')",
        [tenant.organizationId],
      );
      await pool.query(
        "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'follow-latest-e2e','Follow latest e2e')",
        [...scope],
      );
      await pool.query(
        `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
         VALUES ($1,$2,$3,'human','follow-latest-e2e-human',ARRAY['*']),
                ($1,$2,$4,'service','follow-latest-e2e-service',ARRAY['*'])`,
        [...scope, human, service],
      );
      const skillId = uuid("follow-latest-e2e-skill");
      await pool.query(
        `INSERT INTO oao.skills (
           organization_id,project_id,id,skill_key,display_name,created_by_principal_id
         ) VALUES ($1,$2,$3,'import-contract','Import contract',$4)`,
        [...scope, skillId, human],
      );
      const skillV1 = await publishSkillVersion(pool, skillId, 1);
      const validatorId = uuid("follow-latest-e2e-validator");
      const coordinatorId = uuid("follow-latest-e2e-coordinator");
      for (const [id, key] of [
        [validatorId, "validator"],
        [coordinatorId, "coordinator"],
      ] as const)
        await pool.query(
          `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
           VALUES ($1,$2,$3,$4,$4)`,
          [...scope, id, key],
        );
      const validatorV1 = await publishAgentVersion(pool, validatorId, 1, {
        ...agentConfig("Validate version 1.", { skillIds: [skillId] }),
      });
      const coordinatorV1 = await publishAgentVersion(pool, coordinatorId, 1, {
        ...agentConfig("Coordinate.", {
          delegates: [
            {
              key: "validator",
              description: "Validate the drafts.",
              agentId: validatorId,
            },
          ],
        }),
      });

      // The session starts and records what the API resolved.
      const threadId = uuid("follow-latest-e2e-thread") as ThreadId;
      const sessionId = uuid("follow-latest-e2e-session");
      const runId = uuid("follow-latest-e2e-run") as RunId;
      await pool.query(
        "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'Follow latest')",
        [...scope, threadId],
      );
      await pool.query(
        `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [...scope, sessionId, threadId, coordinatorV1],
      );
      const resolution = {
        schemaVersion: 1,
        rootSessionId: sessionId,
        rootAgentVersionId: coordinatorV1,
        resolvedAt: new Date().toISOString(),
        agentVersions: [
          {
            agentId: coordinatorId,
            agentVersionId: coordinatorV1,
            version: 1,
            skills: [],
            delegates: [
              {
                key: "validator",
                agentId: validatorId,
                agentVersionId: validatorV1,
                version: 1,
                followsLatest: true,
              },
            ],
          },
          {
            agentId: validatorId,
            agentVersionId: validatorV1,
            version: 1,
            skills: [
              {
                skillId,
                skillVersionId: skillV1,
                version: 1,
                name: "import-contract",
                followsLatest: true,
              },
            ],
            delegates: [],
          },
        ],
      };
      await pool.query(
        `INSERT INTO oao.session_version_resolutions
           (organization_id,project_id,session_id,resolution)
         VALUES ($1,$2,$3,$4)`,
        [...scope, sessionId, resolution],
      );
      await pool.query(
        `INSERT INTO oao.runs (
           organization_id,project_id,id,thread_id,session_id,agent_version_id,
           created_by_principal_id,idempotency_key,input_public
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'follow-latest-e2e',$8)`,
        [
          ...scope,
          runId,
          threadId,
          sessionId,
          coordinatorV1,
          human,
          { message: "follow-parent exact" },
        ],
      );

      // The Skill and the validator publish new versions mid-session.
      const skillV2 = await publishSkillVersion(pool, skillId, 2);
      const validatorV2 = await publishAgentVersion(pool, validatorId, 2, {
        ...agentConfig("Validate version 2.", { skillIds: [skillId] }),
      });
      assert.notEqual(validatorV2, validatorV1);
      assert.notEqual(skillV2, skillV1);

      await worker.orchestrator.handleWake({
        ...tenant,
        id: uuid(`follow-latest-e2e-wake:${runId}`),
        runId,
        dispatchKey: `admit:${runId}`,
        kind: "admit",
        payload: { reason: "integration_test" },
        attempts: 1,
        fence: 1n,
      });
      // delegate_agent waits for the child's answer, and this worker only
      // handles the wakes the test hands it.
      const child = await waitForDelegation(pool, sessionId);
      // The child runs the version resolved at session start, not the one
      // published since, with the Skill version resolved then.
      assert.equal(child.child_agent_version_id, validatorV1);
      const childSession = await pool.query<{ agent_version_id: string }>(
        "SELECT agent_version_id FROM oao.sessions WHERE id=$1",
        [child.child_session_id],
      );
      assert.equal(childSession.rows[0]?.agent_version_id, validatorV1);
      const childSkills = await pool.query<{ skill_version_id: string }>(
        "SELECT skill_version_id FROM oao.session_skill_bindings WHERE session_id=$1",
        [child.child_session_id],
      );
      assert.deepEqual(
        childSkills.rows.map((row) => row.skill_version_id),
        [skillV1],
      );
      const childResolution = await pool.query<{ resolution: unknown }>(
        "SELECT resolution FROM oao.session_version_resolutions WHERE session_id=$1",
        [child.child_session_id],
      );
      assert.deepEqual(childResolution.rows[0]?.resolution, resolution);
      const created = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT public_payload AS payload FROM oao.product_events
          WHERE organization_id=$1 AND project_id=$2 AND event_kind='delegation.created'
            AND public_payload->>'childSessionId'=$3`,
        [...scope, child.child_session_id],
      );
      assert.equal(created.rows[0]?.payload.childAgentVersionId, validatorV1);

      // The child's run builds its snapshot from the copied resolution.
      await worker.orchestrator.handleWake({
        ...tenant,
        id: uuid(`follow-latest-e2e-wake:${child.child_run_id}`),
        runId: child.child_run_id as RunId,
        dispatchKey: `admit:${child.child_run_id}`,
        kind: "admit",
        payload: { reason: "integration_test" },
        attempts: 1,
        fence: 1n,
      });
      assert.equal(await waitForSettled(pool, child.child_run_id), "completed");
      const childRun = await pool.query<{ agent_version_id: string }>(
        "SELECT agent_version_id FROM oao.runs WHERE id=$1",
        [child.child_run_id],
      );
      assert.equal(childRun.rows[0]?.agent_version_id, validatorV1);
      assert.equal(await waitForSettled(pool, runId), "completed");
    } finally {
      await worker?.stop();
      await pool.end();
    }
  },
);
