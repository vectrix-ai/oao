import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import type { ModelPreset, ModelPresetLimits } from "@oao/contracts";
import { createPool, migrate } from "@oao/db-postgres";
import {
  brandedId,
  type AuthorizationScope,
  type OrganizationId,
  type Principal,
  type PrincipalId,
  type ProjectId,
} from "@oao/domain";
import {
  isApprovedCatalogModel,
  listApprovedModelCatalog,
} from "@oao/models-openrouter";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import { createApiApp } from "../../src/app.js";
import type { RuntimeCommandPort } from "../../src/runtime-commands.js";
import { PostgresApiStore } from "../../src/store.js";

const databaseUrl = process.env.DATABASE_URL;
const principal: Principal = {
  id: brandedId<PrincipalId>("00000000-0000-4000-8000-000002419003"),
  organizationId: brandedId<OrganizationId>(
    "00000000-0000-4000-8000-000002419001",
  ),
  projectId: brandedId<ProjectId>("00000000-0000-4000-8000-000002419002"),
  kind: "human",
  subject: "preset-limits-user",
  scopes: new Set<AuthorizationScope>(["*"]),
};
const projectPath = `/v1/projects/${principal.projectId}`;

class NoRuntimeCommands implements RuntimeCommandPort {
  enqueue(): Promise<void> {
    return Promise.resolve();
  }
}

function write(body: Readonly<Record<string, unknown>>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  };
}

