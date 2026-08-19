import assert from "node:assert/strict";
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
        assert.equal(first.applied.length + first.alreadyApplied.length, 1);
        const second = await migrate(pool);
        assert.deepEqual(second.alreadyApplied, ["0001_foundation.sql"]);
        await seed(pool);
      });

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
          const visible = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              transaction.query("SELECT id FROM oao.projects ORDER BY id"),
          );
          assert.deepEqual(
            visible.rows.map((row) => row.id),
            [ids.project],
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
            "UPDATE oao.tool_calls SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE organization_id=$1 AND project_id=$2 AND id=$3",
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
          await assert.rejects(submit(firstFence), /stale tool claim fence/u);
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
                  "SELECT status, claimed_by_principal_id, claim_expires_at, claim_fence FROM oao.tool_calls WHERE id=$1",
                  [tool],
                ),
            );
            assert.equal(result.rows[0]?.status, "cancelled");
            assert.equal(result.rows[0]?.claimed_by_principal_id, null);
            assert.equal(result.rows[0]?.claim_expires_at, null);
            assert.equal(result.rows[0]?.claim_fence, "2");
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
        "product events reject unsafe keys and audit appends form a chain",
        async () => {
          await assert.rejects(
            withTenantTransaction(pool, otherTenant, (transaction) =>
              transaction.query(
                "SELECT oao.append_product_event($1,$2,$3,'run',$4,'run.created',$5,clock_timestamp())",
                [
                  ids.organization,
                  ids.otherProject,
                  uuid(410),
                  uuid(411),
                  { nested: { authorization: "Bearer secret" } },
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
