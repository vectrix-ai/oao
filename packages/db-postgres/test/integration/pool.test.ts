import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationId, ProjectId } from "@oao/domain";
import { createPool, withTenantTransaction } from "../../src/index.js";

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

test(
  "a pool survives PostgreSQL terminating a connection inside a transaction",
  {
    skip: databaseUrl ? false : "DATABASE_URL is required",
    timeout: 30_000,
  },
  async (t) => {
    assert.ok(databaseUrl);
    const clientErrors: Error[] = [];
    const pool = createPool(databaseUrl, {
      max: 2,
      onClientError: (error) => clientErrors.push(error),
    });
    const admin = createPool(databaseUrl);
    t.after(async () => {
      await pool.end();
      await admin.end();
    });
    const tenant = {
      organizationId: "00000000-0000-4000-8000-00000000a001" as OrganizationId,
      projectId: "00000000-0000-4000-8000-00000000a002" as ProjectId,
    };
    let pid: number | undefined;
    // The callback leaves the connection checked out and idle in the
    // transaction while the backend is terminated, then queries it again.
    const transaction = withTenantTransaction(pool, tenant, async (client) => {
      pid = (
        await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      assert.ok(pid);
      const terminated = await admin.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend($1) AS terminated",
        [pid],
      );
      assert.equal(terminated.rows[0]?.terminated, true);
      // Give the socket time to deliver the termination before the next query.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await client.query("SELECT 1");
    });
    await assert.rejects(transaction);
    assert.ok(clientErrors.length >= 1, "the client error was reported");
    // The broken connection was destroyed, so the pool still answers.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const after = await pool.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      assert.notEqual(after.rows[0]?.pid, pid);
    }
    assert.equal(pool.totalCount <= 2, true);
  },
);
