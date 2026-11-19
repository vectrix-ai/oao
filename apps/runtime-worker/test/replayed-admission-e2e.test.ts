import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
} from "@oao/domain";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
} from "@oao/models-openrouter";
import { startRuntimeWorker, type RuntimeWorkerHandle } from "../src/main.js";

const databaseUrl = process.env.DATABASE_URL;
const testAdminDatabaseUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? databaseUrl;

// Ids live in this file's own namespace: the suites share one database.
function uuid(label: string): string {
  const bytes = createHash("sha256")
    .update(`replayed-admission-e2e/${label}`)
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
const versionId = uuid("version");
const TERMINAL = ["completed", "failed", "cancelled", "timed_out"];

// A run whose own message says "hold" waits until the test releases it.
const held: (() => void)[] = [];
const respond: FauxResponseStep = async (context) => {
  const latest = context.messages.at(-1);
  if (latest?.role === "user" && JSON.stringify(latest).includes("hold"))
    await new Promise<void>((resolve) => held.push(resolve));
  return fauxAssistantMessage("ok");
};

async function seedBase(pool: PgPool): Promise<void> {
  await pool.query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'replayed-admission-e2e','Replayed admission e2e')",
    [tenant.organizationId],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'replayed-admission-e2e','Replayed admission e2e')",
    [tenant.organizationId, tenant.projectId],
  );
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'human','replayed-admission-e2e-human',ARRAY['*']),
            ($1,$2,$4,'service','replayed-admission-e2e-service',ARRAY['*'])`,
    [tenant.organizationId, tenant.projectId, human, service],
  );
  const agentId = uuid("agent");
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
    limits: { maxTurns: 16, timeoutMs: 60_000 },
  };
  await pool.query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,'replay','replay')`,
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
}

interface Chat {
  readonly label: string;
  readonly threadId: ThreadId;
  readonly sessionId: string;
  runs: number;
}

async function seedChat(pool: PgPool, label: string): Promise<Chat> {
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
  return { label, threadId, sessionId, runs: 0 };
}

async function seedRun(
  pool: PgPool,
  chat: Chat,
  message = "answer",
): Promise<RunId> {
  chat.runs += 1;
  const label = `${chat.label}:${chat.runs}`;
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
      chat.threadId,
      chat.sessionId,
      versionId,
      human,
      `replayed-admission-e2e:${label}`,
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
      chat.threadId,
      runId,
      message,
    ],
  );
  return runId;
}

function admitJob(runId: RunId, attempts = 1) {
  return {
    ...tenant,
    id: uuid(`wake:${runId}`),
    runId,
    dispatchKey: `admit:${runId}`,
    kind: "admit" as const,
    payload: { reason: "integration_test" },
    attempts,
    fence: BigInt(attempts),
  };
}

async function runState(pool: PgPool, runId: RunId): Promise<string> {
  const result = await pool.query<{ state: string }>(
    "SELECT state FROM oao.runs WHERE id=$1",
    [runId],
  );
  return result.rows[0]?.state ?? "missing";
}

