import assert from "node:assert/strict";
import test from "node:test";
import { createPool, migrate } from "@oao/db-postgres";
import { provisionIapIdentity } from "../../src/iap-provisioning.js";

const databaseUrl = process.env.DATABASE_URL;
const ids = {
  organization: "00000000-0000-4000-8000-000000009940",
  project: "00000000-0000-4000-8000-000000009941",
  principal: "00000000-0000-4000-8000-000000009942",
};
const expectedAudience =
  "/projects/123456789/locations/europe-west1/services/oao-api";

test(
  "IAP resolves only an explicitly linked immutable subject and audience",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    try {
      await migrate(pool);
      await pool.query(
        `SELECT oao.bootstrap_project(
          $1,'iap-test','IAP test organization',
          $2,'default','Default project',
          $3,'iap-test-principal','development'
        )`,
        [ids.organization, ids.project, ids.principal],
      );
      const input = {
        organizationId: ids.organization,
        projectId: ids.project,
        principalId: ids.principal,
        expectedAudience,
        email: "first@example.test",
      };
      await provisionIapIdentity(pool, input);
      await provisionIapIdentity(pool, input);

      const deniedSubject = await pool.query(
        "SELECT * FROM oao.resolve_iap_principal($1,$2,$3,$4,$5)",
        [
          "accounts.google.com:unlinked",
          "unlinked@example.test",
          expectedAudience,
          ids.organization,
          ids.project,
        ],
      );
      assert.equal(deniedSubject.rowCount, 0);

      const deniedAudience = await pool.query(
        "SELECT * FROM oao.resolve_iap_principal($1,$2,$3,$4,$5)",
        [
          "accounts.google.com:123456789",
          input.email,
          "/projects/123456789/locations/europe-west1/services/other-api",
          ids.organization,
          ids.project,
        ],
      );
      assert.equal(deniedAudience.rowCount, 0);

      const deniedUnclaimedEmail = await pool.query(
        "SELECT * FROM oao.resolve_iap_principal($1,$2,$3,$4,$5)",
        [
          "accounts.google.com:123456789",
          "renamed@example.test",
          expectedAudience,
          ids.organization,
          ids.project,
        ],
      );
      assert.equal(deniedUnclaimedEmail.rowCount, 0);

      const resolved = await pool.query<{
        organization_id: string;
        project_id: string;
        principal_id: string;
        kind: string;
        subject: string;
        scopes: string[];
      }>("SELECT * FROM oao.resolve_iap_principal($1,$2,$3,$4,$5)", [
        "accounts.google.com:123456789",
        input.email,
        expectedAudience,
        ids.organization,
        ids.project,
      ]);
      assert.deepEqual(resolved.rows[0], {
        organization_id: ids.organization,
        project_id: ids.project,
        principal_id: ids.principal,
        kind: "human",
        subject: "iap-test-principal",
        scopes: ["*"],
      });

      const renamed = await pool.query(
        "SELECT * FROM oao.resolve_iap_principal($1,$2,$3,$4,$5)",
        [
          "accounts.google.com:123456789",
          "renamed@example.test",
          expectedAudience,
          ids.organization,
          ids.project,
        ],
      );
      assert.deepEqual(renamed.rows[0], resolved.rows[0]);

      const deniedReplacementSubject = await pool.query(
        "SELECT * FROM oao.resolve_iap_principal($1,$2,$3,$4,$5)",
        [
          "accounts.google.com:replacement",
          input.email,
          expectedAudience,
          ids.organization,
          ids.project,
        ],
      );
      assert.equal(deniedReplacementSubject.rowCount, 0);

      const identity = await pool.query<{ email: string }>(
        `SELECT email FROM oao.auth_identities
         WHERE organization_id=$1 AND project_id=$2
           AND provider='iap' AND provider_subject=$3`,
        [ids.organization, ids.project, "accounts.google.com:123456789"],
      );
      assert.equal(identity.rows[0]?.email, "renamed@example.test");

      const privilege = await pool.query<{ public_can_execute: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_proc function
           JOIN pg_namespace namespace ON namespace.oid=function.pronamespace
           CROSS JOIN LATERAL aclexplode(
             COALESCE(function.proacl,acldefault('f',function.proowner))
           ) acl
           WHERE namespace.nspname='oao'
             AND function.proname='resolve_iap_principal'
             AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
         ) AS public_can_execute`,
      );
      assert.equal(privilege.rows[0]?.public_can_execute, false);

      const schemaPrivilege = await pool.query<{ can_create: boolean }>(
        "SELECT has_schema_privilege('oao_auth','oao','CREATE') AS can_create",
      );
      assert.equal(schemaPrivilege.rows[0]?.can_create, false);
    } finally {
      await pool.end();
    }
  },
);
