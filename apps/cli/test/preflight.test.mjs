/* global Buffer */

import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalEncryptionKey,
  parseDotEnvContents,
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

test("preflight parses dotenv values without treating comments as packages", () => {
  assert.deepEqual(
    parseDotEnvContents(
      "# comment\nOAO_API_PORT=3100\nAUTH_PROVIDER='development'\n",
    ),
    { OAO_API_PORT: "3100", AUTH_PROVIDER: "development" },
  );
});
