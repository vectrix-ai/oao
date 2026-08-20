import assert from "node:assert/strict";
import test from "node:test";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import { InMemoryArtifactAdapter } from "@oao/artifact-s3";
import { createPool, migrate } from "@oao/db-postgres";
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
    const artifacts = new InMemoryArtifactAdapter();
    const app = createApiApp({
      store: new PostgresApiStore(pool, "integration-api-key-pepper"),
      auth: new DevelopmentAuthAdapter({ principal: integrationPrincipal }),
      artifacts,
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
        const run = await app.request(
          `${projectPath}/sessions/${sessionId}/runs`,
          jsonRequest(
            { redactedInput: "safe operator request" },
            "run-create-1",
          ),
        );
        assert.equal(run.status, 202);
        runId = ((await run.json()) as { id: string }).id;
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
      const resumed = await app.request(`${projectPath}/events?once=true`, {
        headers: { "last-event-id": lastId },
      });
      const resumedText = await resumed.text();
      assert.match(resumedText, /run\.cancellation_requested/u);
      assert.doesNotMatch(resumedText, /run\.created/u);
    });

    await t.test(
      "API keys show once, authenticate with scoped principal, and revoke",
      async () => {
        const created = await app.request(
          `${projectPath}/api-keys`,
          jsonRequest(
            {
              name: "Integration key",
              scopes: ["project:admin", "agent:read"],
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
              scopes: ["project:admin", "agent:read"],
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

    await pool.end();
  },
);
