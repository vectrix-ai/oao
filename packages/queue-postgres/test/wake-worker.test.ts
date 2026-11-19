import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationId, ProjectId, RunId } from "@oao/domain";
import {
  WakeWorker,
  type PostgresWakeQueue,
  type RuntimeWakeJob,
} from "../src/index.js";

type Queue = Pick<PostgresWakeQueue, "claim" | "complete" | "retry" | "renew">;

function job(index: number): RuntimeWakeJob {
  return {
    organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
    projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
    id: `job-${index}`,
    runId: `run-${index}` as RunId,
    dispatchKey: `admit:run-${index}`,
    kind: "admit",
    payload: {},
    attempts: 1,
    fence: 1n,
  };
}

/** A queue double that hands out a fixed list of jobs once. */
function fakeQueue(jobs: RuntimeWakeJob[], overrides: Partial<Queue> = {}) {
  const calls = {
    claims: [] as number[],
    completed: [] as string[],
    retried: [] as string[],
    renewed: [] as string[],
  };
  const queue: Queue = {
    claim: async (_worker, options) => {
      calls.claims.push(options?.limit ?? 0);
      return jobs.splice(0, options?.limit ?? 10);
    },
    complete: async (_worker, claimed) => {
      calls.completed.push(claimed.id);
    },
    retry: async (_worker, claimed) => {
      calls.retried.push(claimed.id);
    },
    renew: async (_worker, claimed) => {
      calls.renewed.push(claimed.id);
      return true;
    },
    ...overrides,
  };
  return { queue, calls };
}

async function until(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("handlers overlap up to the concurrency limit", async (t) => {
  const { queue, calls } = fakeQueue(
    Array.from({ length: 6 }, (_, index) => job(index)),
  );
  let running = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  const worker = new WakeWorker(
    queue,
    async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
    },
    { workerId: "w", concurrency: 4, pollMilliseconds: 60_000 },
  );
  t.after(() => worker.stop());
  worker.start();
  await until(() => running === 4);
  assert.equal(peak, 4);
  // A finished handler frees a slot for the work left unclaimed.
  release.shift()?.();
  await until(() => running === 4 && calls.claims.length >= 2);
  await until(() => {
    while (release.length) release.shift()?.();
    return calls.completed.length === 6;
  });
  assert.equal(peak, 4);
  assert.deepEqual(calls.retried, []);
  await worker.stop();
});

test("a claim error is reported and the loop keeps claiming", async () => {
  const errors: unknown[] = [];
  let failures = 1;
  const { queue, calls } = fakeQueue([job(1)], {});
  const claim = queue.claim;
  queue.claim = async (worker, options) => {
    if (failures-- > 0) throw new Error("connection refused");
    return claim(worker, options);
  };
  const worker = new WakeWorker(queue, async () => undefined, {
    workerId: "w",
    pollMilliseconds: 10,
    onError: (error) => errors.push(error),
  });
  worker.start();
  await until(() => calls.completed.length === 1, 3_000);
  assert.match(String(errors[0]), /connection refused/u);
  await worker.stop();
});

test("a failing completion is reported, never retried", async () => {
  const errors: unknown[] = [];
  const { queue, calls } = fakeQueue([job(1)], {
    complete: async () => {
      throw new Error("stale runtime wake fence");
    },
  });
  let handled = 0;
  const worker = new WakeWorker(
    queue,
    async () => {
      handled += 1;
    },
    {
      workerId: "w",
      pollMilliseconds: 10,
      onError: (error) => errors.push(error),
    },
  );
  worker.start();
  await until(() => errors.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handled, 1);
  assert.deepEqual(calls.retried, []);
  await worker.stop();
});

test("a failing handler is retried, and a failing retry is only reported", async () => {
  const errors: unknown[] = [];
  const { queue } = fakeQueue([job(1)], {
    retry: async () => {
      throw new Error("database unavailable");
    },
  });
  const worker = new WakeWorker(
    queue,
    async () => {
      throw new Error("handler failed");
    },
    {
      workerId: "w",
      pollMilliseconds: 10,
      onError: (error) => errors.push(error),
    },
  );
  worker.start();
  await until(() => errors.length === 2);
  assert.match(String(errors[0]), /handler failed/u);
  assert.match(String(errors[1]), /database unavailable/u);
  await worker.stop();
});

test("a long handler renews its lease and a lost lease skips completion", async () => {
  let owned = true;
  const { queue, calls } = fakeQueue([job(1)], {
    renew: async (_worker, claimed) => {
      calls.renewed.push(claimed.id);
      return owned;
    },
  });
  const errors: unknown[] = [];
  let finish: () => void = () => undefined;
  const worker = new WakeWorker(
    queue,
    () => new Promise<void>((resolve) => (finish = resolve)),
    {
      workerId: "w",
      leaseMilliseconds: 30,
      pollMilliseconds: 60_000,
      onError: (error) => errors.push(error),
    },
  );
  worker.start();
  await until(() => calls.renewed.length >= 3);
  owned = false;
  const renewals = calls.renewed.length;
  await until(() => calls.renewed.length > renewals);
  finish();
  await until(() => errors.length === 1);
  assert.match(String(errors[0]), /lease was lost/u);
  assert.deepEqual(calls.completed, []);
  assert.deepEqual(calls.retried, []);
  await worker.stop();
});

test("a wake notification starts a claim without waiting for the poll", async () => {
  let notify: () => void = () => undefined;
  const jobs: RuntimeWakeJob[] = [];
  const { queue, calls } = fakeQueue(jobs);
  const worker = new WakeWorker(queue, async () => undefined, {
    workerId: "w",
    pollMilliseconds: 60_000,
    subscribeToWakes: async (onWake) => {
      notify = onWake;
      return async () => undefined;
    },
  });
  worker.start();
  await until(() => calls.claims.length === 1);
  jobs.push(job(1));
  notify();
  await until(() => calls.completed.length === 1, 500);
  await worker.stop();
});

test("stop waits a bounded time for running handlers", async () => {
  const { queue } = fakeQueue([job(1)]);
  let started = false;
  const worker = new WakeWorker(
    queue,
    async () => {
      started = true;
      await new Promise(() => undefined);
    },
    { workerId: "w", pollMilliseconds: 60_000, stopGraceMilliseconds: 50 },
  );
  worker.start();
  await until(() => started);
  const stopping = Date.now();
  await worker.stop();
  assert.ok(Date.now() - stopping < 1_000);
});
