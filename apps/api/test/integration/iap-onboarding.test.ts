import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, migrate } from "@oao/db-postgres";
import { IapAuthAdapter } from "@oao/auth-iap";
import { ensureIapDefaultTenant } from "../../src/iap-defaults.js";
import { IAP_MEMBER_SCOPES } from "../../src/iap-onboarding.js";
import { PostgresIapTenantResolver } from "../../src/iap-postgres.js";

const adminUrl = process.env.OAO_TEST_ADMIN_DATABASE_URL;
const runtimeUrl = process.env.OAO_TEST_RUNTIME_DATABASE_URL;
const harness = adminUrl && runtimeUrl && process.env.DATABASE_URL === adminUrl;

test(
  "IAP first login creates one owner, then members; restarts and revocations never reopen ownership",
  {
    skip: !harness && "Run pnpm test:postgres:fresh",
  },
  async () => {
    assert.ok(adminUrl && runtimeUrl);
    const dbName = `oao_iap_${randomUUID().replaceAll("-", "")}`;
    const admin = createPool(adminUrl);
    const runtimeConnection = new URL(runtimeUrl);
    const inspectorConnection = new URL(adminUrl);
    runtimeConnection.pathname = inspectorConnection.pathname = `/${dbName}`;
    const pool = createPool(runtimeConnection.toString());
    const inspect = createPool(inspectorConnection.toString());
    try {
      // Real concurrent connections, isolated from every other suite's fixtures.
      await admin.query(`CREATE DATABASE "${dbName}" OWNER oao_runtime`);
      await migrate(pool);
      const audience =
        "/projects/123456789/locations/europe-west1/services/oao-fresh";
      const defaults = await ensureIapDefaultTenant(pool, audience);
      const resolver = new PostgresIapTenantResolver({
        pool,
        expectedAudience: audience,
        ...defaults,
      });
      const identities = Array.from({ length: 6 }, (_, i) => ({
        subject: `accounts.google.com:${100 + i}`,
        email: `user${i}@example.test`,
      }));
      const auth = new IapAuthAdapter({
        tenants: resolver,
        verifier: {
          verify: async (assertion) => identities[Number(assertion)],
        },
      });
      const login = (assertion: string) =>
        auth.authenticate(
          new Request("https://oao.example.test/v1/context", {
            headers: { "x-goog-iap-jwt-assertion": assertion },
          }),
        );
      assert.equal(await login("invalid"), undefined);
      assert.equal(
        await auth.authenticate(
          new Request("https://oao.example.test/v1/context"),
        ),
        undefined,
      );
      assert.equal(
        await resolver.resolvePrincipal({
          subject: "accounts.google.com:999",
          email: "worker@project.iam.gserviceaccount.com",
        }),
        undefined,
      );
      assert.equal(
        (await inspect.query("SELECT * FROM oao.principals")).rowCount,
        0,
      );
      const wrongAudience = new PostgresIapTenantResolver({
        pool,
        ...defaults,
        expectedAudience: audience + "-wrong",
      });
      assert.equal(
        await wrongAudience.resolvePrincipal(identities[0]!),
        undefined,
      );

      const principals = await Promise.all(
        identities.map((_, i) => login(String(i))),
      );
      assert.ok(principals.every(Boolean));
      const owners = principals.filter((p) => p?.scopes.has("*"));
      assert.equal(owners.length, 1);
      const owner = owners[0]!;
      const member = principals.find((p) => p?.id !== owner.id)!;
      assert.deepEqual([...member.scopes], IAP_MEMBER_SCOPES);
      assert.deepEqual(
        (
          await inspect.query(
            "SELECT role,count(*)::int AS count FROM oao.project_members GROUP BY role ORDER BY role::text",
          )
        ).rows,
        [
          { role: "member", count: 5 },
          { role: "owner", count: 1 },
        ],
      );
      assert.equal(
        (
          await inspect.query(
            "SELECT * FROM oao.audit_entries WHERE action='installation.initial_owner_created'",
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await inspect.query(
            "SELECT * FROM oao.audit_entries WHERE action='member.auto_provisioned'",
          )
        ).rowCount,
        5,
      );
      const repeats = await Promise.all(
        Array.from({ length: 6 }, () => login("0")),
      );
      assert.ok(repeats.every((p) => p?.id === principals[0]?.id));
      assert.equal(
        (await inspect.query("SELECT * FROM oao.principals")).rowCount,
        6,
      );
      assert.deepEqual(await ensureIapDefaultTenant(pool, audience), defaults);
      assert.equal(
        await resolver.resolvePrincipal({
          ...identities[0]!,
          subject: "accounts.google.com:999",
        }),
        undefined,
      );
      assert.equal(
        (
          await resolver.resolvePrincipal({
            ...identities[0]!,
            email: "renamed@example.test",
          })
        )?.id,
        principals[0]?.id,
      );

      await inspect.query(
        "DELETE FROM oao.project_members WHERE principal_id=$1",
        [member.id],
      );
      const revoked = identities.find(
        (_, i) => principals[i]?.id === member.id,
      )!;
      assert.equal(await resolver.resolvePrincipal(revoked), undefined);
      await inspect.query("DELETE FROM oao.project_members WHERE role='owner'");
      await inspect.query(
        "DELETE FROM oao.organization_members WHERE role='owner'",
      );
      assert.deepEqual(await ensureIapDefaultTenant(pool, audience), defaults);
      const later = await resolver.resolvePrincipal({
        subject: "accounts.google.com:1000",
        email: "later@example.test",
      });
      assert.ok(later);
      assert.deepEqual([...later.scopes], IAP_MEMBER_SCOPES);
      assert.equal(
        (
          await inspect.query(
            "SELECT * FROM oao.project_members WHERE role='owner'",
          )
        ).rowCount,
        0,
      );
    } finally {
      await pool.end();
      await inspect.end();
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    }
  },
);
