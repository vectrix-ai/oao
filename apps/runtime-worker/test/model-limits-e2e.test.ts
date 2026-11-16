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
  DEFAULT_LOCAL_PRESETS,
  ImmutableModelPresetRegistry,
  ProjectModelPresetRegistry,
  fauxAssistantMessage,
  type FauxResponseStep,
  type ModelPresetLimitsInput,
} from "@oao/models-openrouter";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import { createProjectModelPresetActivator } from "@oao/runtime-flue";
import { startRuntimeWorker, type RuntimeWorkerHandle } from "../src/main.js";

const databaseUrl = process.env.DATABASE_URL;
const testAdminDatabaseUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? databaseUrl;

// Ids live in this file's own namespace: the suites share one database.
function uuid(label: string): string {
  const bytes = createHash("sha256")
    .update(`model-limits-e2e/${label}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const tenant = {
  organizationId: uuid("org") as OrganizationId,
  projectId: uuid("project") as ProjectId,
};
const human = uuid("human") as PrincipalId;
const service = uuid("service") as PrincipalId;

/** The context window and output limit of each model call, as Flue gave it. */
const seen: { contextWindow: number; maxTokens: number }[] = [];

// The fake model counts about four characters of the conversation as a token,
// so the size of each run's message decides when a conversation is full.
const respond: FauxResponseStep = (_context, _options, _state, model) => {
  seen.push({ contextWindow: model.contextWindow, maxTokens: model.maxTokens });
  return fauxAssistantMessage("ok");
};

async function seedBase(pool: PgPool): Promise<string> {
  await pool.query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'model-limits-e2e','Model limits e2e')",
    [tenant.organizationId],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'model-limits-e2e','Model limits e2e')",
    [tenant.organizationId, tenant.projectId],
  );
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'human','model-limits-e2e-human',ARRAY['*']),
            ($1,$2,$4,'service','model-limits-e2e-service',ARRAY['*'])`,
    [tenant.organizationId, tenant.projectId, human, service],
  );
  const agentId = uuid("agent");
  const versionId = uuid("version");
  const config = {
    systemPrompt: "Answer briefly.",
    modelPreset: "local-default",
    tools: [],
    sandbox: {
      enabled: false,
      provider: "daytona-primary",
      network: "none",
      capabilities: [],
    },
    limits: { maxTurns: 16, timeoutMs: 30_000 },
  };
  await pool.query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,'limits','limits')`,
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
      human,
    ],
  );
  return versionId;
}

async function seedSession(pool: PgPool, label: string, versionId: string) {
  const threadId = uuid(`${label}:thread`) as ThreadId;
  const sessionId = uuid(`${label}:session`);
  await pool.query(
    "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,$4)",
    [tenant.organizationId, tenant.projectId, threadId, label],
  );
  await pool.query(
    `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenant.organizationId, tenant.projectId, sessionId, threadId, versionId],
  );
  return { threadId, sessionId, versionId };
}

