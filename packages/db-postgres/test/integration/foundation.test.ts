import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  EventId,
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
  ThreadId,
  ToolCallId,
} from "@oao/domain";
import {
  PostgresEventAppender,
  PostgresFoundationRepository,
  createPool,
  migrate,
  withTenantTransaction,
} from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

const ids = {
  organization: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  project: "00000000-0000-4000-8000-000000000002" as ProjectId,
  principal: "00000000-0000-4000-8000-000000000003" as PrincipalId,
  agent: "00000000-0000-4000-8000-000000000004",
  version: "00000000-0000-4000-8000-000000000005",
  thread: "00000000-0000-4000-8000-000000000006" as ThreadId,
  session: "00000000-0000-4000-8000-000000000007",
  otherProject: "00000000-0000-4000-8000-000000000102" as ProjectId,
  otherPrincipal: "00000000-0000-4000-8000-000000000103" as PrincipalId,
  otherAgent: "00000000-0000-4000-8000-000000000104",
  otherVersion: "00000000-0000-4000-8000-000000000105",
  otherThread: "00000000-0000-4000-8000-000000000106" as ThreadId,
  otherSession: "00000000-0000-4000-8000-000000000107",
} as const;

const tenant = { organizationId: ids.organization, projectId: ids.project };
const otherTenant = {
  organizationId: ids.organization,
  projectId: ids.otherProject,
};

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

async function seed(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query(
    "INSERT INTO oao.organizations (id, slug, name) VALUES ($1, 'test-org', 'Test organization')",
    [ids.organization],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id, id, slug, name) VALUES ($1,$2,'project-a','Project A'),($1,$3,'project-b','Project B')",
    [ids.organization, ids.project, ids.otherProject],
  );
  await pool.query(
    "INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes) VALUES ($1,$2,$3,'human','user-a',ARRAY['*']),($1,$4,$5,'human','user-b',ARRAY['*'])",
    [
      ids.organization,
      ids.project,
      ids.principal,
      ids.otherProject,
      ids.otherPrincipal,
    ],
  );
  await pool.query(
    "INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name) VALUES ($1,$2,$3,'agent-a','Agent A'),($1,$4,$5,'agent-b','Agent B')",
    [
      ids.organization,
      ids.project,
      ids.agent,
      ids.otherProject,
      ids.otherAgent,
    ],
  );
  await pool.query(
    `INSERT INTO oao.agent_versions
      (organization_id,project_id,id,agent_definition_id,version,config,content_hash,created_by_principal_id) VALUES
      ($1,$2,$3,$4,1,'{}',digest('agent-a','sha256'),$5),
      ($1,$6,$7,$8,1,'{}',digest('agent-b','sha256'),$9)`,
    [
      ids.organization,
      ids.project,
      ids.version,
      ids.agent,
      ids.principal,
      ids.otherProject,
      ids.otherVersion,
      ids.otherAgent,
      ids.otherPrincipal,
    ],
  );
  await pool.query(
    "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'Thread A'),($1,$4,$5,'Thread B')",
    [
      ids.organization,
      ids.project,
      ids.thread,
      ids.otherProject,
      ids.otherThread,
    ],
  );
  await pool.query(
    "INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id) VALUES ($1,$2,$3,$4,$5),($1,$6,$7,$8,$9)",
    [
      ids.organization,
      ids.project,
      ids.session,
      ids.thread,
      ids.version,
      ids.otherProject,
      ids.otherSession,
      ids.otherThread,
      ids.otherVersion,
    ],
  );
}

async function insertRun(
  pool: ReturnType<typeof createPool>,
  runId: RunId,
  key: string,
): Promise<void> {
  await withTenantTransaction(pool, tenant, async (transaction) => {
    await transaction.query(
      `INSERT INTO oao.runs (
        organization_id, project_id, id, thread_id, session_id, agent_version_id,
        created_by_principal_id, idempotency_key
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        ids.organization,
        ids.project,
        runId,
        ids.thread,
        ids.session,
        ids.version,
        ids.principal,
        key,
      ],
    );
  });
}

async function insertThreadRun(
  pool: ReturnType<typeof createPool>,
  threadId: ThreadId,
  sessionId: string,
  runId: RunId,
  key: string,
): Promise<void> {
  await withTenantTransaction(pool, tenant, async (transaction) => {
    await transaction.query(
      "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'Race thread')",
      [ids.organization, ids.project, threadId],
    );
    await transaction.query(
      "INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id) VALUES ($1,$2,$3,$4,$5)",
      [ids.organization, ids.project, sessionId, threadId, ids.version],
    );
    await transaction.query(
      `INSERT INTO oao.runs (
        organization_id,project_id,id,thread_id,session_id,agent_version_id,created_by_principal_id,idempotency_key
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        ids.organization,
        ids.project,
        runId,
        threadId,
        sessionId,
        ids.version,
        ids.principal,
        key,
      ],
    );
  });
}

