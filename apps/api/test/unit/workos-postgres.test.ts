import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@oao/db-postgres";
import { PostgresWorkOsTenantResolver } from "../../src/workos-postgres.js";

test("WorkOS principal resolution preserves provider display metadata", async () => {
  const pool = {
    query: async () => ({
      rowCount: 1,
      rows: [
        {
          organization_id: "00000000-0000-4000-8000-000000000001",
          project_id: "00000000-0000-4000-8000-000000000002",
          principal_id: "00000000-0000-4000-8000-000000000003",
          subject: "development-user",
          scopes: ["*"],
        },
      ],
    }),
  } as unknown as PgPool;

  const principal = await new PostgresWorkOsTenantResolver(
    pool,
  ).resolvePrincipal({
    subject: "user_01M0MTYCQD10B3N6QZAA3BHGC4",
    externalOrganizationId: "org_01M0MS7BX7CRF46XQRT4ZPQJCS",
    displayName: "Ben Selleslagh",
    email: "developer@example.test",
  });

  assert.equal(principal?.subject, "development-user");
  assert.equal(principal?.displayName, "Ben Selleslagh");
});
