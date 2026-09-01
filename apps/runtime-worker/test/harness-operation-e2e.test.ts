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
import { runtimeTesting } from "@oao/runtime-flue";
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
  organizationId: uuid("harness-operation-e2e-org") as OrganizationId,
  projectId: uuid("harness-operation-e2e-project") as ProjectId,
};
const human = uuid("harness-operation-e2e-human") as PrincipalId;
const service = uuid("harness-operation-e2e-service") as PrincipalId;
const parallelTenant = {
  organizationId: uuid("harness-parallel-e2e-org") as OrganizationId,
  projectId: uuid("harness-parallel-e2e-project") as ProjectId,
};
const parallelHuman = uuid("harness-parallel-e2e-human") as PrincipalId;
const parallelService = uuid("harness-parallel-e2e-service") as PrincipalId;

const resultSchema = {
  type: "object" as const,
  properties: {
    shipmentReference: { type: "string" as const },
    skillActivated: { type: "boolean" as const },
    internalModelTurns: { type: "integer" as const },
  },
  required: ["internalModelTurns", "shipmentReference", "skillActivated"],
  additionalProperties: false as const,
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

async function seedTenant(
  pool: PgPool,
  input: {
    readonly tenant: typeof tenant;
    readonly human: PrincipalId;
    readonly service: PrincipalId;
    readonly slug: string;
  } = { tenant, human, service, slug: "harness-e2e" },
): Promise<void> {
  await pool.query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,$2,'Harness E2E')",
    [input.tenant.organizationId, input.slug],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,$3,'Harness E2E')",
    [input.tenant.organizationId, input.tenant.projectId, input.slug],
  );
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'human','harness-e2e-human',ARRAY['*']),
            ($1,$2,$4,'service','harness-e2e-service',ARRAY['*'])`,
    [
      input.tenant.organizationId,
      input.tenant.projectId,
      input.human,
      input.service,
    ],
  );
}

async function seedSkill(
  pool: PgPool,
  input: {
    readonly tenant: typeof tenant;
    readonly human: PrincipalId;
    readonly prefix: string;
  } = { tenant, human, prefix: "harness-operation-e2e" },
): Promise<string> {
  const skillId = uuid(`${input.prefix}-skill`);
  const versionId = uuid(`${input.prefix}-skill-version`);
  const instructions =
    "SKILL-ACTIVATED-TOKEN: read shipment.txt in the shared sandbox, then use another sandbox tool to verify the extraction before finishing.";
  const canonical = {
    schemaVersion: 1,
    name: "shipment-extraction",
    description: "Extract a shipment reference from a materialized document.",
    instructions,
    metadata: {},
    files: [],
  };
  await pool.query(
    `INSERT INTO oao.skills (
       organization_id,project_id,id,skill_key,display_name,created_by_principal_id
     ) VALUES ($1,$2,$3,'shipment-extraction','Shipment extraction',$4)`,
    [input.tenant.organizationId, input.tenant.projectId, skillId, input.human],
  );
  await pool.query(
    `INSERT INTO oao.skill_versions (
       organization_id,project_id,id,skill_id,version,skill_name,description,
       instructions,metadata,content_hash,total_bytes,created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,'shipment-extraction',$5,$6,'{}'::jsonb,$7,$8,$9)`,
    [
      input.tenant.organizationId,
      input.tenant.projectId,
      versionId,
      skillId,
      canonical.description,
      instructions,
      createHash("sha256").update(stableJson(canonical)).digest(),
      Buffer.byteLength(instructions),
      input.human,
    ],
  );
  await pool.query(
    `INSERT INTO oao.skill_version_lifecycle (
       organization_id,project_id,skill_version_id,status,updated_by_principal_id
     ) VALUES ($1,$2,$3,'active',$4)`,
    [
      input.tenant.organizationId,
      input.tenant.projectId,
      versionId,
      input.human,
    ],
  );
  await pool.query(
    `UPDATE oao.skills SET latest_version_id=$4
      WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
    [input.tenant.organizationId, input.tenant.projectId, skillId, versionId],
  );
  return versionId;
}

