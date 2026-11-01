import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPool, type PgPool } from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
} from "@oao/domain";
import { OAO_TOOLS } from "@oao/mcp-server";
import {
  createOaoToolExecutor,
  OAO_TOOL_RESULT_CHARACTERS,
  runtimeTesting,
} from "@oao/runtime-flue";

const databaseUrl = process.env.DATABASE_URL;
const testAdminDatabaseUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? databaseUrl;

function uuid(label: string): string {
  return runtimeTesting.eventUuid(`oao-tools-test:${label}`);
}

function tool(name: string) {
  const found = OAO_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(found, name);
  return found;
}

interface Fixture {
  readonly tenant: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly runId: RunId;
    readonly flueToolCallId: string;
  };
  readonly principalId: PrincipalId;
  readonly sessionId: string;
}

/** Seeds one unsettled run created by a principal holding `scopes`. */
async function seedRun(
  admin: PgPool,
  label: string,
  scopes: readonly string[],
): Promise<Fixture> {
  const organizationId = uuid(`${label}:org`) as OrganizationId;
  const projectId = uuid(`${label}:project`) as ProjectId;
  const principalId = uuid(`${label}:principal`) as PrincipalId;
  const ids = {
    agent: uuid(`${label}:agent`),
    agentVersion: uuid(`${label}:agent-version`),
    thread: uuid(`${label}:thread`),
    session: uuid(`${label}:session`),
    run: uuid(`${label}:run`) as RunId,
  };
  const query = (sql: string, values: readonly unknown[]) =>
    admin.query(sql, [...values]);
  await query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,$2,$3)",
    [organizationId, `oao-tools-${label}`, `OAO tools ${label}`],
  );
  await query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,$3,$4)",
    [organizationId, projectId, `oao-tools-${label}`, `OAO tools ${label}`],
  );
  await query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'service',$4,$5)`,
    [organizationId, projectId, principalId, `oao-tools-${label}`, scopes],
  );
  await query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,'coordinator','Coordinator')`,
    [organizationId, projectId, ids.agent],
  );
  await query(
    `INSERT INTO oao.agent_versions (
       organization_id,project_id,id,agent_definition_id,version,config,content_hash,
       created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
    [
      organizationId,
      projectId,
      ids.agentVersion,
      ids.agent,
      {
        systemPrompt: "Coordinate.",
        modelPreset: "local-default",
        tools: [],
        oaoTools: { scopes: ["session:read", "run:create"] },
        sandbox: { enabled: false },
        limits: { maxTurns: 4, timeoutMs: 10_000 },
      },
      createHash("sha256").update(label).digest(),
      principalId,
    ],
  );
  await query(
    "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'OAO tools')",
    [organizationId, projectId, ids.thread],
  );
  await query(
    `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [organizationId, projectId, ids.session, ids.thread, ids.agentVersion],
  );
  await query(
    `INSERT INTO oao.runs (
       organization_id,project_id,id,thread_id,session_id,agent_version_id,
       created_by_principal_id,idempotency_key,input_public
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      organizationId,
      projectId,
      ids.run,
      ids.thread,
      ids.session,
      ids.agentVersion,
      principalId,
      `run-key-${label}`,
      { message: "Ask the extraction agent." },
    ],
  );
  return {
    tenant: {
      organizationId,
      projectId,
      runId: ids.run,
      flueToolCallId: `flue-${label}`,
    },
    principalId,
    sessionId: ids.session,
  };
}

interface Seen {
  readonly path: string;
  readonly idempotencyKey: string | null;
  readonly principal?: { readonly id: string; readonly scopes: string[] };
}

/**
 * A stand-in for the API that authenticates the run token through the real
 * SQL function, the way the API does.
 */
function fakeApi(pool: PgPool, respond: (path: string) => Response | null) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const token = /^Bearer (oao_run_\S+)$/u.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const resolved = token
      ? await pool.query<{ principal_id: string; scopes: string[] }>(
          "SELECT principal_id,scopes FROM oao.authenticate_run_token($1)",
          [createHash("sha256").update(token).digest()],
        )
      : undefined;
    const row = resolved?.rows[0];
    seen.push({
      path,
      idempotencyKey: request.headers.get("idempotency-key"),
      ...(row
        ? { principal: { id: row.principal_id, scopes: row.scopes } }
        : {}),
    });
    if (!row)
      return Response.json(
        {
          error: {
            code: "unauthenticated",
            message: "Authentication is required",
          },
        },
        { status: 401 },
      );
    if (path === "/v1/context")
      return Response.json({
        principal: { id: row.principal_id, scopes: row.scopes },
      });
    return (
      respond(path) ??
      Response.json(
        { error: { code: "not_found", message: "Not found" } },
        {
          status: 404,
        },
      )
    );
  };
  return { fetch, seen };
}

async function tokenCount(admin: PgPool, fixture: Fixture): Promise<number> {
  const result = await admin.query<{ count: string }>(
    "SELECT count(*) FROM oao.run_access_tokens WHERE run_id=$1",
    [fixture.tenant.runId],
  );
  return Number(result.rows[0]?.count);
}

test(
  "an agent's OAO tool calls the API as its run's creator, narrowed to the grant",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const admin = createPool(testAdminDatabaseUrl);
    const pool = createPool(databaseUrl);
    t.after(async () => {
      await pool.end();
      await admin.end();
    });
    const run = createHash("sha256")
      .update(`${t.name}:${process.pid}:${Date.now()}`)
      .digest("hex")
      .slice(0, 10);

    await t.test(
      "the token carries the grant within the creator's scopes",
      async () => {
        const fixture = await seedRun(admin, `${run}-narrow`, [
          "session:read",
          "run:read",
        ]);
        const api = fakeApi(admin, () => null);
        const executor = createOaoToolExecutor({
          pool,
          apiUrl: "http://oao.test",
          fetch: api.fetch,
        });
        const result = await executor.execute(
          fixture.tenant,
          tool("get_context"),
          { scopes: ["session:read", "run:create"], approval: "always" },
          {},
        );
        assert.equal(result.isError, false);
        const context = JSON.parse(result.content) as {
          principal: { id: string; scopes: string[] };
        };
        // The creator holds no run:create, so the run cannot either.
        assert.deepEqual(context.principal, {
          id: fixture.principalId,
          scopes: ["session:read"],
        });
        // The token lives only for the call.
        assert.equal(await tokenCount(admin, fixture), 0);
      },
    );

    await t.test(
      "a write uses the tool call as its idempotency key",
      async () => {
        const fixture = await seedRun(admin, `${run}-write`, ["*"]);
        const api = fakeApi(admin, (path) =>
          path.endsWith(`/sessions/${fixture.sessionId}/runs`)
            ? Response.json(
                {
                  error: {
                    code: "conflict",
                    message:
                      "The session's latest run must settle before another message",
                  },
                },
                { status: 409 },
              )
            : null,
        );
        const executor = createOaoToolExecutor({
          pool,
          apiUrl: "http://oao.test",
          fetch: api.fetch,
        });
        const result = await executor.execute(
          fixture.tenant,
          tool("send_message"),
          { scopes: ["run:create"], approval: "never" },
          { sessionId: fixture.sessionId, message: "Hello", waitSeconds: 0 },
        );
        // The model sees why the API refused.
        assert.equal(result.isError, true);
        assert.match(result.content, /"code":"conflict"/u);
        assert.equal(
          api.seen[0]?.idempotencyKey,
          `platform:${fixture.tenant.runId}:${fixture.tenant.flueToolCallId}:send_message`,
        );
        assert.equal(await tokenCount(admin, fixture), 0);
      },
    );

    await t.test("a settled run's tool is refused", async () => {
      const fixture = await seedRun(admin, `${run}-settled`, ["*"]);
      await admin.query(
        "UPDATE oao.runs SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1",
        [fixture.tenant.runId],
      );
      const api = fakeApi(admin, () => null);
      const result = await createOaoToolExecutor({
        pool,
        apiUrl: "http://oao.test",
        fetch: api.fetch,
      }).execute(
        fixture.tenant,
        tool("get_context"),
        { scopes: ["session:read"], approval: "always" },
        {},
      );
      assert.equal(result.isError, true);
      assert.match(result.content, /"status":401/u);
    });

    await t.test("long results are cut for the model", async () => {
      const fixture = await seedRun(admin, `${run}-long`, ["*"]);
      const api = fakeApi(admin, () =>
        Response.json({
          data: [{ id: "a1", name: "x".repeat(OAO_TOOL_RESULT_CHARACTERS) }],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
      );
      const result = await createOaoToolExecutor({
        pool,
        apiUrl: "http://oao.test",
        fetch: api.fetch,
      }).execute(
        fixture.tenant,
        tool("list_agents"),
        { scopes: ["agent:read"], approval: "always" },
        {},
      );
      assert.equal(result.isError, false);
      assert.ok(result.content.length < OAO_TOOL_RESULT_CHARACTERS + 200);
      assert.match(result.content, /more characters cut/u);
    });

    await t.test("without OAO_API_URL the tool fails clearly", async () => {
      const fixture = await seedRun(admin, `${run}-unconfigured`, ["*"]);
      await assert.rejects(
        createOaoToolExecutor({ pool }).execute(
          fixture.tenant,
          tool("get_context"),
          { scopes: ["session:read"], approval: "always" },
          {},
        ),
        /OAO_API_URL/u,
      );
    });
  },
);
