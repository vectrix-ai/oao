import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationId, PrincipalId, ProjectId } from "@oao/domain";
import { createPool, migrate, withTenantTransaction } from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

const ids = {
  organization: "00000000-0000-4000-8000-000000000601" as OrganizationId,
  project: "00000000-0000-4000-8000-000000000602" as ProjectId,
  principal: "00000000-0000-4000-8000-000000000603" as PrincipalId,
  otherProject: "00000000-0000-4000-8000-000000000612" as ProjectId,
  otherPrincipal: "00000000-0000-4000-8000-000000000613" as PrincipalId,
  preset: "00000000-0000-4000-8000-000000000620",
  otherPreset: "00000000-0000-4000-8000-000000000621",
  conflicting: "00000000-0000-4000-8000-000000000622",
} as const;

const tenant = { organizationId: ids.organization, projectId: ids.project };
const otherTenant = {
  organizationId: ids.organization,
  projectId: ids.otherProject,
};

async function insertPreset(
  pool: ReturnType<typeof createPool>,
  scope: { organizationId: OrganizationId; projectId: ProjectId },
  input: {
    readonly id: string;
    readonly key: string;
    readonly model: string;
    readonly routing?: unknown;
    readonly settings?: unknown;
    readonly principalId: PrincipalId;
  },
): Promise<void> {
  await withTenantTransaction(pool, scope, (transaction) =>
    transaction.query(
      `INSERT INTO oao.project_model_presets
         (organization_id,project_id,id,preset_key,display_name,model,routing,settings,created_by_principal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        scope.organizationId,
        scope.projectId,
        input.id,
        input.key,
        "Approved preset",
        input.model,
        input.routing ?? {},
        input.settings ?? null,
        input.principalId,
      ],
    ),
  );
}

test(
  "project model presets are tenant scoped and append only",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    try {
      await migrate(pool);
      await pool.query(
        "INSERT INTO oao.organizations (id, slug, name) VALUES ($1,'preset-org','Preset organization') ON CONFLICT DO NOTHING",
        [ids.organization],
      );
      await pool.query(
        `INSERT INTO oao.projects (organization_id, id, slug, name)
         VALUES ($1,$2,'preset-project-a','Preset project A'),($1,$3,'preset-project-b','Preset project B')
         ON CONFLICT DO NOTHING`,
        [ids.organization, ids.project, ids.otherProject],
      );
      await pool.query(
        `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
         VALUES ($1,$2,$3,'human','preset-user-a',ARRAY['*']),($1,$4,$5,'human','preset-user-b',ARRAY['*'])
         ON CONFLICT DO NOTHING`,
        [
          ids.organization,
          ids.project,
          ids.principal,
          ids.otherProject,
          ids.otherPrincipal,
        ],
      );

      await t.test("an approved preset is durable", async () => {
        await insertPreset(pool, tenant, {
          id: ids.preset,
          key: "claude-sonnet-4-6-zdr-v1",
          model: "openrouter/anthropic/claude-sonnet-4.6",
          routing: {
            zeroDataRetention: true,
            providerAllowlist: ["anthropic"],
          },
          principalId: ids.principal,
        });
        const stored = await withTenantTransaction(
          pool,
          tenant,
          (transaction) =>
            transaction.query(
              "SELECT model,routing FROM oao.project_model_presets WHERE organization_id=$1 AND project_id=$2 AND preset_key=$3",
              [ids.organization, ids.project, "claude-sonnet-4-6-zdr-v1"],
            ),
        );
        assert.equal(stored.rowCount, 1);
        assert.deepEqual(stored.rows[0]?.routing, {
          zeroDataRetention: true,
          providerAllowlist: ["anthropic"],
        });
      });

      await t.test("rows are immutable and cannot be repointed", async () => {
        await assert.rejects(
          withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              "UPDATE oao.project_model_presets SET model=$4 WHERE organization_id=$1 AND project_id=$2 AND id=$3",
              [
                ids.organization,
                ids.project,
                ids.preset,
                "openrouter/openai/gpt-5.1",
              ],
            ),
          ),
          /immutable/u,
        );
        await assert.rejects(
          withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              "DELETE FROM oao.project_model_presets WHERE organization_id=$1 AND project_id=$2 AND id=$3",
              [ids.organization, ids.project, ids.preset],
            ),
          ),
          /immutable/u,
        );
      });

      await t.test(
        "OpenAI generation settings are stored and validated",
        async () => {
          const id = "00000000-0000-4000-8000-000000000623";
          await insertPreset(pool, tenant, {
            id,
            key: "gpt-5-6-terra-v1",
            model: "openai/gpt-5.6-terra",
            settings: {
              textFormat: "text",
              mode: "standard",
              effort: "medium",
              verbosity: "medium",
              summary: "auto",
            },
            principalId: ids.principal,
          });
          const stored = await withTenantTransaction(
            pool,
            tenant,
            (transaction) =>
              transaction.query(
                "SELECT settings FROM oao.project_model_presets WHERE organization_id=$1 AND project_id=$2 AND id=$3",
                [ids.organization, ids.project, id],
              ),
          );
          assert.equal(stored.rows[0]?.settings.effort, "medium");
          await assert.rejects(
            insertPreset(pool, tenant, {
              id: "00000000-0000-4000-8000-000000000624",
              key: "gpt-invalid-settings-v1",
              model: "openai/gpt-5.6-terra",
              settings: {
                textFormat: "text",
                mode: "unsupported",
                effort: "medium",
                verbosity: "medium",
                summary: "auto",
              },
              principalId: ids.principal,
            }),
            /check constraint/u,
          );
        },
      );

      await t.test("preset keys are unique inside one project", async () => {
        await assert.rejects(
          insertPreset(pool, tenant, {
            id: ids.conflicting,
            key: "claude-sonnet-4-6-zdr-v1",
            model: "openrouter/openai/gpt-5.1",
            principalId: ids.principal,
          }),
          /duplicate key/u,
        );
      });

      await t.test("RLS hides another project's presets", async () => {
        await insertPreset(pool, otherTenant, {
          id: ids.otherPreset,
          key: "claude-sonnet-4-6-zdr-v1",
          model: "openrouter/openai/gpt-5.1",
          principalId: ids.otherPrincipal,
        });
        const visible = await withTenantTransaction(
          pool,
          tenant,
          (transaction) =>
            transaction.query(
              "SELECT id FROM oao.project_model_presets WHERE preset_key=$1",
              ["claude-sonnet-4-6-zdr-v1"],
            ),
        );
        assert.deepEqual(
          visible.rows.map((row) => row.id),
          [ids.preset],
        );
        await assert.rejects(
          withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              `INSERT INTO oao.project_model_presets
                 (organization_id,project_id,id,preset_key,display_name,model,created_by_principal_id)
               VALUES ($1,$2,$3,'cross-tenant-v1','Cross tenant','openrouter/openai/gpt-5.1',$4)`,
              [
                ids.organization,
                ids.otherProject,
                "00000000-0000-4000-8000-000000000630",
                ids.otherPrincipal,
              ],
            ),
          ),
        );
      });

      await t.test(
        "unsupported keys, models, and routing are rejected",
        async () => {
          await assert.rejects(
            insertPreset(pool, tenant, {
              id: "00000000-0000-4000-8000-000000000640",
              key: "missing-version-suffix",
              model: "openrouter/openai/gpt-5.1",
              principalId: ids.principal,
            }),
            /check constraint/u,
          );
          await assert.rejects(
            insertPreset(pool, tenant, {
              id: "00000000-0000-4000-8000-000000000641",
              key: "unapproved-provider-v1",
              model: "some-other-provider/model",
              principalId: ids.principal,
            }),
            /check constraint/u,
          );
          await assert.rejects(
            insertPreset(pool, tenant, {
              id: "00000000-0000-4000-8000-000000000642",
              key: "unknown-routing-field-v1",
              model: "openrouter/openai/gpt-5.1",
              routing: { allow_fallbacks: false },
              principalId: ids.principal,
            }),
            /check constraint/u,
          );
          await assert.rejects(
            insertPreset(pool, tenant, {
              id: "00000000-0000-4000-8000-000000000643",
              key: "secret-bearing-routing-v1",
              model: "openrouter/openai/gpt-5.1",
              routing: { apiKey: "should-never-be-stored" },
              principalId: ids.principal,
            }),
            /check constraint/u,
          );
        },
      );
    } finally {
      await pool.end();
    }
  },
);
