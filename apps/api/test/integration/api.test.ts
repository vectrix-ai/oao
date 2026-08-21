import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import { InMemoryArtifactAdapter } from "@oao/artifact-s3";
import { createPool, migrate, type Queryable } from "@oao/db-postgres";
import {
  isApprovedCatalogModel,
  listApprovedModelCatalog,
} from "@oao/models-openrouter";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import {
  brandedId,
  type AuthorizationScope,
  type OrganizationId,
  type Principal,
  type PrincipalId,
  type ProjectId,
} from "@oao/domain";
import { strToU8, zipSync } from "fflate";
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
const baseModelPresetKey = "integration-base-model-v1";
const disabledSandbox = {
  enabled: false,
  provider: "daytona-primary",
  network: "none",
  capabilities: [],
} as const;

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

function docxFile(text: string): Buffer {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    }),
  );
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
      credentialCipher: new ProviderCredentialCipher(Buffer.alloc(32, 5)),
      modelCatalog: {
        deploymentPresets: [],
        listCatalog: (input) => listApprovedModelCatalog(input?.providerType),
        isApprovedModel: isApprovedCatalogModel,
      },
    });

    const baseModel = listApprovedModelCatalog("openrouter")[0]?.model;
    assert.ok(baseModel);
    const baseProviderResponse = await app.request(
      `${projectPath}/model-providers`,
      jsonRequest(
        {
          key: "integration-base-openrouter",
          displayName: "Integration base OpenRouter",
          providerType: "openrouter",
          apiKey: "sk-integration-base-provider-secret",
        },
        "base-model-provider-1",
      ),
    );
    assert.equal(baseProviderResponse.status, 201);
    const baseProvider = (await baseProviderResponse.json()) as { id: string };
    const basePresetResponse = await app.request(
      `${projectPath}/model-presets`,
      jsonRequest(
        {
          key: baseModelPresetKey,
          displayName: "Integration base model",
          providerId: baseProvider.id,
          model: baseModel,
        },
        "base-model-preset-1",
      ),
    );
    assert.equal(basePresetResponse.status, 201);

    await t.test("context, readiness and tenant/RLS route scope", async () => {
      assert.equal((await app.request("/readyz")).status, 200);
      const context = await app.request("/v1/context");
      assert.equal(context.status, 200);
      assert.deepEqual(
        ((await context.json()) as { activeModelPresets: string[] })
          .activeModelPresets,
        [baseModelPresetKey],
      );
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
    let skillId = "";
    let skillVersionId = "";

    await t.test(
      "Skill packages publish immutable versions and export exact contents",
      async () => {
        const reference = Buffer.from(
          "Only accept shipments with a known customer reference.",
          "utf8",
        );
        const first = await app.request(
          `${projectPath}/skills`,
          jsonRequest(
            {
              key: "shipment-intake",
              displayName: "Shipment intake",
              name: "shipment-intake",
              description: "Validate and normalize inbound shipment requests.",
              instructions:
                "Activate this Skill for inbound shipment intake, then read the reference when validation is required.",
              metadata: { owner: "operations" },
              files: [
                {
                  path: "references/business-rules.md",
                  contentType: "text/markdown",
                  dataBase64: reference.toString("base64"),
                },
              ],
            },
            "skill-create-1",
          ),
        );
        assert.equal(first.status, 201, await first.clone().text());
        const firstBody = (await first.json()) as {
          id: string;
          latestVersion: { id: string; version: number; contentHash: string };
        };
        skillId = firstBody.id;
        skillVersionId = firstBody.latestVersion.id;
        assert.equal(firstBody.latestVersion.version, 1);
        assert.match(firstBody.latestVersion.contentHash, /^[a-f0-9]{64}$/u);

        const second = await app.request(
          `${projectPath}/skills/${skillId}/versions`,
          jsonRequest(
            {
              name: "shipment-intake",
              description: "Validate and normalize inbound shipment requests.",
              instructions:
                "Version two adds a later procedure without changing existing bindings.",
              metadata: { owner: "operations" },
              files: [
                {
                  path: "references/business-rules.md",
                  contentType: "text/markdown",
                  dataBase64: reference.toString("base64"),
                },
              ],
            },
            "skill-version-2",
          ),
        );
        assert.equal(second.status, 201, await second.clone().text());
        const secondBody = (await second.json()) as {
          id: string;
          version: number;
        };
        assert.equal(secondBody.version, 2);

        const list = await app.request(`${projectPath}/skills`);
        assert.equal(list.status, 200);
        const listed = (
          (await list.json()) as {
            data: readonly {
              latestVersionId: string;
              versionIds: readonly string[];
            }[];
          }
        ).data[0]!;
        assert.equal(listed.latestVersionId, secondBody.id);
        assert.deepEqual(listed.versionIds, [skillVersionId, secondBody.id]);

        const exported = await app.request(
          `${projectPath}/skills/${skillId}/versions/${skillVersionId}/export`,
        );
        assert.equal(exported.status, 200);
        const exportBody = (await exported.json()) as {
          version: { version: number; instructions: string };
          files: readonly { path: string; dataBase64: string }[];
        };
        assert.equal(exportBody.version.version, 1);
        assert.match(exportBody.version.instructions, /Activate this Skill/u);
        assert.equal(exportBody.files[0]?.path, "references/business-rules.md");
        assert.deepEqual(
          Buffer.from(exportBody.files[0]!.dataBase64, "base64"),
          reference,
        );

        const deprecated = await app.request(
          `${projectPath}/skills/${skillId}/versions/${secondBody.id}/lifecycle`,
          {
            ...jsonRequest(
              { status: "deprecated" },
              "skill-version-2-deprecated",
            ),
            method: "PATCH",
          },
        );
        assert.equal(deprecated.status, 200, await deprecated.clone().text());
        const replay = await app.request(
          `${projectPath}/skills/${skillId}/versions/${secondBody.id}/lifecycle`,
          {
            ...jsonRequest(
              { status: "deprecated" },
              "skill-version-2-deprecated",
            ),
            method: "PATCH",
          },
        );
        assert.equal(replay.headers.get("idempotency-replayed"), "true");
        const revoked = await app.request(
          `${projectPath}/skills/${skillId}/versions/${secondBody.id}/lifecycle`,
          {
            ...jsonRequest({ status: "revoked" }, "skill-version-2-revoked"),
            method: "PATCH",
          },
        );
        assert.equal(revoked.status, 200, await revoked.clone().text());
      },
    );

    await t.test("agent writes are idempotent and lists paginate", async () => {
      const first = await app.request(
        `${projectPath}/agents`,
        jsonRequest(
          {
            key: "integration-agent",
            name: "Integration agent",
            description: "",
            config: {
              systemPrompt: "Answer with safe public output.",
              modelPreset: baseModelPresetKey,
              tools: [],
              skillVersionIds: [skillVersionId],
              sandbox: disabledSandbox,
              limits: { maxTurns: 32, timeoutMs: 60_000 },
            },
          },
          "agent-create-1",
        ),
      );
      assert.equal(first.status, 201);
      const firstBody = (await first.json()) as {
        id: string;
        latestVersionId: string;
        version: number;
        sandbox: typeof disabledSandbox;
      };
      agentId = firstBody.id;
      assert.ok(firstBody.latestVersionId);
      assert.equal(firstBody.version, 1);
      assert.deepEqual(firstBody.sandbox, disabledSandbox);
      const replay = await app.request(
        `${projectPath}/agents`,
        jsonRequest(
          {
            key: "integration-agent",
            name: "Integration agent",
            description: "",
            config: {
              systemPrompt: "Answer with safe public output.",
              modelPreset: baseModelPresetKey,
              tools: [],
              skillVersionIds: [skillVersionId],
              sandbox: disabledSandbox,
              limits: { maxTurns: 32, timeoutMs: 60_000 },
            },
          },
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
            {
              key: `pagination-agent-${index}`,
              name: `Pagination ${index}`,
              config: {
                systemPrompt: "Answer with safe public output.",
                modelPreset: baseModelPresetKey,
                tools: [],
                sandbox: disabledSandbox,
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
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
      "agent publication explains incompatible delegate sandboxes",
      async () => {
        const child = await app.request(
          `${projectPath}/agents`,
          jsonRequest(
            {
              key: "incompatible-delegate",
              name: "Incompatible delegate",
              config: {
                systemPrompt: "Extract shipment facts for the coordinator.",
                modelPreset: baseModelPresetKey,
                tools: [],
                sandbox: {
                  ...disabledSandbox,
                  provider: "daytona-secondary",
                },
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
            "incompatible-delegate-create",
          ),
        );
        assert.equal(child.status, 201, await child.clone().text());
        const childVersionId = (
          (await child.json()) as { latestVersionId: string }
        ).latestVersionId;
        const response = await app.request(
          `${projectPath}/agents/${agentId}/versions`,
          jsonRequest(
            {
              config: {
                systemPrompt: "Coordinate shipment analysis safely.",
                modelPreset: baseModelPresetKey,
                tools: [],
                delegates: [
                  {
                    key: "shipment-extraction",
                    description: "Extract shipment facts.",
                    agentVersionId: childVersionId,
                    maxParallel: 1,
                  },
                ],
                sandbox: disabledSandbox,
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
            "incompatible-delegate-publish",
          ),
        );
        assert.equal(response.status, 400, await response.clone().text());
        assert.match(
          ((await response.json()) as { error: { message: string } }).error
            .message,
          /same sandbox enabled state, provider, snapshot, and network policy/u,
        );
      },
    );

    await t.test(
      "database publication guard rejects incomplete and unsafe configs",
      async () => {
        const valid = {
          systemPrompt: "Safe deterministic agent",
          modelPreset: baseModelPresetKey,
          tools: [],
          sandbox: disabledSandbox,
          limits: { maxTurns: 32, timeoutMs: 60_000 },
        };
        const invalid = [
          { ...valid, limits: { timeoutMs: 60_000 } },
          { ...valid, limits: { maxTurns: 32 } },
          { ...valid, limits: { maxTurns: "32", timeoutMs: 60_000 } },
          { ...valid, sandbox: { enabled: false } },
          {
            ...valid,
            tools: [
              {
                schemaVersion: 1,
                name: "invalid",
                description: "Unsupported schema keyword",
                owner: "caller",
                approval: "never",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string", minLength: 1 } },
                  required: ["query"],
                  additionalProperties: false,
                },
                outputSchema: {
                  type: "object",
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            ],
          },
        ];
        for (const config of invalid) {
          await assert.rejects(
            pool.query(
              "SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)",
              [
                integrationPrincipal.organizationId,
                integrationPrincipal.projectId,
                agentId,
                randomUUID(),
                config,
                createHash("sha256").update(JSON.stringify(config)).digest(),
                integrationPrincipal.id,
              ],
            ),
            (error: unknown) => (error as { code?: string }).code === "22023",
          );
        }
        const versions = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM oao.agent_versions
         WHERE organization_id=$1 AND project_id=$2 AND agent_definition_id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            agentId,
          ],
        );
        assert.equal(versions.rows[0]?.count, "1");
      },
    );

    await t.test(
      "immutable version, session, and durable run submission",
      async () => {
        const version = await app.request(
          `${projectPath}/agents/${agentId}/versions`,
          jsonRequest(
            {
              config: {
                systemPrompt: "Answer with redacted public output.",
                modelPreset: baseModelPresetKey,
                tools: [
                  {
                    schemaVersion: 1,
                    name: "lookup",
                    description: "Look up a safe public value",
                    owner: "caller",
                    approval: "always",
                    inputSchema: {
                      type: "object",
                      properties: { query: { type: "string" } },
                      required: ["query"],
                      additionalProperties: false,
                    },
                    outputSchema: {
                      type: "object",
                      properties: { found: { type: "boolean" } },
                      required: ["found"],
                      additionalProperties: false,
                    },
                  },
                ],
                skillVersionIds: [skillVersionId],
                sandbox: disabledSandbox,
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
            "version-create-1",
          ),
        );
        assert.equal(version.status, 201, await version.clone().text());
        versionId = ((await version.json()) as { id: string }).id;
        const emailContext = [
          "From: alice@example.com",
          "To: operator@example.com",
          "Subject: Renewal context",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Northwind renews for EUR 48000.",
        ].join("\r\n");
        const wordContext = docxFile(
          "The signed Word brief confirms the EUR 48000 annual value.",
        );
        const session = await app.request(
          `${projectPath}/sessions`,
          jsonRequest(
            {
              agentId,
              agentVersionId: versionId,
              title: "API test",
              initialMessage: "first safe operator request",
              files: [
                {
                  name: "renewal.eml",
                  contentType: "message/rfc822",
                  dataBase64: Buffer.from(emailContext, "utf8").toString(
                    "base64",
                  ),
                },
                {
                  name: "renewal-brief.docx",
                  contentType:
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  dataBase64: wordContext.toString("base64"),
                },
              ],
            },
            "session-create-1",
          ),
        );
        assert.equal(session.status, 201, await session.clone().text());
        const sessionBody = (await session.json()) as {
          id: string;
          run: { id: string; state: string };
        };
        sessionId = sessionBody.id;
        assert.equal(sessionBody.run.state, "queued");
        const sessionList = await app.request(
          `${projectPath}/sessions?limit=100`,
        );
        assert.equal(sessionList.status, 200, await sessionList.clone().text());
        const listedSession = (
          (await sessionList.json()) as {
            data: readonly {
              id: string;
              parentSessionId: string | null;
              delegateKey: string | null;
            }[];
          }
        ).data.find((item) => item.id === sessionId);
        assert.ok(listedSession);
        assert.equal(listedSession.parentSessionId, null);
        assert.equal(listedSession.delegateKey, null);
        const inheritedSkills = await pool.query<{
          skill_version_id: string;
        }>(
          `SELECT skill_version_id FROM oao.session_skill_bindings
           WHERE organization_id=$1 AND project_id=$2 AND session_id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            sessionId,
          ],
        );
        assert.deepEqual(inheritedSkills.rows, [
          { skill_version_id: skillVersionId },
        ]);
        const initialFiles = await pool.query<{
          file_name: string;
          content_bytes: Buffer;
          extracted_text: string | null;
        }>(
          `SELECT file_name,content_bytes,extracted_text
           FROM oao.run_files WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            sessionBody.run.id,
          ],
        );
        const emailFile = initialFiles.rows.find(
          (file) => file.file_name === "renewal.eml",
        );
        const wordFile = initialFiles.rows.find(
          (file) => file.file_name === "renewal-brief.docx",
        );
        assert.equal(emailFile?.content_bytes.toString("utf8"), emailContext);
        assert.deepEqual(wordFile?.content_bytes, wordContext);
        assert.match(
          emailFile?.extracted_text ?? "",
          /Renewal context[\s\S]*Northwind renews for EUR 48000/u,
        );
        assert.match(
          wordFile?.extracted_text ?? "",
          /signed Word brief confirms the EUR 48000 annual value/u,
        );
        await pool.query(
          `UPDATE oao.runs SET state='running' WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            sessionBody.run.id,
          ],
        );
        await pool.query(
          `UPDATE oao.runs SET state='completed' WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            sessionBody.run.id,
          ],
        );
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
        assert.equal(rolledBackCommands.rows[0]?.count, "1");

        const officeContext = String.raw`{\rtf1\ansi\b Account brief\b0\par Contoso annual value is EUR 72000.}`;
        const followUpBody = {
          redactedInput: "safe operator request",
          files: [
            {
              name: "account-brief.rtf",
              contentType: "application/rtf",
              dataBase64: Buffer.from(officeContext, "utf8").toString("base64"),
            },
          ],
        };
        const submitted = await app.request(
          `${projectPath}/sessions/${sessionId}/runs`,
          jsonRequest(followUpBody, "run-create-1"),
        );
        assert.equal(submitted.status, 202);
        runId = ((await submitted.json()) as { id: string }).id;
        const persistedInput = await pool.query<{
          input_public: {
            message?: string;
            files?: readonly { name: string; sha256: string }[];
          };
          message_count: string;
          file_count: string;
        }>(
          `SELECT run.input_public,
             (SELECT count(*)::text FROM oao.messages message
              WHERE message.organization_id=run.organization_id
                AND message.project_id=run.project_id AND message.run_id=run.id
                AND message.role='user') AS message_count,
             (SELECT count(*)::text FROM oao.run_files file
              WHERE file.organization_id=run.organization_id
                AND file.project_id=run.project_id AND file.run_id=run.id) AS file_count
           FROM oao.runs run
           WHERE run.organization_id=$1 AND run.project_id=$2 AND run.id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            runId,
          ],
        );
        assert.equal(
          persistedInput.rows[0]?.input_public.message,
          "safe operator request",
        );
        assert.equal(
          persistedInput.rows[0]?.input_public.files?.[0]?.name,
          "account-brief.rtf",
        );
        assert.match(
          persistedInput.rows[0]?.input_public.files?.[0]?.sha256 ?? "",
          /^[a-f0-9]{64}$/u,
        );
        assert.equal(persistedInput.rows[0]?.message_count, "1");
        assert.equal(persistedInput.rows[0]?.file_count, "1");
        const officeFile = await pool.query<{ extracted_text: string | null }>(
          `SELECT extracted_text FROM oao.run_files
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            runId,
          ],
        );
        assert.match(
          officeFile.rows[0]?.extracted_text ?? "",
          /Account brief[\s\S]*Contoso annual value is EUR 72000/u,
        );
        const replay = await app.request(
          `${projectPath}/sessions/${sessionId}/runs`,
          jsonRequest(followUpBody, "run-create-1"),
        );
        assert.equal(replay.status, 202);
        assert.equal(replay.headers.get("idempotency-replayed"), "true");
        const commands = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.api_test_runtime_commands WHERE run_id=$1 AND command_kind='admit' AND dispatch_key=$2 AND octet_length(request_hash)=32",
          [runId, `admit:${runId}`],
        );
        assert.equal(commands.rows[0]?.count, "1");
        const detail = await app.request(
          `${projectPath}/sessions/${sessionId}`,
        );
        assert.equal(detail.status, 200);
        const detailBody = (await detail.json()) as {
          skills: readonly {
            skillId: string;
            skillVersionId: string;
            version: number;
            name: string;
            description: string;
            contentHash: string;
          }[];
          transcript: readonly {
            runId: string;
            files: readonly {
              name: string;
              contentType: string;
              sizeBytes: number;
              sha256: string;
            }[];
          }[];
        };
        assert.equal(detailBody.skills.length, 1);
        assert.equal(detailBody.skills[0]?.skillId, skillId);
        assert.equal(detailBody.skills[0]?.skillVersionId, skillVersionId);
        assert.equal(detailBody.skills[0]?.version, 1);
        assert.equal(detailBody.skills[0]?.name, "shipment-intake");
        assert.match(
          detailBody.skills[0]?.contentHash ?? "",
          /^[a-f0-9]{64}$/u,
        );
        const transcript = (
          detailBody as {
            transcript: readonly {
              runId: string;
              files: readonly {
                name: string;
                contentType: string;
                sizeBytes: number;
                sha256: string;
              }[];
            }[];
          }
        ).transcript;
        const transcriptFile = transcript.find(
          (message) => message.runId === runId,
        )?.files[0];
        assert.equal(transcriptFile?.name, "account-brief.rtf");
        assert.equal(transcriptFile?.contentType, "application/rtf");
        assert.equal(
          transcriptFile?.sizeBytes,
          Buffer.byteLength(officeContext, "utf8"),
        );
        assert.equal(
          transcriptFile?.sha256,
          createHash("sha256").update(officeContext).digest("hex"),
        );
      },
    );

    await t.test(
      "session reads expose transcript-safe sandbox command contents",
      async () => {
        const run = await pool.query<{ thread_id: string; session_id: string }>(
          `SELECT thread_id,session_id FROM oao.runs
         WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            runId,
          ],
        );
        const identity = run.rows[0];
        assert.ok(identity);
        const sandboxId = randomUUID();
        const commandId = randomUUID();
        await pool.query(
          `INSERT INTO oao.sandbox_instances (
           organization_id,project_id,id,run_id,thread_id,session_id,provider,
           state,creation_key,egress_policy
         ) VALUES ($1,$2,$3,$4,$5,$6,'daytona','running',$7,$8)`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            sandboxId,
            runId,
            identity.thread_id,
            identity.session_id,
            `integration-sandbox:${sandboxId}`,
            { mode: "none" },
          ],
        );
        await pool.query(
          `INSERT INTO oao.sandbox_commands (
           organization_id,project_id,id,sandbox_id,run_id,command_key,
           request_hash,state,safe_command,safe_result,started_at,completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,clock_timestamp(),clock_timestamp())`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            commandId,
            sandboxId,
            runId,
            `integration-command:${commandId}`,
            createHash("sha256").update(commandId).digest(),
            {
              toolName: "write",
              arguments: {
                path: "/root/test.csv",
                content: "id,name\n1,Alice",
              },
            },
            {
              exitCode: 0,
              redactedOutput: "Sandbox tool completed",
              output: {
                content: [{ type: "text", text: "Wrote 18 bytes" }],
              },
            },
          ],
        );

        const response = await app.request(
          `${projectPath}/sessions/${sessionId}`,
        );
        assert.equal(response.status, 200, await response.clone().text());
        const body = (await response.json()) as {
          debug: {
            sandboxCommands: readonly Record<string, unknown>[];
          };
        };
        assert.deepEqual(
          body.debug.sandboxCommands.map((command) => ({
            id: command.id,
            runId: command.runId,
            state: command.state,
            toolName: command.toolName,
            safeCommand: command.safeCommand,
            safeResult: command.safeResult,
          })),
          [
            {
              id: commandId,
              runId,
              state: "completed",
              toolName: "write",
              safeCommand: {
                toolName: "write",
                arguments: {
                  path: "/root/test.csv",
                  content: "id,name\n1,Alice",
                },
              },
              safeResult: {
                exitCode: 0,
                redactedOutput: "Sandbox tool completed",
                output: {
                  content: [{ type: "text", text: "Wrote 18 bytes" }],
                },
              },
            },
          ],
        );
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
        const resumeBody = {
          files: [
            {
              name: "resume.txt",
              contentType: "text/plain",
              dataBase64: Buffer.from("resume file context", "utf8").toString(
                "base64",
              ),
            },
          ],
        };
        const resumed = await app.request(
          `${projectPath}/runs/${runId}/resume`,
          jsonRequest(resumeBody, "resume-run-1"),
        );
        assert.equal(resumed.status, 202, await resumed.clone().text());
        const resumedRunId = ((await resumed.json()) as { id: string }).id;
        const replay = await app.request(
          `${projectPath}/runs/${runId}/resume`,
          jsonRequest(resumeBody, "resume-run-1"),
        );
        assert.equal(replay.headers.get("idempotency-replayed"), "true");
        const commands = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.api_test_runtime_commands WHERE run_id=$1 AND command_kind='admit' AND dispatch_key=$2",
          [resumedRunId, `admit:${resumedRunId}`],
        );
        assert.equal(commands.rows[0]?.count, "1");
        const files = await pool.query<{ file_name: string; content: string }>(
          `SELECT file_name,convert_from(content_bytes,'UTF8') AS content
           FROM oao.run_files WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            resumedRunId,
          ],
        );
        assert.deepEqual(files.rows, [
          { file_name: "resume.txt", content: "resume file context" },
        ]);
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
            {
              key: "api-key-agent",
              name: "API key agent",
              config: {
                systemPrompt: "Answer with safe public output.",
                modelPreset: baseModelPresetKey,
                tools: [],
                sandbox: disabledSandbox,
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
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

    await t.test(
      "a durable model preset becomes publishable and never returns a credential",
      async () => {
        const hosted = createApiApp({
          store: new PostgresApiStore(pool, "integration-api-key-pepper"),
          auth: new DevelopmentAuthAdapter({ principal: integrationPrincipal }),
          artifacts,
          runtimeCommands,
          credentialCipher: new ProviderCredentialCipher(Buffer.alloc(32, 6)),
          modelCatalog: {
            deploymentPresets: [],
            listCatalog: (input) =>
              listApprovedModelCatalog(input?.providerType),
            isApprovedModel: isApprovedCatalogModel,
          },
          sandboxSnapshotCatalog: {
            listSnapshots: ({ apiKey, target }) => {
              assert.equal(apiKey, "daytona-integration-rotated");
              assert.equal(target, "us");
              return Promise.resolve([
                {
                  id: "77777777-7777-4777-8777-777777777777",
                  providerType: "daytona" as const,
                  name: "daytona-small",
                  state: "active",
                  available: true,
                  imageName: "daytonaio/sandbox:0.9.0",
                  general: true,
                  cpu: 1,
                  gpu: 0,
                  memoryGiB: 1,
                  diskGiB: 3,
                  regionIds: ["eu", "us"],
                  sandboxClass: "container",
                  createdAt: "2026-07-28T14:58:11.540Z",
                  updatedAt: "2026-08-20T15:26:23.838Z",
                  lastUsedAt: "2026-08-20T15:26:23.827Z",
                },
              ]);
            },
          },
        });
        const model = listApprovedModelCatalog("openrouter")[0]?.model;
        assert.ok(model);

        const unapproved = await hosted.request(
          `${projectPath}/agents`,
          jsonRequest(
            {
              key: "preset-agent-rejected",
              name: "Preset agent",
              config: {
                systemPrompt: "Answer questions.",
                modelPreset: "integration-preset-v1",
                tools: [],
                sandbox: disabledSandbox,
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
            "preset-agent-rejected-1",
          ),
        );
        assert.equal(unapproved.status, 400);

        const providerCreated = await hosted.request(
          `${projectPath}/model-providers`,
          jsonRequest(
            {
              key: "integration-openrouter",
              displayName: "Integration OpenRouter",
              providerType: "openrouter",
              apiKey: "sk-integration-provider-secret",
            },
            "model-provider-1",
          ),
        );
        assert.equal(providerCreated.status, 201);
        const provider = (await providerCreated.json()) as {
          id: string;
          credentialFingerprint: string;
        };
        assert.match(provider.credentialFingerprint, /^[a-f0-9]{12}$/u);
        assert.doesNotMatch(JSON.stringify(provider), /provider-secret/u);
        const storedCredential = await pool.query<{
          encrypted_api_key: Buffer;
          encryption_nonce: Buffer;
          encryption_tag: Buffer;
          encryption_key_version: number;
        }>(
          `SELECT encrypted_api_key,encryption_nonce,encryption_tag,encryption_key_version
           FROM oao.project_model_providers
           WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            provider.id,
          ],
        );
        assert.equal(storedCredential.rows[0]?.encryption_nonce.length, 12);
        assert.equal(storedCredential.rows[0]?.encryption_tag.length, 16);
        assert.equal(storedCredential.rows[0]?.encryption_key_version, 1);
        assert.doesNotMatch(
          storedCredential.rows[0]?.encrypted_api_key.toString() ?? "",
          /provider-secret/u,
        );

        const rotatedProvider = await hosted.request(
          `${projectPath}/model-providers/${provider.id}/credential`,
          {
            ...jsonRequest(
              { apiKey: "sk-integration-provider-rotated" },
              "model-provider-rotation-2",
            ),
            method: "PUT",
          },
        );
        assert.equal(rotatedProvider.status, 200);
        assert.equal(
          ((await rotatedProvider.json()) as { credentialVersion: number })
            .credentialVersion,
          2,
        );

        const sandboxCreated = await hosted.request(
          `${projectPath}/sandbox-providers`,
          jsonRequest(
            {
              key: "integration-daytona",
              displayName: "Integration Daytona",
              providerType: "daytona",
              apiKey: "daytona-integration-secret",
              target: null,
              restrictedEgress: {
                allowedDomains: ["api.example.com"],
                allowedCidrs: ["203.0.113.0/24"],
              },
            },
            "sandbox-provider-1",
          ),
        );
        assert.equal(sandboxCreated.status, 201);
        const sandboxProvider = (await sandboxCreated.json()) as {
          id: string;
          key: string;
          credentialFingerprint: string;
          credentialVersion: number;
        };
        assert.equal(sandboxProvider.key, "integration-daytona");
        assert.match(sandboxProvider.credentialFingerprint, /^[a-f0-9]{12}$/u);
        assert.doesNotMatch(
          JSON.stringify(sandboxProvider),
          /daytona-integration-secret/u,
        );

        const sandboxRotated = await hosted.request(
          `${projectPath}/sandbox-providers/${sandboxProvider.id}/credential`,
          {
            ...jsonRequest(
              { apiKey: "daytona-integration-rotated" },
              "sandbox-provider-rotate-1",
            ),
            method: "PUT",
          },
        );
        assert.equal(sandboxRotated.status, 200);
        assert.equal(
          ((await sandboxRotated.json()) as { credentialVersion: number })
            .credentialVersion,
          2,
        );

        const sandboxConfigured = await hosted.request(
          `${projectPath}/sandbox-providers/${sandboxProvider.id}/configuration`,
          {
            ...jsonRequest(
              {
                target: "us",
                restrictedEgress: {
                  allowedDomains: ["*.example.com"],
                  allowedCidrs: [],
                },
              },
              "sandbox-provider-config-1",
            ),
            method: "PUT",
          },
        );
        assert.equal(sandboxConfigured.status, 200);
        assert.deepEqual(
          (
            (await sandboxConfigured.json()) as {
              restrictedEgress: { allowedDomains: string[] };
            }
          ).restrictedEgress.allowedDomains,
          ["*.example.com"],
        );

        const sandboxListed = await hosted.request(
          `${projectPath}/sandbox-providers`,
        );
        const sandboxList = (await sandboxListed.json()) as {
          data: { key: string }[];
          credentialEncryptionConfigured: boolean;
        };
        assert.equal(sandboxList.credentialEncryptionConfigured, true);
        assert.deepEqual(
          sandboxList.data.map((entry) => entry.key),
          ["integration-daytona"],
        );

        const snapshotsResponse = await hosted.request(
          `${projectPath}/sandbox-providers/${sandboxProvider.id}/snapshots`,
        );
        assert.equal(snapshotsResponse.status, 200);
        const snapshotList = (await snapshotsResponse.json()) as {
          data: { id: string; name: string; available: boolean }[];
          providerId: string;
        };
        assert.equal(snapshotList.providerId, sandboxProvider.id);
        assert.deepEqual(snapshotList.data, [
          {
            id: "77777777-7777-4777-8777-777777777777",
            name: "daytona-small",
            available: true,
            providerType: "daytona",
            state: "active",
            imageName: "daytonaio/sandbox:0.9.0",
            general: true,
            cpu: 1,
            gpu: 0,
            memoryGiB: 1,
            diskGiB: 3,
            regionIds: ["eu", "us"],
            sandboxClass: "container",
            createdAt: "2026-07-28T14:58:11.540Z",
            updatedAt: "2026-08-20T15:26:23.838Z",
            lastUsedAt: "2026-08-20T15:26:23.827Z",
          },
        ]);

        const storageCreated = await hosted.request(
          `${projectPath}/storage-providers`,
          jsonRequest(
            {
              key: "integration-workspaces",
              displayName: "Integration workspaces",
              providerType: "s3",
              endpoint: "https://objects.example.test",
              region: "eu-test-1",
              bucket: "oao-integration-workspaces",
              prefix: "sessions",
              forcePathStyle: true,
              accessKeyId: "integration-access-key",
              secretAccessKey: "integration-secret-access-key",
            },
            "storage-provider-1",
          ),
        );
        assert.equal(
          storageCreated.status,
          201,
          await storageCreated.clone().text(),
        );
        const storageProvider = (await storageCreated.json()) as {
          id: string;
          key: string;
          default: boolean;
          credentialFingerprint: string;
          credentialVersion: number;
        };
        assert.equal(storageProvider.key, "integration-workspaces");
        assert.equal(storageProvider.default, true);
        assert.match(storageProvider.credentialFingerprint, /^[a-f0-9]{12}$/u);
        assert.doesNotMatch(
          JSON.stringify(storageProvider),
          /integration-(?:access|secret)/u,
        );
        const storedStorageCredential = await pool.query<{
          encrypted_credential: Buffer;
          encryption_nonce: Buffer;
          encryption_tag: Buffer;
        }>(
          `SELECT encrypted_credential,encryption_nonce,encryption_tag
             FROM oao.project_storage_providers
            WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            storageProvider.id,
          ],
        );
        assert.equal(
          storedStorageCredential.rows[0]?.encryption_nonce.length,
          12,
        );
        assert.equal(
          storedStorageCredential.rows[0]?.encryption_tag.length,
          16,
        );
        assert.doesNotMatch(
          storedStorageCredential.rows[0]?.encrypted_credential.toString() ??
            "",
          /integration-secret/u,
        );

        const storageRotated = await hosted.request(
          `${projectPath}/storage-providers/${storageProvider.id}/credential`,
          {
            ...jsonRequest(
              {
                accessKeyId: "integration-access-key-rotated",
                secretAccessKey: "integration-secret-access-key-rotated",
              },
              "storage-provider-rotate-1",
            ),
            method: "PUT",
          },
        );
        assert.equal(storageRotated.status, 200);
        assert.equal(
          ((await storageRotated.json()) as { credentialVersion: number })
            .credentialVersion,
          2,
        );
        const storageListed = await hosted.request(
          `${projectPath}/storage-providers`,
        );
        const storageList = (await storageListed.json()) as {
          data: { key: string; bucket: string }[];
          credentialEncryptionConfigured: boolean;
        };
        assert.equal(storageList.credentialEncryptionConfigured, true);
        assert.equal(storageList.data.length, 1);
        assert.equal(storageList.data[0]?.key, "integration-workspaces");
        assert.equal(storageList.data[0]?.bucket, "oao-integration-workspaces");
        assert.doesNotMatch(
          JSON.stringify(storageList),
          /integration-secret-access-key/u,
        );

        const created = await hosted.request(
          `${projectPath}/model-presets`,
          jsonRequest(
            {
              key: "integration-preset-v1",
              displayName: "Integration preset",
              providerId: provider.id,
              model,
              routing: {
                zeroDataRetention: true,
                dataCollection: "deny",
                providerAllowlist: ["anthropic"],
              },
            },
            "model-preset-1",
          ),
        );
        assert.equal(created.status, 201);
        const preset = (await created.json()) as Record<string, unknown>;
        assert.equal(preset.origin, "project");
        assert.equal(preset.model, model);
        assert.equal(preset.available, true);

        const replay = await hosted.request(
          `${projectPath}/model-presets`,
          jsonRequest(
            {
              key: "integration-preset-v1",
              displayName: "Integration preset",
              providerId: provider.id,
              model,
              routing: {
                zeroDataRetention: true,
                dataCollection: "deny",
                providerAllowlist: ["anthropic"],
              },
            },
            "model-preset-1",
          ),
        );
        assert.equal(replay.headers.get("idempotency-replayed"), "true");

        const duplicate = await hosted.request(
          `${projectPath}/model-presets`,
          jsonRequest(
            {
              key: "integration-preset-v1",
              displayName: "Duplicate key",
              providerId: provider.id,
              model,
            },
            "model-preset-duplicate",
          ),
        );
        assert.equal(duplicate.status, 409);

        const listed = await hosted.request(`${projectPath}/model-presets`);
        const listedBody = (await listed.json()) as {
          data: { key: string; origin: string }[];
          credentialEncryptionConfigured: boolean;
        };
        assert.equal(listedBody.credentialEncryptionConfigured, true);
        assert.deepEqual(
          listedBody.data.map((entry) => `${entry.origin}:${entry.key}`),
          ["project:integration-preset-v1", `project:${baseModelPresetKey}`],
        );

        const context = await hosted.request("/v1/context");
        assert.deepEqual(
          ((await context.json()) as { activeModelPresets: string[] })
            .activeModelPresets,
          [baseModelPresetKey, "integration-preset-v1"],
        );

        const published = await hosted.request(
          `${projectPath}/agents`,
          jsonRequest(
            {
              key: "preset-agent",
              name: "Preset agent",
              config: {
                systemPrompt: "Answer questions.",
                modelPreset: "integration-preset-v1",
                tools: [],
                sandbox: disabledSandbox,
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
            "preset-agent-1",
          ),
        );
        assert.equal(published.status, 201);
        assert.equal(
          ((await published.json()) as { model: string }).model,
          "integration-preset-v1",
        );

        const sandboxAgent = await hosted.request(
          `${projectPath}/agents`,
          jsonRequest(
            {
              key: "sandbox-agent",
              name: "Sandbox agent",
              config: {
                systemPrompt: "Use only the enabled sandbox capabilities.",
                modelPreset: baseModelPresetKey,
                tools: [],
                sandbox: {
                  enabled: true,
                  provider: "integration-daytona",
                  snapshotId: "77777777-7777-4777-8777-777777777777",
                  network: "restricted",
                  capabilities: ["filesystem_read", "shell", "browser"],
                },
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
            "sandbox-agent-1",
          ),
        );
        assert.equal(sandboxAgent.status, 201);

        // Approval is audited and no response body carries a credential.
        const audit = await hosted.request(`${projectPath}/audit?limit=100`);
        const auditText = await audit.text();
        assert.match(auditText, /model_preset\.created/u);
        assert.doesNotMatch(
          auditText,
          /OPENROUTER_API_KEY|daytona-integration|apiKey|authorization/iu,
        );
      },
    );
  },
);