interface HarnessFixture {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly versionId: string;
}

interface HarnessSeedOptions {
  readonly tenant?: typeof tenant;
  readonly human?: PrincipalId;
  readonly prefix?: string;
  readonly operations?: readonly {
    readonly key: string;
    readonly description: string;
    readonly instructions: string;
    readonly resultSchema: typeof resultSchema;
    readonly timeoutMs: number;
  }[];
  readonly message?: string;
}

async function seedHarnessRun(
  pool: PgPool,
  skillVersionId: string,
  options: HarnessSeedOptions = {},
): Promise<HarnessFixture> {
  const targetTenant = options.tenant ?? tenant;
  const targetHuman = options.human ?? human;
  const prefix = options.prefix ?? "harness-operation-e2e";
  const message =
    options.message ?? "Run the multi-turn shipment Harness Operation test.";
  const agentId = uuid(`${prefix}-agent`);
  const versionId = uuid(`${prefix}-version`);
  const threadId = uuid(`${prefix}-thread`) as ThreadId;
  const sessionId = uuid(`${prefix}-session`);
  const runId = uuid(`${prefix}-run`) as RunId;
  const operation = {
    key: "extract_shipment",
    description:
      "Extract and verify a materialized shipment document as structured data.",
    instructions:
      "Activate the shipment-extraction Skill, read the already-materialized shipment.txt file from the shared sandbox, verify it with another sandbox tool turn, and return the structured extraction.",
    resultSchema,
    timeoutMs: 10_000,
  };
  const config = {
    systemPrompt: "Execute the focused Harness Operation test run.",
    modelPreset: "local-default",
    tools: [],
    harnessOperations: options.operations ?? [operation],
    skillVersionIds: [skillVersionId],
    sandbox: {
      enabled: true,
      provider: "test-daytona",
      snapshotId: uuid("harness-operation-e2e-snapshot"),
      network: "none",
      capabilities: ["filesystem_read", "filesystem_write", "shell"],
    },
    limits: { maxTurns: 32, timeoutMs: 20_000 },
  };
  await pool.query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,'harness-operation-e2e','Harness Operation E2E')`,
    [targetTenant.organizationId, targetTenant.projectId, agentId],
  );
  await pool.query(
    `INSERT INTO oao.agent_versions (
       organization_id,project_id,id,agent_definition_id,version,config,content_hash,
       created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
    [
      targetTenant.organizationId,
      targetTenant.projectId,
      versionId,
      agentId,
      config,
      createHash("sha256").update(stableJson(config)).digest(),
      targetHuman,
    ],
  );
  await pool.query(
    `INSERT INTO oao.agent_version_skill_bindings (
       organization_id,project_id,agent_version_id,skill_version_id,skill_name
     ) VALUES ($1,$2,$3,$4,'shipment-extraction')`,
    [
      targetTenant.organizationId,
      targetTenant.projectId,
      versionId,
      skillVersionId,
    ],
  );
  await pool.query(
    "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'Harness Operation E2E')",
    [targetTenant.organizationId, targetTenant.projectId, threadId],
  );
  await pool.query(
    `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      targetTenant.organizationId,
      targetTenant.projectId,
      sessionId,
      threadId,
      versionId,
    ],
  );
  await pool.query(
    `INSERT INTO oao.session_skill_bindings (
       organization_id,project_id,session_id,agent_version_id,
       skill_version_id,skill_name
     ) VALUES ($1,$2,$3,$4,$5,'shipment-extraction')`,
    [
      targetTenant.organizationId,
      targetTenant.projectId,
      sessionId,
      versionId,
      skillVersionId,
    ],
  );
  await pool.query(
    `INSERT INTO oao.runs (
       organization_id,project_id,id,thread_id,session_id,agent_version_id,
       created_by_principal_id,idempotency_key,input_public
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'harness-operation-e2e',$8)`,
    [
      targetTenant.organizationId,
      targetTenant.projectId,
      runId,
      threadId,
      sessionId,
      versionId,
      targetHuman,
      { message },
    ],
  );
  await pool.query(
    `INSERT INTO oao.messages (
       organization_id,project_id,id,thread_id,run_id,role,redacted_content
     ) VALUES ($1,$2,$3,$4,$5,'user',$6)`,
    [
      targetTenant.organizationId,
      targetTenant.projectId,
      uuid(`${prefix}-user-message`),
      threadId,
      runId,
      message,
    ],
  );
  return { runId, threadId, versionId };
}

async function waitForCompleted(
  pool: PgPool,
  runId: RunId,
  targetTenant = tenant,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND id=$3",
      [targetTenant.organizationId, targetTenant.projectId, runId],
    );
    const state = result.rows[0]?.state;
    if (state === "completed") return;
    if (state === "failed" || state === "cancelled" || state === "timed_out")
      throw new Error(`Harness Operation test run ended in ${state}`);
    if (Date.now() >= deadline)
      throw new Error(`Harness Operation test run stayed in ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test(
  "a Harness Operation performs multiple internal model and tool turns in the shared sandbox",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 60_000 },
  async () => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const pool = createPool(testAdminDatabaseUrl);
    const sandbox = new FakeSandboxProvider();
    let worker: RuntimeWorkerHandle | undefined;
    const observedTools: string[] = [];
    const stopObserving = runtimeTesting.observe((event) => {
      if (event.type === "tool_start" || event.type === "tool")
        observedTools.push(
          `${event.type}:${event.toolName}:${event.origin ?? "unknown"}:${event.harness ?? "unknown"}`,
        );
    });
    let parentModelTurns = 0;
    let harnessModelTurns = 0;
    const fakeResponse: FauxResponseStep = (context) => {
      const transcript = JSON.stringify(context.messages);
      const insideHarness = transcript.includes(
        "Execute the Harness Operation",
      );
      if (insideHarness) {
        harnessModelTurns += 1;
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
              internalModelTurns: 4,
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      parentModelTurns += 1;
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
              task: "Activate the shipment-extraction Skill, read shipment.txt, verify it with a second sandbox tool, and return the structured result.",
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("harness-operation-e2e:completed");
    };

    try {
      worker = await startRuntimeWorker({
        databaseUrl,
        listen: false,
        env: {
          ...process.env,
          OAO_RUNTIME_SERVICE_PRINCIPAL_ID: service,
        },
        daytonaProvider: sandbox,
        fakeResponses: Array.from({ length: 16 }, () => fakeResponse),
        backgroundWakes: false,
      });
      await seedTenant(pool);
      const skillVersionId = await seedSkill(pool);
      const fixture = await seedHarnessRun(pool, skillVersionId);
      const storedOperation = await pool.query<{
        configured: unknown;
        normalized: unknown;
      }>(
        `SELECT version.config->'harnessOperations' AS configured,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'key',operation.operation_key,
                  'description',operation.description,
                  'instructions',operation.instructions,
                  'resultSchema',operation.result_schema,
                  'timeoutMs',operation.timeout_ms
                ) ORDER BY operation.operation_key),'[]'::jsonb) AS normalized
           FROM oao.agent_versions version
           LEFT JOIN oao.agent_version_harness_operations operation
             ON operation.organization_id=version.organization_id
            AND operation.project_id=version.project_id
            AND operation.agent_version_id=version.id
          WHERE version.organization_id=$1 AND version.project_id=$2
            AND version.id=$3
          GROUP BY version.config`,
        [tenant.organizationId, tenant.projectId, fixture.versionId],
      );
      assert.deepEqual(
        storedOperation.rows[0]?.normalized,
        storedOperation.rows[0]?.configured,
      );
      await worker.orchestrator.handleWake({
        ...tenant,
        id: uuid("harness-operation-e2e-wake"),
        runId: fixture.runId,
        dispatchKey: `admit:${fixture.runId}`,
        kind: "admit",
        payload: { reason: "integration_test" },
        attempts: 1,
        fence: 1n,
      });
      await waitForCompleted(pool, fixture.runId);
      await worker.stop();
      worker = undefined;

      const evidence = await pool.query<{
        assistant_reply: string;
        skill_activations: string;
        harness_started: string;
        harness_completed: string;
        result_validated: string;
        sandbox_tools: string;
      }>(
        `SELECT
           (SELECT redacted_content FROM oao.messages
             WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
               AND role='assistant' ORDER BY created_at DESC LIMIT 1) AS assistant_reply,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='skill.activated') AS skill_activations,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_started') AS harness_started,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_completed') AS harness_completed,
           (SELECT public_payload->>'resultValidated' FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_completed' LIMIT 1) AS result_validated,
           (SELECT COUNT(*) FROM oao.sandbox_commands
             WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
               AND safe_command->>'toolName' IN ('write','read','bash')) AS sandbox_tools`,
        [tenant.organizationId, tenant.projectId, fixture.runId],
      );
      assert.equal(parentModelTurns, 3);
      assert.equal(harnessModelTurns, 4);
      assert.deepEqual(observedTools, [
        "tool_start:write:adapter:default",
        "tool:write:adapter:default",
        "tool_start:extract_shipment:model:default",
        "tool_start:activate_skill:framework:default",
        "tool:activate_skill:framework:default",
        "tool_start:read:adapter:default",
        "tool:read:adapter:default",
        "tool_start:bash:adapter:default",
        "tool:bash:adapter:default",
        "tool_start:finish:framework:default",
        "tool:finish:framework:default",
        "tool:extract_shipment:model:default",
      ]);
      assert.deepEqual(evidence.rows[0], {
        assistant_reply: "harness-operation-e2e:completed",
        skill_activations: "1",
        harness_started: "1",
        harness_completed: "1",
        result_validated: "true",
        sandbox_tools: "3",
      });
    } finally {
      stopObserving();
      await worker?.stop();
      await pool.end();
    }
  },
);

