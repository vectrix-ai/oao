import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, type PgClient } from "@oao/db-postgres";

// Fixtures are isolated by the disposable harness and rolled back after each
// case. Never truncate an arbitrary DATABASE_URL or the local development DB.
const databaseUrl = process.env.OAO_TEST_ADMIN_DATABASE_URL;
const disposable = databaseUrl && databaseUrl === process.env.DATABASE_URL;
const audience = "/projects/123456789/locations/europe-west1/services/oao-api";
const ensure = "SELECT * FROM oao.ensure_iap_default_tenant($1)";

async function fixture(
  run: (client: PgClient) => Promise<void>,
): Promise<void> {
  assert.ok(databaseUrl);
  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE oao.organizations CASCADE");
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
}

async function seed(client: PgClient, linked: boolean) {
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const principalId = randomUUID();
  await client.query(
    "SELECT oao.bootstrap_project($1,$2,'Existing organization',$3,'existing','Existing project',$4,$5,'development')",
    [organizationId, organizationId, projectId, principalId, principalId],
  );
  if (linked)
    await client.query(
      "INSERT INTO oao.auth_tenant_links (organization_id,project_id,provider,provider_tenant_id) VALUES ($1,$2,'iap',$3)",
      [organizationId, projectId, audience],
    );
  return { organization_id: organizationId, project_id: projectId };
}

test(
  "IAP application defaults",
  { skip: !disposable && "Run pnpm test:postgres:fresh" },
  async (t) => {
    await t.test(
      "fresh boot generates IDs once, keeps constant names, and grants nobody access",
      async () => {
        await fixture(async (client) => {
          await client.query("SET LOCAL ROLE oao_app");
          const first = (await client.query(ensure, [audience])).rows[0];
          assert.match(first.organization_id, /^[0-9a-f-]{36}$/u);
          assert.notEqual(first.organization_id, first.project_id);
          assert.deepEqual(
            (await client.query(ensure, [audience])).rows[0],
            first,
          );
          await client.query("RESET ROLE");
          assert.deepEqual(
            (await client.query("SELECT name FROM oao.organizations")).rows,
            [{ name: "Default organization" }],
          );
          assert.deepEqual(
            (await client.query("SELECT name FROM oao.projects")).rows,
            [{ name: "Default project" }],
          );
          assert.equal(
            (await client.query("SELECT * FROM oao.principals")).rowCount,
            0,
          );
          assert.equal(
            (await client.query("SELECT * FROM oao.organization_members"))
              .rowCount,
            0,
          );
          await client.query("UPDATE oao.organizations SET name='Renamed'");
          await client.query(ensure, [audience]);
          assert.equal(
            (await client.query("SELECT name FROM oao.organizations")).rows[0]
              .name,
            "Renamed",
          );
        });
      },
    );

    await t.test(
      "adopts the explicit IAP link and preserves owners, names and IDs",
      async () => {
        await fixture(async (client) => {
          const selected = await seed(client, true);
          await seed(client, false); // Never choose an arbitrary existing tenant.
          await client.query("SET LOCAL ROLE oao_app");
          assert.deepEqual(
            (await client.query(ensure, [audience])).rows[0],
            selected,
          );
          await client.query("RESET ROLE");
          await seed(client, true); // Later projects cannot change the saved default.
          assert.deepEqual(
            (await client.query(ensure, [audience])).rows[0],
            selected,
          );
          assert.equal(
            (
              await client.query(
                "SELECT name FROM oao.organizations WHERE id=$1",
                [selected.organization_id],
              )
            ).rows[0].name,
            "Existing organization",
          );
          assert.equal(
            (
              await client.query(
                "SELECT role FROM oao.project_members WHERE organization_id=$1",
                [selected.organization_id],
              )
            ).rows[0].role,
            "owner",
          );
        });
      },
    );

    await t.test(
      "adopts a project whose owner is a copied organization identity",
      async () => {
        await fixture(async (client) => {
          const existing = await seed(client, false);
          const projectId = randomUUID();
          const principalId = randomUUID();
          await client.query(
            "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'copied-owner','Copied owner project')",
            [existing.organization_id, projectId],
          );
          await client.query(
            "INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes) VALUES ($1,$2,$3,'human','copied-owner',ARRAY['*'])",
            [existing.organization_id, projectId, principalId],
          );
          await client.query(
            "INSERT INTO oao.project_members (organization_id,project_id,principal_id,role) VALUES ($1,$2,$3,'owner')",
            [existing.organization_id, projectId, principalId],
          );
          await client.query(
            "INSERT INTO oao.auth_tenant_links (organization_id,project_id,provider,provider_tenant_id) VALUES ($1,$2,'iap',$3)",
            [existing.organization_id, projectId, audience],
          );
          await client.query("SET LOCAL ROLE oao_app");
          assert.deepEqual((await client.query(ensure, [audience])).rows[0], {
            organization_id: existing.organization_id,
            project_id: projectId,
          });
        });
      },
    );

    for (const scenario of [
      "unlinked",
      "ownerless",
      "ambiguous",
      "different audience",
      "invalid audience",
    ] as const) {
      await t.test(
        `rejects ${scenario} without guessing or relinking`,
        async () => {
          await fixture(async (client) => {
            if (scenario === "unlinked") await seed(client, false);
            if (scenario === "ownerless") {
              await seed(client, true);
              await client.query(
                "DELETE FROM oao.project_members WHERE role='owner'",
              );
            }
            if (scenario === "ambiguous") {
              await seed(client, true);
              await seed(client, true);
            }
            if (scenario === "different audience")
              await client.query(ensure, [audience]);
            await client.query("SET LOCAL ROLE oao_app");
            await assert.rejects(
              client.query(ensure, [
                scenario === "different audience"
                  ? audience + "-other"
                  : scenario === "invalid audience"
                    ? "invalid"
                    : audience,
              ]),
              /operator review|required|Multiple IAP|Cloud Run IAP/u,
            );
          });
        },
      );
    }

    await t.test(
      "runtime cannot write defaults directly and PUBLIC cannot call bootstrap",
      async () => {
        await fixture(async (client) => {
          const privileges = (
            await client.query(`SELECT
        has_table_privilege('oao_app','oao.iap_default_tenant','INSERT,UPDATE,DELETE') AS can_write,
        has_schema_privilege('oao_auth','oao','CREATE') AS can_create,
        EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl
          WHERE p.oid IN ('oao.ensure_iap_default_tenant(text)'::regprocedure,
            'oao.claim_iap_initial_owner(uuid,uuid,text)'::regprocedure)
            AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute`)
          ).rows[0];
          assert.deepEqual(privileges, {
            can_write: false,
            can_create: false,
            public_execute: false,
          });
          await client.query("SET LOCAL ROLE oao_app");
          await assert.rejects(
            client.query("DELETE FROM oao.iap_default_tenant"),
            /permission denied/u,
          );
        });
      },
    );
  },
);
