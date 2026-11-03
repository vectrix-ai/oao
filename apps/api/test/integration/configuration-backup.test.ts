import assert from "node:assert/strict";
import test from "node:test";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import type {
  ConfigurationBackup,
  ConfigurationRestorePlan,
  ConfigurationRestoreResult,
} from "@oao/contracts";
import { createPool, migrate, type PgPool } from "@oao/db-postgres";
import {
  brandedId,
  type AuthorizationScope,
  type OrganizationId,
  type Principal,
  type PrincipalId,
  type ProjectId,
} from "@oao/domain";
import type { McpRemotePort } from "@oao/mcp-remote";
import {
  isApprovedCatalogModel,
  listApprovedModelCatalog,
} from "@oao/models-openrouter";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import { createApiApp } from "../../src/app.js";
import { PostgresApiStore } from "../../src/store.js";

const databaseUrl = process.env.DATABASE_URL;

function person(
  organizationId: string,
  projectId: string,
  id: string,
  subject: string,
): Principal {
  return {
    id: brandedId<PrincipalId>(id),
    organizationId: brandedId<OrganizationId>(organizationId),
    projectId: brandedId<ProjectId>(projectId),
    kind: "human",
    subject,
    scopes: new Set<AuthorizationScope>(["*"]),
  };
}

const source = person(
  "00000000-0000-4000-8000-00000000b001",
  "00000000-0000-4000-8000-00000000b002",
  "00000000-0000-4000-8000-00000000b003",
  "backup-source-user",
);
const target = person(
  "00000000-0000-4000-8000-00000000c001",
  "00000000-0000-4000-8000-00000000c002",
  "00000000-0000-4000-8000-00000000c003",
  "backup-target-user",
);

// The secrets the source was configured with. Restoring with the same ones
// must reproduce the same credential fingerprints.
const SECRETS = {
  openrouter: "sk-backup-openrouter-secret",
  daytona: "daytona-backup-secret-key",
  s3: {
    accessKeyId: "AKIABACKUPTEST",
    secretAccessKey: "backup-s3-secret-access-key",
  },
  mcp: "backup-mcp-bearer-secret",
  hookA: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
  hookB: `whsec_${Buffer.alloc(32, 2).toString("base64")}`,
} as const;

let discoveryRevision = 1;
const oauthResource = "https://extraction.example.test/mcp";
const oauthConfig = {
  resource: oauthResource,
  resourceMetadataUrl:
    "https://extraction.example.test/.well-known/oauth-protected-resource/mcp",
  issuer: "https://auth.example.test",
  tokenEndpoint: "https://auth.example.test/oauth2/token",
  clientId: "client_backup",
  tokenEndpointAuthMethod: "client_secret_basic" as const,
  scope: "extraction:mcp",
  sendResource: false,
};

