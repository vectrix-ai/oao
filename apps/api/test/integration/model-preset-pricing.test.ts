import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import type {
  ModelPreset,
  ModelPresetPrice,
  SessionUsage,
} from "@oao/contracts";
import { createPool, findRunModelPresetPrice, migrate } from "@oao/db-postgres";
import {
  brandedId,
  priceModelCall,
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
  id: brandedId<PrincipalId>("00000000-0000-4000-8000-00000000e003"),
  organizationId: brandedId<OrganizationId>(
    "00000000-0000-4000-8000-00000000e001",
  ),
  projectId: brandedId<ProjectId>("00000000-0000-4000-8000-00000000e002"),
  kind: "human",
  subject: "preset-pricing-user",
  scopes: new Set<AuthorizationScope>(["*"]),
};
const projectPath = `/v1/projects/${principal.projectId}`;
const sandbox = {
  enabled: false,
  provider: "daytona-primary",
  network: "none",
  capabilities: [],
} as const;
const rates = {
  inputUsdPerMillion: 2,
  cachedInputUsdPerMillion: 0.1,
  cacheWriteUsdPerMillion: 2.5,
  outputUsdPerMillion: 10,
};

/** Sessions are only created here; no worker runs them. */
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
  "model preset prices, what they charge, and usage reports",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    await migrate(pool);
    t.after(() => pool.end());
    await pool.query(
      `SELECT oao.bootstrap_project(
        $1,'preset-pricing','Preset pricing organization',
        $2,'preset-pricing','Preset pricing project',$3,$4,'development'
      )`,
      [
        principal.organizationId,
        principal.projectId,
        principal.id,
        principal.subject,
      ],
    );
    const app = createApiApp({
      store: new PostgresApiStore(pool, "preset-pricing-pepper"),
      auth: new DevelopmentAuthAdapter({ principal }),
      runtimeCommands: new NoRuntimeCommands(),
      credentialCipher: new ProviderCredentialCipher(Buffer.alloc(32, 7)),
      modelCatalog: {
        deploymentPresets: [],
        listCatalog: (input) => listApprovedModelCatalog(input?.providerType),
        isApprovedModel: isApprovedCatalogModel,
      },
    });
    const post = async <T>(path: string, body: Record<string, unknown>) => {
      const response = await app.request(`${projectPath}${path}`, write(body));
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()) as T;
    };
    const get = async <T>(path: string) => {
      const response = await app.request(`${projectPath}${path}`);
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as T;
    };

    const model = listApprovedModelCatalog("openrouter")[0]?.model;
    assert.ok(model);
    const provider = await post<{ id: string }>("/model-providers", {
      key: "preset-pricing-openrouter",
      displayName: "Preset pricing OpenRouter",
      providerType: "openrouter",
      apiKey: "sk-preset-pricing-provider-secret",
    });

    // A preset can be created with its first price, or without one.
    const priced = await post<ModelPreset>("/model-presets", {
      key: "priced-model-v1",
      displayName: "Priced model",
      providerId: provider.id,
      model,
      price: rates,
    });
    assert.equal(priced.price?.inputUsdPerMillion, 2);
    assert.equal(priced.price?.longContext, null);
    const unpriced = await post<ModelPreset>("/model-presets", {
      key: "unpriced-model-v1",
      displayName: "Unpriced model",
      providerId: provider.id,
      model,
    });
    assert.equal(unpriced.price, null);

    const incomplete = await app.request(
      `${projectPath}/model-presets/${priced.id}/prices`,
      write({ inputUsdPerMillion: 2 }),
    );
    assert.equal(incomplete.status, 400);
    const past = await app.request(
      `${projectPath}/model-presets/${priced.id}/prices`,
      write({ ...rates, validFrom: "2020-01-01T00:00:00.000Z" }),
    );
    assert.equal(past.status, 400);
    assert.match(await past.text(), /past/u);
    const missing = await app.request(
      `${projectPath}/model-presets/${randomUUID()}/prices`,
      write(rates),
    );
    assert.equal(missing.status, 404);

    // A scheduled price is in the history but is not in effect yet.
    const validFrom = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await post<ModelPresetPrice>(
      `/model-presets/${priced.id}/prices`,
      { ...rates, outputUsdPerMillion: 20, validFrom },
    );
    assert.equal(scheduled.validFrom, validFrom);
    const listed = await get<{ data: ModelPreset[] }>("/model-presets");
    const byKey = new Map(listed.data.map((entry) => [entry.key, entry]));
    assert.equal(byKey.get("priced-model-v1")?.price?.outputUsdPerMillion, 10);
    assert.equal(byKey.get("unpriced-model-v1")?.price, null);
    const history = await get<{ data: ModelPresetPrice[] }>(
      `/model-presets/${priced.id}/prices`,
    );
    assert.deepEqual(
      history.data.map((entry) => entry.outputUsdPerMillion),
      [20, 10],
    );

    // Prices are append-only: triggers refuse changes even on this admin pool.
    await assert.rejects(
      pool.query(
        "UPDATE oao.model_preset_prices SET output_usd_per_million=1 WHERE id=$1",
        [scheduled.id],
      ),
      /immutable/u,
    );
    await assert.rejects(
      pool.query("DELETE FROM oao.model_preset_prices WHERE id=$1", [
        scheduled.id,
      ]),
      /immutable/u,
    );

    const session = async (key: string, preset: string) => {
      const agent = await post<{ id: string }>("/agents", {
        key,
        name: key,
        config: {
          systemPrompt: "Answer with safe public output.",
          modelPreset: preset,
          tools: [],
          sandbox,
          limits: { maxTurns: 8, timeoutMs: 60_000 },
        },
      });
      return post<{ id: string; run: { id: string } }>("/sessions", {
        agentId: agent.id,
        initialMessage: "Hello",
      });
    };
    const first = await session("priced-agent", "priced-model-v1");
    const second = await session("unpriced-agent", "unpriced-model-v1");

    // The price a run's preset has at a moment, from the real tables.
    const tenantIds = {
      organizationId: principal.organizationId,
      projectId: principal.projectId,
    };
    const now = await findRunModelPresetPrice(pool, {
      ...tenantIds,
      runId: first.run.id,
      at: new Date(),
    });
    assert.equal(now?.rates.outputUsdPerMillion, 10);
    const later = await findRunModelPresetPrice(pool, {
      ...tenantIds,
      runId: first.run.id,
      at: new Date(Date.parse(validFrom) + 1_000),
    });
    assert.equal(later?.rates.outputUsdPerMillion, 20);
    assert.equal(later?.id, scheduled.id);
    assert.equal(
      await findRunModelPresetPrice(pool, {
        ...tenantIds,
        runId: first.run.id,
        at: new Date("2020-01-01T00:00:00.000Z"),
      }),
      null,
    );
    assert.equal(
      await findRunModelPresetPrice(pool, {
        ...tenantIds,
        runId: second.run.id,
        at: new Date(),
      }),
      null,
    );

    // Two model calls overlap, so their model time counts once.
    const usage = {
      input: 14,
      output: 1_052,
      cacheRead: 85_753,
      cacheWrite: 26_232,
    };
    const { costMicrounits } = priceModelCall(now!.rates, usage);
    assert.equal(costMicrounits, 84_703);
    const invocation = async (input: {
      readonly runId: string;
      readonly attempt: number;
      readonly cost: number;
      readonly source: string;
      readonly startedAt: string;
      readonly completedAt: string;
    }) =>
      pool.query(
        `INSERT INTO oao.model_invocations (
           organization_id,project_id,id,run_id,attempt,provider_key,model_key,status,
           input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
           cost_microunits,safe_request,safe_response,started_at,completed_at,
           usage_source,pricing_snapshot,provider_route
         ) VALUES ($1,$2,$3,$4,$5,'provider','test-model','completed',
                   $6,$7,$8,$9,$10,'{}','{}',$11,$12,'estimated',$13,'{}')`,
        [
          principal.organizationId,
          principal.projectId,
          randomUUID(),
          input.runId,
          input.attempt,
          usage.input,
          usage.output,
          usage.cacheRead,
          usage.cacheWrite,
          input.cost,
          input.startedAt,
          input.completedAt,
          {
            model: "test-model",
            source: input.source,
            ...(input.source === "preset_price"
              ? {
                  costByKind: {
                    inputMicrounits: 28,
                    cacheReadMicrounits: 8_575,
                    cacheWriteMicrounits: 65_580,
                    outputMicrounits: 10_520,
                  },
                }
              : {}),
          },
        ],
      );
    await invocation({
      runId: first.run.id,
      attempt: 1,
      cost: costMicrounits,
      source: "preset_price",
      startedAt: "2026-11-04T10:00:00.000Z",
      completedAt: "2026-11-04T10:00:10.000Z",
    });
    await invocation({
      runId: first.run.id,
      attempt: 2,
      cost: costMicrounits,
      source: "preset_price",
      startedAt: "2026-11-04T10:00:05.000Z",
      completedAt: "2026-11-04T10:00:12.000Z",
    });
    await invocation({
      runId: second.run.id,
      attempt: 1,
      cost: 0,
      source: "none",
      startedAt: "2026-11-04T11:00:00.000Z",
      completedAt: "2026-11-04T11:00:01.000Z",
    });

    // Tool time: a tool call, one that waited 30 s for an approval, a delegate
    // that only waited for its child, and a sandbox command.
    const toolCall = async (input: {
      readonly name: string;
      readonly createdAt: string;
      readonly updatedAt: string;
    }) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO oao.tool_calls (
           organization_id,project_id,id,run_id,tool_name,owner,stage,
           safe_arguments,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,'platform','result_committed','{}',$6,$7)`,
        [
          principal.organizationId,
          principal.projectId,
          id,
          first.run.id,
          input.name,
          input.createdAt,
          input.updatedAt,
        ],
      );
      return id;
    };
    await toolCall({
      name: "lookup_customer",
      createdAt: "2026-11-04T10:01:00.000Z",
      updatedAt: "2026-11-04T10:01:02.000Z",
    });
    const approvedToolCall = await toolCall({
      name: "change_customer",
      createdAt: "2026-11-04T10:02:00.000Z",
      updatedAt: "2026-11-04T10:02:33.000Z",
    });
    await pool.query(
      `INSERT INTO oao.approvals (
         organization_id,project_id,id,run_id,tool_call_id,status,summary,
         resolved_by_principal_id,created_at,resolved_at
       ) VALUES ($1,$2,$3,$4,$5,'approved','Change it',$6,$7,$8)`,
      [
        principal.organizationId,
        principal.projectId,
        randomUUID(),
        first.run.id,
        approvedToolCall,
        principal.id,
        "2026-11-04T10:02:00.000Z",
        "2026-11-04T10:02:30.000Z",
      ],
    );
    await toolCall({
      name: "delegate_agent",
      createdAt: "2026-11-04T10:03:00.000Z",
      updatedAt: "2026-11-04T10:04:00.000Z",
    });
    const sandboxId = randomUUID();
    const commandId = randomUUID();
    const identity = await pool.query<{
      thread_id: string;
      session_id: string;
    }>(
      "SELECT thread_id,session_id FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND id=$3",
      [principal.organizationId, principal.projectId, first.run.id],
    );
    await pool.query(
      `INSERT INTO oao.sandbox_instances (
         organization_id,project_id,id,run_id,thread_id,session_id,provider,
         state,creation_key,egress_policy
       ) VALUES ($1,$2,$3,$4,$5,$6,'daytona','running',$7,$8)`,
      [
        principal.organizationId,
        principal.projectId,
        sandboxId,
        first.run.id,
        identity.rows[0]?.thread_id,
        identity.rows[0]?.session_id,
        `preset-pricing-sandbox:${sandboxId}`,
        { mode: "none" },
      ],
    );
    await pool.query(
      `INSERT INTO oao.sandbox_commands (
         organization_id,project_id,id,sandbox_id,run_id,command_key,
         request_hash,state,safe_command,safe_result,started_at,completed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',$8,'{}',$9,$10)`,
      [
        principal.organizationId,
        principal.projectId,
        commandId,
        sandboxId,
        first.run.id,
        `sandbox-tool:${first.run.id}:${commandId}`,
        createHash("sha256").update(commandId).digest(),
        { toolName: "bash", arguments: {} },
        "2026-11-04T10:05:00.000Z",
        "2026-11-04T10:05:04.000Z",
      ],
    );

    const pricedUsage = await get<SessionUsage>(`/sessions/${first.id}/usage`);
    assert.equal(pricedUsage.time.toolMs, 2_000 + 3_000 + 4_000);
    assert.equal(pricedUsage.sessionCount, 1);
    assert.equal(pricedUsage.modelCalls, 2);
    assert.equal(pricedUsage.cacheReadTokens, 2 * usage.cacheRead);
    assert.equal(pricedUsage.cacheWriteTokens, 2 * usage.cacheWrite);
    assert.equal(pricedUsage.costMicrounits, 2 * costMicrounits);
    assert.equal(pricedUsage.costProvenance, "estimated");
    assert.deepEqual(pricedUsage.costByKind, {
      inputMicrounits: 56,
      cacheReadMicrounits: 17_150,
      cacheWriteMicrounits: 131_160,
      outputMicrounits: 21_040,
    });
    assert.equal(pricedUsage.byModel[0]?.costByKind?.outputMicrounits, 21_040);
    assert.equal(pricedUsage.time.modelMs, 12_000);
    assert.equal(pricedUsage.byAgent[0]?.agentName, "priced-agent");
    assert.equal(pricedUsage.byModel[0]?.modelPreset, "priced-model-v1");

    const unpricedUsage = await get<SessionUsage>(
      `/sessions/${second.id}/usage`,
    );
    assert.equal(unpricedUsage.costProvenance, "unpriced");
    assert.equal(unpricedUsage.unpricedCalls, 1);

    const sessions = await get<{
      data: { id: string; costProvenance: string }[];
    }>("/sessions");
    const provenance = new Map(
      sessions.data.map((entry) => [entry.id, entry.costProvenance]),
    );
    assert.equal(provenance.get(first.id), "estimated");
    assert.equal(provenance.get(second.id), "unpriced");
    const detail = await get<{ costProvenance: string }>(
      `/sessions/${second.id}`,
    );
    assert.equal(detail.costProvenance, "unpriced");

    const missingUsage = await app.request(
      `${projectPath}/sessions/${randomUUID()}/usage`,
    );
    assert.equal(missingUsage.status, 404);

    const period = "from=2026-11-04T00:00:00.000Z&to=2026-11-05T00:00:00.000Z";
    const byDay = await get<{
      totals: {
        modelCalls: number;
        costMicrounits: number;
        sessionCount: number;
      };
      data: { key: string; modelCalls: number; unpricedCalls: number }[];
    }>(`/usage?${period}`);
    assert.deepEqual(byDay.totals.modelCalls, 3);
    assert.equal(byDay.totals.sessionCount, 2);
    assert.equal(byDay.totals.costMicrounits, 2 * costMicrounits);
    assert.equal(byDay.data[0]?.key, "2026-11-04");
    assert.equal(byDay.data[0]?.unpricedCalls, 1);
    const byAgent = await get<{
      data: { label: string; costMicrounits: number }[];
    }>(`/usage?${period}&groupBy=agent`);
    assert.deepEqual(
      byAgent.data.map((row) => [row.label, row.costMicrounits]),
      [
        ["priced-agent", 2 * costMicrounits],
        ["unpriced-agent", 0],
      ],
    );
    const badGroup = await app.request(`${projectPath}/usage?groupBy=week`);
    assert.equal(badGroup.status, 400);
    const badPeriod = await app.request(
      `${projectPath}/usage?from=2026-11-05T00:00:00.000Z&to=2026-11-04T00:00:00.000Z`,
    );
    assert.equal(badPeriod.status, 400);

    // A project with prices can still be deleted: they go with its presets.
    const createdProject = await app.request(
      "/v1/projects",
      write({ slug: "preset-pricing-other", name: "Other project" }),
    );
    assert.equal(
      createdProject.status,
      201,
      await createdProject.clone().text(),
    );
    const otherProject = (await createdProject.json()) as { id: string };
    const inOtherProject = write({
      key: "doomed-model-v1",
      displayName: "Doomed model",
      providerId: provider.id,
      model,
      price: rates,
    });
    const doomed = await app.request(
      `/v1/projects/${otherProject.id}/model-presets`,
      {
        ...inOtherProject,
        headers: {
          ...(inOtherProject.headers as Record<string, string>),
          cookie: `oao_active_project=${otherProject.id}`,
        },
      },
    );
    assert.equal(doomed.status, 201, await doomed.clone().text());
    const pricesIn = async (projectId: string) =>
      (
        await pool.query(
          "SELECT 1 FROM oao.model_preset_prices WHERE organization_id=$1 AND project_id=$2",
          [principal.organizationId, projectId],
        )
      ).rowCount;
    assert.equal(await pricesIn(otherProject.id), 1);
    const deleted = await app.request(`/v1/projects/${otherProject.id}`, {
      method: "DELETE",
      headers: { "idempotency-key": randomUUID() },
    });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal(await pricesIn(otherProject.id), 0);
    assert.equal(await pricesIn(principal.projectId), 2);
  },
);
