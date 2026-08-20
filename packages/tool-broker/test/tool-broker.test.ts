import assert from "node:assert/strict";
import test from "node:test";
import { toolBrokerTesting } from "../src/index.js";

test("stable runtime ids converge for duplicate delivery", () => {
  assert.equal(
    toolBrokerTesting.stableUuid("tool:run:call"),
    toolBrokerTesting.stableUuid("tool:run:call"),
  );
  assert.notEqual(
    toolBrokerTesting.stableUuid("tool:run:call"),
    toolBrokerTesting.stableUuid("tool:run:other"),
  );
});

test("failed results are sanitized for the model", () => {
  assert.deepEqual(
    toolBrokerTesting.decodeResult({
      version: 1,
      status: "failure",
      error: {
        code: "tool_failed",
        message: "sensitive details",
      },
    }),
    {
      version: 1,
      status: "failure",
      error: { code: "tool_failed", message: "Tool execution failed" },
    },
  );
});
