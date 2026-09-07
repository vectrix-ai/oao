import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@oao/db-postgres";
import { PostgresIapTenantResolver } from "../../src/iap-postgres.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const expectedAudience =
  "/projects/123456789/locations/europe-west1/services/oao-api";

test("IAP resolution uses immutable subject, exact audience, and database identity kind", async () => {
  const calls: readonly unknown[][] = [];
  const mutableCalls = calls as unknown[][];
  const pool = {
    async query(_text: string, values: readonly unknown[]) {
      mutableCalls.push([...values]);
      return {
        rowCount: 1,
        rows: [
          {
            organization_id: organizationId,
            project_id: projectId,
            principal_id: "00000000-0000-4000-8000-000000000003",
            kind: "human",
            subject: "iap-user",
            scopes: ["*"],
          },
        ],
      };
    },
  } as unknown as PgPool;
  const resolver = new PostgresIapTenantResolver({
    pool,
    expectedAudience,
    organizationId,
    projectId,
  });

  const principal = await resolver.resolvePrincipal({
    subject: "accounts.google.com:123",
    email: "admin@example.test",
  });
  assert.equal(principal?.kind, "human");
  assert.equal(principal?.displayName, "admin@example.test");
  assert.deepEqual(calls[0], [
    "accounts.google.com:123",
    "admin@example.test",
    expectedAudience,
    organizationId,
    projectId,
  ]);
});