async function seedRun(
  pool: PgPool,
  session: Awaited<ReturnType<typeof seedSession>>,
  label: string,
  message: string,
): Promise<RunId> {
  const runId = uuid(`${label}:run`) as RunId;
  await pool.query(
    `INSERT INTO oao.runs (
       organization_id,project_id,id,thread_id,session_id,agent_version_id,
       created_by_principal_id,idempotency_key,input_public
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tenant.organizationId,
      tenant.projectId,
      runId,
      session.threadId,
      session.sessionId,
      session.versionId,
      human,
      `model-limits-e2e:${label}`,
      { message },
    ],
  );
  await pool.query(
    `INSERT INTO oao.messages (
       organization_id,project_id,id,thread_id,run_id,role,redacted_content
     ) VALUES ($1,$2,$3,$4,$5,'user',$6)`,
    [
      tenant.organizationId,
      tenant.projectId,
      uuid(`${label}:message`),
      session.threadId,
      runId,
      message,
    ],
  );
  return runId;
}

async function waitFor<T>(
  description: string,
  read: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Runs to settlement; returns its state and how many calls compacted. */
async function settle(
  worker: RuntimeWorkerHandle,
  pool: PgPool,
  runId: RunId,
): Promise<{ readonly state: string; readonly compactions: number }> {
  await worker.orchestrator.handleWake({
    ...tenant,
    id: uuid(`wake:${runId}`),
    runId,
    dispatchKey: `admit:${runId}`,
    kind: "admit",
    payload: { reason: "integration_test" },
    attempts: 1,
    fence: 1n,
  });
  const state = await waitFor(`run ${runId} to settle`, async () => {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM oao.runs WHERE id=$1",
      [runId],
    );
    const value = result.rows[0]?.state ?? "missing";
    return ["completed", "failed", "cancelled", "timed_out"].includes(value)
      ? value
      : undefined;
  });
  const calls = await pool.query<{ compactions: number }>(
    `SELECT count(*) FILTER (WHERE safe_request->>'purpose'='compaction')::int AS compactions
       FROM oao.model_invocations WHERE run_id=$1`,
    [runId],
  );
  return { state, compactions: calls.rows[0]?.compactions ?? 0 };
}

async function withWorker<T>(
  limits: ModelPresetLimitsInput | undefined,
  use: (worker: RuntimeWorkerHandle) => Promise<T>,
): Promise<T> {
  assert.ok(databaseUrl);
  const worker = await startRuntimeWorker({
    databaseUrl,
    listen: false,
    env: { ...process.env, OAO_RUNTIME_SERVICE_PRINCIPAL_ID: service },
    fakeResponses: Array.from({ length: 64 }, () => respond),
    ...(limits ? { fakeModelLimits: limits } : {}),
  });
  try {
    return await use(worker);
  } finally {
    await worker.stop();
  }
}

// About 25,000, 12,500 and 5,000 tokens: a conversation of the first two is
// about 37,500 tokens, and of all three about 42,500.
const FIRST = "a".repeat(99_000);
const SECOND = "b".repeat(50_000);
const THIRD = "c".repeat(20_000);

test(
  "a preset's context window decides when its conversation compacts",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 240_000 },
  async (t) => {
    assert.ok(testAdminDatabaseUrl);
    const pool = createPool(testAdminDatabaseUrl);
    try {
      const versionId = await seedBase(pool);

      await t.test(
        "without limits the model's own window applies, as before",
        async () => {
          // The test model holds 32,000 tokens and writes up to 4,096, so it
          // compacts past 32,000 - 4,096 = 27,904.
          await withWorker(undefined, async (worker) => {
            const session = await seedSession(pool, "default", versionId);
            const first = await seedRun(pool, session, "default-1", FIRST);
            assert.deepEqual(await settle(worker, pool, first), {
              state: "completed",
              compactions: 0,
            });
            const second = await seedRun(pool, session, "default-2", SECOND);
            assert.deepEqual(await settle(worker, pool, second), {
              state: "completed",
              compactions: 1,
            });
          });
          assert.deepEqual(seen.at(0), {
            contextWindow: 32_000,
            maxTokens: 4_096,
          });
        },
      );

      await t.test(
        "with limits it compacts only past the window minus min(20,000, output limit)",
        async () => {
          seen.length = 0;
          // 60,000 - min(20,000, 30,000) = 40,000 tokens.
          await withWorker(
            {
              id: uuid("limits"),
              contextWindow: 60_000,
              maxOutputTokens: 30_000,
            },
            async (worker) => {
              const session = await seedSession(pool, "limited", versionId);
              const first = await seedRun(pool, session, "limited-1", FIRST);
              assert.deepEqual(await settle(worker, pool, first), {
                state: "completed",
                compactions: 0,
              });
              // About 37,500 tokens: past the model's own threshold, not this one.
              const second = await seedRun(pool, session, "limited-2", SECOND);
              assert.deepEqual(await settle(worker, pool, second), {
                state: "completed",
                compactions: 0,
              });
              // About 42,500 tokens: past 40,000.
              const third = await seedRun(pool, session, "limited-3", THIRD);
              assert.deepEqual(await settle(worker, pool, third), {
                state: "completed",
                compactions: 1,
              });
            },
          );
          assert.ok(seen.length >= 3);
          for (const model of seen)
            assert.deepEqual(model, {
              contextWindow: 60_000,
              maxTokens: 30_000,
            });
        },
      );

      await t.test(
        "a change to a preset's limits reaches its next run without a new agent version",
        async () => {
          const cipher = new ProviderCredentialCipher(Buffer.alloc(32, 9));
          const providerId = uuid("provider");
          const presetId = uuid("preset");
          const encrypted = cipher.encrypt("sk-or-model-limits-e2e", {
            organizationId: tenant.organizationId,
            providerId,
            providerType: "openrouter",
            keyVersion: 1,
          });
          await pool.query(
            `INSERT INTO oao.project_model_providers (
               organization_id,id,provider_key,display_name,provider_type,
               encrypted_api_key,encryption_nonce,encryption_tag,
               encryption_key_version,credential_fingerprint,created_by_principal_id
             ) VALUES ($1,$2,'limits-openrouter','Limits OpenRouter','openrouter',
                       $3,$4,$5,$6,$7,$8)`,
            [
              tenant.organizationId,
              providerId,
              encrypted.ciphertext,
              encrypted.nonce,
              encrypted.tag,
              encrypted.keyVersion,
              encrypted.fingerprint,
              human,
            ],
          );
          await pool.query(
            `INSERT INTO oao.project_model_presets (
               organization_id,project_id,id,preset_key,display_name,model,
               routing,provider_id,created_by_principal_id
             ) VALUES ($1,$2,$3,'azure-sol-61-v1','Sol',
                       'openrouter/@preset/azure-sol-61','{}',$4,$5)`,
            [
              tenant.organizationId,
              tenant.projectId,
              presetId,
              providerId,
              human,
            ],
          );
          const setLimits = (
            id: string,
            contextWindow: number | null,
            maxOutputTokens: number | null,
          ) =>
            pool.query(
              `INSERT INTO oao.model_preset_limits (
                 organization_id,project_id,id,preset_id,context_window,
                 max_output_tokens,created_by_principal_id
               ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [
                tenant.organizationId,
                tenant.projectId,
                id,
                presetId,
                contextWindow,
                maxOutputTokens,
                human,
              ],
            );
          const models: {
            readonly id: string;
            getModels(): readonly {
              readonly contextWindow: number;
              readonly maxTokens: number;
            }[];
          }[] = [];
          const activator = createProjectModelPresetActivator({
            pool,
            credentialCipher: cipher,
            registry: new ProjectModelPresetRegistry({
              deployment: new ImmutableModelPresetRegistry(
                DEFAULT_LOCAL_PRESETS,
                { hostedEnabled: false },
              ),
              registerProvider: (provider) => models.push(provider),
            }),
            deploymentPresetKeys: new Set(["local-default"]),
          });
          const latestModel = () => {
            const model = models.at(-1)?.getModels()[0];
            assert.ok(model);
            return {
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
            };
          };

          // Without a limits row the placeholder applies, as before.
          await activator.activate(tenant, "azure-sol-61-v1");
          assert.deepEqual(latestModel(), {
            contextWindow: 128_000,
            maxTokens: 4_096,
          });

          await setLimits(uuid("limits-1"), 250_000, 128_000);
          const first = await activator.activate(tenant, "azure-sol-61-v1");
          assert.deepEqual(latestModel(), {
            contextWindow: 250_000,
            maxTokens: 128_000,
          });
          assert.equal(first?.limits?.presetLimitsId, uuid("limits-1"));

          // The next run of the same preset gets the newest row.
          await setLimits(uuid("limits-2"), 200_000, null);
          const second = await activator.activate(tenant, "azure-sol-61-v1");
          assert.deepEqual(latestModel(), {
            contextWindow: 200_000,
            maxTokens: 4_096,
          });
          assert.deepEqual(second?.limits, {
            contextWindow: 200_000,
            contextWindowSource: "preset",
            maxOutputTokens: 4_096,
            maxOutputTokensSource: "model",
            presetLimitsId: uuid("limits-2"),
          });
          assert.equal(models.length, 3);
          // Nothing about the agent changed.
          const versions = await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM oao.agent_versions WHERE organization_id=$1",
            [tenant.organizationId],
          );
          assert.equal(versions.rows[0]?.count, 1);
          // Rows are history: they cannot be changed or removed directly.
          await assert.rejects(
            pool.query(
              "UPDATE oao.model_preset_limits SET context_window=1024 WHERE id=$1",
              [uuid("limits-1")],
            ),
          );
          await assert.rejects(
            pool.query("DELETE FROM oao.model_preset_limits WHERE id=$1", [
              uuid("limits-1"),
            ]),
          );
        },
      );
    } finally {
      await pool.end();
    }
  },
);
