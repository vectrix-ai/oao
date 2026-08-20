import assert from "node:assert/strict";
import test from "node:test";
import { wakeRequestHash } from "../src/index.js";

test("wake request hashes are stable across object key order", () => {
  const left = wakeRequestHash({
    runId: "run",
    kind: "admit",
    payload: { nested: { b: 2, a: 1 }, value: true },
  });
  const right = wakeRequestHash({
    runId: "run",
    kind: "admit",
    payload: { value: true, nested: { a: 1, b: 2 } },
  });
  assert.deepEqual(left, right);
});
