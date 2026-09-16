import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { IapAuthAdapter } from "@oao/auth-iap";
import { createPool, migrate } from "@oao/db-postgres";
import { AUTHORIZATION_ACTIONS } from "@oao/domain";
import { createApiApp } from "../../src/app.js";
import { ensureIapDefaultTenant } from "../../src/iap-defaults.js";
import { IAP_MEMBER_SCOPES } from "../../src/iap-onboarding.js";
import { PostgresIapTenantResolver } from "../../src/iap-postgres.js";
import { provisionIapIdentity } from "../../src/iap-provisioning.js";
import { PostgresApiStore } from "../../src/store.js";

const adminUrl = process.env.OAO_TEST_ADMIN_DATABASE_URL;
const runtimeUrl = process.env.OAO_TEST_RUNTIME_DATABASE_URL;
const harness = adminUrl && runtimeUrl && process.env.DATABASE_URL === adminUrl;

test(
  "IAP owners appoint owners, admins grant admin access, and demotion/removal revoke authority",
  {
    skip: !harness && "Run pnpm test:postgres:fresh",
  },
  async () => {
    assert.ok(adminUrl && runtimeUrl);
    const dbName = `oao_roles_${randomUUID().replaceAll("-", "")}`;
    const admin = createPool(adminUrl);
    const runtimeConnection = new URL(runtimeUrl);
    const inspectorConnection = new URL(adminUrl);
    runtimeConnection.pathname = inspectorConnection.pathname = `/${dbName}`;
    const pool = createPool(runtimeConnection.toString());
    const inspect = createPool(inspectorConnection.toString());
    try {
      await admin.query(`CREATE DATABASE "${dbName}" OWNER oao_runtime`);
      await migrate(pool);
      const expectedAudience =
        "/projects/123/locations/europe-west1/services/roles";
      const tenant = await ensureIapDefaultTenant(pool, expectedAudience);
      const resolver = new PostgresIapTenantResolver({
        pool,
        expectedAudience,
        ...tenant,
      });
      const identities = ["owner", "alice", "bob"].map((name, index) => ({
        subject: `accounts.google.com:${100 + index}`,
        email: `${name}@example.test`,
      }));
      const principals = [];
      for (const identity of identities)
        principals.push((await resolver.resolvePrincipal(identity))!);
      const [owner, alice, bob] = principals;
      assert.ok(owner && alice && bob);
      const app = createApiApp({
        store: new PostgresApiStore(pool, "test-pepper-at-least-16-characters"),
        auth: new IapAuthAdapter({
          tenants: resolver,
          verifier: { verify: async (token) => identities[Number(token)] },
        }),
        runtimeCommands: {
          enqueue: async () => {
            throw new Error("No runtime work expected");
          },
        },
        authConfiguration: {
          provider: "iap",
          appOrigin: "https://oao.example.test",
          appOrigins: ["https://oao.example.test"],
          callbackUri: "https://oao.example.test/v1/auth/callback",
          cookieSecure: true,
        },
      });
      const request = async (
        who: number,
        path: string,
        method = "GET",
        body?: unknown,
        token?: string,
      ) =>
        app.request(`https://oao.example.test/v1${path}`, {
          method,
          headers: {
            "x-goog-iap-jwt-assertion": String(who),
            origin: "https://oao.example.test",
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const waitForAdvisoryWaiters = async (count: number) => {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const locks = await inspect.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
          );
          if ((locks.rowCount ?? 0) >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.fail(`Expected ${count} advisory-lock waiters`);
      };
      const path = `/projects/${tenant.projectId}`;
      const change = (who: number, id: string, role: string) =>
        request(who, `${path}/members/${id}`, "PATCH", { role });
      const ownerContext = await request(0, "/context");
      assert.equal(ownerContext.status, 200, await ownerContext.clone().text());
      assert.equal(
        (await ownerContext.json()).principal.organizationRole,
        "owner",
      );
      const before = await (await request(1, "/context")).json();
      assert.equal(before.principal.organizationRole, "member");
      assert.deepEqual(before.principal.scopes, IAP_MEMBER_SCOPES);
      assert.equal((await change(1, bob.id, "admin")).status, 403);

      // Legacy operator provisioning shares the same email lock as first login.
      const legacyPrincipal = randomUUID();
      const legacyIdentity = {
        subject: "accounts.google.com:10999",
        email: "legacy-race@example.test",
      };
      await inspect.query(
        "INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes) VALUES ($1,$2,$3,'human','legacy-operator',$4)",
        [
          tenant.organizationId,
          tenant.projectId,
          legacyPrincipal,
          [...IAP_MEMBER_SCOPES],
        ],
      );
      await inspect.query(
        "INSERT INTO oao.project_members (organization_id,project_id,principal_id,role) VALUES ($1,$2,$3,'member')",
        [tenant.organizationId, tenant.projectId, legacyPrincipal],
      );
      const emailBlocker = await inspect.connect();
      let pendingProvision: Promise<void> | undefined;
      let pendingLogin:
        ReturnType<typeof resolver.resolvePrincipal> | undefined;
      try {
        await emailBlocker.query("BEGIN");
        await emailBlocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [
            `${tenant.organizationId}/${tenant.projectId}/${legacyIdentity.email}`,
          ],
        );
        pendingProvision = provisionIapIdentity(pool, {
          ...tenant,
          principalId: legacyPrincipal,
          expectedAudience,
          email: legacyIdentity.email,
        });
        pendingLogin = resolver.resolvePrincipal(legacyIdentity);
        await waitForAdvisoryWaiters(2);
        await emailBlocker.query("COMMIT");
        await Promise.allSettled([pendingProvision, pendingLogin]);
        const mappings = await inspect.query(
          "SELECT principal_id FROM oao.auth_identities WHERE organization_id=$1 AND project_id=$2 AND provider='iap' AND email=$3",
          [tenant.organizationId, tenant.projectId, legacyIdentity.email],
        );
        assert.equal(
          mappings.rowCount,
          1,
          "Provisioning and auto-onboarding cannot create conflicting email mappings",
        );
        assert.equal(
          (await resolver.resolvePrincipal(legacyIdentity))?.id,
          mappings.rows[0].principal_id,
        );
        await provisionIapIdentity(pool, {
          ...tenant,
          principalId: mappings.rows[0].principal_id,
          expectedAudience,
          email: legacyIdentity.email,
        });
      } finally {
        await emailBlocker.query("ROLLBACK");
        emailBlocker.release();
        await Promise.allSettled([pendingProvision, pendingLogin]);
      }

      // Existing project copies of a person must not retain stale privileges.
      const otherProject = randomUUID();
      const otherAlice = randomUUID();
      await inspect.query(
        "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'other','Other')",
        [tenant.organizationId, otherProject],
      );
      await inspect.query(
        "INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes) VALUES ($1,$2,$3,'human',$4,$5)",
        [
          tenant.organizationId,
          otherProject,
          otherAlice,
          "legacy-alice-other-project",
          [...alice.scopes],
        ],
      );
      await inspect.query(
        "INSERT INTO oao.project_members (organization_id,project_id,principal_id,role) VALUES ($1,$2,$3,'member')",
        [tenant.organizationId, otherProject, otherAlice],
      );
      await inspect.query(
        "INSERT INTO oao.auth_identities (organization_id,project_id,principal_id,provider,provider_subject,email) VALUES ($1,$2,$3,'iap',$4,$5)",
        [
          tenant.organizationId,
          otherProject,
          otherAlice,
          identities[1]!.subject,
          identities[1]!.email,
        ],
      );

      await inspect.query(
        "INSERT INTO oao.auth_tenant_links (organization_id,project_id,provider,provider_tenant_id) VALUES ($1,$2,'iap',$3)",
        [tenant.organizationId, otherProject, expectedAudience],
      );
      assert.equal(
        (
          await request(1, "/auth/switch-project", "POST", {
            projectId: otherProject,
          })
        ).status,
        200,
        "IAP switching follows the immutable identity across legacy aliases",
      );
      await inspect.query(
        "UPDATE oao.auth_tenant_links SET provider_tenant_id=$2 WHERE project_id=$1 AND provider='iap'",
        [otherProject, expectedAudience + "-other"],
      );
      assert.equal(
        (
          await request(1, "/auth/switch-project", "POST", {
            projectId: otherProject,
          })
        ).status,
        403,
        "Switching cannot bypass the target IAP audience",
      );
      await inspect.query(
        "UPDATE oao.auth_tenant_links SET provider_tenant_id=$2 WHERE project_id=$1 AND provider='iap'",
        [otherProject, expectedAudience],
      );
      const unlinkedProject = randomUUID();
      const unlinkedAlice = randomUUID();
      await inspect.query(
        "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'unlinked','Unlinked')",
        [tenant.organizationId, unlinkedProject],
      );
      await inspect.query(
        "INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes) VALUES ($1,$2,$3,'human',$4,ARRAY['*'])",
        [tenant.organizationId, unlinkedProject, unlinkedAlice, alice.subject],
      );
      await inspect.query(
        "INSERT INTO oao.project_members (organization_id,project_id,principal_id,role) VALUES ($1,$2,$3,'owner')",
        [tenant.organizationId, unlinkedProject, unlinkedAlice],
      );
      assert.equal(
        (
          await request(1, "/auth/switch-project", "POST", {
            projectId: unlinkedProject,
          })
        ).status,
        403,
        "Unlinked same-subject principals cannot supply wildcard access",
      );
      const promoted = await change(0, alice.id, "admin");
      assert.equal(promoted.status, 200, await promoted.clone().text());
      const member = await promoted.json();
      assert.equal(member.organizationRole, "admin");
      assert.equal(member.role, "admin");
      assert.deepEqual(
        [...member.scopes].sort(),
        [...AUTHORIZATION_ACTIONS].sort(),
      );
      assert.ok(!member.scopes.includes("*"));
      assert.equal(
        (await change(1, bob.id, "admin")).status,
        200,
        "Admins can promote other users",
      );
      assert.equal(
        (await change(1, owner.id, "member")).status,
        403,
        "Owner access is protected",
      );
      assert.equal(
        (await change(1, bob.id, "owner")).status,
        403,
        "No implicit owner grant",
      );
      assert.equal(
        (await change(1, alice.id, "viewer")).status,
        400,
        "No self lockout",
      );
      assert.equal(
        (
          await request(1, `${path}/members`, "POST", {
            subject: alice.subject,
            role: "owner",
            scopes: ["*"],
          })
        ).status,
        400,
        "Generic member upsert cannot bypass IAP project-access input",
      );

      const projectResponse = await request(0, "/projects", "POST", {
        slug: "shared-project",
        name: "Shared project",
      });
      assert.equal(
        projectResponse.status,
        201,
        await projectResponse.clone().text(),
      );
      const sharedProjectId = (await projectResponse.json()).id as string;
      const pendingPrincipal = randomUUID();
      await inspect.query(
        "INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes) VALUES ($1,$2,$3,'human','pending-project-user',$4)",
        [
          tenant.organizationId,
          tenant.projectId,
          pendingPrincipal,
          [...IAP_MEMBER_SCOPES],
        ],
      );
      await inspect.query(
        "INSERT INTO oao.organization_members (organization_id,principal_id,role) VALUES ($1,$2,'member')",
        [tenant.organizationId, pendingPrincipal],
      );
      await inspect.query(
        "INSERT INTO oao.project_members (organization_id,project_id,principal_id,role) VALUES ($1,$2,$3,'member')",
        [tenant.organizationId, tenant.projectId, pendingPrincipal],
      );
      await provisionIapIdentity(pool, {
        ...tenant,
        principalId: pendingPrincipal,
        expectedAudience,
        email: "pending-project-user@example.test",
      });
      assert.equal(
        (
          await request(0, `/projects/${sharedProjectId}/members`, "POST", {
            email: "pending-project-user@example.test",
          })
        ).status,
        404,
        "Provisioned users must complete IAP sign-in before project access is copied",
      );
      const legacySharedAlice = randomUUID();
      await inspect.query(
        "INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes) VALUES ($1,$2,$3,'human',$4,$5)",
        [
          tenant.organizationId,
          sharedProjectId,
          legacySharedAlice,
          alice.subject,
          [...IAP_MEMBER_SCOPES],
        ],
      );
      await inspect.query(
        "INSERT INTO oao.project_members (organization_id,project_id,principal_id,role) VALUES ($1,$2,$3,'viewer')",
        [tenant.organizationId, sharedProjectId, legacySharedAlice],
      );
      assert.equal(
        (
          await request(1, "/auth/switch-project", "POST", {
            projectId: sharedProjectId,
          })
        ).status,
        403,
        "IAP sign-in does not grant access to every project",
      );
      const grantProjectAccess = await request(
        0,
        `/projects/${sharedProjectId}/members`,
        "POST",
        { email: identities[1]!.email },
      );
      assert.equal(
        grantProjectAccess.status,
        201,
        await grantProjectAccess.clone().text(),
      );
      const sharedAlice = await grantProjectAccess.json();
      assert.equal(
        sharedAlice.id,
        legacySharedAlice,
        "Granting access links a safe unlinked legacy principal instead of duplicating it",
      );
      assert.equal(sharedAlice.organizationRole, "admin");
      assert.equal(sharedAlice.role, "admin");
      assert.equal(
        (
          await request(1, "/auth/switch-project", "POST", {
            projectId: sharedProjectId,
          })
        ).status,
        200,
        "An owner can grant an existing IAP user project access",
      );
      assert.equal(
        (
          await request(
            0,
            `${path}/members/${alice.id}/project-access`,
            "DELETE",
          )
        ).status,
        400,
        "Default-project membership cannot be removed while it anchors IAP authentication",
      );
      assert.equal(
        (await request(1, "/context")).status,
        200,
        "Rejected default-project removal preserves console authentication",
      );
      assert.equal(
        (
          await request(
            0,
            `/projects/${sharedProjectId}/members/${sharedAlice.id}/project-access`,
            "DELETE",
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await request(1, "/auth/switch-project", "POST", {
            projectId: sharedProjectId,
          })
        ).status,
        403,
        "Project-only removal leaves no switchable membership",
      );
      assert.equal(
        (await (await request(1, "/context")).json()).principal
          .organizationRole,
        "admin",
        "Project-only removal preserves organization access",
      );
      assert.equal(
        (
          await request(0, `/projects/${sharedProjectId}/members`, "POST", {
            email: identities[1]!.email,
          })
        ).status,
        201,
        "A removed project membership can be restored safely",
      );
      assert.equal(
        (
          await request(0, `/projects/${sharedProjectId}/members`, "POST", {
            email: "never-signed-in@example.test",
          })
        ).status,
        404,
        "Only verified IAP organization users can be added",
      );
      assert.equal(
        (await request(1, `${path}/members/${owner.id}`, "DELETE")).status,
        403,
      );
      const copies = await inspect.query(
        "SELECT scopes FROM oao.principals WHERE id=$1",
        [otherAlice],
      );
      assert.ok(copies.rows[0].scopes.includes("project:admin"));

      const otherMembers = await request(
        1,
        `/projects/${otherProject}/members`,
      );
      assert.equal(otherMembers.status, 200);
      assert.equal(
        (await otherMembers.json()).data[0].organizationRole,
        "admin",
        "Legacy aliases resolve organization roles by immutable IAP identity",
      );
      const keyResponse = await request(
        1,
        `/projects/${otherProject}/api-keys`,
        "POST",
        {
          name: "Admin test key",
          scopes: ["project:admin"],
        },
      );
      assert.equal(keyResponse.status, 201, await keyResponse.clone().text());
      const key = await keyResponse.json();
      const childKeyResponse = await request(
        1,
        `${path}/api-keys`,
        "POST",
        { name: "Derived key", scopes: ["project:admin"] },
        key.secret,
      );
      assert.equal(childKeyResponse.status, 201);
      const childKey = await childKeyResponse.json();
      assert.equal(
        (
          await request(
            1,
            `${path}/members/${bob.id}`,
            "PATCH",
            { role: "admin" },
            key.secret,
          )
        ).status,
        403,
        "API keys cannot administer IAP humans",
      );
      assert.equal(
        (
          await request(1, `${path}/api-keys`, "POST", {
            name: "Wildcard",
            scopes: ["*"],
          })
        ).status,
        403,
      );
      const deletedCreatorId = randomUUID();
      await inspect.query(
        "UPDATE oao.api_keys SET created_by_principal_id=$2 WHERE organization_id=$1 AND id=$3",
        [tenant.organizationId, deletedCreatorId, key.id],
      );
      assert.equal(
        (
          await inspect.query("SELECT 1 FROM oao.principals WHERE id=$1", [
            deletedCreatorId,
          ])
        ).rowCount,
        0,
        "Project deletion can leave organization keys with a deleted creator UUID",
      );
      assert.equal(
        (
          await inspect.query(
            "SELECT created_by_iap_subject FROM oao.api_keys WHERE id=$1",
            [key.id],
          )
        ).rows[0].created_by_iap_subject,
        identities[1]!.subject,
        "API keys retain durable IAP creator provenance after their principal is deleted",
      );

      assert.equal(
        (await change(2, alice.id, "member")).status,
        200,
        "Another admin can demote an admin",
      );
      assert.deepEqual(
        (await resolver.resolvePrincipal(identities[1]!))?.scopes,
        new Set(IAP_MEMBER_SCOPES),
      );
      assert.equal((await change(1, bob.id, "member")).status, 403);
      assert.equal(
        (await request(1, `${path}/members`, "GET", undefined, key.secret))
          .status,
        401,
        "Demotion revokes keys even after their creator project was deleted",
      );
      assert.equal(
        (await request(1, `${path}/members`, "GET", undefined, childKey.secret))
          .status,
        401,
        "Keys derived from a revoked user key cannot retain authority",
      );
      assert.equal((await change(0, alice.id, "viewer")).status, 200);
      const viewer = (await resolver.resolvePrincipal(identities[1]!))!;
      await assert.rejects(
        new PostgresApiStore(
          pool,
          "test-pepper-at-least-16-characters",
        ).transaction(viewer, "agent:write", async () => undefined),
        /required scope/,
      );
      assert.equal(
        (await request(2, `${path}/members/${alice.id}`, "DELETE")).status,
        200,
      );
      assert.equal(
        await resolver.resolvePrincipal(identities[1]!),
        undefined,
        "Revoked identity cannot auto-rejoin",
      );
      assert.equal(
        (
          await inspect.query(
            "SELECT 1 FROM oao.project_members WHERE principal_id=ANY($1::uuid[])",
            [[alice.id, otherAlice]],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await inspect.query(
            "SELECT role FROM oao.organization_members WHERE principal_id=$1",
            [owner.id],
          )
        ).rows[0].role,
        "owner",
      );
      const appointedOwner = await change(0, bob.id, "owner");
      assert.equal(
        appointedOwner.status,
        200,
        await appointedOwner.clone().text(),
      );
      assert.equal((await appointedOwner.json()).organizationRole, "owner");
      assert.deepEqual(
        [...(await resolver.resolvePrincipal(identities[2]!))!.scopes],
        ["*"],
      );
      assert.equal(
        (await (await request(2, "/context")).json()).principal
          .organizationRole,
        "owner",
      );
      const ownerKeyResponse = await request(0, `${path}/api-keys`, "POST", {
        name: "Owner key",
        scopes: ["*"],
      });
      assert.equal(ownerKeyResponse.status, 201);
      const ownerKey = await ownerKeyResponse.json();
      assert.equal(
        (await change(2, owner.id, "admin")).status,
        200,
        "An owner can demote another owner",
      );
      assert.ok(
        !(await resolver.resolvePrincipal(identities[0]!))!.scopes.has("*"),
      );
      assert.equal(
        (await request(0, `${path}/members`, "GET", undefined, ownerKey.secret))
          .status,
        401,
      );
      assert.equal(
        (await change(0, bob.id, "admin")).status,
        403,
        "The former owner no longer controls owners",
      );
      assert.equal(
        (await change(2, bob.id, "admin")).status,
        400,
        "The last owner cannot demote itself",
      );
      assert.equal(
        (await request(2, `${path}/members/${bob.id}`, "DELETE")).status,
        409,
      );
      assert.equal(
        (
          await inspect.query(
            "SELECT count(DISTINCT principal_id)::int AS count FROM oao.organization_members WHERE role='owner'",
          )
        ).rows[0].count,
        1,
      );
      assert.equal(
        (
          await inspect.query(
            "SELECT count(*)::int AS count FROM oao.audit_entries WHERE action='member.organization_role_changed'",
          )
        ).rows[0].count,
        6,
      );
      // A request authenticated before demotion cannot mint a new key after it.
      const blocker = await inspect.connect();
      let pendingKey: Promise<Response> | undefined;
      let pendingProject: Promise<Response> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SET LOCAL ROLE oao_app");
        await blocker.query("SELECT oao.set_tenant_context($1,$2)", [
          tenant.organizationId,
          tenant.projectId,
        ]);
        await blocker.query(
          "SELECT oao.change_iap_member_role($1,$2,$3,$4,'member')",
          [tenant.organizationId, tenant.projectId, bob.id, owner.id],
        );
        pendingKey = request(0, `${path}/api-keys`, "POST", {
          name: "Must not survive demotion",
          scopes: ["project:admin"],
        });
        pendingProject = request(0, "/projects", "POST", {
          name: "Must not survive demotion",
          slug: "must-not-survive-demotion",
        });
        await waitForAdvisoryWaiters(2);
        await blocker.query("COMMIT");
        assert.equal((await pendingKey).status, 403);
        assert.equal((await pendingProject).status, 403);
        assert.equal(
          (
            await inspect.query(
              "SELECT 1 FROM oao.projects WHERE slug='must-not-survive-demotion'",
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await inspect.query(
              "SELECT 1 FROM oao.api_keys WHERE name='Must not survive demotion'",
            )
          ).rowCount,
          0,
        );
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await pendingKey;
        await pendingProject;
      }
    } finally {
      await pool.end();
      await inspect.end();
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    }
  },
);
