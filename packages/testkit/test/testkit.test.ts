import assert from "node:assert/strict";
import test from "node:test";
import {
  CrashBarrier,
  DeterministicClock,
  DeterministicIds,
  SimulatedCrash,
} from "../src/index.js";

test("deterministic clocks and IDs are reproducible", () => {
  const clock = new DeterministicClock();
  clock.advance(1_000);
  assert.equal(clock.now().toISOString(), "2026-01-01T00:00:01.000Z");
  const ids = new DeterministicIds();
  assert.equal(ids.next(), "00000000-0000-4000-8000-000000000001");
  assert.equal(ids.next(), "00000000-0000-4000-8000-000000000002");
});

test("crash barriers fail exactly once at an armed boundary", async () => {
  const barrier = new CrashBarrier();
  barrier.arm("after_provider");
  await assert.rejects(barrier.reach("after_provider"), SimulatedCrash);
  await barrier.reach("after_provider");
  assert.deepEqual(barrier.reached, ["after_provider", "after_provider"]);
});