test(
  "PostgreSQL foundation invariants",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    const repository = new PostgresFoundationRepository();
    const eventAppender = new PostgresEventAppender();
    try {
      await t.test("migration applies cleanly and is idempotent", async () => {
        const first = await migrate(pool);
        assert.equal(first.applied.length + first.alreadyApplied.length, 38);
        const second = await migrate(pool);
        assert.deepEqual(second.alreadyApplied, [
          "0001_foundation.sql",
          "0002_foundation_followup.sql",
          "0003_api_auth.sql",
          "0004_runtime.sql",
          "0005_mvp_integration.sql",
          "0006_model_presets.sql",
          "0007_project_model_providers.sql",
          "0008_openrouter_presets.sql",
          "0009_sandbox_providers.sql",
          "0010_real_providers_only.sql",
          "0011_rebind_real_provider_validation.sql",
          "0012_preserve_publication_guards.sql",
          "0013_sandbox_provider_target.sql",
          "0014_agent_sandbox_snapshot.sql",
          "0015_workspace_storage.sql",
          "0017_skills.sql",
          "0018_multi_agent_orchestration.sql",
          "0019_skill_package_drafts.sql",
          "0020_agent_sandbox_snapshot_required.sql",
          "0021_rich_tool_schemas.sql",
          "0022_mcp_toolsets_credentials.sql",
          "0023_mcp_runtime_hardening.sql",
          "0024_cached_token_usage.sql",
          "0025_harness_operations.sql",
          "0026_harness_operation_events.sql",
          "0027_harness_operation_steps.sql",
          "0028_model_generation_settings.sql",
          "0029_provider_neutral_model_generation_settings.sql",
          "0030_anthropic_model_provider.sql",
          "0031_xai_model_provider.sql",
          "0032_cloud_sql_recovery_role.sql",
          "0033_xai_model_generation_settings.sql",
          "0034_agent_archive.sql",
          "0035_model_archive.sql",
          "0036_skill_disable_archive.sql",
          "0037_organization_projects.sql",
          "0038_organization_sandbox_providers.sql",
          "0039_cloud_sql_auth_role.sql",
        ]);
        await seed(pool);
      });

      await t.test(
        "delegate versions are normalized and child threads share the root workspace",
        async () => {
          await withTenantTransaction(pool, tenant, async (transaction) => {
            const childAgentId = uuid(300);
            const childVersionId = uuid(301);
            const parentAgentId = uuid(302);
            const parentVersionId = uuid(303);
            const rootThreadId = uuid(304);
            const rootSessionId = uuid(305);
            const rootRunId = uuid(306);
            const childThreadId = uuid(307);
            const childSessionId = uuid(308);
            const childRunId = uuid(309);
            const baseConfig = {
              systemPrompt: "Perform the assigned shipment work carefully.",
              modelPreset: "local-default",
              tools: [],
              skillVersionIds: [],
              delegates: [],
              sandbox: {
                enabled: true,
                provider: "daytona-primary",
                snapshotId: uuid(310),
                network: "none",
                capabilities: ["filesystem_read", "filesystem_write", "shell"],
              },
              limits: { maxTurns: 32, timeoutMs: 60_000 },
            };
            await transaction.query(
              `INSERT INTO oao.agent_definitions
                 (organization_id,project_id,id,agent_key,name)
               VALUES ($1,$2,$3,'shipment-child','Shipment child'),
                      ($1,$2,$4,'shipment-parent','Shipment parent')`,
              [ids.organization, ids.project, childAgentId, parentAgentId],
            );
            await transaction.query(
              "SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)",
              [
                ids.organization,
                ids.project,
                childAgentId,
                childVersionId,
                baseConfig,
                createHash("sha256")
                  .update(JSON.stringify(baseConfig))
                  .digest(),
                ids.principal,
              ],
            );
            const parentConfig = {
              ...baseConfig,
              systemPrompt: "Coordinate shipment analysis with a child agent.",
              delegates: [
                {
                  key: "shipment-extraction",
                  description:
                    "Extract shipment facts in the shared workspace.",
                  agentVersionId: childVersionId,
                  maxParallel: 2,
                },
              ],
            };
            await transaction.query(
              "SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)",
              [
                ids.organization,
                ids.project,
                parentAgentId,
                parentVersionId,
                parentConfig,
                createHash("sha256")
                  .update(JSON.stringify(parentConfig))
                  .digest(),
                ids.principal,
              ],
            );
            const binding = await transaction.query<{
              child_agent_version_id: string;
              max_parallel: number;
            }>(
              `SELECT child_agent_version_id,max_parallel
                 FROM oao.agent_version_delegates
                WHERE organization_id=$1 AND project_id=$2
                  AND parent_agent_version_id=$3
                  AND delegate_key='shipment-extraction'`,
              [ids.organization, ids.project, parentVersionId],
            );
            assert.equal(
              binding.rows[0]?.child_agent_version_id,
              childVersionId,
            );
            assert.equal(binding.rows[0]?.max_parallel, 2);

            await transaction.query(
              `INSERT INTO oao.threads (organization_id,project_id,id,title)
               VALUES ($1,$2,$3,'Root')`,
              [ids.organization, ids.project, rootThreadId],
            );
            await transaction.query(
              `INSERT INTO oao.sessions
                 (organization_id,project_id,id,thread_id,agent_version_id)
               VALUES ($1,$2,$3,$4,$5)`,
              [
                ids.organization,
                ids.project,
                rootSessionId,
                rootThreadId,
                parentVersionId,
              ],
            );
            await transaction.query(
              `INSERT INTO oao.runs (
                 organization_id,project_id,id,thread_id,session_id,
                 agent_version_id,created_by_principal_id,idempotency_key
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,'workspace-root')`,
              [
                ids.organization,
                ids.project,
                rootRunId,
                rootThreadId,
                rootSessionId,
                parentVersionId,
                ids.principal,
              ],
            );
            const rootWorkspace = await transaction.query<{
              workspace_id: string;
            }>(
              `SELECT workspace_id FROM oao.thread_workspace_bindings
                WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3`,
              [ids.organization, ids.project, rootThreadId],
            );
            const workspaceId = rootWorkspace.rows[0]?.workspace_id;
            assert.ok(workspaceId);
            await transaction.query(
              `INSERT INTO oao.threads (organization_id,project_id,id,title)
               VALUES ($1,$2,$3,'Child')`,
              [ids.organization, ids.project, childThreadId],
            );
            await transaction.query(
              `INSERT INTO oao.sessions
                 (organization_id,project_id,id,thread_id,agent_version_id)
               VALUES ($1,$2,$3,$4,$5)`,
              [
                ids.organization,
                ids.project,
                childSessionId,
                childThreadId,
                childVersionId,
              ],
            );
            await transaction.query(
              `INSERT INTO oao.thread_workspace_bindings
                 (organization_id,project_id,thread_id,workspace_id,role)
               VALUES ($1,$2,$3,$4,'child')`,
              [ids.organization, ids.project, childThreadId, workspaceId],
            );
            await transaction.query(
              `INSERT INTO oao.runs (
                 organization_id,project_id,id,thread_id,session_id,
                 agent_version_id,created_by_principal_id,idempotency_key
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,'workspace-child')`,
              [
                ids.organization,
                ids.project,
                childRunId,
                childThreadId,
                childSessionId,
                childVersionId,
                ids.principal,
              ],
            );
            const shared = await transaction.query<{ count: string }>(
              `SELECT count(DISTINCT workspace_id)::text AS count
                 FROM oao.thread_workspace_bindings
                WHERE organization_id=$1 AND project_id=$2
                  AND thread_id IN ($3,$4)`,
              [ids.organization, ids.project, rootThreadId, childThreadId],
            );
            assert.equal(shared.rows[0]?.count, "1");
          });
        },
      );

      await t.test(
        "Harness Operations are normalized, immutable, validated, and tenant isolated",
        async () => {
          const agentId = uuid(320);
          const versionId = uuid(321);
          const operation = {
            key: "extract_shipment",
            description: "Extract shipment facts from mounted documents.",
            instructions:
              "Read the original mounted shipment documents and return verified facts.",
            resultSchema: {
              type: "object",
              properties: { shipmentReference: { type: "string" } },
              required: ["shipmentReference"],
              additionalProperties: false,
            },
            timeoutMs: 45_000,
          };
          const baseConfig = {
            systemPrompt: "Coordinate shipment extraction.",
            modelPreset: "local-default",
            tools: [],
            skillVersionIds: [],
            mcpBindings: [],
            delegates: [],
            harnessOperations: [operation],
            sandbox: {
              enabled: true,
              provider: "daytona-primary",
              snapshotId: uuid(322),
              network: "none",
              capabilities: ["filesystem_read", "filesystem_write", "shell"],
            },
            limits: { maxTurns: 32, timeoutMs: 60_000 },
          };
          await withTenantTransaction(pool, tenant, async (transaction) => {
            await transaction.query(
              `INSERT INTO oao.agent_definitions
                 (organization_id,project_id,id,agent_key,name)
               VALUES ($1,$2,$3,'harness-agent','Harness agent')`,
              [ids.organization, ids.project, agentId],
            );
            await transaction.query(
              "SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)",
              [
                ids.organization,
                ids.project,
                agentId,
                versionId,
                baseConfig,
                createHash("sha256")
                  .update(JSON.stringify(baseConfig))
                  .digest(),
                ids.principal,
              ],
            );
            const normalized = await transaction.query<{
              operation_key: string;
              result_schema: Record<string, unknown>;
              timeout_ms: number;
            }>(
              `SELECT operation_key,result_schema,timeout_ms
                 FROM oao.agent_version_harness_operations
                WHERE organization_id=$1 AND project_id=$2
                  AND agent_version_id=$3`,
              [ids.organization, ids.project, versionId],
            );
            assert.deepEqual(normalized.rows, [
              {
                operation_key: operation.key,
                result_schema: operation.resultSchema,
                timeout_ms: operation.timeoutMs,
              },
            ]);
          });

          await assert.rejects(
            pool.query(
              `UPDATE oao.agent_version_harness_operations
                  SET timeout_ms=46000
                WHERE organization_id=$1 AND project_id=$2
                  AND agent_version_id=$3 AND operation_key=$4`,
              [ids.organization, ids.project, versionId, operation.key],
            ),
            /immutable/u,
          );
          await assert.rejects(
            withTenantTransaction(pool, tenant, (transaction) =>
              transaction.query(
                "SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)",
                [
                  ids.organization,
                  ids.project,
                  agentId,
                  uuid(323),
                  {
                    ...baseConfig,
                    harnessOperations: [
                      { ...operation, resultSchema: { type: "string" } },
                    ],
                  },
                  createHash("sha256").update("invalid-result-schema").digest(),
                  ids.principal,
                ],
              ),
            ),
            /invalid agent publication config/u,
          );
          await assert.rejects(
            withTenantTransaction(pool, tenant, (transaction) =>
              transaction.query(
                "SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)",
                [
                  ids.organization,
                  ids.project,
                  agentId,
                  uuid(324),
                  {
                    ...baseConfig,
                    tools: [
                      {
                        schemaVersion: 1,
                        name: operation.key,
                        description: "Colliding tool",
                        owner: "platform",
                        approval: "never",
                        inputSchema: {
                          type: "object",
                          properties: {},
                          required: [],
                          additionalProperties: false,
                        },
                        outputSchema: {
                          type: "object",
                          properties: {},
                          required: [],
                          additionalProperties: false,
                        },
                      },
                    ],
                  },
                  createHash("sha256").update("colliding-tool").digest(),
                  ids.principal,
                ],
              ),
            ),
            /invalid agent publication config/u,
          );
          const otherVisible = await withTenantTransaction(
            pool,
            otherTenant,
            (transaction) =>
              transaction.query(
                `SELECT operation_key
                   FROM oao.agent_version_harness_operations
                  WHERE organization_id=$1 AND agent_version_id=$2`,
                [ids.organization, versionId],
              ),
          );
          assert.equal(otherVisible.rowCount, 0);
        },
      );

      await t.test(
        "tenant correlation and RLS require both organization and project",
        async () => {
          await assert.rejects(
            pool.query(
              `INSERT INTO oao.runs (
            organization_id, project_id, id, thread_id, session_id, agent_version_id,
            created_by_principal_id, idempotency_key
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'cross-tenant')`,
              [
                ids.organization,
                ids.otherProject,
                uuid(200),
                ids.thread,
                ids.otherSession,
                ids.otherVersion,
                ids.otherPrincipal,
              ],
            ),
            /foreign key constraint/u,
          );
          // Project rows are organization-visible so any project can list its
          // organization's projects; project-scoped tables stay isolated.
          const visible = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              transaction.query("SELECT id FROM oao.projects ORDER BY id"),
          );
          assert.deepEqual(
            visible.rows.map((row) => row.id),
            [ids.project, ids.otherProject],
          );
        },
      );

      await t.test(
        "same-tenant rows still reject mismatched thread and parent identities",
        async () => {
          const threadA = uuid(230) as ThreadId;
          const sessionA = uuid(231);
          const runA = uuid(232) as RunId;
          const threadB = uuid(233) as ThreadId;
          const sessionB = uuid(234);
          const runB = uuid(235) as RunId;
          const secondAgent = uuid(236);
          const secondVersion = uuid(237);
          await insertThreadRun(pool, threadA, sessionA, runA, "parent-a");
          await insertThreadRun(pool, threadB, sessionB, runB, "parent-b");
          await withTenantTransaction(pool, tenant, async (transaction) => {
            await transaction.query(
              "INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name) VALUES ($1,$2,$3,'agent-second','Second agent')",
              [ids.organization, ids.project, secondAgent],
            );
            await transaction.query(
              `INSERT INTO oao.agent_versions
                (organization_id,project_id,id,agent_definition_id,version,config,content_hash,created_by_principal_id)
               VALUES ($1,$2,$3,$4,1,'{}',digest('agent-second','sha256'),$5)`,
              [
                ids.organization,
                ids.project,
                secondVersion,
                secondAgent,
                ids.principal,
              ],
            );
          });

          const rejectTenantWrite = (sql: string, parameters: unknown[]) =>
            assert.rejects(
              withTenantTransaction(pool, tenant, (transaction) =>
                transaction.query(sql, parameters),
              ),
              /foreign key constraint/u,
            );

          await rejectTenantWrite(
            `INSERT INTO oao.thread_admission_heads
              (organization_id,project_id,thread_id,run_id,admission_key,request_hash)
             VALUES ($1,$2,$3,$4,'mismatched-thread',digest('mismatch','sha256'))`,
            [ids.organization, ids.project, threadB, runA],
          );
          await rejectTenantWrite(
            `INSERT INTO oao.runs
              (organization_id,project_id,id,thread_id,session_id,agent_version_id,created_by_principal_id,idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'mismatched-session-thread')`,
            [
              ids.organization,
              ids.project,
              uuid(238),
              threadB,
              sessionA,
              ids.version,
              ids.principal,
            ],
          );
          await rejectTenantWrite(
            `INSERT INTO oao.runs
              (organization_id,project_id,id,thread_id,session_id,agent_version_id,created_by_principal_id,idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'mismatched-session-version')`,
            [
              ids.organization,
              ids.project,
              uuid(239),
              threadA,
              sessionA,
              secondVersion,
              ids.principal,
            ],
          );
          await rejectTenantWrite(
            `INSERT INTO oao.messages
              (organization_id,project_id,id,thread_id,run_id,role,redacted_content)
             VALUES ($1,$2,$3,$4,$5,'assistant','safe')`,
            [ids.organization, ids.project, uuid(240), threadB, runA],
          );

          const toolCall = uuid(241) as ToolCallId;
          await withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              "INSERT INTO oao.tool_calls (organization_id,project_id,id,run_id,tool_name,safe_arguments) VALUES ($1,$2,$3,$4,'lookup','{}')",
              [ids.organization, ids.project, toolCall, runA],
            ),
          );
          await rejectTenantWrite(
            `INSERT INTO oao.approvals
              (organization_id,project_id,id,run_id,tool_call_id,summary)
             VALUES ($1,$2,$3,$4,$5,'Wrong run')`,
            [ids.organization, ids.project, uuid(242), runB, toolCall],
          );
        },
      );

      await t.test(
        "legal transitions succeed and illegal/terminal transitions fail",
        async () => {
          const run = uuid(201) as RunId;
          await insertRun(pool, run, "transition-run");
          await withTenantTransaction(pool, tenant, (transaction) =>
            repository.transition(transaction, tenant, run, "running"),
          );
          await assert.rejects(
            withTenantTransaction(pool, tenant, (transaction) =>
              repository.transition(
                transaction,
                tenant,
                run,
                "retry_scheduled",
              ),
            ),
            /illegal run transition/u,
          );
          await withTenantTransaction(pool, tenant, (transaction) =>
            repository.transition(transaction, tenant, run, "completed"),
          );
          await assert.rejects(
            withTenantTransaction(pool, tenant, (transaction) =>
              repository.transition(transaction, tenant, run, "running"),
            ),
            /illegal run transition/u,
          );
        },
      );

      await t.test(
        "thread admission is single-headed and replays only an identical request",
        async () => {
          const firstRun = uuid(202) as RunId;
          const secondRun = uuid(203) as RunId;
          await insertRun(pool, firstRun, "admission-a");
          await insertRun(pool, secondRun, "admission-b");
          const reserve = (runId: RunId, key: string, hashByte: number) =>
            withTenantTransaction(pool, tenant, (transaction) =>
              repository.reserve(transaction, {
                ...tenant,
                threadId: ids.thread,
                runId,
                admissionKey: key,
                requestHash: Buffer.alloc(32, hashByte),
              }),
            );
          const raced = await Promise.allSettled([
            reserve(firstRun, "admit-a", 1),
            reserve(secondRun, "admit-b", 2),
          ]);
          assert.equal(
            raced.filter((result) => result.status === "fulfilled").length,
            1,
          );
          assert.equal(
            raced.filter((result) => result.status === "rejected").length,
            1,
          );
          const winner =
            raced[0]?.status === "fulfilled" ? firstRun : secondRun;
          const winnerKey = winner === firstRun ? "admit-a" : "admit-b";
          const winnerHash = winner === firstRun ? 1 : 2;
          assert.equal(
            (await reserve(winner, winnerKey, winnerHash)).runId,
            winner,
          );
          await assert.rejects(
            reserve(winner, `${winnerKey}-changed`, winnerHash),
            /idempotency conflict/u,
          );

          const loser = winner === firstRun ? secondRun : firstRun;
          assert.equal(
            await withTenantTransaction(pool, tenant, (transaction) =>
              repository.requestCancellation(transaction, tenant, loser),
            ),
            "cancelled_pre_admission",
          );
          assert.equal(
            await withTenantTransaction(pool, tenant, (transaction) =>
              repository.requestCancellation(transaction, tenant, winner),
            ),
            "reconcile_and_abort",
          );
        },
      );

      await t.test(
        "admission and cancellation serialize on the run lock",
        async () => {
          const reserveFirstThread = uuid(220) as ThreadId;
          const reserveFirstRun = uuid(222) as RunId;
          await insertThreadRun(
            pool,
            reserveFirstThread,
            uuid(221),
            reserveFirstRun,
            "reserve-first",
          );
          let releaseReserve!: () => void;
          let markReserved!: () => void;
          const reserveRelease = new Promise<void>(
            (resolve) => (releaseReserve = resolve),
          );
          const reserved = new Promise<void>(
            (resolve) => (markReserved = resolve),
          );
          const reservation = withTenantTransaction(
            pool,
            tenant,
            async (transaction) => {
              const head = await repository.reserve(transaction, {
                ...tenant,
                threadId: reserveFirstThread,
                runId: reserveFirstRun,
                admissionKey: "race-reserve-first",
                requestHash: Buffer.alloc(32, 8),
              });
              markReserved();
              await reserveRelease;
              return head;
            },
          );
          await reserved;
          const waitingCancellation = withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              repository.requestCancellation(
                transaction,
                tenant,
                reserveFirstRun,
              ),
          );
          await new Promise((resolve) => setTimeout(resolve, 25));
          releaseReserve();
          assert.equal((await reservation).runId, reserveFirstRun);
          assert.equal(await waitingCancellation, "reconcile_and_abort");

          const cancelFirstThread = uuid(223) as ThreadId;
          const cancelFirstRun = uuid(225) as RunId;
          await insertThreadRun(
            pool,
            cancelFirstThread,
            uuid(224),
            cancelFirstRun,
            "cancel-first",
          );
          let releaseCancellation!: () => void;
          let markCancelled!: () => void;
          const cancellationRelease = new Promise<void>(
            (resolve) => (releaseCancellation = resolve),
          );
          const cancelled = new Promise<void>(
            (resolve) => (markCancelled = resolve),
          );
          const cancellation = withTenantTransaction(
            pool,
            tenant,
            async (transaction) => {
              const outcome = await repository.requestCancellation(
                transaction,
                tenant,
                cancelFirstRun,
              );
              markCancelled();
              await cancellationRelease;
              return outcome;
            },
          );
          await cancelled;
          const waitingReservation = withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              repository.reserve(transaction, {
                ...tenant,
                threadId: cancelFirstThread,
                runId: cancelFirstRun,
                admissionKey: "race-cancel-first",
                requestHash: Buffer.alloc(32, 9),
              }),
          );
          await new Promise((resolve) => setTimeout(resolve, 25));
          releaseCancellation();
          assert.equal(await cancellation, "cancelled_pre_admission");
          await assert.rejects(
            waitingReservation,
            /not eligible for admission/u,
          );
        },
      );

      await t.test(
        "idempotency replays identical input and rejects conflicting input",
        async () => {
          const claim = (byte: number) =>
            withTenantTransaction(pool, tenant, (transaction) =>
              repository.claimIdempotency(transaction, {
                ...tenant,
                scope: "runs.create",
                key: "same-key",
                requestHash: Buffer.alloc(32, byte),
                expiresAt: new Date(Date.now() + 60_000),
              }),
            );
          assert.equal(await claim(1), "claimed");
          assert.equal(await claim(1), "claimed");
          await withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              "UPDATE oao.api_idempotency SET status_code = 201, response_public = '{}' WHERE organization_id=$1 AND project_id=$2 AND scope='runs.create' AND idempotency_key='same-key'",
              [ids.organization, ids.project],
            ),
          );
          assert.equal(await claim(1), "replayed");
          await assert.rejects(claim(2), /idempotency key reused/u);
        },
      );

      await t.test(
        "runtime wakes deduplicate and expired leases restart with a new fence",
        async () => {
          const run = uuid(226) as RunId;
          const wake = uuid(227);
          await insertRun(pool, run, "runtime-wake-run");
          await withTenantTransaction(pool, tenant, async (transaction) => {
            await transaction.query(
              `INSERT INTO oao.runtime_thread_instances (
                organization_id,project_id,thread_id,session_id,agent_version_id,
                snapshot_hash,flue_instance_id
              ) VALUES ($1,$2,$3,$4,$5,digest('runtime-role-test','sha256'),$6)`,
              [
                ids.organization,
                ids.project,
                ids.thread,
                ids.session,
                ids.version,
                `runtime-role-test:${run}`,
              ],
            );
            await transaction.query(
              `INSERT INTO oao.runtime_dispatches (
                organization_id,project_id,run_id,thread_id,admission_key,
                request_hash,snapshot_hash,state,fence,flue_conversation_id,deadline_at
              ) VALUES ($1,$2,$3,$4,$5,digest('request','sha256'),
                digest('snapshot','sha256'),'admitted',1,$6,clock_timestamp()+interval '1 minute')`,
              [
                ids.organization,
                ids.project,
                run,
                ids.thread,
                `runtime-role-test:${run}`,
                `runtime-role-test:${run}`,
              ],
            );
          });
          const roleClient = await pool.connect();
          try {
            await roleClient.query("BEGIN");
            await roleClient.query("SET LOCAL ROLE oao_app");
            await roleClient.query("SELECT oao.set_tenant_context($1,$2)", [
              ids.organization,
              ids.otherProject,
            ]);
            const active = await roleClient.query<{ active: boolean }>(
              "SELECT oao.runtime_has_active_dispatches() AS active",
            );
            assert.equal(active.rows[0]?.active, true);
          } finally {
            await roleClient.query("ROLLBACK").catch(() => undefined);
            roleClient.release();
          }
          const enqueue = (payload: Record<string, string>) =>
            withTenantTransaction(pool, tenant, (transaction) =>
              transaction.query(
                "SELECT oao.enqueue_runtime_wake($1,$2,$3,$4,$5,digest($6,'sha256'),'admit',$7)",
                [
                  ids.organization,
                  ids.project,
                  wake,
                  run,
                  `admit:${run}`,
                  JSON.stringify(payload),
                  payload,
                ],
              ),
            );
          await enqueue({ source: "test" });
          await enqueue({ source: "test" });
          await assert.rejects(
            enqueue({ source: "changed" }),
            /runtime wake idempotency conflict/u,
          );

          const first = await pool.query(
            "SELECT * FROM oao.claim_runtime_wakes('worker-before-restart',1,interval '1 minute')",
          );
          assert.equal(first.rows[0]?.lease_fence, "1");
          await pool.query(
            "UPDATE oao.runtime_wake_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [wake],
          );
          const recovered = await pool.query(
            "SELECT * FROM oao.claim_runtime_wakes('worker-after-restart',1,interval '1 minute')",
          );
          assert.equal(recovered.rows[0]?.lease_fence, "2");
          assert.equal(recovered.rows[0]?.attempts, 2);
          await assert.rejects(
            pool.query(
              "SELECT oao.complete_runtime_wake($1,$2,$3,'worker-before-restart',1)",
              [ids.organization, ids.project, wake],
            ),
            /stale runtime wake fence/u,
          );
          await pool.query(
            "SELECT oao.complete_runtime_wake($1,$2,$3,'worker-after-restart',2)",
            [ids.organization, ids.project, wake],
          );
          const stored = await pool.query(
            "SELECT state,attempts FROM oao.runtime_wake_jobs WHERE id=$1",
            [wake],
          );
          assert.deepEqual(stored.rows[0], { state: "completed", attempts: 2 });
          await withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              "UPDATE oao.runtime_dispatches SET state='settled' WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
              [ids.organization, ids.project, run],
            ),
          );
        },
      );

      await t.test(
        "claim fences reject stale tool results and replay immutable results",
        async () => {
          const run = uuid(204) as RunId;
          const toolCall = uuid(205) as ToolCallId;
          await insertRun(pool, run, "tool-run");
          await withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              "INSERT INTO oao.tool_calls (organization_id,project_id,id,run_id,tool_name,safe_arguments) VALUES ($1,$2,$3,$4,'lookup','{}')",
              [ids.organization, ids.project, toolCall, run],
            ),
          );
          const firstFence = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              repository.claimToolCall(transaction, {
                ...tenant,
                toolCallId: toolCall,
                principalId: ids.principal,
                leaseMilliseconds: 60_000,
              }),
          );
          await pool.query(
            "UPDATE oao.tool_calls SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE organization_id=$1 AND project_id=$2 AND id=$3",
            [ids.organization, ids.project, toolCall],
          );
          const secondFence = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              repository.claimToolCall(transaction, {
                ...tenant,
                toolCallId: toolCall,
                principalId: ids.principal,
                leaseMilliseconds: 60_000,
              }),
          );
          assert.ok(secondFence > firstFence);
          const submit = (fence: bigint, hashByte = 3) =>
            withTenantTransaction(pool, tenant, (transaction) =>
              repository.submitResult(transaction, {
                ...tenant,
                toolCallId: toolCall,
                principalId: ids.principal,
                fence,
                idempotencyKey: "tool-result",
                requestHash: Buffer.alloc(32, hashByte),
                safeResult: { found: true },
              }),
            );
          await assert.rejects(
            submit(firstFence),
            /stale tool execution fence/u,
          );
          assert.equal(await submit(secondFence), "submitted");
          assert.equal(await submit(secondFence), "replayed");
          await assert.rejects(submit(secondFence, 4), /idempotency conflict/u);
          await assert.rejects(
            withTenantTransaction(pool, tenant, (transaction) =>
              transaction.query(
                "UPDATE oao.tool_call_results SET safe_result='{\"changed\":true}' WHERE tool_call_id=$1",
                [toolCall],
              ),
            ),
            /immutable/u,
          );
          assert.equal(
            (
              await withTenantTransaction(pool, tenant, (transaction) =>
                transaction.query(
                  "SELECT oao.commit_tool_result($1,$2,$3,$4,$5) AS outcome",
                  [
                    ids.organization,
                    ids.project,
                    toolCall,
                    secondFence.toString(),
                    "tool-result",
                  ],
                ),
              )
            ).rows[0]?.outcome,
            "committed",
          );
          const committed = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              transaction.query(
                "SELECT owner, stage, claim_fence FROM oao.tool_calls WHERE id=$1",
                [toolCall],
              ),
          );
          assert.deepEqual(committed.rows[0], {
            owner: "caller",
            stage: "result_committed",
            claim_fence: secondFence.toString(),
          });
        },
      );

      await t.test(
        "platform tools use execution leases and are never caller-claimable",
        async () => {
          const run = uuid(243) as RunId;
          const platformTool = uuid(244) as ToolCallId;
          const callerTool = uuid(245) as ToolCallId;
          await insertRun(pool, run, "owner-stages");
          await withTenantTransaction(pool, tenant, async (transaction) => {
            await transaction.query(
              `INSERT INTO oao.tool_calls
                (organization_id,project_id,id,run_id,tool_name,owner,stage,safe_arguments)
               VALUES ($1,$2,$3,$4,'platform_lookup','platform','platform_ready','{}')`,
              [ids.organization, ids.project, platformTool, run],
            );
            await transaction.query(
              "INSERT INTO oao.tool_calls (organization_id,project_id,id,run_id,tool_name,safe_arguments) VALUES ($1,$2,$3,$4,'caller_lookup','{}')",
              [ids.organization, ids.project, callerTool, run],
            );
          });
          await assert.rejects(
            withTenantTransaction(pool, tenant, (transaction) =>
              repository.claimToolCall(transaction, {
                ...tenant,
                toolCallId: platformTool,
                principalId: ids.principal,
                leaseMilliseconds: 60_000,
              }),
            ),
            /not claimable/u,
          );
          await assert.rejects(
            withTenantTransaction(pool, tenant, (transaction) =>
              repository.beginPlatformExecution(transaction, {
                ...tenant,
                toolCallId: callerTool,
                servicePrincipalId: ids.principal,
                leaseMilliseconds: 60_000,
              }),
            ),
            /not executable/u,
          );
          const fence = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              repository.beginPlatformExecution(transaction, {
                ...tenant,
                toolCallId: platformTool,
                servicePrincipalId: ids.principal,
                leaseMilliseconds: 60_000,
              }),
          );
          assert.equal(
            await withTenantTransaction(pool, tenant, (transaction) =>
              repository.submitResult(transaction, {
                ...tenant,
                toolCallId: platformTool,
                principalId: ids.principal,
                fence,
                idempotencyKey: "platform-result",
                requestHash: Buffer.alloc(32, 6),
                safeResult: { inputTokens: 12, outputTokens: 4 },
              }),
            ),
            "submitted",
          );
          const result = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              transaction.query(
                "SELECT owner, stage, lease_holder_principal_id, lease_expires_at FROM oao.tool_calls WHERE id=$1",
                [platformTool],
              ),
          );
          assert.deepEqual(result.rows[0], {
            owner: "platform",
            stage: "result_submitted",
            lease_holder_principal_id: null,
            lease_expires_at: null,
          });
        },
      );

      await t.test(
        "approval denial and expiry clear claims and invalidate fences",
        async () => {
          const run = uuid(206) as RunId;
          await insertRun(pool, run, "approval-run");
          for (const offset of [207, 208]) {
            const tool = uuid(offset) as ToolCallId;
            const approval = uuid(offset + 10);
            await withTenantTransaction(pool, tenant, async (transaction) => {
              await transaction.query(
                "INSERT INTO oao.tool_calls (organization_id,project_id,id,run_id,tool_name,safe_arguments) VALUES ($1,$2,$3,$4,'dangerous','{}')",
                [ids.organization, ids.project, tool, run],
              );
              await transaction.query(
                "SELECT oao.claim_tool_call($1,$2,$3,$4,interval '1 hour')",
                [ids.organization, ids.project, tool, ids.principal],
              );
              await transaction.query(
                "INSERT INTO oao.approvals (organization_id,project_id,id,run_id,tool_call_id,summary,expires_at) VALUES ($1,$2,$3,$4,$5,'Approve?',clock_timestamp() + interval '1 hour')",
                [ids.organization, ids.project, approval, run, tool],
              );
              if (offset === 207) {
                await transaction.query(
                  "SELECT oao.resolve_approval($1,$2,$3,'denied',$4,'operator denied')",
                  [ids.organization, ids.project, approval, ids.principal],
                );
              } else {
                await transaction.query(
                  "UPDATE oao.approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
                  [approval],
                );
                await transaction.query(
                  "SELECT oao.expire_approvals(clock_timestamp())",
                );
              }
            });
            const result = await withTenantTransaction(
              pool,
              tenant,
              (transaction) =>
                transaction.query(
                  "SELECT stage, lease_holder_principal_id, lease_expires_at, claim_fence FROM oao.tool_calls WHERE id=$1",
                  [tool],
                ),
            );
            assert.equal(
              result.rows[0]?.stage,
              offset === 207 ? "approval_denied" : "approval_expired",
            );
            assert.equal(result.rows[0]?.lease_holder_principal_id, null);
            assert.equal(result.rows[0]?.lease_expires_at, null);
            assert.equal(result.rows[0]?.claim_fence, "2");
            await assert.rejects(
              withTenantTransaction(pool, tenant, (transaction) =>
                repository.claimToolCall(transaction, {
                  ...tenant,
                  toolCallId: tool,
                  principalId: ids.principal,
                  leaseMilliseconds: 60_000,
                }),
              ),
              /not claimable/u,
            );
            await assert.rejects(
              withTenantTransaction(pool, tenant, (transaction) =>
                repository.submitResult(transaction, {
                  ...tenant,
                  toolCallId: tool,
                  principalId: ids.principal,
                  fence: 2n,
                  idempotencyKey: `terminal-result-${offset}`,
                  requestHash: Buffer.alloc(32, 7),
                  safeResult: { ok: true },
                }),
              ),
              /stale tool execution fence/u,
            );
          }
        },
      );

      await t.test(
        "project positions serialize at commit and rollbacks leave no gaps",
        async () => {
          const append = (eventNumber: number) =>
            withTenantTransaction(pool, otherTenant, (transaction) =>
              eventAppender.append(transaction, {
                id: uuid(300 + eventNumber) as EventId,
                ...otherTenant,
                aggregateType: "sandbox",
                aggregateId: uuid(399),
                kind: "sandbox.started",
                publicPayload: { region: "eu", number: eventNumber },
                occurredAt: new Date("2026-08-20T12:00:00.000Z"),
              }),
            );

          const rollbackClient = await pool.connect();
          try {
            await rollbackClient.query("BEGIN");
            await rollbackClient.query("SET LOCAL ROLE oao_app");
            await rollbackClient.query("SELECT oao.set_tenant_context($1,$2)", [
              ids.organization,
              ids.otherProject,
            ]);
            const rolledBack = await eventAppender.append(rollbackClient, {
              id: uuid(300) as EventId,
              ...otherTenant,
              aggregateType: "sandbox",
              aggregateId: uuid(399),
              kind: "sandbox.created",
              publicPayload: { region: "eu" },
              occurredAt: new Date("2026-08-20T12:00:00.000Z"),
            });
            assert.equal(rolledBack.projectPosition, 1n);
          } finally {
            await rollbackClient.query("ROLLBACK").catch(() => undefined);
            rollbackClient.release();
          }
          assert.equal((await append(1)).projectPosition, 1n);

          let releaseFirst!: () => void;
          let markAllocated!: () => void;
          const release = new Promise<void>(
            (resolve) => (releaseFirst = resolve),
          );
          const allocated = new Promise<void>(
            (resolve) => (markAllocated = resolve),
          );
          const firstCommit = withTenantTransaction(
            pool,
            otherTenant,
            async (transaction) => {
              const event = await eventAppender.append(transaction, {
                id: uuid(302) as EventId,
                ...otherTenant,
                aggregateType: "sandbox",
                aggregateId: uuid(399),
                kind: "sandbox.stopped",
                publicPayload: { reason: "idle" },
                occurredAt: new Date("2026-08-20T12:01:00.000Z"),
              });
              markAllocated();
              await release;
              return event;
            },
          );
          await allocated;
          const secondCommit = append(3);
          await new Promise((resolve) => setTimeout(resolve, 50));
          releaseFirst();
          const [second, third] = await Promise.all([
            firstCommit,
            secondCommit,
          ]);
          assert.equal(second.projectPosition, 2n);
          assert.equal(third.projectPosition, 3n);
          const positions = await withTenantTransaction(
            pool,
            otherTenant,
            (transaction) =>
              transaction.query(
                "SELECT project_position FROM oao.product_events ORDER BY project_position",
              ),
          );
          assert.deepEqual(
            positions.rows.map((row) => row.project_position),
            ["1", "2", "3"],
          );
        },
      );

      await t.test(
        "product events allow token counts, reject sensitive keys, and audit appends form a chain",
        async () => {
          const keyChecks = await withTenantTransaction(
            pool,
            otherTenant,
            (transaction) =>
              transaction.query(
                `SELECT key, oao.is_sensitive_public_key(key) AS sensitive
                 FROM unnest(ARRAY[
                   'inputTokens', 'output_tokens', 'reasoningTokens', 'tokenCount',
                   'Authorization', 'set-cookie', 'db_password', 'API_TOKEN', 'API_KEY',
                   'accessToken', 'refresh-token', 'session.token', 'client_secret', 'databaseSecretValue',
                   'rawPrompt', 'raw_payload', 'tool-payload', 'rawToolPayload', 'reasoning_content', 'chain-of-thought'
                 ]) AS key`,
              ),
          );
          const sensitivity = Object.fromEntries(
            keyChecks.rows.map((row) => [row.key, row.sensitive]),
          );
          for (const key of [
            "inputTokens",
            "output_tokens",
            "reasoningTokens",
            "tokenCount",
          ]) {
            assert.equal(sensitivity[key], false, key);
          }
          for (const key of [
            "Authorization",
            "set-cookie",
            "db_password",
            "API_TOKEN",
            "API_KEY",
            "accessToken",
            "refresh-token",
            "session.token",
            "client_secret",
            "databaseSecretValue",
            "rawPrompt",
            "raw_payload",
            "tool-payload",
            "rawToolPayload",
            "reasoning_content",
            "chain-of-thought",
          ]) {
            assert.equal(sensitivity[key], true, key);
          }
          const usageEvent = await withTenantTransaction(
            pool,
            otherTenant,
            (transaction) =>
              eventAppender.append(transaction, {
                id: uuid(409) as EventId,
                ...otherTenant,
                aggregateType: "model_invocation",
                aggregateId: uuid(408),
                kind: "model.invocation_completed",
                publicPayload: {
                  inputTokens: 1_024,
                  outputTokens: 128,
                  tokenCount: 1_152,
                },
                occurredAt: new Date("2026-08-20T12:02:00.000Z"),
              }),
          );
          assert.equal(usageEvent.projectPosition, 4n);
          await assert.rejects(
            withTenantTransaction(pool, otherTenant, (transaction) =>
              transaction.query(
                "SELECT oao.append_product_event($1,$2,$3,'run',$4,'run.created',$5,clock_timestamp())",
                [
                  ids.organization,
                  ids.otherProject,
                  uuid(410),
                  uuid(411),
                  { nested: { accessToken: "secret" } },
                ],
              ),
            ),
            /check constraint/u,
          );
          const auditIds = [uuid(420), uuid(421)];
          for (const auditId of auditIds) {
            await withTenantTransaction(pool, tenant, (transaction) =>
              transaction.query(
                "SELECT oao.append_audit_entry($1,$2,$3,$4,'run.read','run',$5,'{}',clock_timestamp())",
                [
                  ids.organization,
                  ids.project,
                  auditId,
                  ids.principal,
                  uuid(201),
                ],
              ),
            );
          }
          const chain = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              transaction.query(
                "SELECT sequence, previous_hash, entry_hash FROM oao.audit_entries ORDER BY sequence",
              ),
          );
          assert.equal(chain.rowCount, 2);
          assert.deepEqual(
            chain.rows.map((row) => row.sequence),
            ["1", "2"],
          );
          assert.deepEqual(
            chain.rows[1]?.previous_hash,
            chain.rows[0]?.entry_hash,
          );
        },
      );
    } finally {
      await pool.end();
    }
  },
);
