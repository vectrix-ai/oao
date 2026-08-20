import assert from "node:assert/strict";
import test from "node:test";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
  ToolCallId,
} from "@oao/domain";
import {
  PostgresFoundationRepository,
  createPool,
  migrate,
  type PgClient,
  withTenantTransaction,
} from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

const ids = {
  organization: uuid(900) as OrganizationId,
  project: uuid(901) as ProjectId,
  principal: uuid(902) as PrincipalId,
  secondPrincipal: uuid(903) as PrincipalId,
  agent: uuid(904),
  version: uuid(905),
  thread: uuid(906),
  session: uuid(907),
  run: uuid(908) as RunId,
  toolCall: uuid(909) as ToolCallId,
  apiKey: uuid(910),
  authSession: uuid(911),
  apiKeyPrincipal: uuid(912) as PrincipalId,
  otherOrganization: uuid(920) as OrganizationId,
  otherProject: uuid(921) as ProjectId,
  otherPrincipal: uuid(922) as PrincipalId,
} as const;

const tenant = {
  organizationId: ids.organization,
  projectId: ids.project,
};

async function asApp<T>(
  pool: ReturnType<typeof createPool>,
  callback: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE oao_app");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

test(
  "PostgreSQL API/auth invariants",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    const repository = new PostgresFoundationRepository();
    try {
      await migrate(pool);
      await pool.query(
        "SELECT oao.bootstrap_project($1,'api-auth-org','API auth organization',$2,'api-auth-project','API auth project',$3,'development-user','development')",
        [ids.organization, ids.project, ids.principal],
      );
      await pool.query(
        "SELECT oao.bootstrap_project($1,'other-api-auth-org','Other organization',$2,'other-api-auth-project','Other project',$3,'other-development-user','development')",
        [ids.otherOrganization, ids.otherProject, ids.otherPrincipal],
      );
      await pool.query(
        `INSERT INTO oao.principals
          (organization_id,project_id,id,kind,subject,scopes)
         VALUES
           ($1,$2,$3,'human','second-development-user',ARRAY['run:read']),
           ($1,$2,$4,'api_key','api-key:test',ARRAY['run:read'])
         ON CONFLICT DO NOTHING`,
        [
          ids.organization,
          ids.project,
          ids.secondPrincipal,
          ids.apiKeyPrincipal,
        ],
      );

      await t.test(
        "bootstrap is idempotent and memberships remain tenant-isolated",
        async () => {
          await pool.query(
            "SELECT oao.bootstrap_project($1,'api-auth-org','API auth organization',$2,'api-auth-project','API auth project',$3,'development-user','development')",
            [ids.organization, ids.project, ids.principal],
          );
          const visible = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              transaction.query(
                `SELECT organization_id, project_id, principal_id, role
                 FROM oao.project_members ORDER BY principal_id`,
              ),
          );
          assert.deepEqual(visible.rows, [
            {
              organization_id: ids.organization,
              project_id: ids.project,
              principal_id: ids.principal,
              role: "owner",
            },
          ]);
          const otherVisible = await withTenantTransaction(
            pool,
            {
              organizationId: ids.otherOrganization,
              projectId: ids.otherProject,
            },
            (transaction) =>
              transaction.query("SELECT principal_id FROM oao.project_members"),
          );
          assert.deepEqual(otherVisible.rows, [
            { principal_id: ids.otherPrincipal },
          ]);
        },
      );

      await t.test(
        "API keys store only keyed hashes and authenticate before tenant context",
        async () => {
          await withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              `INSERT INTO oao.api_keys
                (organization_id,project_id,id,principal_id,name,key_prefix,key_hash,scopes,created_by_principal_id)
               VALUES ($1,$2,$3,$4,'Test key','abcdef12',digest('keyed-value','sha256'),ARRAY['run:read'],$5)`,
              [
                ids.organization,
                ids.project,
                ids.apiKey,
                ids.apiKeyPrincipal,
                ids.principal,
              ],
            ),
          );
          const columns = await pool.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema='oao' AND table_name='api_keys'`,
          );
          assert.equal(
            columns.rows.some((row) =>
              /(?:secret|raw|plain)/u.test(row.column_name),
            ),
            false,
          );
          const authenticated = await asApp(pool, (client) =>
            client.query(
              "SELECT * FROM oao.authenticate_api_key('abcdef12',digest('keyed-value','sha256'),clock_timestamp())",
            ),
          );
          assert.deepEqual(authenticated.rows, [
            {
              organization_id: ids.organization,
              project_id: ids.project,
              principal_id: ids.apiKeyPrincipal,
              scopes: ["run:read"],
            },
          ]);
          assert.equal(
            (
              await withTenantTransaction(pool, tenant, (transaction) =>
                transaction.query(
                  "SELECT last_used_at IS NOT NULL AS used FROM oao.api_keys WHERE id=$1",
                  [ids.apiKey],
                ),
              )
            ).rows[0]?.used,
            true,
          );
          await withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              "UPDATE oao.api_keys SET revoked_at=clock_timestamp() WHERE id=$1",
              [ids.apiKey],
            ),
          );
          assert.equal(
            (
              await asApp(pool, (client) =>
                client.query(
                  "SELECT * FROM oao.authenticate_api_key('abcdef12',digest('keyed-value','sha256'),clock_timestamp())",
                ),
              )
            ).rowCount,
            0,
          );
        },
      );

      await t.test(
        "auth sessions resolve by hash without exposing session material",
        async () => {
          await withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              `INSERT INTO oao.auth_sessions
                (organization_id,project_id,id,principal_id,provider,session_key_hash,expires_at)
               VALUES ($1,$2,$3,$4,'development',digest('session-value','sha256'),clock_timestamp()+interval '1 hour')`,
              [ids.organization, ids.project, ids.authSession, ids.principal],
            ),
          );
          const resolved = await asApp(pool, (client) =>
            client.query(
              "SELECT * FROM oao.resolve_auth_session(digest('session-value','sha256'),clock_timestamp())",
            ),
          );
          assert.equal(resolved.rows[0]?.subject, "development-user");
          assert.equal(resolved.rows[0]?.provider, "development");
        },
      );

      await t.test(
        "WorkOS webhook claims replay only byte-identical verified bodies",
        async () => {
          const claim = (body: string) =>
            asApp(pool, (client) =>
              client.query(
                "SELECT oao.claim_workos_webhook_event('evt_api_auth','user.updated',digest($1,'sha256')) AS outcome",
                [body],
              ),
            );
          assert.equal((await claim("body-a")).rows[0]?.outcome, "claimed");
          assert.equal((await claim("body-a")).rows[0]?.outcome, "in_progress");
          await assert.rejects(claim("body-b"), /replay conflict/u);
          assert.equal(
            (
              await asApp(pool, (client) =>
                client.query(
                  "SELECT oao.release_workos_webhook_event('evt_api_auth',digest('body-a','sha256'),'{\"code\":\"retry\"}') AS outcome",
                ),
              )
            ).rows[0]?.outcome,
            "released",
          );
          assert.equal((await claim("body-a")).rows[0]?.outcome, "claimed");
          assert.equal(
            (
              await asApp(pool, (client) =>
                client.query(
                  "SELECT oao.complete_workos_webhook_event('evt_api_auth',digest('body-a','sha256'),'{}') AS outcome",
                ),
              )
            ).rows[0]?.outcome,
            "completed",
          );
          assert.equal((await claim("body-a")).rows[0]?.outcome, "replayed");
        },
      );

      await t.test(
        "write idempotency is isolated by principal and route and completes immutably",
        async () => {
          const claim = (
            principal: PrincipalId,
            route: string,
            hash = "request-a",
          ) =>
            withTenantTransaction(pool, tenant, (transaction) =>
              transaction.query(
                `SELECT oao.claim_api_request_idempotency(
                  $1,$2,$3,'POST',$4,'same-key',digest($5,'sha256'),clock_timestamp()+interval '1 hour'
                ) AS outcome`,
                [ids.organization, ids.project, principal, route, hash],
              ),
            );
          assert.equal(
            (await claim(ids.principal, "/v1/runs")).rows[0]?.outcome,
            "claimed",
          );
          assert.equal(
            (await claim(ids.secondPrincipal, "/v1/runs")).rows[0]?.outcome,
            "claimed",
          );
          assert.equal(
            (await claim(ids.principal, "/v1/sessions")).rows[0]?.outcome,
            "claimed",
          );
          const complete = () =>
            withTenantTransaction(pool, tenant, (transaction) =>
              transaction.query(
                `SELECT oao.complete_api_request_idempotency(
                  $1,$2,$3,'POST','/v1/runs','same-key',digest('request-a','sha256'),202,
                  '{"data":{"state":"queued"}}',$4
                ) AS outcome`,
                [ids.organization, ids.project, ids.principal, ids.run],
              ),
            );
          assert.equal((await complete()).rows[0]?.outcome, "completed");
          assert.equal((await complete()).rows[0]?.outcome, "replayed");
          assert.equal(
            (await claim(ids.principal, "/v1/runs")).rows[0]?.outcome,
            "replayed",
          );
          await assert.rejects(
            claim(ids.principal, "/v1/runs", "different"),
            /different request/u,
          );
        },
      );

      await t.test(
        "agent publication serializes versions and updates latest_version_id",
        async () => {
          await withTenantTransaction(pool, tenant, async (transaction) => {
            await transaction.query(
              `INSERT INTO oao.agent_definitions
                (organization_id,project_id,id,agent_key,name)
               VALUES ($1,$2,$3,'published-agent','Published agent')`,
              [ids.organization, ids.project, ids.agent],
            );
            const published = await transaction.query(
              `SELECT (version).version AS version
               FROM (SELECT oao.publish_agent_version(
                 $1,$2,$3,$4,
                 '{"systemPrompt":"safe instructions","modelPreset":"project-model-v1","tools":[],"sandbox":{"enabled":false,"provider":"daytona-primary","network":"none","capabilities":[]},"limits":{"maxTurns":32,"timeoutMs":60000}}',
                 digest('published-agent-v1','sha256'),$5
               ) AS version) q`,
              [
                ids.organization,
                ids.project,
                ids.agent,
                ids.version,
                ids.principal,
              ],
            );
            assert.equal(published.rows[0]?.version, 1);
            assert.equal(
              (
                await transaction.query(
                  "SELECT latest_version_id FROM oao.agent_definitions WHERE id=$1",
                  [ids.agent],
                )
              ).rows[0]?.latest_version_id,
              ids.version,
            );
          });
        },
      );

      await t.test(
        "tool claims renew and release only through the current fence",
        async () => {
          await withTenantTransaction(pool, tenant, async (transaction) => {
            await transaction.query(
              "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'API auth thread')",
              [ids.organization, ids.project, ids.thread],
            );
            await transaction.query(
              `INSERT INTO oao.sessions
                (organization_id,project_id,id,thread_id,agent_version_id)
               VALUES ($1,$2,$3,$4,$5)`,
              [
                ids.organization,
                ids.project,
                ids.session,
                ids.thread,
                ids.version,
              ],
            );
            await transaction.query(
              `INSERT INTO oao.runs
                (organization_id,project_id,id,thread_id,session_id,agent_version_id,
                 created_by_principal_id,idempotency_key)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'api-auth-tool-run')`,
              [
                ids.organization,
                ids.project,
                ids.run,
                ids.thread,
                ids.session,
                ids.version,
                ids.principal,
              ],
            );
            await transaction.query(
              `INSERT INTO oao.tool_calls
                (organization_id,project_id,id,run_id,tool_name,safe_arguments)
               VALUES ($1,$2,$3,$4,'caller_lookup','{}')`,
              [ids.organization, ids.project, ids.toolCall, ids.run],
            );
          });
          const firstFence = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              repository.claimToolCall(transaction, {
                ...tenant,
                toolCallId: ids.toolCall,
                principalId: ids.principal,
                leaseMilliseconds: 60_000,
              }),
          );
          const renewed = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              transaction.query(
                "SELECT oao.renew_tool_call_claim($1,$2,$3,$4,$5,interval '2 minutes') AS expires_at",
                [
                  ids.organization,
                  ids.project,
                  ids.toolCall,
                  ids.principal,
                  firstFence.toString(),
                ],
              ),
          );
          assert.equal(renewed.rows[0]?.expires_at, firstFence.toString());
          assert.equal(
            (
              await withTenantTransaction(pool, tenant, (transaction) =>
                transaction.query(
                  "SELECT oao.release_tool_call_claim($1,$2,$3,$4,$5) AS outcome",
                  [
                    ids.organization,
                    ids.project,
                    ids.toolCall,
                    ids.principal,
                    firstFence.toString(),
                  ],
                ),
              )
            ).rows[0]?.outcome,
            (firstFence + 1n).toString(),
          );
          await assert.rejects(
            withTenantTransaction(pool, tenant, (transaction) =>
              transaction.query(
                "SELECT oao.renew_tool_call_claim($1,$2,$3,$4,$5,interval '2 minutes')",
                [
                  ids.organization,
                  ids.project,
                  ids.toolCall,
                  ids.principal,
                  firstFence.toString(),
                ],
              ),
            ),
            /stale tool execution fence/u,
          );
          const secondFence = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              repository.claimToolCall(transaction, {
                ...tenant,
                toolCallId: ids.toolCall,
                principalId: ids.principal,
                leaseMilliseconds: 60_000,
              }),
          );
          assert.ok(secondFence > firstFence);
        },
      );
    } finally {
      await pool.end();
    }
  },
);
