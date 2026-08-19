import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("foundation migration encodes tenant, cursor, admission, and safety boundaries", async () => {
  const sql = await readFile(
    new URL("../../migrations/0001_foundation.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
  assert.match(sql, /PRIMARY KEY \(organization_id, project_id, thread_id\)/u);
  assert.match(sql, /committed_position = committed_position \+ 1/u);
  assert.match(sql, /jsonb_has_forbidden_public_key/u);
  assert.match(sql, /sandbox\.started/u);
  assert.doesNotMatch(sql, /CREATE (?:SEQUENCE|DATABASE)/u);
});
