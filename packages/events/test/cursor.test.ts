import assert from "node:assert/strict";
import test from "node:test";
import { decodeEventCursor, encodeEventCursor } from "../src/index.js";

test("event cursors round-trip positions above Number.MAX_SAFE_INTEGER", () => {
  const position = 9_007_199_254_740_993n;
  assert.equal(decodeEventCursor(encodeEventCursor(position)), position);
});

test("event cursors are versioned and reject malformed values", () => {
  assert.throws(
    () => decodeEventCursor(Buffer.from("v2:1").toString("base64url")),
    /Invalid event cursor/u,
  );
  assert.throws(() => encodeEventCursor(-1n), /must not be negative/u);
});
