import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  createPool,
  PostgresWakeNotifier,
  withTenantTransaction,
  type PgPool,
} from "@oao/db-postgres";
import type { OrganizationId, ProjectId, RunId } from "@oao/domain";
import {
  PostgresWakeQueue,
  RUNTIME_WAKE_CHANNEL,
  WakeWorker,
  type RuntimeWakeJob,
} from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const tenant = {
  organizationId: "00000000-0000-4000-8000-00000000b001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-00000000b002" as ProjectId,
};
const principal = "00000000-0000-4000-8000-00000000b003";
const agentId = "00000000-0000-4000-8000-00000000b004";
const agentVersionId = "00000000-0000-4000-8000-00000000b005";
const threadId = "00000000-0000-4000-8000-00000000b006";
const sessionId = "00000000-0000-4000-8000-00000000b007";

async function seed(pool: PgPool): Promise<void> {
  const config = {
    systemPrompt: "Queue integration.",
    modelPreset: "integration-model",
    tools: [],
    sandbox: {
      enabled: false,
      provider: "integration-daytona",
      network: "none",
      capabilities: [],
    },
    limits: { maxTurns: 32, timeoutMs: 60_000 },
  };
  await pool.query(
    `INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'queue','Queue')
     ON CONFLICT DO NOTHING`,
    [tenant.organizationId],
  );
  await pool.query(
    `INSERT INTO oao.projects (organization_id,id,slug,name)
     VALUES ($1,$2,'queue','Queue') ON CONFLICT DO NOTHING`,
    [tenant.organizationId, tenant.projectId],
  );
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'human','queue-human',ARRAY['*']) ON CONFLICT DO NOTHING`,
    [tenant.organizationId, tenant.projectId, principal],
  );
  await pool.query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,'queue-agent','Queue agent') ON CONFLICT DO NOTHING`,
    [tenant.organizationId, tenant.projectId, agentId],
  );
  await pool.query(
    `INSERT INTO oao.agent_versions (
       organization_id,project_id,id,agent_definition_id,version,config,
       content_hash,created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,$5,$6,$7) ON CONFLICT DO NOTHING`,
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
     VALUES ($1,$2,$3,'Queue thread') ON CONFLICT DO NOTHING`,
    [tenant.organizationId, tenant.projectId, threadId],
  );
  await pool.query(
    `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [
      tenant.organizationId,
      tenant.projectId,
      sessionId,
      threadId,
      agentVersionId,
    ],
  );
}