test(
  "a model tool batch runs two multi-turn Harness Operations concurrently",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 60_000 },
  async () => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const pool = createPool(testAdminDatabaseUrl);
    const sandbox = new FakeSandboxProvider();
    let worker: RuntimeWorkerHandle | undefined;
    const harnessToolLifecycle: string[] = [];
    const stopObserving = runtimeTesting.observe((event) => {
      if (
        (event.type === "tool_start" || event.type === "tool") &&
        ["extract_shipment", "verify_shipment"].includes(event.toolName)
      )
        harnessToolLifecycle.push(`${event.type}:${event.toolName}`);
    });
    let parentModelTurns = 0;
    let harnessModelTurns = 0;
    let maximumConcurrentHarnesses = 0;
    const enteredHarnesses = new Set<string>();
    const activeHarnesses = new Set<string>();
    let releaseBothHarnesses!: () => void;
    const bothHarnessesEntered = new Promise<void>((resolve) => {
      releaseBothHarnesses = resolve;
    });
    const waitForBothHarnesses = async () => {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          bothHarnessesEntered,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Harness batch did not overlap")),
              3_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const fakeResponse: FauxResponseStep = async (context) => {
      const transcript = JSON.stringify(context.messages);
      const insideHarness = transcript.includes(
        "Execute the Harness Operation",
      );
      if (insideHarness) {
        harnessModelTurns += 1;
        const operationKey = transcript.includes("verify_shipment")
          ? "verify_shipment"
          : "extract_shipment";
        if (!transcript.includes("SKILL-ACTIVATED-TOKEN")) {
          enteredHarnesses.add(operationKey);
          activeHarnesses.add(operationKey);
          maximumConcurrentHarnesses = Math.max(
            maximumConcurrentHarnesses,
            activeHarnesses.size,
          );
          if (enteredHarnesses.size === 2) releaseBothHarnesses();
          await waitForBothHarnesses();
          return fauxAssistantMessage(
            [fauxToolCall("activate_skill", { name: "shipment-extraction" })],
            { stopReason: "toolUse" },
          );
        }
        if (!transcript.includes("shipment_reference=SHP-4815"))
          return fauxAssistantMessage(
            [fauxToolCall("read", { path: "shipment.txt" })],
            { stopReason: "toolUse" },
          );
        activeHarnesses.delete(operationKey);
        return fauxAssistantMessage(
          [
            fauxToolCall("finish", {
              shipmentReference: "SHP-4815",
              skillActivated: true,
              internalModelTurns: 3,
            }),
          ],
          { stopReason: "toolUse" },
        );
      }

      parentModelTurns += 1;
      if (parentModelTurns === 1)
        return fauxAssistantMessage(
          [
            fauxToolCall("write", {
              path: "shipment.txt",
              content: "shipment_reference=SHP-4815",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (parentModelTurns === 2)
        return fauxAssistantMessage(
          [
            fauxToolCall(
              "extract_shipment",
              {
                task: "Extract the shipment reference from the shared fixture.",
              },
              { id: "parallel-extract-call" },
            ),
            fauxToolCall(
              "verify_shipment",
              {
                task: "Independently verify the shared shipment fixture.",
              },
              { id: "parallel-verify-call" },
            ),
          ],
          { stopReason: "toolUse" },
        );
      const harnessResults = context.messages.filter(
        (message) =>
          message.role === "toolResult" &&
          ["extract_shipment", "verify_shipment"].includes(message.toolName),
      );
      assert.equal(harnessResults.length, 2);
      for (const result of harnessResults) {
        if (result.role !== "toolResult")
          throw new Error("Expected a Harness tool result");
        assert.match(JSON.stringify(result), /"shipmentReference":"SHP-4815"/u);
        assert.equal(result.isError, false);
      }
      return fauxAssistantMessage("parallel-harness-e2e:completed");
    };
    const parallelOperations = [
      {
        key: "extract_shipment",
        description: "Extract the shipment fixture.",
        instructions:
          "Activate shipment-extraction, then read shipment.txt from the shared sandbox and extract its reference.",
        resultSchema,
        timeoutMs: 10_000,
      },
      {
        key: "verify_shipment",
        description: "Verify the shipment fixture independently.",
        instructions:
          "Activate shipment-extraction, then read shipment.txt from the shared sandbox and verify its reference.",
        resultSchema,
        timeoutMs: 10_000,
      },
    ] as const;

    try {
      worker = await startRuntimeWorker({
        databaseUrl,
        listen: false,
        env: {
          ...process.env,
          OAO_RUNTIME_SERVICE_PRINCIPAL_ID: parallelService,
        },
        daytonaProvider: sandbox,
        fakeResponses: Array.from({ length: 24 }, () => fakeResponse),
        backgroundWakes: false,
      });
      await seedTenant(pool, {
        tenant: parallelTenant,
        human: parallelHuman,
        service: parallelService,
        slug: "harness-parallel-e2e",
      });
      const skillVersionId = await seedSkill(pool, {
        tenant: parallelTenant,
        human: parallelHuman,
        prefix: "harness-parallel-e2e",
      });
      const fixture = await seedHarnessRun(pool, skillVersionId, {
        tenant: parallelTenant,
        human: parallelHuman,
        prefix: "harness-parallel-e2e",
        operations: parallelOperations,
        message:
          "Run both multi-turn shipment Harness Operations in one tool batch.",
      });
      await worker.orchestrator.handleWake({
        ...parallelTenant,
        id: uuid("harness-parallel-e2e-wake"),
        runId: fixture.runId,
        dispatchKey: `admit:${fixture.runId}`,
        kind: "admit",
        payload: { reason: "integration_test" },
        attempts: 1,
        fence: 1n,
      });
      await waitForCompleted(pool, fixture.runId, parallelTenant);
      await worker.stop();
      worker = undefined;

      const evidence = await pool.query<{
        assistant_reply: string;
        skill_activations: string;
        harness_started: string;
        harness_completed: string;
        validated_results: string;
        distinct_tool_calls: string;
        harness_steps: string;
        harness_model_steps: string;
        harness_tool_steps: string;
        correlated_step_calls: string;
        distinct_step_ids: string;
        step_operations: string;
        sensitive_step_payloads: string;
        shared_reads: string;
        lifecycle_overlapped: boolean;
      }>(
        `WITH lifecycle AS (
           SELECT event_kind, occurred_at
             FROM oao.product_events
            WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
              AND event_kind IN ('harness.operation_started','harness.operation_completed')
         )
         SELECT
           (SELECT redacted_content FROM oao.messages
             WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
               AND role='assistant' ORDER BY created_at DESC LIMIT 1) AS assistant_reply,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='skill.activated') AS skill_activations,
           (SELECT COUNT(*) FROM lifecycle
             WHERE event_kind='harness.operation_started') AS harness_started,
           (SELECT COUNT(*) FROM lifecycle
             WHERE event_kind='harness.operation_completed') AS harness_completed,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_completed'
               AND public_payload->>'resultValidated'='true') AS validated_results,
           (SELECT COUNT(DISTINCT public_payload->>'toolCallId')
              FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_started') AS distinct_tool_calls,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_step') AS harness_steps,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_step'
               AND public_payload->>'stepKind'='model') AS harness_model_steps,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_step'
               AND public_payload->>'stepKind'='tool') AS harness_tool_steps,
           (SELECT COUNT(DISTINCT public_payload->>'harnessToolCallId')
              FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_step') AS correlated_step_calls,
           (SELECT COUNT(DISTINCT public_payload->>'stepId')
              FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_step') AS distinct_step_ids,
           (SELECT COUNT(DISTINCT public_payload->>'operationKey')
              FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_step') AS step_operations,
           (SELECT COUNT(*) FROM oao.product_events
             WHERE organization_id=$1 AND project_id=$2 AND aggregate_id=$3
               AND event_kind='harness.operation_step'
               AND (public_payload ? 'arguments' OR public_payload ? 'result')) AS sensitive_step_payloads,
           (SELECT COUNT(*) FROM oao.sandbox_commands
             WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
               AND safe_command->>'toolName'='read') AS shared_reads,
           (SELECT MAX(occurred_at) FILTER (WHERE event_kind='harness.operation_started')
                 < MIN(occurred_at) FILTER (WHERE event_kind='harness.operation_completed')
              FROM lifecycle) AS lifecycle_overlapped`,
        [
          parallelTenant.organizationId,
          parallelTenant.projectId,
          fixture.runId,
        ],
      );
      assert.equal(parentModelTurns, 3);
      assert.equal(harnessModelTurns, 6);
      assert.equal(maximumConcurrentHarnesses, 2);
      assert.deepEqual(harnessToolLifecycle.slice(0, 2).sort(), [
        "tool_start:extract_shipment",
        "tool_start:verify_shipment",
      ]);
      assert.deepEqual(evidence.rows[0], {
        assistant_reply: "parallel-harness-e2e:completed",
        skill_activations: "2",
        harness_started: "2",
        harness_completed: "2",
        validated_results: "2",
        distinct_tool_calls: "2",
        harness_steps: "12",
        harness_model_steps: "6",
        harness_tool_steps: "6",
        correlated_step_calls: "2",
        distinct_step_ids: "12",
        step_operations: "2",
        sensitive_step_payloads: "0",
        shared_reads: "2",
        lifecycle_overlapped: true,
      });
    } finally {
      stopObserving();
      await worker?.stop();
      await pool.end();
    }
  },
);
