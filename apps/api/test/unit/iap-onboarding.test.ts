import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@oao/db-postgres";
import {
  IAP_MEMBER_SCOPES,
  onboardIapHuman,
} from "../../src/iap-onboarding.js";
import { PostgresIapTenantResolver } from "../../src/iap-postgres.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const expectedAudience =
  "/projects/123456789/locations/europe-west1/services/oao-api";
const identity = {
  subject: "accounts.google.com:123",
  email: "member@example.test",
};

test("onboarding rejects service identities and malformed human identities before DB access", async () => {
  const pool = {
    connect() {
      throw new Error("Unexpected DB access");
    },
  } as unknown as PgPool;
  for (const candidate of [
    { ...identity, subject: "service-account:123" },
    { ...identity, email: "worker@project.iam.gserviceaccount.com" },
    { ...identity, email: "a@@example.test" },
  ])
    await onboardIapHuman(pool, {
      identity: candidate,
      expectedAudience,
      organizationId,
      projectId,
    });
  assert.ok(!IAP_MEMBER_SCOPES.includes("*"));
  assert.ok(!IAP_MEMBER_SCOPES.includes("project:admin"));
  assert.ok(!IAP_MEMBER_SCOPES.includes("credential:write"));
  assert.ok(IAP_MEMBER_SCOPES.includes("agent:write"));
});

test("service identities and requests for another project or through Authorization do not onboard", async () => {
  const pool = {
    async query() {
      return { rows: [] };
    },
    connect() {
      throw new Error("Unexpected provisioning");
    },
  } as unknown as PgPool;
  await new PostgresIapTenantResolver({
    pool,
    expectedAudience,
    organizationId,
    projectId,
  }).resolvePrincipal({ ...identity, subject: "service-account:123" });
  const resolver = new PostgresIapTenantResolver({
    pool,
    expectedAudience,
    organizationId,
    projectId,
  });
  assert.equal(
    await resolver.resolvePrincipal(
      identity,
      new Request(
        "https://oao.example.test/v1/projects/00000000-0000-4000-8000-000000000099/agents",
      ),
    ),
    undefined,
  );
  assert.equal(
    await resolver.resolvePrincipal(
      identity,
      new Request("https://oao.example.test/v1/agents", {
        headers: { authorization: "Bearer invalid" },
      }),
    ),
    undefined,
  );
});

for (const failedWrite of [
  "INSERT INTO oao.project_members",
  "oao.append_audit_entry",
]) {
  test(`a failed ${failedWrite} rolls back the ownership claim and releases the connection`, async () => {
    const calls: string[] = [];
    const pool = {
      async connect() {
        return {
          async query(sql: string) {
            calls.push(sql);
            if (sql.includes(failedWrite)) throw new Error("test failure");
            return {
              rowCount: sql.includes("SELECT 1 FROM oao.auth_tenant_links")
                ? 1
                : 0,
              rows: sql.includes("claim_iap_initial_owner")
                ? [{ initial_owner: true }]
                : [],
            };
          },
          release() {
            calls.push("RELEASE");
          },
        };
      },
    } as unknown as PgPool;
    await assert.rejects(
      () =>
        onboardIapHuman(pool, {
          identity,
          expectedAudience,
          organizationId,
          projectId,
        }),
      /test failure/u,
    );
    assert.deepEqual(calls.slice(-2), ["ROLLBACK", "RELEASE"]);
    assert.ok(!calls.includes("COMMIT"));
  });
}
