import assert from "node:assert/strict";
import test from "node:test";
import { isTransientDatabaseError } from "../../src/index.js";

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

test("a lost or unreachable database is transient", () => {
  assert.equal(
    isTransientDatabaseError(new Error("Connection terminated unexpectedly")),
    true,
  );
  assert.equal(
    isTransientDatabaseError(
      new Error("timeout exceeded when trying to connect"),
    ),
    true,
  );
  assert.equal(
    isTransientDatabaseError(withCode("terminating connection", "57P01")),
    true,
  );
  assert.equal(
    isTransientDatabaseError(withCode("connection failure", "08006")),
    true,
  );
  assert.equal(isTransientDatabaseError(withCode("reset", "ECONNRESET")), true);
  assert.equal(
    isTransientDatabaseError(
      new Error("read failed", {
        cause: new Error("Connection terminated unexpectedly"),
      }),
    ),
    true,
  );
});

test("statement and work failures are not transient", () => {
  assert.equal(
    isTransientDatabaseError(withCode("duplicate key", "23505")),
    false,
  );
  assert.equal(
    isTransientDatabaseError(withCode("stale runtime wake fence", "P0001")),
    false,
  );
  assert.equal(isTransientDatabaseError(new Error("model refused")), false);
  assert.equal(isTransientDatabaseError("Connection terminated"), false);
  assert.equal(isTransientDatabaseError(undefined), false);
});