const mcpRemote: McpRemotePort = {
  discoverAuthorization: (endpointUrl) =>
    Promise.resolve({
      endpointUrl,
      resource: oauthResource,
      resourceName: null,
      resourceMetadataUrl: oauthConfig.resourceMetadataUrl,
      resourceMetadataSource: "www_authenticate",
      challengeScope: null,
      scopesSupported: [oauthConfig.scope],
      authorizationServers: [
        {
          issuer: oauthConfig.issuer,
          tokenEndpoint: oauthConfig.tokenEndpoint,
          metadataSource: "oauth",
          tokenEndpointAuthMethodsSupported: null,
          grantTypesSupported: null,
          scopesSupported: null,
          problem: null,
        },
      ],
    }),
  testCredential: () => Promise.resolve({ expiresIn: 60, grantedScope: null }),
  discover: () =>
    Promise.resolve([
      {
        name: "lookup_trace",
        title: "Lookup trace",
        description: `Find a trace. Revision ${discoveryRevision}.`,
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
    Promise.resolve({ content: "{}", isError: false, responseBytes: 2 }),
};

const cipher = new ProviderCredentialCipher(Buffer.alloc(32, 9));

function api(pool: PgPool, principal: Principal) {
  return createApiApp({
    store: new PostgresApiStore(pool, "backup-api-key-pepper"),
    auth: new DevelopmentAuthAdapter({ principal }),
    runtimeCommands: { enqueue: async () => {} },
    credentialCipher: cipher,
    mcpRemote,
    modelCatalog: {
      deploymentPresets: [],
      listCatalog: (input) => listApprovedModelCatalog(input?.providerType),
      isApprovedModel: isApprovedCatalogModel,
    },
  });
}

type App = ReturnType<typeof api>;
let requestNumber = 0;

async function call<T>(
  app: App,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body: Readonly<Record<string, unknown>> | undefined,
  expected: number,
): Promise<T> {
  requestNumber += 1;
  const response = await app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": `backup-test-${requestNumber}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const caller = {
  schemaVersion: 1,
  name: "lookup_order",
  description: "Look up one order.",
  owner: "caller",
  approval: "never",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { status: { type: "string" } },
    required: ["status"],
    additionalProperties: false,
  },
} as const;
const sandbox = {
  enabled: false,
  provider: "backup-daytona",
  network: "none",
  capabilities: [],
} as const;
const limits = { maxTurns: 16, timeoutMs: 60_000 } as const;

/** Seeds a source organization with one of every configuration resource. */
async function seedSource(
  pool: PgPool,
  app: App,
  model: string,
): Promise<void> {
  const project = `/v1/projects/${source.projectId}`;
  const provider = await call<{ id: string }>(
    app,
    "POST",
    `${project}/model-providers`,
    {
      key: "backup-openrouter",
      displayName: "Backup OpenRouter",
      providerType: "openrouter",
      apiKey: SECRETS.openrouter,
    },
    201,
  );
  await call(
    app,
    "POST",
    `${project}/model-presets`,
    {
      key: "backup-model-v1",
      displayName: "Backup model",
      providerId: provider.id,
      model,
    },
    201,
  );
  // An archived connection with an archived preset that still points at it.
  const retired = await call<{ id: string }>(
    app,
    "POST",
    `${project}/model-providers`,
    {
      key: "backup-retired",
      displayName: "Retired OpenRouter",
      providerType: "openrouter",
      apiKey: "sk-backup-retired-secret",
    },
    201,
  );
  const retiredPreset = await call<{ id: string }>(
    app,
    "POST",
    `${project}/model-presets`,
    {
      key: "backup-retired-model-v1",
      displayName: "Retired model",
      providerId: retired.id,
      model,
    },
    201,
  );
  await call(
    app,
    "DELETE",
    `${project}/model-presets/${retiredPreset.id}`,
    undefined,
    200,
  );
  await call(
    app,
    "DELETE",
    `${project}/model-providers/${retired.id}`,
    undefined,
    200,
  );

  await call(
    app,
    "POST",
    `${project}/sandbox-providers`,
    {
      key: "backup-daytona",
      displayName: "Backup Daytona",
      providerType: "daytona",
      apiKey: SECRETS.daytona,
      target: "eu",
      restrictedEgress: {
        allowedDomains: ["api.example.test"],
        allowedCidrs: [],
      },
    },
    201,
  );
  await call(
    app,
    "POST",
    `${project}/storage-providers`,
    {
      key: "backup-s3",
      displayName: "Backup S3",
      providerType: "s3",
      endpoint: null,
      region: "eu-west-1",
      bucket: "backup-bucket",
      prefix: null,
      forcePathStyle: false,
      setDefault: true,
      ...SECRETS.s3,
    },
    201,
  );

  const credential = await call<{ id: string }>(
    app,
    "POST",
    `${project}/mcp-credentials`,
    {
      key: "backup-trace-token",
      displayName: "Trace token",
      kind: "static_bearer",
      headerName: null,
      destination: { origin: "https://mcp.example.test", pathPrefix: "/mcp" },
      secret: SECRETS.mcp,
    },
    201,
  );
  await call(
    app,
    "POST",
    `${project}/mcp-credentials`,
    {
      key: "backup-extraction-oauth",
      displayName: "Extraction OAuth",
      kind: "oauth_client_credentials",
      oauth: oauthConfig,
      secret: SECRETS.mcp,
    },
    201,
  );
  const revoked = await call<{ id: string }>(
    app,
    "POST",
    `${project}/mcp-credentials`,
    {
      key: "backup-old-token",
      displayName: "Old token",
      kind: "api_key_header",
      headerName: "x-api-key",
      destination: { origin: "https://old.example.test", pathPrefix: "/" },
      secret: "backup-old-mcp-secret",
    },
    201,
  );
  await call(
    app,
    "DELETE",
    `${project}/mcp-credentials/${revoked.id}`,
    undefined,
    200,
  );
  const policy = await call<{ latestVersionId: string }>(
    app,
    "POST",
    `${project}/mcp-credential-policies`,
    {
      key: "backup-trace-egress",
      displayName: "Trace egress",
      credentialId: credential.id,
      exactOrigin: "https://mcp.example.test",
      pathPrefix: "/mcp",
      timeoutMs: 10_000,
      maximumResponseBytes: 65_536,
      forwardCallContext: true,
    },
    201,
  );
  const server = await call<{ id: string; latestVersionId: string }>(
    app,
    "POST",
    `${project}/mcp-servers`,
    {
      key: "backup-trace",
      displayName: "Trace MCP",
      endpointUrl: "https://mcp.example.test/mcp",
      transport: "streamable_http",
    },
    201,
  );
  await call(
    app,
    "POST",
    `${project}/mcp-servers/${server.id}/discover`,
    {
      credentialPolicyVersionId: policy.latestVersionId,
    },
    200,
  );
  const toolset = await call<{ latestVersionId: string }>(
    app,
    "POST",
    `${project}/mcp-toolsets`,
    {
      key: "backup-trace-tools",
      displayName: "Trace tools",
      serverVersionId: server.latestVersionId,
      tools: [{ remoteToolName: "lookup_trace", approval: "never" }],
    },
    201,
  );
  // Rediscovery after the remote changed creates server version 2.
  discoveryRevision = 2;
  await call(
    app,
    "POST",
    `${project}/mcp-servers/${server.id}/discover`,
    {
      credentialPolicyVersionId: policy.latestVersionId,
    },
    200,
  );

  const guide = Buffer.from("# Guide\n\nCheck the order first.\n").toString(
    "base64",
  );
  const skill = await call<{ id: string; latestVersionId: string }>(
    app,
    "POST",
    `${project}/skills`,
    {
      key: "order-triage",
      displayName: "Order triage",
      name: "order-triage",
      description: "Triage incoming orders.",
      instructions: "Read the guide, then triage.",
      license: "MIT",
      metadata: { owner: "operations" },
      files: [
        {
          path: "references/guide.md",
          contentType: "text/markdown",
          dataBase64: guide,
        },
        {
          path: "assets/logo.bin",
          contentType: "application/octet-stream",
          dataBase64: Buffer.from([0, 1, 2, 255]).toString("base64"),
        },
      ],
    },
    201,
  );
  const skillV2 = await call<{ id: string }>(
    app,
    "POST",
    `${project}/skills/${skill.id}/versions`,
    {
      name: "order-triage",
      description: "Triage incoming orders.",
      instructions: "Read the guide twice, then triage.",
      files: [
        {
          path: "references/guide.md",
          contentType: "text/markdown",
          dataBase64: guide,
        },
      ],
    },
    201,
  );
  const retiredSkill = await call<{ id: string; latestVersionId: string }>(
    app,
    "POST",
    `${project}/skills`,
    {
      key: "legacy-lookup",
      displayName: "Legacy lookup",
      name: "legacy-lookup",
      description: "The old lookup.",
      instructions: "Use the old lookup.",
    },
    201,
  );

  const child = await call<{ id: string; latestVersionId: string }>(
    app,
    "POST",
    `${project}/agents`,
    {
      key: "order-child",
      name: "Order child",
      config: {
        systemPrompt: "Handle one order.",
        modelPreset: "backup-model-v1",
        tools: [],
        // Follows the Skill's latest version instead of pinning one.
        skillIds: [skill.id],
        sandbox,
        limits,
      },
    },
    201,
  );
  const coordinator = await call<{ id: string; latestVersionId: string }>(
    app,
    "POST",
    `${project}/agents`,
    {
      key: "order-coordinator",
      name: "Order coordinator",
      description: "Coordinates orders.",
      config: {
        systemPrompt: "Coordinate orders.",
        modelPreset: "backup-model-v1",
        tools: [caller],
        skillVersionIds: [skill.latestVersionId],
        mcpBindings: [
          {
            toolsetVersionId: toolset.latestVersionId,
            credentialPolicyVersionId: policy.latestVersionId,
            namespace: "traces",
          },
        ],
        delegates: [
          {
            key: "child",
            description: "Handles one order.",
            agentVersionId: child.latestVersionId,
          },
        ],
        sandbox,
        limits,
      },
    },
    201,
  );
  await call(
    app,
    "POST",
    `${project}/agents/${coordinator.id}/versions`,
    {
      config: {
        systemPrompt: "Coordinate orders carefully.",
        modelPreset: "backup-model-v1",
        tools: [caller],
        skillVersionIds: [skillV2.id, retiredSkill.latestVersionId],
        // Follows the child's latest version instead of pinning one.
        delegates: [
          {
            key: "child",
            description: "Handles one order.",
            agentId: child.id,
          },
        ],
        harnessOperations: [
          {
            key: "summarise",
            description: "Summarise the order history.",
            instructions: "Summarise in three bullet points.",
            resultSchema: {
              type: "object",
              properties: { summary: { type: "string" } },
              required: ["summary"],
              additionalProperties: false,
            },
            timeoutMs: 30_000,
          },
        ],
        sandbox,
        limits,
      },
    },
    201,
  );
  // Lifecycle states applied after binding, as they would be in real use.
  await call(
    app,
    "PATCH",
    `${project}/skills/${skill.id}/versions/${skill.latestVersionId}/lifecycle`,
    { status: "deprecated" },
    200,
  );
  await call(
    app,
    "DELETE",
    `${project}/skills/${retiredSkill.id}`,
    undefined,
    200,
  );
  // An archived agent whose key is reused by a live one.
  const old = await call<{ id: string }>(
    app,
    "POST",
    `${project}/agents`,
    {
      key: "order-helper",
      name: "Old helper",
      config: {
        systemPrompt: "The old helper.",
        modelPreset: "backup-model-v1",
        tools: [],
        sandbox,
        limits,
      },
    },
    201,
  );
  await call(app, "DELETE", `${project}/agents/${old.id}`, undefined, 200);
  await call(
    app,
    "POST",
    `${project}/agents`,
    {
      key: "order-helper",
      name: "New helper",
      config: {
        systemPrompt: "The new helper.",
        modelPreset: "backup-model-v1",
        tools: [],
        sandbox,
        limits,
      },
    },
    201,
  );

  await call(
    app,
    "POST",
    `${project}/event-webhooks`,
    {
      displayName: "Order hook",
      endpointUrl: "https://hooks.example.test/oao",
      signingSecret: SECRETS.hookA,
      eventKinds: ["run.*"],
    },
    201,
  );
  await call(
    app,
    "POST",
    `${project}/event-webhooks`,
    {
      displayName: "Paused hook",
      endpointUrl: "https://hooks.example.test/paused",
      signingSecret: SECRETS.hookB,
      enabled: false,
    },
    201,
  );

  // A second, smaller project in the same organization.
  const second = await call<{ id: string }>(
    app,
    "POST",
    "/v1/projects",
    { slug: "backup-second", name: "Backup second" },
    201,
  );
  const copy = await pool.query<{ id: string }>(
    `SELECT id FROM oao.principals
      WHERE organization_id=$1 AND project_id=$2 AND subject=$3`,
    [source.organizationId, second.id, source.subject],
  );
  const secondApp = api(pool, {
    ...source,
    projectId: brandedId<ProjectId>(second.id),
    id: brandedId<PrincipalId>(copy.rows[0]!.id),
  });
  await call(
    secondApp,
    "POST",
    `/v1/projects/${second.id}/model-presets`,
    {
      key: "backup-model-v1",
      displayName: "Backup model",
      providerId: provider.id,
      model,
    },
    201,
  );
  await call(
    secondApp,
    "POST",
    `/v1/projects/${second.id}/agents`,
    {
      key: "second-agent",
      name: "Second agent",
      config: {
        systemPrompt: "Answer questions.",
        modelPreset: "backup-model-v1",
        tools: [],
        sandbox,
        limits,
      },
    },
    201,
  );
}

async function download(app: App, organizationId: string) {
  const response = await app.request(
    `/v1/organizations/${organizationId}/configuration-backup`,
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return {
    text,
    backup: JSON.parse(text) as ConfigurationBackup,
    disposition: response.headers.get("content-disposition") ?? "",
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Replaces IDs with stable labels and drops timestamps, for comparison. */
function normalise(backup: ConfigurationBackup, slugs: readonly string[]) {
  const labels = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object")
      for (const [key, nested] of Object.entries(value)) {
        if (key === "id" && typeof nested === "string")
          labels.set(nested, `#${labels.size}`);
        visit(nested);
      }
  };
  // Exports list projects by creation time; compare them in a fixed order.
  const projects = slugs.map((slug) => {
    const project = backup.projects.find((entry) => entry.slug === slug);
    assert.ok(project, `backup has no project ${slug}`);
    return project;
  });
  visit({ ...backup, projects });
  const replace = (value: unknown): unknown => {
    if (typeof value === "string" && UUID.test(value))
      return labels.get(value) ?? "#unknown";
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "publishedAt")
          .map(([key, nested]) => [key, replace(nested)]),
      );
    return value;
  };
  return replace({
    ...backup,
    exportedAt: undefined,
    organization: undefined,
    projects,
  });
}

const credentialsFor = (plan: ConfigurationRestorePlan) => {
  const byKind = (kind: string) =>
    plan.requiredCredentials.filter((entry) => entry.kind === kind);
  const webhooks = byKind("event_webhook");
  return {
    modelProviders: Object.fromEntries(
      byKind("model_provider").map((entry) => [entry.id, SECRETS.openrouter]),
    ),
    sandboxProviders: Object.fromEntries(
      byKind("sandbox_provider").map((entry) => [entry.id, SECRETS.daytona]),
    ),
    storageProviders: Object.fromEntries(
      byKind("storage_provider").map((entry) => [entry.id, SECRETS.s3]),
    ),
    mcpCredentials: Object.fromEntries(
      byKind("mcp_credential").map((entry) => [entry.id, SECRETS.mcp]),
    ),
    eventWebhooks: Object.fromEntries(
      webhooks.map((entry) => [
        entry.id,
        entry.displayName === "Order hook" ? SECRETS.hookA : SECRETS.hookB,
      ]),
    ),
  };
};

test(
  "an organization's configuration round-trips through a backup",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    await migrate(pool);
    t.after(async () => {
      await pool.end();
    });
    for (const [principal, slug] of [
      [source, "backup-source"],
      [target, "backup-target"],
    ] as const)
      await pool.query(
        `SELECT oao.bootstrap_project($1,$2,$3,$4,$5,$6,$7,$8,'development')`,
        [
          principal.organizationId,
          `${slug}-org`,
          `${slug} organization`,
          principal.projectId,
          slug,
          `${slug} project`,
          principal.id,
          principal.subject,
        ],
      );
    const model = listApprovedModelCatalog("openrouter")[0]?.model;
    assert.ok(model);
    const sourceApp = api(pool, source);
    const targetApp = api(pool, target);
    await seedSource(pool, sourceApp, model);

    const exported = await download(sourceApp, source.organizationId);
    const backup = exported.backup;
    await t.test("the backup holds every version and no secret", () => {
      assert.match(
        exported.disposition,
        /^attachment; filename="backup-source-org-\d{4}-\d{2}-\d{2}-\d{6}\.oao-backup\.json"$/u,
      );
      for (const secret of [
        SECRETS.openrouter,
        SECRETS.daytona,
        SECRETS.s3.accessKeyId,
        SECRETS.s3.secretAccessKey,
        SECRETS.mcp,
        SECRETS.hookA,
        SECRETS.hookB,
        "sk-backup-retired-secret",
        "backup-old-mcp-secret",
      ])
        assert.ok(!exported.text.includes(secret), `backup leaks ${secret}`);
      assert.doesNotMatch(exported.text, /encrypted|ciphertext|nonce/iu);
      assert.equal(backup.format, "oao.organization-configuration");
      assert.deepEqual(
        backup.projects.map((project) => project.slug),
        ["backup-source", "backup-second"],
      );
      const project = backup.projects[0]!;
      assert.deepEqual(
        project.agents.map((agent) => [
          agent.key,
          agent.archived,
          agent.versions.length,
        ]),
        [
          ["order-child", false, 1],
          ["order-coordinator", false, 2],
          ["order-helper", true, 1],
          ["order-helper", false, 1],
        ],
      );
      assert.deepEqual(
        project.skills.map((skill) => [
          skill.key,
          skill.archived,
          skill.versions.map((version) => version.status),
        ]),
        [
          ["order-triage", false, ["deprecated", "active"]],
          ["legacy-lookup", true, ["active"]],
        ],
      );
      assert.equal(project.skills[0]!.versions[0]!.files.length, 2);
      assert.deepEqual(
        backup.modelProviders.map((provider) => [
          provider.key,
          provider.archived,
        ]),
        [
          ["backup-openrouter", false],
          ["backup-retired", true],
        ],
      );
      assert.equal(backup.mcpServers[0]!.versions.length, 2);
      assert.equal(
        backup.mcpCredentialPolicies[0]!.versions[0]!.forwardCallContext,
        true,
      );
      // The pinned OAuth configuration is kept; its client secret is not.
      assert.deepEqual(
        backup.mcpCredentials.find(
          (credential) => credential.key === "backup-extraction-oauth",
        )?.oauth,
        oauthConfig,
      );
      assert.deepEqual(
        backup.mcpCredentials.map((credential) => [
          credential.key,
          credential.status,
          credential.destination,
        ]),
        [
          [
            "backup-trace-token",
            "active",
            { origin: "https://mcp.example.test", pathPrefix: "/mcp" },
          ],
          [
            "backup-extraction-oauth",
            "active",
            { origin: "https://extraction.example.test", pathPrefix: "/mcp" },
          ],
          [
            "backup-old-token",
            "revoked",
            { origin: "https://old.example.test", pathPrefix: "/" },
          ],
        ],
      );
    });

    await t.test(
      "restore refuses a non-empty organization and non-admins",
      async () => {
        const blocked = await call<ConfigurationRestorePlan>(
          sourceApp,
          "POST",
          `/v1/organizations/${source.organizationId}/configuration-restore/preview`,
          { backup },
          200,
        );
        assert.equal(blocked.ready, false);
        assert.ok(
          blocked.conflicts.some((conflict) =>
            /Project backup-source already has configuration \(4 agents, 2 Skills, 2 model presets, 1 MCP toolset, 2 event webhooks\)/u.test(
              conflict.message,
            ),
          ),
        );
        assert.ok(
          blocked.conflicts.some(
            (conflict) =>
              conflict.kind === "model_provider" &&
              /backup-openrouter/u.test(conflict.message),
          ),
        );
        await call(
          sourceApp,
          "POST",
          `/v1/organizations/${source.organizationId}/configuration-restore`,
          { backup, credentials: credentialsFor(blocked) },
          409,
        );

        // A project member without an organization role cannot restore.
        const memberId = "00000000-0000-4000-8000-00000000c009";
        await pool.query(
          `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
         VALUES ($1,$2,$3,'human','backup-member',ARRAY['*'])`,
          [target.organizationId, target.projectId, memberId],
        );
        await pool.query(
          `INSERT INTO oao.project_members (organization_id,project_id,principal_id,role,created_by_principal_id)
         VALUES ($1,$2,$3,'member',$4)`,
          [target.organizationId, target.projectId, memberId, target.id],
        );
        const memberApp = api(pool, {
          ...target,
          id: brandedId<PrincipalId>(memberId),
          subject: "backup-member",
        });
        await call(
          memberApp,
          "POST",
          `/v1/organizations/${target.organizationId}/configuration-restore/preview`,
          { backup },
          403,
        );
        const denied = await memberApp.request(
          `/v1/organizations/${target.organizationId}/configuration-backup`,
        );
        assert.equal(denied.status, 403);
      },
    );

    await t.test("a failed restore leaves nothing behind", async () => {
      const broken = structuredClone(backup);
      const coordinator = broken.projects[0]!.agents[1]!;
      coordinator.versions[1]!.config = {
        ...coordinator.versions[1]!.config,
        systemPrompt: "",
      };
      const plan = await call<ConfigurationRestorePlan>(
        targetApp,
        "POST",
        `/v1/organizations/${target.organizationId}/configuration-restore/preview`,
        { backup: broken },
        200,
      );
      assert.equal(plan.ready, true);
      const failed = await call<{ error: { message: string } }>(
        targetApp,
        "POST",
        `/v1/organizations/${target.organizationId}/configuration-restore`,
        { backup: broken, credentials: credentialsFor(plan) },
        400,
      );
      assert.match(
        failed.error.message,
        /Project backup-source, agent order-coordinator version 2/u,
      );
      const leftovers = await pool.query<{ count: number }>(
        `SELECT (SELECT count(*)::int FROM oao.projects WHERE organization_id=$1)
              + (SELECT count(*)::int FROM oao.project_model_providers WHERE organization_id=$1)
              + (SELECT count(*)::int FROM oao.mcp_servers WHERE organization_id=$1) AS count`,
        [target.organizationId],
      );
      assert.equal(
        leftovers.rows[0]?.count,
        1,
        "only the bootstrap project remains",
      );

      // A key the database rejects aborts the transaction; the error still
      // names the resource instead of becoming a server error.
      const rejected = structuredClone(backup);
      rejected.projects[0]!.skills[0]!.key = "Not Valid";
      const rejectedPlan = await call<ConfigurationRestorePlan>(
        targetApp,
        "POST",
        `/v1/organizations/${target.organizationId}/configuration-restore/preview`,
        { backup: rejected },
        200,
      );
      assert.equal(rejectedPlan.ready, true);
      const aborted = await call<{ error: { message: string } }>(
        targetApp,
        "POST",
        `/v1/organizations/${target.organizationId}/configuration-restore`,
        { backup: rejected, credentials: credentialsFor(rejectedPlan) },
        400,
      );
      assert.match(
        aborted.error.message,
        /^Project backup-source, Skill Not Valid: /u,
      );
    });

    await t.test("a restore needs every credential and no others", async () => {
      const plan = await call<ConfigurationRestorePlan>(
        targetApp,
        "POST",
        `/v1/organizations/${target.organizationId}/configuration-restore/preview`,
        { backup },
        200,
      );
      const credentials = credentialsFor(plan);
      const missing = await call<{ error: { message: string } }>(
        targetApp,
        "POST",
        `/v1/organizations/${target.organizationId}/configuration-restore`,
        { backup, credentials: { ...credentials, sandboxProviders: {} } },
        400,
      );
      assert.match(missing.error.message, /Backup Daytona \(backup-daytona\)/u);
      const retired = backup.modelProviders.find((p) => p.archived)!;
      await call(
        targetApp,
        "POST",
        `/v1/organizations/${target.organizationId}/configuration-restore`,
        {
          backup,
          credentials: {
            ...credentials,
            modelProviders: {
              ...credentials.modelProviders,
              [retired.id]: "sk-not-needed-secret",
            },
          },
        },
        400,
      );
    });

    await t.test(
      "restore waits for a concurrent write to an empty project and refuses it",
      async () => {
        // A third organization whose only project already has a backup slug.
        const racer = person(
          "00000000-0000-4000-8000-00000000d001",
          "00000000-0000-4000-8000-00000000d002",
          "00000000-0000-4000-8000-00000000d003",
          "backup-race-user",
        );
        await pool.query(
          `SELECT oao.bootstrap_project($1,'backup-race-org','Race organization',
             $2,'backup-second','Race project',$3,$4,'development')`,
          [racer.organizationId, racer.projectId, racer.id, racer.subject],
        );
        const raceApp = api(pool, racer);
        const plan = await call<ConfigurationRestorePlan>(
          raceApp,
          "POST",
          `/v1/organizations/${racer.organizationId}/configuration-restore/preview`,
          { backup },
          200,
        );
        assert.equal(
          plan.projects.find((project) => project.slug === "backup-second")
            ?.action,
          "use_empty_project",
        );
        // Another writer adds an agent and has not committed yet.
        const writer = await pool.connect();
        try {
          await writer.query("BEGIN");
          await writer.query(
            `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
             VALUES ($1,$2,'00000000-0000-4000-8000-00000000d009','racing-agent','Racing agent')`,
            [racer.organizationId, racer.projectId],
          );
          const restoring = call<{ error: { message: string } }>(
            raceApp,
            "POST",
            `/v1/organizations/${racer.organizationId}/configuration-restore`,
            { backup, credentials: credentialsFor(plan) },
            409,
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          await writer.query("COMMIT");
          const refused = await restoring;
          assert.match(
            refused.error.message,
            /Project backup-second already has configuration \(1 agent\)/u,
          );
        } finally {
          writer.release();
        }
        const projects = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM oao.projects WHERE organization_id=$1",
          [racer.organizationId],
        );
        assert.equal(projects.rows[0]?.count, 1);
      },
    );

    await t.test(
      "restore into an empty organization reproduces the configuration",
      async () => {
        // An existing empty project with a backup project's slug is filled in
        // and takes the backup's name.
        const empty = await call<{ id: string }>(
          targetApp,
          "POST",
          "/v1/projects",
          { slug: "backup-second", name: "Placeholder" },
          201,
        );
        const plan = await call<ConfigurationRestorePlan>(
          targetApp,
          "POST",
          `/v1/organizations/${target.organizationId}/configuration-restore/preview`,
          { backup },
          200,
        );
        assert.equal(plan.ready, true, JSON.stringify(plan.conflicts));
        assert.deepEqual(
          plan.projects.map((project) => [
            project.slug,
            project.action,
            project.projectId,
          ]),
          [
            ["backup-source", "create", null],
            ["backup-second", "use_empty_project", empty.id],
          ],
        );
        assert.deepEqual(
          plan.requiredCredentials.map((entry) => [
            entry.kind,
            entry.key ?? entry.displayName,
          ]),
          [
            ["model_provider", "backup-openrouter"],
            ["sandbox_provider", "backup-daytona"],
            ["storage_provider", "backup-s3"],
            ["mcp_credential", "backup-trace-token"],
            ["mcp_credential", "backup-extraction-oauth"],
            ["event_webhook", "Order hook"],
            ["event_webhook", "Paused hook"],
          ],
        );
        const result = await call<ConfigurationRestoreResult>(
          targetApp,
          "POST",
          `/v1/organizations/${target.organizationId}/configuration-restore`,
          { backup, credentials: credentialsFor(plan) },
          201,
        );
        assert.deepEqual(result.counts, plan.counts);
        assert.deepEqual(
          result.projects.map((project) => [project.slug, project.created]),
          [
            ["backup-source", true],
            ["backup-second", false],
          ],
        );
        assert.equal(result.projects[1]!.projectId, empty.id);
        const renamed = await pool.query<{ name: string }>(
          "SELECT name FROM oao.projects WHERE organization_id=$1 AND id=$2",
          [target.organizationId, empty.id],
        );
        assert.equal(renamed.rows[0]?.name, "Backup second");

        const restored = await download(targetApp, target.organizationId);
        assert.deepEqual(
          normalise(restored.backup, ["backup-source", "backup-second"]),
          normalise(backup, ["backup-source", "backup-second"]),
        );

        // Restored rows behave like the originals.
        const restoredProject = result.projects[0]!.projectId;
        const bindings = await pool.query<{ count: number }>(
          `SELECT
           (SELECT count(*)::int FROM oao.agent_version_skill_bindings WHERE organization_id=$1 AND project_id=$2)
         + (SELECT count(*)::int FROM oao.agent_version_mcp_bindings WHERE organization_id=$1 AND project_id=$2)
         + (SELECT count(*)::int FROM oao.agent_version_delegates WHERE organization_id=$1 AND project_id=$2)
         + (SELECT count(*)::int FROM oao.agent_version_harness_operations WHERE organization_id=$1 AND project_id=$2)
           AS count`,
          [target.organizationId, restoredProject],
        );
        // Skills: v1 → 1, v2 → 2; MCP: 1; delegates: v1 pins and v2
        // follows → 2; Harness Operations: 1.
        assert.equal(bindings.rows[0]?.count, 7);
        // The followed links point at the restored agent and Skill.
        const followed = await pool.query<{
          child_agent_definition_id: string;
          agent_key: string;
        }>(
          `SELECT edge.child_agent_definition_id,definition.agent_key
             FROM oao.agent_version_delegates edge
             JOIN oao.agent_definitions definition
               ON definition.organization_id=edge.organization_id
              AND definition.project_id=edge.project_id
              AND definition.id=edge.child_agent_definition_id
            WHERE edge.organization_id=$1 AND edge.project_id=$2`,
          [target.organizationId, restoredProject],
        );
        assert.deepEqual(
          followed.rows.map((row) => row.agent_key),
          ["order-child"],
        );
        const followedSkills = await pool.query<{ skill_key: string }>(
          `SELECT skill.skill_key
             FROM oao.agent_versions version
             JOIN oao.skills skill
               ON skill.organization_id=version.organization_id
              AND skill.project_id=version.project_id
              AND skill.id=(version.config->'skillIds'->>0)::uuid
            WHERE version.organization_id=$1 AND version.project_id=$2`,
          [target.organizationId, restoredProject],
        );
        assert.deepEqual(
          followedSkills.rows.map((row) => row.skill_key),
          ["order-triage"],
        );
        const providers = await pool.query<{
          provider_key: string;
          encrypted_api_key: Buffer;
          encryption_nonce: Buffer;
          encryption_tag: Buffer;
          encryption_key_version: number;
          id: string;
        }>(
          `SELECT id,provider_key,encrypted_api_key,encryption_nonce,encryption_tag,
                encryption_key_version
           FROM oao.project_model_providers
          WHERE organization_id=$1 AND archived_at IS NULL`,
          [target.organizationId],
        );
        const live = providers.rows[0]!;
        assert.equal(
          cipher.decrypt(
            {
              ciphertext: live.encrypted_api_key,
              nonce: live.encryption_nonce,
              tag: live.encryption_tag,
              keyVersion: live.encryption_key_version,
            },
            {
              organizationId: target.organizationId,
              providerId: live.id,
              providerType: "openrouter",
            },
          ),
          SECRETS.openrouter,
        );

        // The same backup cannot be restored twice.
        const again = await call<ConfigurationRestorePlan>(
          targetApp,
          "POST",
          `/v1/organizations/${target.organizationId}/configuration-restore/preview`,
          { backup },
          200,
        );
        assert.equal(again.ready, false);
      },
    );
  },
);
