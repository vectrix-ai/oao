import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../../src/index.js";

// No query runs, so the pool never opens a connection to this address.
const unreachable = "postgresql://oao:oao@127.0.0.1:1/oao";

test("an idle connection error reaches the handler instead of crashing", async () => {
  const errors: Error[] = [];
  const pool = createPool(unreachable, {
    onIdleClientError: (error) => errors.push(error),
  });
  const lost = new Error("terminating connection due to administrator command");
  assert.doesNotThrow(() => pool.emit("error", lost));
  assert.deepEqual(errors, [lost]);
  await pool.end();
});

test("a pool without a handler still absorbs idle connection errors", async () => {
  const pool = createPool(unreachable);
  assert.doesNotThrow(() => pool.emit("error", new Error("connection lost")));
  await pool.end();
});
