import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationId, ProjectId } from "@oao/domain";
import { createPool, migrate, withTenantTransaction } from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

const ids = {
  organization: "00000000-0000-4000-8000-000000009901",
  projectA: "00000000-0000-4000-8000-000000009902",
  projectB: "00000000-0000-4000-8000-000000009903",
  principalA: "00000000-0000-4000-8000-000000009904",
  principalB: "00000000-0000-4000-8000-000000009905",
  agentA: "00000000-0000-4000-8000-000000009906",
  agentB: "00000000-0000-4000-8000-000000009907",
  versionA: "00000000-0000-4000-8000-000000009908",
  versionB: "00000000-0000-4000-8000-000000009909",
  threadA: "00000000-0000-4000-8000-000000009910",
  threadB: "00000000-0000-4000-8000-000000009911",
  sessionA: "00000000-0000-4000-8000-000000009912",
  sessionB: "00000000-0000-4000-8000-000000009913",
  runA: "00000000-0000-4000-8000-000000009914",
  runB: "00000000-0000-4000-8000-000000009915",
} as const;

test(
  "Cloud SQL recovery role preserves tenant isolation and sees recovery state",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    let testMembershipGranted = false;
    try {
      await migrate(pool);

      const appMembership = await pool.query<{
        set_option: boolean;
        inherit_option: boolean;
      }>(
        `SELECT membership.set_option, membership.inherit_option
           FROM pg_auth_members membership
           JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
           JOIN pg_roles member_role ON member_role.oid = membership.member
          WHERE granted_role.rolname = 'oao_app'
            AND member_role.rolname = current_user`,
      );
      assert.ok(
        appMembership.rows.some(
          (membership) => membership.set_option && !membership.inherit_option,
        ),
        "migration login must have explicit SET-only access to oao_app",
      );

      const transactionRole = await withTenantTransaction(
        pool,
        {
          organizationId: ids.organization as OrganizationId,
          projectId: ids.projectA as ProjectId,
        },
        async (transaction) => {
          const current = await transaction.query<{ role: string }>(
            "SELECT current_user AS role",
          );
          return current.rows[0]?.role;
        },
      );
      assert.equal(transactionRole, "oao_app");

      await pool.query(
        "GRANT oao_recovery TO CURRENT_USER WITH SET TRUE, INHERIT FALSE",
      );
      testMembershipGranted = true;
      const role = await pool.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolinherit, rolreplication, rolbypassrls
           FROM pg_roles
          WHERE rolname = 'oao_recovery'`,
      );
      assert.deepEqual(role.rows[0], {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      });

      const grants = await pool.query<{
        table_name: string;
        privilege_type: string;
      }>(
        `SELECT c.relname AS table_name, acl.privilege_type
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(c.relacl, acldefault('r', c.relowner))
          ) acl
          WHERE n.nspname = 'oao'
            AND c.relkind IN ('r', 'p')
            AND acl.grantee = 'oao_recovery'::regrole
          ORDER BY c.relname, acl.privilege_type`,
      );
      assert.deepEqual(grants.rows, [
        {
          table_name: "runtime_dispatches",
          privilege_type: "SELECT",
        },
        {
          table_name: "runtime_wake_jobs",
          privilege_type: "SELECT",
        },
        {
          table_name: "runtime_wake_jobs",
          privilege_type: "UPDATE",
        },
        {
          table_name: "thread_admission_heads",
          privilege_type: "SELECT",
        },
      ]);

      const policies = await pool.query<{
        tablename: string;
        cmd: string;
        qual: string;
      }>(
        `SELECT tablename, cmd, qual
           FROM pg_policies
          WHERE schemaname = 'oao'
            AND policyname = 'recovery_visibility'
            AND 'oao_recovery' = ANY (roles)
          ORDER BY tablename`,
      );
      assert.deepEqual(policies.rows, [
        {
          tablename: "runtime_dispatches",
          cmd: "SELECT",
          qual: "true",
        },
        {
          tablename: "runtime_wake_jobs",
          cmd: "ALL",
          qual: "true",
        },
        {
          tablename: "thread_admission_heads",
          cmd: "SELECT",
          qual: "true",
        },
      ]);

      const functions = await pool.query<{
        proname: string;
        owner: string;
        app_can_execute: boolean;
        runtime_can_execute: boolean;
        public_can_execute: boolean;
      }>(
        `SELECT p.proname,
                pg_get_userbyid(p.proowner) AS owner,
                has_function_privilege('oao_app', p.oid, 'EXECUTE') AS app_can_execute,
                has_function_privilege(current_user, p.oid, 'EXECUTE') AS runtime_can_execute,
                EXISTS (
                  SELECT 1
                    FROM aclexplode(
                      COALESCE(p.proacl, acldefault('f', p.proowner))
                    ) acl
                   WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
                ) AS public_can_execute
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'oao'
            AND p.proname IN (
              'claim_runtime_wakes',
              'complete_runtime_wake',
              'find_runtime_dispatch',
              'list_runtime_recovery_heads',
              'retry_runtime_wake',
              'runtime_has_active_dispatches'
            )
          ORDER BY p.proname`,
      );
      assert.deepEqual(functions.rows, [
        {
          proname: "claim_runtime_wakes",
          owner: "oao_recovery",
          app_can_execute: false,
          runtime_can_execute: true,
          public_can_execute: false,
        },
        {
          proname: "complete_runtime_wake",
          owner: "oao_recovery",
          app_can_execute: false,
          runtime_can_execute: true,
          public_can_execute: false,
        },
        {
          proname: "find_runtime_dispatch",
          owner: "oao_recovery",
          app_can_execute: false,
          runtime_can_execute: true,
          public_can_execute: false,
        },
        {
          proname: "list_runtime_recovery_heads",
          owner: "oao_recovery",
          app_can_execute: true,
          runtime_can_execute: true,
          public_can_execute: false,
        },
        {
          proname: "retry_runtime_wake",
          owner: "oao_recovery",
          app_can_execute: false,
          runtime_can_execute: true,
          public_can_execute: false,
        },
        {
          proname: "runtime_has_active_dispatches",
          owner: "oao_recovery",
          app_can_execute: true,
          runtime_can_execute: true,
          public_can_execute: false,
        },
      ]);

      await pool.query(
        "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'recovery-test','Recovery test')",
        [ids.organization],
      );
      await pool.query(
        `INSERT INTO oao.projects (organization_id,id,slug,name)
         VALUES ($1,$2,'recovery-a','Recovery A'),
                ($1,$3,'recovery-b','Recovery B')`,
        [ids.organization, ids.projectA, ids.projectB],
      );
      await pool.query(
        `INSERT INTO oao.principals
           (organization_id,project_id,id,kind,subject,scopes)
         VALUES ($1,$2,$3,'human','recovery-a',ARRAY['*']),
                ($1,$4,$5,'human','recovery-b',ARRAY['*'])`,
        [
          ids.organization,
          ids.projectA,
          ids.principalA,
          ids.projectB,
          ids.principalB,
        ],
      );
      await pool.query(
        `INSERT INTO oao.agent_definitions
           (organization_id,project_id,id,agent_key,name)
         VALUES ($1,$2,$3,'recovery-a','Recovery A'),
                ($1,$4,$5,'recovery-b','Recovery B')`,
        [ids.organization, ids.projectA, ids.agentA, ids.projectB, ids.agentB],
      );
      await pool.query(
        `INSERT INTO oao.agent_versions
           (organization_id,project_id,id,agent_definition_id,version,config,
            content_hash,created_by_principal_id)
         VALUES ($1,$2,$3,$4,1,'{}',digest('recovery-a','sha256'),$5),
                ($1,$6,$7,$8,1,'{}',digest('recovery-b','sha256'),$9)`,
        [
          ids.organization,
          ids.projectA,
          ids.versionA,
          ids.agentA,
          ids.principalA,
          ids.projectB,
          ids.versionB,
          ids.agentB,
          ids.principalB,
        ],
      );
      await pool.query(
        `INSERT INTO oao.threads (organization_id,project_id,id,title)
         VALUES ($1,$2,$3,'Recovery A'),($1,$4,$5,'Recovery B')`,
        [
          ids.organization,
          ids.projectA,
          ids.threadA,
          ids.projectB,
          ids.threadB,
        ],
      );
      await pool.query(
        `INSERT INTO oao.sessions
           (organization_id,project_id,id,thread_id,agent_version_id)
         VALUES ($1,$2,$3,$4,$5),($1,$6,$7,$8,$9)`,
        [
          ids.organization,
          ids.projectA,
          ids.sessionA,
          ids.threadA,
          ids.versionA,
          ids.projectB,
          ids.sessionB,
          ids.threadB,
          ids.versionB,
        ],
      );
      await pool.query(
        `INSERT INTO oao.runs
           (organization_id,project_id,id,thread_id,session_id,
            agent_version_id,created_by_principal_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'recovery-a'),
                ($1,$8,$9,$10,$11,$12,$13,'recovery-b')`,
        [
          ids.organization,
          ids.projectA,
          ids.runA,
          ids.threadA,
          ids.sessionA,
          ids.versionA,
          ids.principalA,
          ids.projectB,
          ids.runB,
          ids.threadB,
          ids.sessionB,
          ids.versionB,
          ids.principalB,
        ],
      );
      await pool.query(
        `INSERT INTO oao.thread_admission_heads
           (organization_id,project_id,thread_id,run_id,admission_key,request_hash)
         VALUES ($1,$2,$3,$4,'recovery-a',digest('recovery-a','sha256')),
                ($1,$5,$6,$7,'recovery-b',digest('recovery-b','sha256'))`,
        [
          ids.organization,
          ids.projectA,
          ids.threadA,
          ids.runA,
          ids.projectB,
          ids.threadB,
          ids.runB,
        ],
      );
      await pool.query(
        `INSERT INTO oao.runtime_thread_instances
           (organization_id,project_id,thread_id,session_id,agent_version_id,
            snapshot_hash,flue_instance_id)
         VALUES ($1,$2,$3,$4,$5,digest('recovery-a','sha256'),'recovery-a'),
                ($1,$6,$7,$8,$9,digest('recovery-b','sha256'),'recovery-b')`,
        [
          ids.organization,
          ids.projectA,
          ids.threadA,
          ids.sessionA,
          ids.versionA,
          ids.projectB,
          ids.threadB,
          ids.sessionB,
          ids.versionB,
        ],
      );
      await pool.query(
        `INSERT INTO oao.runtime_dispatches
           (organization_id,project_id,run_id,thread_id,admission_key,
            request_hash,snapshot_hash,state,fence,flue_conversation_id,deadline_at)
         VALUES ($1,$2,$3,$4,'recovery-a',digest('request-a','sha256'),
                 digest('snapshot-a','sha256'),'settled',1,'recovery-a',clock_timestamp()),
                ($1,$5,$6,$7,'recovery-b',digest('request-b','sha256'),
                 digest('snapshot-b','sha256'),'admitted',1,'recovery-b',clock_timestamp())`,
        [
          ids.organization,
          ids.projectA,
          ids.runA,
          ids.threadA,
          ids.projectB,
          ids.runB,
          ids.threadB,
        ],
      );

      const settledDispatch = await pool.query<{ run_id: string }>(
        "SELECT run_id FROM oao.find_runtime_dispatch('', 'recovery-a')",
      );
      assert.equal(settledDispatch.rows[0]?.run_id, ids.runA);

      const appClient = await pool.connect();
      try {
        await appClient.query("BEGIN");
        await appClient.query("SET LOCAL ROLE oao_app");
        await appClient.query("SELECT oao.set_tenant_context($1,$2)", [
          ids.organization,
          ids.projectA,
        ]);
        const directHeads = await appClient.query<{ run_id: string }>(
          `SELECT run_id FROM oao.thread_admission_heads
            WHERE run_id = ANY($1::uuid[]) ORDER BY run_id`,
          [[ids.runA, ids.runB]],
        );
        assert.deepEqual(
          directHeads.rows.map((row) => row.run_id),
          [ids.runA],
        );
        const directActive = await appClient.query<{ active: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM oao.runtime_dispatches
              WHERE run_id = ANY($1::uuid[]) AND state <> 'settled'
           ) AS active`,
          [[ids.runA, ids.runB]],
        );
        assert.equal(directActive.rows[0]?.active, false);

        const recoveryHeads = await appClient.query<{ run_id: string }>(
          `SELECT run_id FROM oao.list_runtime_recovery_heads()
            WHERE run_id = ANY($1::uuid[]) ORDER BY run_id`,
          [[ids.runA, ids.runB]],
        );
        assert.deepEqual(
          recoveryHeads.rows.map((row) => row.run_id),
          [ids.runA, ids.runB],
        );
        const recoveryActive = await appClient.query<{ active: boolean }>(
          "SELECT oao.runtime_has_active_dispatches() AS active",
        );
        assert.equal(recoveryActive.rows[0]?.active, true);
      } finally {
        await appClient.query("ROLLBACK").catch(() => undefined);
        appClient.release();
      }

      const recoveryClient = await pool.connect();
      try {
        await recoveryClient.query("BEGIN");
        await recoveryClient.query("SET LOCAL ROLE oao_recovery");
        const visible = await recoveryClient.query<{ run_id: string }>(
          `SELECT run_id FROM oao.runtime_dispatches
            WHERE run_id = ANY($1::uuid[]) ORDER BY run_id`,
          [[ids.runA, ids.runB]],
        );
        assert.deepEqual(
          visible.rows.map((row) => row.run_id),
          [ids.runA, ids.runB],
        );
        await assert.rejects(
          recoveryClient.query("SELECT id FROM oao.runs LIMIT 1"),
          /permission denied/u,
        );
      } finally {
        await recoveryClient.query("ROLLBACK").catch(() => undefined);
        recoveryClient.release();
      }
    } finally {
      if (testMembershipGranted)
        await pool
          .query("REVOKE oao_recovery FROM CURRENT_USER")
          .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM oao.runtime_dispatches WHERE run_id = ANY($1::uuid[])",
          [[ids.runA, ids.runB]],
        )
        .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM oao.runtime_thread_instances WHERE thread_id = ANY($1::uuid[])",
          [[ids.threadA, ids.threadB]],
        )
        .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM oao.thread_admission_heads WHERE run_id = ANY($1::uuid[])",
          [[ids.runA, ids.runB]],
        )
        .catch(() => undefined);
      await pool
        .query("DELETE FROM oao.runs WHERE id = ANY($1::uuid[])", [
          [ids.runA, ids.runB],
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM oao.sessions WHERE id = ANY($1::uuid[])", [
          [ids.sessionA, ids.sessionB],
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM oao.threads WHERE id = ANY($1::uuid[])", [
          [ids.threadA, ids.threadB],
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM oao.agent_versions WHERE id = ANY($1::uuid[])", [
          [ids.versionA, ids.versionB],
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM oao.agent_definitions WHERE id = ANY($1::uuid[])", [
          [ids.agentA, ids.agentB],
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM oao.principals WHERE id = ANY($1::uuid[])", [
          [ids.principalA, ids.principalB],
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM oao.projects WHERE organization_id = $1", [
          ids.organization,
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM oao.organizations WHERE id = $1", [
          ids.organization,
        ])
        .catch(() => undefined);
      await pool.end();
    }
  },
);