/** A run with one due wake job; the job id is returned. */
async function enqueueRun(
  pool: PgPool,
  queue: PostgresWakeQueue,
): Promise<string> {
  const runId = randomUUID() as RunId;
  const id = randomUUID();
  await withTenantTransaction(pool, tenant, async (transaction) => {
    await transaction.query(
      `INSERT INTO oao.runs (
         organization_id,project_id,id,thread_id,session_id,agent_version_id,
         created_by_principal_id,idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tenant.organizationId,
        tenant.projectId,
        runId,
        threadId,
        sessionId,
        agentVersionId,
        principal,
        `queue-${runId}`,
      ],
    );
    await queue.enqueue(transaction, {
      ...tenant,
      id,
      runId,
      dispatchKey: `admit:${runId}`,
      kind: "admit",
      payload: { reason: "queue_integration" },
    });
  });
  return id;
}

async function jobState(pool: PgPool, id: string) {
  const result = await pool.query<{ state: string; attempts: number }>(
    "SELECT state,attempts FROM oao.runtime_wake_jobs WHERE id=$1",
    [id],
  );
  return result.rows[0];
}

async function until(condition: () => Promise<boolean> | boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "runtime wakes are pushed, leased per job, and never replayed",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 120_000 },
  async (t) => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    const queue = new PostgresWakeQueue(pool);
    const notifier = new PostgresWakeNotifier(pool, {
      channel: RUNTIME_WAKE_CHANNEL,
    });
    t.after(async () => {
      await notifier.close();
      await pool.end();
    });
    await seed(pool);
    // Leave nothing due from earlier suites.
    await pool.query(
      "UPDATE oao.runtime_wake_jobs SET state='completed',lease_owner=NULL,lease_expires_at=NULL WHERE state IN ('pending','leased')",
    );

    await t.test("a late completion still completes the job", async () => {
      const id = await enqueueRun(pool, queue);
      const [claimed] = await queue.claim("late-worker", {
        limit: 1,
        leaseMilliseconds: 1_000,
      });
      assert.equal(claimed?.id, id);
      assert.ok(claimed);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      // Nobody claimed it again, so owner and fence still prove ownership.
      await queue.complete("late-worker", claimed);
      assert.deepEqual(await jobState(pool, id), {
        state: "completed",
        attempts: 1,
      });
      assert.equal(await queue.renew("late-worker", claimed, 1_000), false);
    });

    await t.test("a renewed lease keeps other workers away", async () => {
      const id = await enqueueRun(pool, queue);
      const [claimed] = await queue.claim("owner", {
        limit: 1,
        leaseMilliseconds: 1_000,
      });
      assert.ok(claimed);
      assert.equal(await queue.renew("intruder", claimed, 5_000), false);
      assert.equal(await queue.renew("owner", claimed, 5_000), true);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      assert.deepEqual(
        await queue.claim("other", { limit: 10, leaseMilliseconds: 1_000 }),
        [],
      );
      await queue.complete("owner", claimed);
      assert.equal((await jobState(pool, id))?.state, "completed");
    });

    await t.test(
      "a handler three times longer than its lease runs once",
      async () => {
        const id = await enqueueRun(pool, queue);
        const runs: string[] = [];
        const options = {
          leaseMilliseconds: 1_000,
          pollMilliseconds: 100,
        };
        const handler = async (job: RuntimeWakeJob) => {
          runs.push(job.id);
          await new Promise((resolve) => setTimeout(resolve, 3_200));
        };
        const first = new WakeWorker(queue, handler, {
          ...options,
          workerId: "slow-a",
        });
        const second = new WakeWorker(queue, handler, {
          ...options,
          workerId: "slow-b",
        });
        first.start();
        second.start();
        try {
          await until(
            async () => (await jobState(pool, id))?.state === "completed",
          );
        } finally {
          await first.stop();
          await second.stop();
        }
        assert.deepEqual(runs, [id]);
        assert.deepEqual(await jobState(pool, id), {
          state: "completed",
          attempts: 1,
        });
      },
    );

    await t.test(
      "an enqueued wake starts at once without waiting for the poll",
      async () => {
        const started = new Map<string, number>();
        const worker = new WakeWorker(
          queue,
          async (job) => {
            started.set(job.id, Date.now());
          },
          {
            workerId: "pushed",
            pollMilliseconds: 60_000,
            subscribeToWakes: (onWake) => notifier.subscribe(onWake),
          },
        );
        worker.start();
        try {
          // Let the worker go idle and the listener connect.
          await new Promise((resolve) => setTimeout(resolve, 500));
          const latencies: number[] = [];
          for (let index = 0; index < 5; index += 1) {
            const enqueuedAt = Date.now();
            const id = await enqueueRun(pool, queue);
            await until(() => started.has(id), 5_000);
            latencies.push((started.get(id) ?? Infinity) - enqueuedAt);
          }
          latencies.sort((left, right) => left - right);
          assert.ok(
            (latencies[2] ?? Infinity) < 100,
            `median start ${latencies[2]} ms`,
          );
        } finally {
          await worker.stop();
        }
      },
    );

    await t.test("two workers never run one job at the same time", async () => {
      const ids = new Set<string>();
      for (let index = 0; index < 40; index += 1)
        ids.add(await enqueueRun(pool, queue));
      const running = new Set<string>();
      const handled: string[] = [];
      let overlaps = 0;
      const handler = async (job: RuntimeWakeJob) => {
        if (running.has(job.id)) overlaps += 1;
        running.add(job.id);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running.delete(job.id);
        handled.push(job.id);
      };
      const workers = ["pair-a", "pair-b"].map(
        (workerId) =>
          new WakeWorker(queue, handler, {
            workerId,
            concurrency: 8,
            pollMilliseconds: 50,
          }),
      );
      for (const worker of workers) worker.start();
      try {
        await until(() => [...ids].every((id) => handled.includes(id)));
      } finally {
        for (const worker of workers) await worker.stop();
      }
      assert.equal(overlaps, 0);
      assert.equal(
        handled.filter((id) => ids.has(id)).length,
        ids.size,
        "each job ran exactly once",
      );
    });
  },
);
