import assert from "node:assert/strict";
import test from "node:test";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import { InMemoryArtifactAdapter } from "@oao/artifact-s3";
import { createPool, migrate, type Queryable } from "@oao/db-postgres";
import {
  brandedId,
  type AuthorizationScope,
  type OrganizationId,
  type Principal,
  type PrincipalId,
  type ProjectId,
} from "@oao/domain";
import { createApiApp } from "../../src/app.js";
import { PostgresApiStore } from "../../src/store.js";
import { provisionWorkOsIdentity } from "../../src/workos-provisioning.js";
import type {
  RuntimeCommand,
  RuntimeCommandPort,
} from "../../src/runtime-commands.js";
import { buildRuntimeWake } from "../../src/runtime-commands.js";

const databaseUrl = process.env.DATABASE_URL;
const integrationPrincipal: Principal = {
  id: brandedId<PrincipalId>("00000000-0000-4000-8000-000000009003"),
  organizationId: brandedId<OrganizationId>(
    "00000000-0000-4000-8000-000000009001",
  ),
  projectId: brandedId<ProjectId>("00000000-0000-4000-8000-000000009002"),
  kind: "human",
  subject: "api-integration-user",
  scopes: new Set<AuthorizationScope>(["*"]),
};
const projectPath = `/v1/projects/${integrationPrincipal.projectId}`;

class TransactionalTestRuntimeCommands implements RuntimeCommandPort {
  failNext = false;

  async enqueue(
    transaction: Queryable,
    command: RuntimeCommand,
  ): Promise<void> {
    const wake = buildRuntimeWake(command);
    await transaction.query(
      `INSERT INTO public.api_test_runtime_commands
         (organization_id,project_id,wake_id,run_id,dispatch_key,request_hash,command_kind,payload_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING`,
      [
        wake.organizationId,
        wake.projectId,
        wake.id,
        wake.runId,
        wake.dispatchKey,
        wake.requestHash,
        wake.kind,
        wake.payload,
      ],
    );
    if (this.failNext) {
      this.failNext = false;
      throw new Error("injected runtime command failure");
    }
  }
}

