import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

test(
  "a pool survives PostgreSQL closing one of its idle connections",
  {
    skip: databaseUrl ? false : "DATABASE_URL is required",
    timeout: 30_000,
  },
  async (t) => {
    assert.ok(databaseUrl);
    let reportIdleError: (error: Error) => void = () => undefined;
    const idleError = new Promise<Error>((resolve) => {
      reportIdleError = resolve;
    });
    const pool = createPool(databaseUrl, {
      onIdleClientError: (error) => reportIdleError(error),
    });
    const admin = createPool(databaseUrl);
    t.after(async () => {
      await pool.end();
      await admin.end();
    });

    const before = await pool.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const pid = before.rows[0]?.pid;
    assert.ok(pid);
    // The connection sits idle in the pool once its query has returned.
    const terminated = await admin.query<{ terminated: boolean }>(
      "SELECT pg_terminate_backend($1) AS terminated",
      [pid],
    );
    assert.equal(terminated.rows[0]?.terminated, true);

    const error = await idleError;
    assert.match(error.message, /terminating connection/u);
    const after = await pool.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    assert.notEqual(after.rows[0]?.pid, pid);
  },
);
