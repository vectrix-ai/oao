/* global Buffer */

import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalEncryptionKey,
  parseDotEnvContents,
  satisfiesNodeRange,
} from "../bootstrap/preflight.mjs";

test("preflight recognizes only canonical 32-byte encryption keys", () => {
  const valid = Buffer.alloc(32, 7).toString("base64");
  assert.equal(canonicalEncryptionKey(valid), true);
  assert.equal(
    canonicalEncryptionKey(Buffer.alloc(31).toString("base64")),
    false,
  );
  assert.equal(canonicalEncryptionKey(`${valid}\n`), false);
  assert.equal(canonicalEncryptionKey("not-base64"), false);
});

test("preflight checks Node.js against each alternative of the engines range", () => {
  const range = "^22.22.2 || ^24.15.0 || >=26.0.0";
  for (const version of ["22.22.2", "22.23.5", "24.15.0", "26.0.0", "27.1.0"])
    assert.equal(satisfiesNodeRange(version, range), true, version);
  for (const version of ["22.22.0", "23.11.0", "24.14.1", "25.9.0", "20.19.0"])
    assert.equal(satisfiesNodeRange(version, range), false, version);
  assert.equal(satisfiesNodeRange("22.22.2", ">=22.22.2"), true);
});

test("preflight parses dotenv values without treating comments as packages", () => {
  assert.deepEqual(
    parseDotEnvContents(
      "# comment\nOAO_API_PORT=3100\nAUTH_PROVIDER='development'\n",
    ),
    { OAO_API_PORT: "3100", AUTH_PROVIDER: "development" },
  );
});