async function waitUntil<T>(
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

async function admitAndSettle(
  worker: RuntimeWorkerHandle,
  pool: PgPool,
  runId: RunId,
): Promise<string> {
  await worker.orchestrator.handleWake(admitJob(runId));
  return waitSettled(pool, runId);
}

function waitSettled(pool: PgPool, runId: RunId): Promise<string> {
  return waitUntil(`run ${runId} to settle`, async () => {
    const state = await runState(pool, runId);
    return TERMINAL.includes(state) ? state : undefined;
  });
}

async function instanceState(pool: PgPool, chat: Chat) {
  const result = await pool.query<{
    state: string;
    safe_error: { code?: string } | null;
  }>(
    "SELECT state,safe_error FROM oao.runtime_thread_instances WHERE thread_id=$1",
    [chat.threadId],
  );
  return result.rows[0];
}

async function corruptionEvents(pool: PgPool, chat: Chat): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM oao.product_events event
       JOIN oao.runs run ON run.id=event.aggregate_id
      WHERE run.thread_id=$1 AND event.event_kind='runtime.recovery_completed'
        AND event.public_payload->>'outcome'='failed'`,
    [chat.threadId],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Writes what admission wrote before it became idempotent, when the wake of
 * the settled run `replayed` ran again: the thread instance corrupt, and the
 * recovery event on the run that held the thread's admission (`affected`, the
 * replayed run itself when none did). The wake then completed.
 */
async function corruptLikeReplayedAdmission(
  admin: PgPool,
  chat: Chat,
  replayed: RunId,
  affected: RunId,
): Promise<void> {
  await withTenantTransaction(admin, tenant, async (transaction) => {
    await transaction.query(
      `UPDATE oao.runtime_thread_instances
          SET state='corrupt',safe_error=$2,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND project_id=$3 AND thread_id=$4`,
      [
        tenant.organizationId,
        {
          code: "flue_incarnation_mismatch",
          message: "The durable conversation identity could not be verified",
        },
        tenant.projectId,
        chat.threadId,
      ],
    );
    await transaction.query(
      "SELECT oao.append_product_event($1,$2,$3,'run',$4,'runtime.recovery_completed',$5,clock_timestamp())",
      [
        tenant.organizationId,
        tenant.projectId,
        randomUUID(),
        affected,
        { outcome: "failed", code: "flue_incarnation_mismatch" },
      ],
    );
  });
  await withTenantTransaction(admin, tenant, (transaction) =>
    transaction.query(
      `INSERT INTO oao.runtime_wake_jobs (
         organization_id,project_id,id,run_id,dispatch_key,request_hash,kind,
         state,attempts,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'admit','completed',2,clock_timestamp())`,
      [
        tenant.organizationId,
        tenant.projectId,
        randomUUID(),
        replayed,
        `admit:${replayed}`,
        createHash("sha256").update(`admit:${replayed}`).digest(),
      ],
    ),
  );
}

async function repairState(admin: PgPool, chat: Chat) {
  const result = await admin.query<{
    state: string;
    outcome_code: string | null;
    replayed_run_id: string;
  }>(
    "SELECT state,outcome_code,replayed_run_id FROM oao.runtime_incarnation_repairs WHERE thread_id=$1",
    [chat.threadId],
  );
  return result.rows[0];
}

test(
  "a replayed admission is a no-op and the chats it broke are repaired once",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 300_000 },
  async (t) => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const admin = createPool(testAdminDatabaseUrl);
    const worker = await startRuntimeWorker({
      databaseUrl,
      listen: false,
      backgroundWakes: false,
      eventWebhooks: false,
      env: { ...process.env, OAO_RUNTIME_SERVICE_PRINCIPAL_ID: service },
      fakeResponses: Array.from({ length: 256 }, () => respond),
    });
    let heldRun: RunId | undefined;
    t.after(async () => {
      while (held.length) held.shift()?.();
      if (heldRun) await waitSettled(admin, heldRun).catch(() => undefined);
      // An unsettled dispatch left behind would block every later stop.
      await admin.query(
        "UPDATE oao.runtime_dispatches SET state='settled' WHERE organization_id=$1 AND state<>'settled'",
        [tenant.organizationId],
      );
      await worker.stop();
      await admin.end();
    });
    await seedBase(admin);

    await t.test(
      "replaying a settled run's admission leaves the chat ready",
      async () => {
        const chat = await seedChat(admin, "replay-no-head");
        const first = await seedRun(admin, chat);
        assert.equal(await admitAndSettle(worker, admin, first), "completed");
        // The wake runs again after its run settled and released its head.
        await worker.orchestrator.handleWake(admitJob(first, 2));
        assert.equal((await instanceState(admin, chat))?.state, "ready");
        assert.equal(await corruptionEvents(admin, chat), 0);
        assert.equal(await runState(admin, first), "completed");
        const next = await seedRun(admin, chat);
        assert.equal(await admitAndSettle(worker, admin, next), "completed");
      },
    );

    await t.test(
      "replaying it while a successor holds the head leaves both alone",
      async () => {
        const chat = await seedChat(admin, "replay-successor");
        const first = await seedRun(admin, chat);
        assert.equal(await admitAndSettle(worker, admin, first), "completed");
        const successor = await seedRun(admin, chat, "hold this run");
        await worker.orchestrator.handleWake(admitJob(successor));
        await waitUntil("the successor to reach the model", async () =>
          held.length > 0 ? true : undefined,
        );
        await worker.orchestrator.handleWake(admitJob(first, 2));
        assert.equal((await instanceState(admin, chat))?.state, "ready");
        assert.equal(await corruptionEvents(admin, chat), 0);
        assert.equal(await runState(admin, successor), "running");
        held.shift()?.();
        assert.equal(await waitSettled(admin, successor), "completed");
        const next = await seedRun(admin, chat);
        assert.equal(await admitAndSettle(worker, admin, next), "completed");
      },
    );

    // Chats in the state the old admission left behind.
    const noHead = await seedChat(admin, "repair-no-head");
    const withSuccessor = await seedChat(admin, "repair-successor");
    const forged = await seedChat(admin, "repair-forged-uid");
    const running = await seedChat(admin, "repair-unsettled");
    const projected = await seedChat(admin, "repair-projection");

    await t.test("the broken chats are recorded as candidates", async () => {
      // No head left: the replayed run is the run the event names.
      const noHeadRun = await seedRun(admin, noHead);
      assert.equal(await admitAndSettle(worker, admin, noHeadRun), "completed");
      await corruptLikeReplayedAdmission(admin, noHead, noHeadRun, noHeadRun);
      // Every later message failed while the chat was corrupt.
      const failedLater = await seedRun(admin, noHead);
      assert.equal(await admitAndSettle(worker, admin, failedLater), "failed");

      // A successor held the head: the event names it, and it settled later.
      const replayed = await seedRun(admin, withSuccessor);
      assert.equal(await admitAndSettle(worker, admin, replayed), "completed");
      const successor = await seedRun(admin, withSuccessor);
      assert.equal(await admitAndSettle(worker, admin, successor), "completed");
      await corruptLikeReplayedAdmission(
        admin,
        withSuccessor,
        replayed,
        successor,
      );
      await withTenantTransaction(admin, tenant, async (transaction) => {
        const dispatch = await transaction.query<{
          admission_key: string;
          request_hash: Buffer;
          fence: string;
        }>(
          "SELECT admission_key,request_hash,fence FROM oao.runtime_dispatches WHERE run_id=$1",
          [successor],
        );
        const row = dispatch.rows[0];
        assert.ok(row);
        await transaction.query(
          `INSERT INTO oao.thread_admission_heads (
             organization_id,project_id,thread_id,run_id,admission_key,
             request_hash,state,fence,draining_at
           ) VALUES ($1,$2,$3,$4,$5,$6,'ambiguous',$7,clock_timestamp())`,
          [
            tenant.organizationId,
            tenant.projectId,
            withSuccessor.threadId,
            successor,
            row.admission_key,
            row.request_hash,
            row.fence,
          ],
        );
        // The old writer marked the successor's dispatch aborting without
        // aborting Flue, and no watcher settled it after Flue finished.
        await transaction.query(
          "UPDATE oao.runtime_dispatches SET state='aborting',updated_at=clock_timestamp() WHERE run_id=$1",
          [successor],
        );
      });

      // The same signature, but Flue stores another identity.
      const forgedRun = await seedRun(admin, forged);
      assert.equal(await admitAndSettle(worker, admin, forgedRun), "completed");
      await withTenantTransaction(admin, tenant, async (transaction) => {
        await transaction.query(
          "UPDATE oao.runtime_thread_instances SET flue_instance_uid='forged-uid' WHERE thread_id=$1",
          [forged.threadId],
        );
        await transaction.query(
          "UPDATE oao.runtime_dispatches SET flue_instance_uid='forged-uid' WHERE thread_id=$1",
          [forged.threadId],
        );
      });
      await corruptLikeReplayedAdmission(admin, forged, forgedRun, forgedRun);

      // The same signature, but the successor is still running in Flue.
      const runningFirst = await seedRun(admin, running);
      assert.equal(
        await admitAndSettle(worker, admin, runningFirst),
        "completed",
      );
      heldRun = await seedRun(admin, running, "hold this run");
      await worker.orchestrator.handleWake(admitJob(heldRun));
      await waitUntil("the held run to reach the model", async () =>
        held.length > 0 ? true : undefined,
      );
      await corruptLikeReplayedAdmission(admin, running, runningFirst, heldRun);

      // Corrupted by the projection's identity check: it appends no event.
      const projectedRun = await seedRun(admin, projected);
      assert.equal(
        await admitAndSettle(worker, admin, projectedRun),
        "completed",
      );
      await withTenantTransaction(admin, tenant, (transaction) =>
        transaction.query(
          `UPDATE oao.runtime_thread_instances SET state='corrupt',
             safe_error='{"code":"flue_incarnation_mismatch","message":"x"}'
           WHERE thread_id=$1`,
          [projected.threadId],
        ),
      );

      const detected = await admin.query<{ added: number }>(
        "SELECT oao.detect_replayed_admission_repairs() AS added",
      );
      assert.equal(detected.rows[0]?.added, 4);
      assert.equal(
        (await repairState(admin, noHead))?.replayed_run_id,
        noHeadRun,
      );
      assert.equal(
        (await repairState(admin, withSuccessor))?.replayed_run_id,
        replayed,
      );
      assert.equal(await repairState(admin, projected), undefined);
      // Detection is idempotent.
      const again = await admin.query<{ added: number }>(
        "SELECT oao.detect_replayed_admission_repairs() AS added",
      );
      assert.equal(again.rows[0]?.added, 0);
    });

    await t.test(
      "only chats whose identity still matches are repaired",
      async () => {
        const results = await worker.orchestrator.repairReplayedAdmissions();
        const byThread = new Map(
          results.map((result) => [result.threadId, result]),
        );
        assert.equal(byThread.get(noHead.threadId)?.outcome, "repaired");
        assert.equal(byThread.get(withSuccessor.threadId)?.outcome, "repaired");
        assert.deepEqual(
          [
            byThread.get(forged.threadId)?.outcome,
            byThread.get(forged.threadId)?.code,
          ],
          ["skipped", "flue_identity_mismatch"],
        );
        assert.deepEqual(
          [
            byThread.get(running.threadId)?.outcome,
            byThread.get(running.threadId)?.code,
          ],
          ["pending", "unsettled_dispatch"],
        );
        for (const chat of [noHead, withSuccessor])
          assert.deepEqual(await instanceState(admin, chat), {
            state: "ready",
            safe_error: null,
          });
        for (const chat of [forged, running, projected])
          assert.equal((await instanceState(admin, chat))?.state, "corrupt");
        assert.equal((await repairState(admin, noHead))?.state, "repaired");
        assert.equal((await repairState(admin, forged))?.state, "skipped");
        assert.equal((await repairState(admin, running))?.state, "pending");
        const heads = await admin.query(
          "SELECT 1 FROM oao.thread_admission_heads WHERE thread_id=$1",
          [withSuccessor.threadId],
        );
        assert.equal(heads.rowCount, 0);
        // The successor's stale aborting dispatch was finished.
        const unsettled = await admin.query(
          "SELECT 1 FROM oao.runtime_dispatches WHERE thread_id=$1 AND state<>'settled'",
          [withSuccessor.threadId],
        );
        assert.equal(unsettled.rowCount, 0);
        const repairedEvents = await admin.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM oao.product_events
            WHERE organization_id=$1 AND project_id=$2
              AND event_kind='runtime.recovery_completed'
              AND public_payload->>'outcome'='repaired'`,
          [tenant.organizationId, tenant.projectId],
        );
        assert.equal(repairedEvents.rows[0]?.count, 2);

        // A repaired chat runs again; a second pass changes nothing.
        for (const chat of [noHead, withSuccessor]) {
          const next = await seedRun(admin, chat);
          assert.equal(await admitAndSettle(worker, admin, next), "completed");
        }
        const second = await worker.orchestrator.repairReplayedAdmissions();
        assert.deepEqual(
          second.map((result) => [result.threadId, result.outcome]),
          [[running.threadId, "pending"]],
        );
      },
    );
  },
);