function jsonRequest(
  body: Readonly<Record<string, unknown>>,
  key: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

test(
  "PostgreSQL-backed API milestone",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    await migrate(pool);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.api_test_runtime_commands (
        organization_id uuid NOT NULL,
        project_id uuid NOT NULL,
        wake_id uuid NOT NULL,
        run_id uuid NOT NULL,
        dispatch_key text NOT NULL,
        request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
        command_kind text NOT NULL,
        payload_public jsonb NOT NULL,
        PRIMARY KEY (organization_id,project_id,dispatch_key)
      )
    `);
    await pool.query(
      "GRANT INSERT, SELECT ON public.api_test_runtime_commands TO oao_app",
    );
    await pool.query("TRUNCATE public.api_test_runtime_commands");
    t.after(async () => {
      await pool.query("DROP TABLE IF EXISTS public.api_test_runtime_commands");
      await pool.end();
    });
    await pool.query(
      `SELECT oao.bootstrap_project(
        $1,'api-integration','API integration organization',
        $2,'api-integration','API integration project',$3,$4,'development'
      )`,
      [
        integrationPrincipal.organizationId,
        integrationPrincipal.projectId,
        integrationPrincipal.id,
        integrationPrincipal.subject,
      ],
    );
    await t.test(
      "operator provisioning idempotently links real WorkOS IDs",
      async () => {
        const input = {
          organizationId: integrationPrincipal.organizationId,
          projectId: integrationPrincipal.projectId,
          principalId: integrationPrincipal.id,
          workosUserId: "user_api_integration",
          workosOrganizationId: "org_api_integration",
          email: "integration@example.test",
        };
        await provisionWorkOsIdentity(pool, input);
        await provisionWorkOsIdentity(pool, input);
        const resolved = await pool.query<{
          principal_id: string;
          organization_id: string;
          project_id: string;
        }>("SELECT * FROM oao.resolve_workos_principal($1,$2,$3)", [
          input.workosUserId,
          input.workosOrganizationId,
          input.projectId,
        ]);
        assert.equal(resolved.rows.length, 1);
        assert.equal(resolved.rows[0]?.principal_id, input.principalId);

        await assert.rejects(
          provisionWorkOsIdentity(pool, {
            ...input,
            workosOrganizationId: "org_different",
          }),
          /different organization/u,
        );
      },
    );
    const artifacts = new InMemoryArtifactAdapter();
    const runtimeCommands = new TransactionalTestRuntimeCommands();
    const app = createApiApp({
      store: new PostgresApiStore(pool, "integration-api-key-pepper"),
      auth: new DevelopmentAuthAdapter({ principal: integrationPrincipal }),
      artifacts,
      runtimeCommands,
    });

    await t.test("readiness and tenant/RLS route scope", async () => {
      assert.equal((await app.request("/readyz")).status, 200);
      assert.equal(
        (
          await app.request(
            "/v1/projects/00000000-0000-4000-8000-000000000099/agents",
          )
        ).status,
        403,
      );
    });

    let agentId = "";
    let versionId = "";
    let sessionId = "";
    let runId = "";

    await t.test("agent writes are idempotent and lists paginate", async () => {
      const first = await app.request(
        `${projectPath}/agents`,
        jsonRequest(
          { key: "integration-agent", name: "Integration agent" },
          "agent-create-1",
        ),
      );
      assert.equal(first.status, 201);
      const firstBody = (await first.json()) as { id: string };
      agentId = firstBody.id;
      const replay = await app.request(
        `${projectPath}/agents`,
        jsonRequest(
          { key: "integration-agent", name: "Integration agent" },
          "agent-create-1",
        ),
      );
      assert.equal(replay.status, 201);
      assert.equal(replay.headers.get("idempotency-replayed"), "true");
      assert.equal(((await replay.json()) as { id: string }).id, agentId);

      for (let index = 0; index < 2; index += 1) {
        const response = await app.request(
          `${projectPath}/agents`,
          jsonRequest(
            { key: `pagination-agent-${index}`, name: `Pagination ${index}` },
            `agent-page-${index}`,
          ),
        );
        assert.equal(response.status, 201);
      }
      const pageOne = await app.request(`${projectPath}/agents?limit=1`);
      const pageOneBody = (await pageOne.json()) as {
        data: unknown[];
        pageInfo: { hasMore: boolean; nextCursor: string };
      };
      assert.equal(pageOneBody.data.length, 1);
      assert.equal(pageOneBody.pageInfo.hasMore, true);
      const pageTwo = await app.request(
        `${projectPath}/agents?limit=1&cursor=${encodeURIComponent(pageOneBody.pageInfo.nextCursor)}`,
      );
      assert.equal(
        ((await pageTwo.json()) as { data: unknown[] }).data.length,
        1,
      );
    });

    await t.test(
      "immutable version, session, and durable run submission",
      async () => {
        const version = await app.request(
          `${projectPath}/agents/${agentId}/versions`,
          jsonRequest(
            {
              config: {
                systemPrompt: "Answer with redacted public output.",
                modelPreset: "deterministic-test",
                tools: [
                  {
                    name: "lookup",
                    owner: "caller",
                    approval: "always",
                    inputSchema: { type: "object" },
                  },
                ],
                sandboxPolicy: { enabled: false, network: "none" },
              },
            },
            "version-create-1",
          ),
        );
        assert.equal(version.status, 201, await version.clone().text());
        versionId = ((await version.json()) as { id: string }).id;
        const session = await app.request(
          `${projectPath}/sessions`,
          jsonRequest(
            { agentVersionId: versionId, title: "API test" },
            "session-create-1",
          ),
        );
        assert.equal(session.status, 201);
        sessionId = ((await session.json()) as { id: string }).id;
        runtimeCommands.failNext = true;
        const run = await app.request(
          `${projectPath}/sessions/${sessionId}/runs`,
          jsonRequest(
            { redactedInput: "must roll back" },
            "run-command-rollback",
          ),
        );
        assert.equal(run.status, 500);
        const rolledBack = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM oao.runs
           WHERE organization_id=$1 AND project_id=$2
             AND idempotency_key='run-command-rollback'`,
          [integrationPrincipal.organizationId, integrationPrincipal.projectId],
        );
        assert.equal(rolledBack.rows[0]?.count, "0");
        const rolledBackCommands = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.api_test_runtime_commands",
        );
        assert.equal(rolledBackCommands.rows[0]?.count, "0");

        const submitted = await app.request(
          `${projectPath}/sessions/${sessionId}/runs`,
          jsonRequest(
            { redactedInput: "safe operator request" },
            "run-create-1",
          ),
        );
        assert.equal(submitted.status, 202);
        runId = ((await submitted.json()) as { id: string }).id;
        const persistedInput = await pool.query<{
          input_public: { message?: string; redactedInput?: string };
          message_count: string;
        }>(
          `SELECT run.input_public,
             (SELECT count(*)::text FROM oao.messages message
              WHERE message.organization_id=run.organization_id
                AND message.project_id=run.project_id AND message.run_id=run.id
                AND message.role='user') AS message_count
           FROM oao.runs run
           WHERE run.organization_id=$1 AND run.project_id=$2 AND run.id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            runId,
          ],
        );
        assert.deepEqual(persistedInput.rows[0]?.input_public, {
          message: "safe operator request",
        });
        assert.equal(persistedInput.rows[0]?.message_count, "1");
        const replay = await app.request(
          `${projectPath}/sessions/${sessionId}/runs`,
          jsonRequest(
            { redactedInput: "safe operator request" },
            "run-create-1",
          ),
        );
        assert.equal(replay.status, 202);
        assert.equal(replay.headers.get("idempotency-replayed"), "true");
        const commands = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.api_test_runtime_commands WHERE run_id=$1 AND command_kind='admit' AND dispatch_key=$2 AND octet_length(request_hash)=32",
          [runId, `admit:${runId}`],
        );
        assert.equal(commands.rows[0]?.count, "1");
      },
    );

    await t.test("SSE resumes from durable Last-Event-ID", async () => {
      const initial = await app.request(`${projectPath}/events?once=true`);
      const initialText = await initial.text();
      const ids = [...initialText.matchAll(/^id: (.+)$/gmu)].map(
        (match) => match[1],
      );
      const lastId = ids.at(-1);
      assert.ok(lastId);
      const cancel = await app.request(
        `${projectPath}/runs/${runId}/cancel`,
        jsonRequest({}, "cancel-run-1"),
      );
      assert.equal(cancel.status, 202);
      const cancelReplay = await app.request(
        `${projectPath}/runs/${runId}/cancel`,
        jsonRequest({}, "cancel-run-1"),
      );
      assert.equal(cancelReplay.headers.get("idempotency-replayed"), "true");
      const cancelCommands = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.api_test_runtime_commands WHERE run_id=$1 AND command_kind='cancel' AND dispatch_key=$2",
        [runId, `cancel:${runId}`],
      );
      assert.equal(cancelCommands.rows[0]?.count, "1");
      const resumed = await app.request(`${projectPath}/events?once=true`, {
        headers: { "last-event-id": lastId },
      });
      const resumedText = await resumed.text();
      assert.match(resumedText, /run\.cancellation_requested/u);
      assert.doesNotMatch(resumedText, /run\.created/u);
    });

    await t.test(
      "run resume has one transactional durable command",
      async () => {
        const resumed = await app.request(
          `${projectPath}/runs/${runId}/resume`,
          jsonRequest(
            { redactedInput: "safe resumed request" },
            "resume-run-1",
          ),
        );
        assert.equal(resumed.status, 202, await resumed.clone().text());
        const resumedRunId = ((await resumed.json()) as { id: string }).id;
        const replay = await app.request(
          `${projectPath}/runs/${runId}/resume`,
          jsonRequest(
            { redactedInput: "safe resumed request" },
            "resume-run-1",
          ),
        );
        assert.equal(replay.headers.get("idempotency-replayed"), "true");
        const commands = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.api_test_runtime_commands WHERE run_id=$1 AND command_kind='admit' AND dispatch_key=$2",
          [resumedRunId, `admit:${resumedRunId}`],
        );
        assert.equal(commands.rows[0]?.count, "1");
      },
    );

    await t.test(
      "API keys show once, authenticate with scoped principal, and revoke",
      async () => {
        const created = await app.request(
          `${projectPath}/api-keys`,
          jsonRequest(
            {
              name: "Integration key",
              scopes: ["*"],
            },
            "api-key-create-1",
          ),
        );
        assert.equal(created.status, 201);
        const createdBody = (await created.json()) as {
          id: string;
          secret: string;
          shown: boolean;
        };
        assert.equal(createdBody.shown, true);
        assert.match(createdBody.secret, /^oao_/u);
        const replay = await app.request(
          `${projectPath}/api-keys`,
          jsonRequest(
            {
              name: "Integration key",
              scopes: ["*"],
            },
            "api-key-create-1",
          ),
        );
        const replayText = await replay.text();
        assert.doesNotMatch(replayText, new RegExp(createdBody.secret, "u"));
        assert.equal(
          (JSON.parse(replayText) as { shown: boolean }).shown,
          false,
        );
        const authenticated = await app.request(
          `${projectPath}/agents?limit=1`,
          {
            headers: { authorization: `Bearer ${createdBody.secret}` },
          },
        );
        assert.equal(authenticated.status, 200);
        const csrfExemptWrite = await app.request(`${projectPath}/agents`, {
          ...jsonRequest(
            { key: "api-key-agent", name: "API key agent" },
            "api-key-agent-create-1",
          ),
          headers: {
            "content-type": "application/json",
            "idempotency-key": "api-key-agent-create-1",
            authorization: `Bearer ${createdBody.secret}`,
            cookie: "oao_session=untrusted-browser-cookie",
          },
        });
        assert.equal(csrfExemptWrite.status, 201);
        const revoked = await app.request(
          `${projectPath}/api-keys/${createdBody.id}`,
          {
            method: "DELETE",
            headers: { "idempotency-key": "api-key-revoke-1" },
          },
        );
        assert.equal(revoked.status, 200);
        const rejected = await app.request(`${projectPath}/agents`, {
          headers: { authorization: `Bearer ${createdBody.secret}` },
        });
        assert.equal(rejected.status, 401);
      },
    );

    await t.test("audit export writes a tenant-scoped artifact", async () => {
      const exported = await app.request(
        `${projectPath}/audit/export`,
        jsonRequest({}, "audit-export-1"),
      );
      assert.equal(exported.status, 201);
      const body = (await exported.json()) as {
        artifactRef: string;
        contentType: string;
      };
      assert.match(body.artifactRef, /^artifact:\/\//u);
      assert.equal(body.contentType, "application/x-ndjson");
    });
  },
);
