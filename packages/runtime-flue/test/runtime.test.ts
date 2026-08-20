import assert from "node:assert/strict";
import test from "node:test";
import { FLUE_PACKAGE_VERSIONS, runtimeTesting } from "../src/index.js";

test("Flue packages are pinned to the planned release", () => {
  assert.deepEqual(FLUE_PACKAGE_VERSIONS, {
    runtime: "2.0.3",
    postgres: "2.0.3",
    opentelemetry: "2.0.3",
    piAi: "0.83.0",
  });
});

test("runtime projections use deterministic ids and redact unsafe arguments", () => {
  assert.equal(
    runtimeTesting.eventUuid("same"),
    runtimeTesting.eventUuid("same"),
  );
  assert.deepEqual(
    runtimeTesting.safeArguments({
      authorization: "Bearer x",
      orderId: "safe",
    }),
    { authorization: "[REDACTED]", orderId: "safe" },
  );
});
