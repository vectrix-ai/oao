import assert from "node:assert/strict";
import test from "node:test";
import { mergedWindowMs } from "../../src/model-usage.js";

test("parallel work counts once and gaps do not count", () => {
  assert.equal(mergedWindowMs([]), 0);
  assert.equal(mergedWindowMs([[100, 200]]), 100);
  assert.equal(
    mergedWindowMs([
      [300, 400],
      [100, 200],
    ]),
    200,
  );
  assert.equal(
    mergedWindowMs([
      [100, 300],
      [150, 200],
      [250, 500],
      [700, 800],
    ]),
    500,
  );
  assert.equal(mergedWindowMs([[100, 100]]), 0);
});
