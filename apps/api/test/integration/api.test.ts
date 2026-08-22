import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import {
  encodeWorkspaceBackupManifest,
  InMemoryArtifactAdapter,
  workspaceBackupManifestObjectKey,
} from "@oao/artifact-s3";
import { createPool, migrate, type Queryable } from "@oao/db-postgres";
import {
  isApprovedCatalogModel,
  listApprovedModelCatalog,
} from "@oao/models-openrouter";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import type { McpRemotePort } from "@oao/mcp-remote";
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
const baseModelPresetKey = "integration-base-model-v1";
const disabledSandbox = {
  enabled: false,
  provider: "daytona-primary",
  network: "none",
  capabilities: [],
} as const;
const fileSandbox = {
  enabled: true,
  provider: "integration-file-daytona",
  snapshotId: "77777777-7777-4777-8777-777777777777",
  network: "none",
  capabilities: ["filesystem_read", "filesystem_write", "shell"],
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

let fakeMcpDiscoveryRevision = 1;
const fakeMcpRemote: McpRemotePort = {
  discover: () =>
    Promise.resolve([
      {
        name: "lookup_trace",
        title: "Lookup trace",
        description: `Find an approved trace by identifier. Revision ${fakeMcpDiscoveryRevision}.`,
        inputSchema: {
          type: "object",
          properties: { traceId: { type: "string" } },
          required: ["traceId"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { found: { type: "boolean" } },
          required: ["found"],
          additionalProperties: false,
        },
      },
    ]),
  call: () =>
    Promise.resolve({
      content: '{"found":true}',
      isError: false,
      responseBytes: 14,
    }),
};

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
    const runFileStorageProviderId = "00000000-0000-4000-8000-000000009010";
    const runFileStorage = {
      resolve: (input: { readonly providerId?: string }) =>
        Promise.resolve(
          input.providerId && input.providerId !== runFileStorageProviderId
            ? undefined
            : { providerId: runFileStorageProviderId, store: artifacts },
        ),
    };
    const runtimeCommands = new TransactionalTestRuntimeCommands();
    const app = createApiApp({
      store: new PostgresApiStore(pool, "integration-api-key-pepper"),
      auth: new DevelopmentAuthAdapter({ principal: integrationPrincipal }),
      artifacts,
      runFileStorage,
      runtimeCommands,
      credentialCipher: new ProviderCredentialCipher(Buffer.alloc(32, 5)),
      mcpRemote: fakeMcpRemote,
      modelCatalog: {
        deploymentPresets: [],
        listCatalog: (input) => listApprovedModelCatalog(input?.providerType),
        isApprovedModel: isApprovedCatalogModel,
      },
      sandboxSnapshotCatalog: {
        listSnapshots: () =>
          Promise.resolve([
            {
              id: fileSandbox.snapshotId,
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
          ]),
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
    const fileSandboxProviderResponse = await app.request(
      `${projectPath}/sandbox-providers`,
      jsonRequest(
        {
          key: fileSandbox.provider,
          displayName: "Integration file Daytona",
          providerType: "daytona",
          apiKey: "daytona-integration-file-secret",
          target: null,
          restrictedEgress: { allowedDomains: [], allowedCidrs: [] },
        },
        "file-sandbox-provider-1",
      ),
    );
    assert.equal(fileSandboxProviderResponse.status, 201);

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
    let disabledAgentVersionId = "";
    let versionId = "";
    let sessionId = "";
    let runId = "";
    let skillId = "";
    let skillVersionId = "";

    await t.test(
      "MCP credentials remain redacted while immutable toolsets bind to agent versions",
      async () => {
        const credentialResponse = await app.request(
          `${projectPath}/mcp-credentials`,
          jsonRequest(
            {
              key: "integration-mcp-token",
              displayName: "Integration MCP token",
              kind: "static_bearer",
              headerName: null,
              secret: "integration-mcp-secret",
            },
            "mcp-credential-1",
          ),
        );
        assert.equal(credentialResponse.status, 201);
        const credentialText = await credentialResponse.text();
        assert.doesNotMatch(credentialText, /integration-mcp-secret/u);
        const credential = JSON.parse(credentialText) as { id: string };
        const rotationResponse = await app.request(
          `${projectPath}/mcp-credentials/${credential.id}/rotate`,
          jsonRequest(
            { secret: "rotated-integration-mcp-secret" },
            "mcp-credential-rotate-1",
          ),
        );
        assert.equal(rotationResponse.status, 200);
        const rotationText = await rotationResponse.text();
        assert.doesNotMatch(rotationText, /rotated-integration-mcp-secret/u);
        assert.equal(
          (JSON.parse(rotationText) as { credentialVersion: number })
            .credentialVersion,
          2,
        );

        const policyResponse = await app.request(
          `${projectPath}/mcp-credential-policies`,
          jsonRequest(
            {
              key: "integration-mcp-egress",
              displayName: "Integration MCP egress",
              credentialId: credential.id,
              exactOrigin: "https://mcp.example.test",
              pathPrefix: "/mcp",
              timeoutMs: 10_000,
              maximumResponseBytes: 65_536,
            },
            "mcp-policy-1",
          ),
        );
        assert.equal(policyResponse.status, 201);
        const policy = (await policyResponse.json()) as {
          latestVersionId: string;
        };

        const serverResponse = await app.request(
          `${projectPath}/mcp-servers`,
          jsonRequest(
            {
              key: "integration-mcp",
              displayName: "Integration MCP",
              endpointUrl: "https://mcp.example.test/mcp",
              transport: "streamable_http",
            },
            "mcp-server-1",
          ),
        );
        assert.equal(serverResponse.status, 201);
        const server = (await serverResponse.json()) as {
          id: string;
          latestVersionId: string;
        };
        const discovery = await app.request(
          `${projectPath}/mcp-servers/${server.id}/discover`,
          jsonRequest(
            { credentialPolicyVersionId: policy.latestVersionId },
            "mcp-discovery-1",
          ),
        );
        assert.equal(discovery.status, 200);
        assert.equal(
          ((await discovery.json()) as { tools: readonly unknown[] }).tools
            .length,
          1,
        );

        const toolsetResponse = await app.request(
          `${projectPath}/mcp-toolsets`,
          jsonRequest(
            {
              key: "trace-readonly",
              displayName: "Trace read-only",
              serverVersionId: server.latestVersionId,
              tools: [{ remoteToolName: "lookup_trace", approval: "always" }],
            },
            "mcp-toolset-1",
          ),
        );
        assert.equal(toolsetResponse.status, 201);
        const toolset = (await toolsetResponse.json()) as {
          latestVersionId: string;
        };

        const agentResponse = await app.request(
          `${projectPath}/agents`,
          jsonRequest(
            {
              key: "mcp-agent",
              name: "MCP agent",
              config: {
                systemPrompt: "Use the approved remote trace lookup tool only.",
                modelPreset: baseModelPresetKey,
                tools: [],
                mcpBindings: [
                  {
                    toolsetVersionId: toolset.latestVersionId,
                    credentialPolicyVersionId: policy.latestVersionId,
                    namespace: "traces",
                  },
                ],
                sandbox: disabledSandbox,
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
            "mcp-agent-1",
          ),
        );
        assert.equal(agentResponse.status, 201);
        const agent = (await agentResponse.json()) as {
          id: string;
          latestVersionId: string;
        };
        const binding = await pool.query(
          `SELECT namespace FROM oao.agent_version_mcp_bindings
            WHERE organization_id=$1 AND project_id=$2 AND agent_version_id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            agent.latestVersionId,
          ],
        );
        assert.deepEqual(binding.rows, [{ namespace: "traces" }]);

        const generatedName = await pool.query<{ name: string }>(
          "SELECT oao.mcp_tool_name('traces','lookup_trace') AS name",
        );
        assert.equal(generatedName.rows[0]?.name, "mcp__traces__lookup_trace");

        fakeMcpDiscoveryRevision = 2;
        const driftDiscovery = await app.request(
          `${projectPath}/mcp-servers/${server.id}/discover`,
          jsonRequest(
            { credentialPolicyVersionId: policy.latestVersionId },
            "mcp-discovery-drift-1",
          ),
        );
        assert.equal(driftDiscovery.status, 200);
        const driftedServer = (await driftDiscovery.json()) as {
          latestVersionId: string;
          version: number;
          tools: readonly { description: string }[];
        };
        assert.equal(driftedServer.version, 2);
        assert.notEqual(driftedServer.latestVersionId, server.latestVersionId);
        assert.match(driftedServer.tools[0]?.description ?? "", /Revision 2/u);
        const pinnedToolset = await pool.query<{ server_version_id: string }>(
          `SELECT server_version_id FROM oao.mcp_toolset_versions
            WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            toolset.latestVersionId,
          ],
        );
        assert.equal(
          pinnedToolset.rows[0]?.server_version_id,
          server.latestVersionId,
        );

        const revokeResponse = await app.request(
          `${projectPath}/mcp-credentials/${credential.id}`,
          {
            method: "DELETE",
            headers: { "idempotency-key": "mcp-credential-revoke-1" },
          },
        );
        assert.equal(revokeResponse.status, 200);
        assert.equal(
          ((await revokeResponse.json()) as { status: string }).status,
          "revoked",
        );

        const audit = await app.request(`${projectPath}/audit?limit=100`);
        assert.doesNotMatch(
          await audit.text(),
          /rotated-integration-mcp-secret|"authorization"\s*:/iu,
        );
      },
    );

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

    await t.test(
      "Skill drafts persist folders and multiple Markdown files before atomic publication",
      async () => {
        const created = await app.request(
          `${projectPath}/skill-drafts`,
          jsonRequest({}, "skill-draft-create-1"),
        );
        assert.equal(created.status, 201, await created.clone().text());
        const draft = (await created.json()) as {
          id: string;
          status: string;
          entries: readonly unknown[];
        };
        assert.equal(draft.status, "editing");
        assert.deepEqual(draft.entries, []);

        const saved = await app.request(
          `${projectPath}/skill-drafts/${draft.id}`,
          {
            ...jsonRequest(
              {
                key: "business-rules-library",
                displayName: "Business rules library",
                name: "business-rules-library",
                description: "Load customer-specific operating rules.",
                instructions:
                  "Read only the customer reference required for the request.",
              },
              "skill-draft-save-1",
            ),
            method: "PATCH",
          },
        );
        assert.equal(saved.status, 200, await saved.clone().text());

        const directory = await app.request(
          `${projectPath}/skill-drafts/${draft.id}/directories`,
          jsonRequest(
            { path: "references/customers" },
            "skill-draft-directory-1",
          ),
        );
        assert.equal(directory.status, 201, await directory.clone().text());

        for (const [index, customer] of ["acme", "globex"].entries()) {
          const uploaded = await app.request(
            `${projectPath}/skill-drafts/${draft.id}/files`,
            {
              ...jsonRequest(
                {
                  path: `references/customers/${customer}.md`,
                  contentType: "text/markdown",
                  dataBase64: Buffer.from(
                    `# ${customer}\n\nUse the approved ${customer} workflow.`,
                    "utf8",
                  ).toString("base64"),
                },
                `skill-draft-file-${index + 1}`,
              ),
              method: "PUT",
            },
          );
          assert.equal(uploaded.status, 200, await uploaded.clone().text());
        }

        const traversal = await app.request(
          `${projectPath}/skill-drafts/${draft.id}/files`,
          {
            ...jsonRequest(
              {
                path: "../escape.md",
                contentType: "text/markdown",
                dataBase64: Buffer.from("# Escape", "utf8").toString("base64"),
              },
              "skill-draft-traversal-1",
            ),
            method: "PUT",
          },
        );
        assert.equal(traversal.status, 400);

        const foldedCollision = await app.request(
          `${projectPath}/skill-drafts/${draft.id}/files`,
          {
            ...jsonRequest(
              {
                path: "references/customers/ACME.md",
                contentType: "text/markdown",
                dataBase64: Buffer.from("# Collision", "utf8").toString(
                  "base64",
                ),
              },
              "skill-draft-collision-1",
            ),
            method: "PUT",
          },
        );
        assert.equal(foldedCollision.status, 409);

        const validation = await app.request(
          `${projectPath}/skill-drafts/${draft.id}/validate`,
          { method: "POST" },
        );
        assert.equal(validation.status, 200, await validation.clone().text());
        assert.equal(
          ((await validation.json()) as { fileCount: number }).fileCount,
          2,
        );

        const published = await app.request(
          `${projectPath}/skill-drafts/${draft.id}/publish`,
          jsonRequest({}, "skill-draft-publish-1"),
        );
        assert.equal(published.status, 201, await published.clone().text());
        const publishedBody = (await published.json()) as {
          skillId: string;
          version: { id: string; version: number };
        };
        assert.equal(publishedBody.version.version, 1);

        const exported = await app.request(
          `${projectPath}/skills/${publishedBody.skillId}/versions/${publishedBody.version.id}/export`,
        );
        assert.equal(exported.status, 200);
        const files = (
          (await exported.json()) as {
            files: readonly { path: string; dataBase64: string }[];
          }
        ).files;
        assert.deepEqual(
          files.map((file) => file.path),
          ["references/customers/acme.md", "references/customers/globex.md"],
        );
        assert.match(
          Buffer.from(files[0]!.dataBase64, "base64").toString("utf8"),
          /approved acme workflow/u,
        );
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
      disabledAgentVersionId = firstBody.latestVersionId;
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
      "caller results are validated before persistence and normalized for agent retry",
      async () => {
        const createdAgent = await app.request(
          `${projectPath}/agents`,
          jsonRequest(
            {
              key: "tool-result-validation-agent",
              name: "Tool result validation agent",
              config: {
                systemPrompt: "Retry safe shipment lookups after failures.",
                modelPreset: baseModelPresetKey,
                tools: [
                  {
                    schemaVersion: 1,
                    name: "lookup_shipment",
                    description: "Look up one shipment.",
                    owner: "caller",
                    approval: "never",
                    inputSchema: {
                      type: "object",
                      properties: {
                        reference: { type: "string", minLength: 2 },
                      },
                      required: ["reference"],
                      additionalProperties: false,
                    },
                    outputSchema: {
                      type: "object",
                      properties: {
                        status: {
                          type: "string",
                          enum: ["in_transit", "delivered", "exception"],
                        },
                        eta: { type: ["string", "null"], format: "date-time" },
                        checkpoints: {
                          type: "array",
                          items: { type: "string" },
                          minItems: 1,
                        },
                      },
                      required: ["status", "eta", "checkpoints"],
                      additionalProperties: false,
                    },
                  },
                ],
                sandbox: disabledSandbox,
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
            "tool-result-validation-agent-create",
          ),
        );
        assert.equal(
          createdAgent.status,
          201,
          await createdAgent.clone().text(),
        );
        const validationAgent = (await createdAgent.json()) as {
          id: string;
          latestVersionId: string;
        };
        const validationThreadId = randomUUID();
        const validationSessionId = randomUUID();
        const validationRunId = randomUUID();
        await pool.query(
          `INSERT INTO oao.threads (organization_id,project_id,id,title)
           VALUES ($1,$2,$3,'Tool result validation')`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            validationThreadId,
          ],
        );
        await pool.query(
          `INSERT INTO oao.sessions
             (organization_id,project_id,id,thread_id,agent_version_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            validationSessionId,
            validationThreadId,
            validationAgent.latestVersionId,
          ],
        );
        await pool.query(
          `INSERT INTO oao.runs
             (organization_id,project_id,id,thread_id,session_id,agent_version_id,
              created_by_principal_id,idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'tool-result-validation-run')`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            validationRunId,
            validationThreadId,
            validationSessionId,
            validationAgent.latestVersionId,
            integrationPrincipal.id,
          ],
        );
        const toolCallId = randomUUID();
        const toolRequestKey = `api-validation:${toolCallId}`;
        await pool.query(
          "SELECT oao.publish_runtime_tool_call($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            toolCallId,
            validationRunId,
            `flue:${toolCallId}`,
            toolRequestKey,
            createHash("sha256").update(toolRequestKey).digest(),
            "lookup_shipment",
            "caller",
            { reference: "VX-2048" },
          ],
        );
        const claimed = await app.request(
          `${projectPath}/tool-calls/${toolCallId}/claim`,
          jsonRequest({ leaseMs: 60_000 }, "tool-result-validation-claim"),
        );
        assert.equal(claimed.status, 200, await claimed.clone().text());
        const fence = ((await claimed.json()) as { fence: string }).fence;
        const submitted = await app.request(
          `${projectPath}/tool-calls/${toolCallId}/result`,
          jsonRequest(
            {
              fence,
              safeResult: {
                version: 1,
                status: "success",
                value: {
                  status: "moving",
                  eta: "not-a-date",
                  checkpoints: [],
                },
              },
            },
            "tool-result-validation-submit",
          ),
        );
        assert.equal(submitted.status, 202, await submitted.clone().text());
        assert.deepEqual(await submitted.json(), {
          outcome: "submitted",
          normalizedFailure: {
            code: "invalid_tool_result",
            path: "safeResult.value.status",
          },
        });
        const persisted = await pool.query<{
          stage: string;
          safe_result: {
            status: string;
            error: { code: string; message: string };
          };
        }>(
          `SELECT call.stage,result.safe_result
           FROM oao.tool_calls call
           JOIN oao.tool_call_results result
             ON result.organization_id=call.organization_id
            AND result.project_id=call.project_id
            AND result.tool_call_id=call.id
           WHERE call.organization_id=$1 AND call.project_id=$2 AND call.id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            toolCallId,
          ],
        );
        assert.equal(persisted.rows[0]?.stage, "result_submitted");
        assert.equal(persisted.rows[0]?.safe_result.status, "failure");
        assert.equal(
          persisted.rows[0]?.safe_result.error.code,
          "invalid_tool_result",
        );
        assert.match(
          persisted.rows[0]?.safe_result.error.message ?? "",
          /safeResult\.value\.status/u,
        );
        assert.doesNotMatch(
          JSON.stringify(persisted.rows[0]?.safe_result),
          /not-a-date|moving/u,
        );
      },
    );

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
        const unsupportedTool = {
          schemaVersion: 1,
          name: "invalid",
          description: "Unsupported schema keyword",
          owner: "caller",
          approval: "never",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                $ref: "https://example.com/unsafe.json",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        };
        const apiRejection = await app.request(
          `${projectPath}/agents/${agentId}/versions`,
          jsonRequest(
            { config: { ...valid, tools: [unsupportedTool] } },
            "invalid-rich-schema-path",
          ),
        );
        assert.equal(apiRejection.status, 400);
        const apiError = (await apiRejection.json()) as {
          readonly error: {
            readonly details?: { readonly path?: string };
          };
        };
        assert.equal(
          apiError.error.details?.path,
          "tools[0].inputSchema.properties.query",
        );
        const invalid = [
          { ...valid, limits: { timeoutMs: 60_000 } },
          { ...valid, limits: { maxTurns: 32 } },
          { ...valid, limits: { maxTurns: "32", timeoutMs: 60_000 } },
          { ...valid, sandbox: { enabled: false } },
          {
            ...valid,
            tools: [unsupportedTool],
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
                      description: "Lookup arguments.",
                      properties: {
                        query: {
                          type: "string",
                          description: "The customer search query.",
                          minLength: 2,
                          maxLength: 200,
                        },
                        options: {
                          type: ["object", "null"],
                          description: "Optional dynamic lookup options.",
                        },
                      },
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
                sandbox: fileSandbox,
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
        const wordContext = Buffer.from([
          0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x80,
        ]);
        const rejectedWithoutSandbox = await app.request(
          `${projectPath}/sessions`,
          jsonRequest(
            {
              agentVersionId: disabledAgentVersionId,
              title: "Rejected raw file session",
              files: [
                {
                  name: "renewal-brief.docx",
                  contentType:
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  dataBase64: wordContext.toString("base64"),
                },
              ],
            },
            "session-files-without-sandbox-1",
          ),
        );
        assert.equal(rejectedWithoutSandbox.status, 409);
        assert.match(
          await rejectedWithoutSandbox.text(),
          /File attachments require a sandbox-enabled agent/u,
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
        const initialInput = await pool.query<{
          input_public: {
            files: readonly {
              name: string;
              contentType: string;
              objectKey: string;
              storageProviderId: string;
            }[];
          };
        }>(
          `SELECT input_public FROM oao.runs
           WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            sessionBody.run.id,
          ],
        );
        const emailManifest = initialInput.rows[0]?.input_public.files.find(
          (file) => file.name === "renewal.eml",
        );
        const wordManifest = initialInput.rows[0]?.input_public.files.find(
          (file) => file.name === "renewal-brief.docx",
        );
        assert.equal(
          emailManifest?.storageProviderId,
          runFileStorageProviderId,
        );
        assert.equal(wordManifest?.storageProviderId, runFileStorageProviderId);
        assert.ok(emailManifest);
        assert.ok(wordManifest);
        const emailFile = await artifacts.get({
          tenant: integrationPrincipal,
          key: emailManifest.objectKey,
        });
        const wordFile = await artifacts.get({
          tenant: integrationPrincipal,
          key: wordManifest.objectKey,
        });
        assert.equal(
          Buffer.from(emailFile?.bytes ?? []).toString("utf8"),
          emailContext,
        );
        assert.deepEqual(Buffer.from(wordFile?.bytes ?? []), wordContext);
        const storageRoot = await app.request(
          `${projectPath}/storage-providers/${runFileStorageProviderId}/objects`,
        );
        assert.equal(storageRoot.status, 200, await storageRoot.clone().text());
        const storageRootBody = (await storageRoot.json()) as {
          providerId: string;
          prefix: string;
          folders: readonly string[];
          objects: readonly { key: string }[];
          truncated: boolean;
        };
        assert.equal(storageRootBody.providerId, runFileStorageProviderId);
        assert.equal(storageRootBody.prefix, "");
        assert.ok(storageRootBody.folders.includes("run-files/"));
        const emailFolder = emailManifest.objectKey
          .split("/")
          .slice(0, -1)
          .join("/");
        const storageFolder = await app.request(
          `${projectPath}/storage-providers/${runFileStorageProviderId}/objects?prefix=${encodeURIComponent(emailFolder)}`,
        );
        assert.equal(
          storageFolder.status,
          200,
          await storageFolder.clone().text(),
        );
        const storageFolderBody = (await storageFolder.json()) as {
          objects: readonly { key: string; sizeBytes: number }[];
        };
        assert.deepEqual(
          storageFolderBody.objects.map((object) => object.key),
          [emailManifest.objectKey],
        );
        assert.equal(
          storageFolderBody.objects[0]?.sizeBytes,
          Buffer.byteLength(emailContext, "utf8"),
        );
        const badPrefix = await app.request(
          `${projectPath}/storage-providers/${runFileStorageProviderId}/objects?prefix=${encodeURIComponent("../escape")}`,
        );
        assert.equal(badPrefix.status, 400);
        const unknownProvider = await app.request(
          `${projectPath}/storage-providers/00000000-0000-4000-8000-000000009999/objects`,
        );
        assert.equal(unknownProvider.status, 404);
        const legacyTable = await pool.query<{ table_name: string | null }>(
          "SELECT to_regclass('oao.run_files')::text AS table_name",
        );
        assert.equal(legacyTable.rows[0]?.table_name, null);
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
            files?: readonly {
              name: string;
              sha256: string;
              objectKey: string;
              storageProviderId: string;
            }[];
          };
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
        const officeManifest = persistedInput.rows[0]?.input_public.files?.[0];
        assert.equal(
          officeManifest?.storageProviderId,
          runFileStorageProviderId,
        );
        assert.ok(officeManifest);
        const officeFile = await artifacts.get({
          tenant: integrationPrincipal,
          key: officeManifest.objectKey,
        });
        assert.equal(
          Buffer.from(officeFile?.bytes ?? []).toString("utf8"),
          officeContext,
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
        const backupIdentity = await pool.query<{
          thread_id: string;
          session_id: string;
        }>(
          `SELECT thread_id,session_id FROM oao.runs
           WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            runId,
          ],
        );
        const backupThreadId = backupIdentity.rows[0]?.thread_id;
        assert.ok(backupThreadId);
        const archive = Buffer.from("workspace archive");
        const archiveSha256 = createHash("sha256").update(archive).digest();
        const backupObjectKey = `workspace-backups/threads/${backupThreadId}/workspace.tar.gz`;
        const workspaceFiles = [
          {
            name: "account-brief.rtf",
            path: `.oao/attachments/${runId}/account-brief.rtf`,
            sizeBytes: Buffer.byteLength(officeContext, "utf8"),
          },
          { name: "result.csv", path: "output/result.csv", sizeBytes: 42 },
        ];
        await artifacts.put({
          tenant: integrationPrincipal,
          key: workspaceBackupManifestObjectKey(backupObjectKey),
          bytes: encodeWorkspaceBackupManifest({
            archive,
            files: workspaceFiles,
          }),
          contentType: "application/json",
        });
        await pool.query(
          `INSERT INTO oao.project_storage_providers (
             organization_id,project_id,id,provider_key,display_name,
             provider_type,endpoint,region,bucket,object_prefix,force_path_style,
             is_default,encrypted_credential,encryption_nonce,encryption_tag,
             encryption_key_version,credential_fingerprint,created_by_principal_id
           ) VALUES ($1,$2,$3,'run-files-test','Run files test','s3',NULL,
             'test-1','run-files',NULL,false,false,$4,$5,$6,1,$7,$8)`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            runFileStorageProviderId,
            Buffer.from("test"),
            Buffer.alloc(12, 1),
            Buffer.alloc(16, 2),
            "a".repeat(64),
            integrationPrincipal.id,
          ],
        );
        await pool.query(
          `INSERT INTO oao.thread_workspace_backups (
             organization_id,project_id,thread_id,session_id,storage_provider_id,
             last_run_id,object_key,content_length,content_sha256
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            backupThreadId,
            sessionId,
            runFileStorageProviderId,
            runId,
            backupObjectKey,
            archive.byteLength,
            archiveSha256,
          ],
        );
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
          tools: readonly {
            name: string;
            description: string;
            owner: string;
            approval: string;
          }[];
          transcript: readonly {
            runId: string;
            files: readonly {
              name: string;
              contentType: string;
              sizeBytes: number;
              sha256: string;
              storageProviderId: string;
              objectKey: string;
            }[];
          }[];
          debug: {
            workspaceBackups: readonly {
              lastRunId: string;
              manifestState: string;
              files: readonly {
                name: string;
                path: string;
                sizeBytes: number;
              }[];
            }[];
          };
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
        const transcript = detailBody.transcript;
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
        assert.equal(
          transcriptFile?.storageProviderId,
          runFileStorageProviderId,
        );
        assert.match(transcriptFile?.objectKey ?? "", /^run-files\/runs\//u);
        assert.equal(
          detailBody.debug.workspaceBackups[0]?.manifestState,
          "available",
        );
        assert.equal(detailBody.debug.workspaceBackups[0]?.lastRunId, runId);
        assert.equal(
          (
            detailBody.debug.workspaceBackups[0] as unknown as {
              storageProviderId?: string;
            }
          ).storageProviderId,
          runFileStorageProviderId,
        );
        assert.deepEqual(
          detailBody.debug.workspaceBackups[0]?.files,
          workspaceFiles,
        );
        await pool.query(
          `DELETE FROM oao.thread_workspace_backups
           WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            backupThreadId,
          ],
        );
        await pool.query(
          `DELETE FROM oao.project_storage_providers
           WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            runFileStorageProviderId,
          ],
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
        const resumeInput = await pool.query<{
          input_public: {
            files: readonly { name: string; objectKey: string }[];
          };
        }>(
          `SELECT input_public FROM oao.runs
           WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [
            integrationPrincipal.organizationId,
            integrationPrincipal.projectId,
            resumedRunId,
          ],
        );
        const resumeManifest = resumeInput.rows[0]?.input_public.files[0];
        assert.equal(resumeManifest?.name, "resume.txt");
        assert.ok(resumeManifest);
        const resumeFile = await artifacts.get({
          tenant: integrationPrincipal,
          key: resumeManifest.objectKey,
        });
        assert.equal(
          Buffer.from(resumeFile?.bytes ?? []).toString("utf8"),
          "resume file context",
        );
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
          ["integration-daytona", "integration-file-daytona"],
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

        const unavailableSnapshotAgent = await hosted.request(
          `${projectPath}/agents`,
          jsonRequest(
            {
              key: "sandbox-agent-unavailable-snapshot",
              name: "Sandbox agent unavailable snapshot",
              config: {
                systemPrompt: "Use only an active Daytona snapshot.",
                modelPreset: baseModelPresetKey,
                tools: [],
                sandbox: {
                  enabled: true,
                  provider: "integration-daytona",
                  snapshotId: "78787878-7878-4787-8787-787878787878",
                  network: "none",
                  capabilities: ["filesystem_read", "shell"],
                },
                limits: { maxTurns: 32, timeoutMs: 60_000 },
              },
            },
            "sandbox-agent-unavailable-snapshot-1",
          ),
        );
        assert.equal(unavailableSnapshotAgent.status, 400);
        assert.match(
          await unavailableSnapshotAgent.text(),
          /not an active snapshot for this Daytona connection/u,
        );

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
