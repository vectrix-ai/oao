import assert from "node:assert/strict";
import test from "node:test";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import type { PgPool } from "@oao/db-postgres";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import { createApiApp, type ModelCatalogPort } from "../../src/app.js";
import { PostgresApiStore } from "../../src/store.js";
import type { RuntimeCommandPort } from "../../src/runtime-commands.js";

const unusedRuntimeCommands: RuntimeCommandPort = {
  enqueue: async () => {
    throw new Error("runtime commands are not expected in this unit test");
  },
};

const catalog: ModelCatalogPort = {
  deploymentPresets: [{ key: "local-default", model: "fake/deterministic" }],
  listCatalog: () => [
    {
      providerType: "openrouter",
      model: "openrouter/anthropic/claude-sonnet-4.6",
      catalogId: "anthropic/claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      reasoning: true,
    },
  ],
  isApprovedModel: (model) =>
    model === "openrouter/anthropic/claude-sonnet-4.6",
};
const credentialCipher = new ProviderCredentialCipher(Buffer.alloc(32, 3));
const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const providerId = "00000000-0000-4000-8000-000000000077";
const encryptedProviderKey = credentialCipher.encrypt("sk-openrouter-live", {
  organizationId,
  projectId,
  providerId,
  providerType: "openrouter",
  keyVersion: 1,
});
const defaultProviderRow = {
  id: providerId,
  provider_type: "openrouter",
  encrypted_api_key: encryptedProviderKey.ciphertext,
  encryption_nonce: encryptedProviderKey.nonce,
  encryption_tag: encryptedProviderKey.tag,
  encryption_key_version: encryptedProviderKey.keyVersion,
};

interface QueryLog {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * Records every statement so a test can assert tenant scoping without a live
 * database. Membership, idempotency, and preset lookups return empty results
 * unless a route needs a specific shape.
 */
function recordingPool(
  rowsByFragment: Readonly<Record<string, unknown[]>> = {},
) {
  const queries: QueryLog[] = [];
  const pool = {
    connect: async () => ({
      query: async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(text.trim()))
          return { rowCount: 0, rows: [] };
        if (text.includes("set_tenant_context"))
          return { rowCount: 0, rows: [] };
        if (text.includes("oao.project_members"))
          return { rowCount: 1, rows: [{ ok: 1 }] };
        for (const [fragment, rows] of Object.entries(rowsByFragment))
          if (text.includes(fragment)) return { rowCount: rows.length, rows };
        return { rowCount: 0, rows: [] };
      },
      release: () => undefined,
    }),
    query: async (text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      return { rowCount: 0, rows: [] };
    },
  } as unknown as PgPool;
  return { pool, queries };
}

async function authenticate(
  app: ReturnType<typeof createApiApp>,
): Promise<{ readonly cookie: string; readonly projectId: string }> {
  const login = await app.request("/v1/auth/development/login", {
    method: "POST",
  });
  const setCookie = login.headers.get("set-cookie") ?? "";
  const match = /(?:^|,\s*)oao_session=([^;]*)/u.exec(setCookie);
  assert.ok(match?.[1]);
  const body = (await login.json()) as {
    readonly principal: { readonly projectId: string };
  };
  return {
    cookie: `oao_session=${match[1]}`,
    projectId: body.principal.projectId,
  };
}

function app(
  input: {
    readonly catalog?: ModelCatalogPort;
    readonly rows?: Readonly<Record<string, unknown[]>>;
    readonly encryptionConfigured?: boolean;
  } = {},
) {
  const { pool, queries } = recordingPool({
    "FROM oao.project_model_providers": [defaultProviderRow],
    ...input.rows,
  });
  return {
    queries,
    app: createApiApp({
      store: new PostgresApiStore(pool, "unit-test-api-key-pepper"),
      auth: new DevelopmentAuthAdapter(),
      runtimeCommands: unusedRuntimeCommands,
      activeModelPresetKeys: new Set(["local-default"]),
      ...(input.encryptionConfigured === false ? {} : { credentialCipher }),
      ...(input.catalog === undefined ? {} : { modelCatalog: input.catalog }),
      authConfiguration: {
        provider: "development",
        appOrigins: ["http://localhost"],
        appOrigin: "http://localhost",
        callbackUri: "http://localhost/v1/auth/callback",
        cookieSecure: false,
      },
    }),
  };
}

