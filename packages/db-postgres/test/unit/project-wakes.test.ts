import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationId, ProjectId } from "@oao/domain";
import {
  abortableDelay,
  createProjectWakeWaiter,
  sleepingProjectWakeWatch,
} from "../../src/index.js";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
};

function notifier() {
  const subscribers = new Set<() => void>();
  return {
    subscribers,
    wakeAll: () => {
      for (const wake of subscribers) wake();
    },
    subscribe: async (onWake: () => void) => {
      subscribers.add(onWake);
      return async () => {
        subscribers.delete(onWake);
      };
    },
  };
}

test("a project wake ends the wait, at most once per minimum interval", async () => {
  const source = notifier();
  const waiter = createProjectWakeWaiter(source, {
    fallbackMilliseconds: 60_000,
    minimumIntervalMilliseconds: 80,
  });
  const watch = await waiter.watch(scope);
  // A wake that arrives before the first wait still counts.
  source.wakeAll();
  let started = Date.now();
  await watch.next();
  assert.ok(Date.now() - started < 50);
  started = Date.now();
  setTimeout(() => source.wakeAll(), 5);
  await watch.next();
  // The second re-check waits out the minimum interval.
  assert.ok(Date.now() - started >= 70, `${Date.now() - started} ms`);
  await watch.close();
  assert.equal(source.subscribers.size, 0);
});

test("without a wake the fallback interval ends the wait", async () => {
  const waiter = createProjectWakeWaiter(notifier(), {
    fallbackMilliseconds: 30,
  });
  const watch = await waiter.watch(scope);
  const started = Date.now();
  await watch.next();
  assert.ok(Date.now() - started >= 25);
  await watch.close();
});

test("an abort rejects the wait with its reason", async () => {
  const waiter = createProjectWakeWaiter(notifier(), {
    fallbackMilliseconds: 60_000,
  });
  const watch = await waiter.watch(scope);
  const controller = new AbortController();
  const waiting = watch.next(controller.signal);
  controller.abort(new Error("run cancelled"));
  await assert.rejects(waiting, /run cancelled/u);
  await watch.close();
});

test("a sleeping watch only sleeps", async () => {
  const watch = sleepingProjectWakeWatch(abortableDelay, 10);
  const started = Date.now();
  await watch.next();
  assert.ok(Date.now() - started >= 8);
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  await assert.rejects(watch.next(controller.signal), /stopped/u);
});