test(
  "model preset limits are set on create, changed later, and kept as history",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    await migrate(pool);
    t.after(() => pool.end());
    await pool.query(
      `SELECT oao.bootstrap_project(
        $1,'preset-limits','Preset limits organization',
        $2,'preset-limits','Preset limits project',$3,$4,'development'
      )`,
      [
        principal.organizationId,
        principal.projectId,
        principal.id,
        principal.subject,
      ],
    );
    const app = createApiApp({
      store: new PostgresApiStore(pool, "preset-limits-pepper"),
      auth: new DevelopmentAuthAdapter({ principal }),
      runtimeCommands: new NoRuntimeCommands(),
      credentialCipher: new ProviderCredentialCipher(Buffer.alloc(32, 8)),
      modelCatalog: {
        deploymentPresets: [],
        listCatalog: (input) => listApprovedModelCatalog(input?.providerType),
        isApprovedModel: isApprovedCatalogModel,
      },
    });
    const post = (path: string, body: Record<string, unknown>) =>
      app.request(`${projectPath}${path}`, write(body));
    const created = async <T>(path: string, body: Record<string, unknown>) => {
      const response = await post(path, body);
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()) as T;
    };
    const get = async <T>(path: string) => {
      const response = await app.request(`${projectPath}${path}`);
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as T;
    };
    const refused = async (
      path: string,
      body: Record<string, unknown>,
      status = 400,
    ) => {
      const response = await post(path, body);
      assert.equal(response.status, status, await response.clone().text());
      return ((await response.json()) as { error: { message: string } }).error
        .message;
    };

    const model = listApprovedModelCatalog("openrouter")[0]?.model;
    assert.ok(model);
    const provider = await created<{ id: string }>("/model-providers", {
      key: "preset-limits-openrouter",
      displayName: "Preset limits OpenRouter",
      providerType: "openrouter",
      apiKey: "sk-preset-limits-provider-secret",
    });

    // A preset can be created with its first limits, or without any.
    const limited = await created<ModelPreset>("/model-presets", {
      key: "limited-model-v1",
      displayName: "Limited model",
      providerId: provider.id,
      model,
      limits: { contextWindow: 250_000, maxOutputTokens: 128_000 },
    });
    assert.equal(limited.limits?.contextWindow, 250_000);
    assert.equal(limited.limits?.maxOutputTokens, 128_000);
    const plain = await created<ModelPreset>("/model-presets", {
      key: "plain-model-v1",
      displayName: "Plain model",
      providerId: provider.id,
      model,
    });
    assert.equal(plain.limits, null);
    // Limits with both values empty keep no row, so the preset is plain.
    const empty = await created<ModelPreset>("/model-presets", {
      key: "empty-limits-model-v1",
      displayName: "Empty limits model",
      providerId: provider.id,
      model,
      limits: { contextWindow: null, maxOutputTokens: null },
    });
    assert.equal(empty.limits, null);
    for (const limits of [
      { contextWindow: 1_000 },
      { contextWindow: 10_000_001 },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 1.5 },
      { contextWindow: 100_000, maxOutputTokens: 100_001 },
      { contextWindow: "250000" },
      { contextWindow: 250_000, extra: 1 },
    ])
      assert.match(
        await refused("/model-presets", {
          key: `bad-limits-${randomUUID().slice(0, 8)}-v1`,
          displayName: "Bad limits",
          providerId: provider.id,
          model,
          limits,
        }),
        /limits within range/u,
      );

    // The list shows the limits in effect now.
    const listed = await get<{ data: ModelPreset[] }>("/model-presets");
    const byKey = new Map(listed.data.map((preset) => [preset.key, preset]));
    assert.equal(byKey.get("limited-model-v1")?.limits?.contextWindow, 250_000);
    assert.equal(byKey.get("plain-model-v1")?.limits, null);

    // A change adds a row; the newest applies, and the old one stays.
    const changed = await created<ModelPresetLimits>(
      `/model-presets/${limited.id}/limits`,
      { contextWindow: 200_000 },
    );
    assert.equal(changed.contextWindow, 200_000);
    assert.equal(changed.maxOutputTokens, null);
    assert.equal(changed.presetId, limited.id);
    assert.equal(changed.createdByPrincipalId, principal.id);
    const history = await get<{ data: ModelPresetLimits[] }>(
      `/model-presets/${limited.id}/limits`,
    );
    assert.deepEqual(
      history.data.map((entry) => [entry.contextWindow, entry.maxOutputTokens]),
      [
        [200_000, null],
        [250_000, 128_000],
      ],
    );
    const relisted = await get<{ data: ModelPreset[] }>("/model-presets");
    assert.equal(
      relisted.data.find((preset) => preset.id === limited.id)?.limits?.id,
      changed.id,
    );
    // Clearing both goes back to the model's own values.
    const cleared = await created<ModelPresetLimits>(
      `/model-presets/${limited.id}/limits`,
      { contextWindow: null, maxOutputTokens: null },
    );
    assert.equal(cleared.contextWindow, null);
    assert.equal(cleared.maxOutputTokens, null);
    // Edits right after each other still get their own, later times, so the
    // last one is the newest and the order survives a restore.
    const ordered = await get<{ data: ModelPresetLimits[] }>(
      `/model-presets/${limited.id}/limits`,
    );
    assert.equal(ordered.data[0]?.id, cleared.id);
    const times = ordered.data.map((entry) => Date.parse(entry.createdAt));
    assert.deepEqual(
      times,
      [...times].sort((left, right) => right - left),
    );
    assert.equal(new Set(times).size, times.length);
    // A plain preset gets its first limits the same way.
    await created<ModelPresetLimits>(`/model-presets/${plain.id}/limits`, {
      contextWindow: 250_000,
      maxOutputTokens: 128_000,
    });

    assert.match(
      await refused(`/model-presets/${limited.id}/limits`, {
        contextWindow: 100_000,
        maxOutputTokens: 120_000,
      }),
      /maxOutputTokens not larger than contextWindow/u,
    );
    assert.equal(
      await refused(
        `/model-presets/${randomUUID()}/limits`,
        { contextWindow: 250_000 },
        404,
      ),
      "Model preset not found",
    );
    const unknownHistory = await app.request(
      `${projectPath}/model-presets/${randomUUID()}/limits`,
    );
    assert.equal(unknownHistory.status, 404);

    // Each change is audited with the values it set.
    const audits = await pool.query<{ safe_detail: Record<string, unknown> }>(
      `SELECT safe_detail FROM oao.audit_entries
        WHERE organization_id=$1 AND action='model_preset.limits_set'
        ORDER BY sequence`,
      [principal.organizationId],
    );
    assert.deepEqual(
      audits.rows.map((row) => [
        row.safe_detail.key,
        row.safe_detail.contextWindow,
        row.safe_detail.maxOutputTokens,
      ]),
      [
        ["limited-model-v1", 200_000, null],
        ["limited-model-v1", null, null],
        ["plain-model-v1", 250_000, 128_000],
      ],
    );
  },
);