function createRequest(
  cookie: string,
  body: Readonly<Record<string, unknown>>,
  key = "preset-1",
): RequestInit {
  return {
    method: "POST",
    headers: {
      cookie,
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  };
}

const validPreset = {
  key: "claude-sonnet-4-6-zdr-v1",
  displayName: "Claude Sonnet 4.6 (zero retention)",
  providerId,
  model: "openrouter/anthropic/claude-sonnet-4.6",
  routing: { zeroDataRetention: true, providerAllowlist: ["anthropic"] },
};

test("model preset routes are scoped to the principal's project", async () => {
  const harness = app({ catalog });
  const foreignProject = "/v1/projects/00000000-0000-4000-8000-000000000099";
  // The tenant scope is refused before any database access, with and without
  // an established session.
  assert.equal(
    (await harness.app.request(`${foreignProject}/model-presets`)).status,
    403,
  );
  assert.equal(
    (await harness.app.request(`${foreignProject}/model-catalog`)).status,
    403,
  );
  const { cookie } = await authenticate(harness.app);
  assert.equal(
    (
      await harness.app.request(`${foreignProject}/model-presets`, {
        headers: { cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    harness.queries.filter((query) =>
      query.text.includes("project_model_presets"),
    ).length,
    0,
  );
});

test("preset listing includes deployment presets and encryption state", async () => {
  const harness = app({ catalog });
  const { cookie, projectId } = await authenticate(harness.app);
  const response = await harness.app.request(
    `/v1/projects/${projectId}/model-presets`,
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    readonly data: readonly Record<string, unknown>[];
    readonly credentialEncryptionConfigured: boolean;
  };
  assert.equal(body.credentialEncryptionConfigured, true);
  assert.deepEqual(
    body.data.map((preset) => preset.key),
    ["local-default"],
  );
  assert.equal(body.data[0]?.origin, "deployment");
  assert.equal(body.data[0]?.model, "fake/deterministic");
  const listing = harness.queries.find((query) =>
    query.text.includes("FROM oao.project_model_presets"),
  );
  assert.ok(listing);
  assert.equal(listing.values[1], projectId);
});

test("catalog listing exposes only safe metadata", async () => {
  const harness = app({ catalog });
  const { cookie, projectId } = await authenticate(harness.app);
  const response = await harness.app.request(
    `/v1/projects/${projectId}/model-catalog?providerId=${validPreset.providerId}`,
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /anthropic\/claude-sonnet-4\.6/u);
  assert.doesNotMatch(text, /apiKey|authorization|OPENROUTER_API_KEY/iu);

  const filtered = await harness.app.request(
    `/v1/projects/${projectId}/model-catalog?providerId=${validPreset.providerId}&search=nothing-matches`,
    { headers: { cookie } },
  );
  assert.deepEqual((await filtered.json()).data, []);
});

test("OpenRouter catalog lookup uses the decrypted project provider key", async () => {
  let observedApiKey: string | undefined;
  const liveCatalog: ModelCatalogPort = {
    ...catalog,
    listCatalog: (input) => {
      observedApiKey = input?.apiKey;
      return catalog.listCatalog(input);
    },
  };
  const harness = app({ catalog: liveCatalog });
  const { cookie, projectId } = await authenticate(harness.app);
  const response = await harness.app.request(
    `/v1/projects/${projectId}/model-catalog?providerId=${validPreset.providerId}`,
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  assert.equal(observedApiKey, "sk-openrouter-live");
});

test("preset creation validates keys, catalog membership, and routing", async () => {
  const harness = app({ catalog });
  const { cookie, projectId } = await authenticate(harness.app);
  const path = `/v1/projects/${projectId}/model-presets`;

  const missingIdempotency = await harness.app.request(path, {
    method: "POST",
    headers: {
      cookie,
      origin: "http://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify(validPreset),
  });
  assert.equal(missingIdempotency.status, 400);

  const unversioned = await harness.app.request(
    path,
    createRequest(cookie, { ...validPreset, key: "no-version-suffix" }),
  );
  assert.equal(unversioned.status, 400);

  const deploymentCollision = await harness.app.request(
    path,
    createRequest(cookie, { ...validPreset, key: "local-default" }),
  );
  assert.equal(deploymentCollision.status, 400);

  const unknownModel = await harness.app.request(
    path,
    createRequest(cookie, {
      ...validPreset,
      model: "openrouter/not-a-real/model",
    }),
  );
  assert.equal(unknownModel.status, 400);
  assert.match((await unknownModel.json()).error.message, /provider catalog/u);

  const providerWireNames = await harness.app.request(
    path,
    createRequest(cookie, {
      ...validPreset,
      routing: { allow_fallbacks: false },
    }),
  );
  assert.equal(providerWireNames.status, 400);

  const credential = await harness.app.request(
    path,
    createRequest(cookie, { ...validPreset, apiKey: "never-accepted" }),
  );
  assert.equal(credential.status, 400);
});

test("encryption-disabled deployments refuse to approve a hosted preset", async () => {
  const harness = app({
    catalog,
    encryptionConfigured: false,
  });
  const { cookie, projectId } = await authenticate(harness.app);
  const response = await harness.app.request(
    `/v1/projects/${projectId}/model-presets`,
    createRequest(cookie, validPreset),
  );
  assert.equal(response.status, 500);
  assert.match(
    (await response.json()).error.message,
    /credential encryption is not configured/u,
  );
});

test("encryption-disabled project presets cannot be linked to a new agent version", async () => {
  const harness = app({
    catalog,
    encryptionConfigured: false,
    rows: { "FROM oao.project_model_presets": [{ approved: 1 }] },
  });
  const { cookie, projectId } = await authenticate(harness.app);
  const response = await harness.app.request(
    `/v1/projects/${projectId}/agents`,
    createRequest(cookie, {
      name: "Unavailable model agent",
      config: {
        systemPrompt: "Answer support questions safely.",
        modelPreset: "claude-sonnet-4-6-zdr-v1",
        tools: [],
        sandbox: {
          enabled: false,
          provider: "daytona-primary",
          network: "none",
          capabilities: [],
        },
        limits: { maxTurns: 32, timeoutMs: 60_000 },
      },
    }),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /not available/u);
});

test("a valid preset is inserted, audited, and returned without credentials", async () => {
  const created = {
    id: "00000000-0000-4000-8000-000000000701",
    organization_id: "00000000-0000-4000-8000-000000000001",
    project_id: "00000000-0000-4000-8000-000000000002",
    key: validPreset.key,
    display_name: validPreset.displayName,
    origin: "project",
    provider_id: validPreset.providerId,
    provider_type: "openrouter",
    model: validPreset.model,
    routing: validPreset.routing,
    hosted: true,
    available: true,
    created_by_principal_id: "00000000-0000-4000-8000-000000000003",
    created_at: new Date("2026-08-20T09:00:00.000Z"),
  };
  const harness = app({
    catalog,
    rows: { "INSERT INTO oao.project_model_presets": [created] },
  });
  const { cookie, projectId } = await authenticate(harness.app);
  const response = await harness.app.request(
    `/v1/projects/${projectId}/model-presets`,
    createRequest(cookie, validPreset),
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.key, validPreset.key);
  assert.equal(body.origin, "project");
  assert.equal(body.available, true);
  assert.deepEqual(body.routing, validPreset.routing);

  const insert = harness.queries.find((query) =>
    query.text.includes("INSERT INTO oao.project_model_presets"),
  );
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(0, 2), [
    created.organization_id,
    projectId,
  ]);
  assert.ok(
    harness.queries.some(
      (query) =>
        query.text.includes("append_audit_entry") &&
        query.values.includes("model_preset.created"),
    ),
  );
});

test("agent publication rejects a preset the project never approved", async () => {
  const harness = app({ catalog });
  const { cookie, projectId } = await authenticate(harness.app);
  const response = await harness.app.request(
    `/v1/projects/${projectId}/agents`,
    createRequest(
      cookie,
      {
        name: "Support agent",
        config: {
          systemPrompt: "Answer support questions.",
          modelPreset: "never-approved-v1",
          tools: [],
          sandbox: {
            enabled: false,
            provider: "daytona-primary",
            network: "none",
            capabilities: [],
          },
          limits: { maxTurns: 32, timeoutMs: 60_000 },
        },
      },
      "agent-1",
    ),
  );
  assert.equal(response.status, 400);
  assert.match(
    (await response.json()).error.message,
    /not an approved model preset/u,
  );
  assert.ok(
    harness.queries.some((query) =>
      query.text.includes("FROM oao.project_model_presets"),
    ),
  );
});
