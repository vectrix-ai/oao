import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  runIsolatedScenario,
  withScenarioCleanup,
} from "./support/isolated-scenario.js";

const fixture = fileURLToPath(
  new URL("./support/scenario-fixture.ts", import.meta.url),
);

test("scenario cleanup preserves the original error and attempts every cleanup", async (context) => {
  context.mock.method(console, "error", () => {});
  const original = new Error("original assertion");
  const cleanup = new Error("cleanup failure");
  let finalCleanupRan = false;
  await assert.rejects(
    withScenarioCleanup(async () => {
      throw original;
    }, [
      async () => {
        throw cleanup;
      },
      async () => {
        finalCleanupRan = true;
      },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.deepEqual(error.errors, [original, cleanup]);
      return true;
    },
  );
  assert.equal(finalCleanupRan, true);
});

test("cleanup failure cannot turn a successful scenario green", async (context) => {
  context.mock.method(console, "error", () => {});
  await assert.rejects(
    withScenarioCleanup(async () => {}, [
      async () => {
        throw new Error("cleanup");
      },
    ]),
  );
});

test(
  "isolated scenario succeeds only after a zero exit",
  { timeout: 10_000 },
  async () => {
    await runIsolatedScenario(fixture, { args: ["success"], timeoutMs: 5_000 });
  },
);

test(
  "isolated failure exits despite background handles and retains both errors",
  { timeout: 10_000 },
  async () => {
    await assert.rejects(
      runIsolatedScenario(fixture, { args: ["failure"], timeoutMs: 5_000 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /exited with 1/u);
        assert.match(error.message, /original assertion/u);
        assert.match(error.message, /cleanup refused active work/u);
        return true;
      },
    );
  },
);

test(
  "isolated scenario enforces a deadline for leaked handles",
  { timeout: 10_000 },
  async () => {
    await assert.rejects(
      runIsolatedScenario(fixture, { args: ["timeout"], timeoutMs: 2_000 }),
      /exceeded 2000ms/u,
    );
  },
);

test(
  "isolated scenario obeys parent cancellation",
  { timeout: 10_000 },
  async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runIsolatedScenario(fixture, {
        args: ["timeout"],
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
      /was aborted/u,
    );
  },
);
