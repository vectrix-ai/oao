import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@oao/db-postgres";
import type { OrganizationId, ProjectId } from "@oao/domain";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import {
  FLUE_PACKAGE_VERSIONS,
  createProjectModelPresetActivator,
  runtimeTesting,
} from "../src/index.js";

test("Flue packages are pinned to the planned release", () => {
  assert.deepEqual(FLUE_PACKAGE_VERSIONS, {
    runtime: "2.0.3",
    postgres: "2.0.3",
    opentelemetry: "2.0.3",
    piAi: "0.83.0",
  });
});

test("runtime projections use deterministic ids and redact unsafe arguments", () => {
  assert.equal(
    runtimeTesting.eventUuid("same"),
    runtimeTesting.eventUuid("same"),
  );
  assert.deepEqual(
    runtimeTesting.safeArguments({
      authorization: "Bearer x",
      orderId: "safe",
    }),
    { authorization: "[REDACTED]", orderId: "safe" },
  );
});

test("runtime projections retain full model timing and thinking text", () => {
  const timing = runtimeTesting.turnWindow({
    timestamp: "2026-08-20T17:31:17.187Z",
    durationMs: 5_942,
  });
  assert.equal(timing.startedAt.toISOString(), "2026-08-20T17:31:11.245Z");
  assert.equal(timing.completedAt.toISOString(), "2026-08-20T17:31:17.187Z");
  assert.equal(
    runtimeTesting.turnThinking({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Count the words first." },
        { type: "text", text: "Done." },
        { type: "thinking", thinking: "Then count the letters." },
      ],
    }),
    "Count the words first.\n\nThen count the letters.",
  );
});

const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
};
const providerId = "00000000-0000-4000-8000-000000000003";
const credentialCipher = new ProviderCredentialCipher(Buffer.alloc(32, 4));

function presetRow(input: {
  readonly preset_key: string;
  readonly model: string;
  readonly routing: unknown;
}): Record<string, unknown> {
  const encrypted = credentialCipher.encrypt("sk-runtime-test-key", {
    ...tenant,
    providerId,
    providerType: "openrouter",
    keyVersion: 1,
  });
  return {
    ...input,
    provider_id: providerId,
    provider_type: "openrouter",
    encrypted_api_key: encrypted.ciphertext,
    encryption_nonce: encrypted.nonce,
    encryption_tag: encrypted.tag,
    encryption_key_version: encrypted.keyVersion,
  };
}

/** Minimal pool that answers only the tenant-scoped preset lookup. */
function presetPool(rows: readonly Record<string, unknown>[]) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const pool = {
    connect: async () => ({
      query: async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        return text.includes("oao.project_model_presets")
          ? { rowCount: rows.length, rows }
          : { rowCount: 0, rows: [] };
      },
      release: () => undefined,
    }),
  } as unknown as PgPool;
  return { pool, queries };
}

test("deployment presets resolve after checking for a durable collision", async () => {
  const { pool, queries } = presetPool([]);
  const activator = createProjectModelPresetActivator({
    pool,
    registry: {
      activate: () => {
        throw new Error("a deployment preset must not be activated");
      },
    },
    deploymentPresetKeys: new Set(["local-default"]),
  });
  assert.equal(await activator.activate(tenant, "local-default"), undefined);
  assert.equal(
    queries.some((query) => query.text.includes("project_model_presets")),
    true,
  );
});

test("a durable preset is activated even when deployment later uses its key", async () => {
  const { pool } = presetPool([
    presetRow({
      preset_key: "stable-v1",
      model: "openrouter/anthropic/claude-sonnet-4.6",
      routing: { zeroDataRetention: true },
    }),
  ]);
  const activated: string[] = [];
  const activator = createProjectModelPresetActivator({
    pool,
    credentialCipher,
    registry: {
      activate: (preset) => {
        activated.push(preset.model);
        return {
          key: preset.key,
          model: `project/${preset.model}`,
          approvedModel: preset.model,
          origin: "project" as const,
        };
      },
    },
    deploymentPresetKeys: new Set(["local-default", "stable-v1"]),
  });
  const resolved = await activator.activate(tenant, "stable-v1");
  assert.equal(resolved?.origin, "project");
  assert.deepEqual(activated, ["openrouter/anthropic/claude-sonnet-4.6"]);
});

test("a durable project preset is loaded, tenant scoped, and activated", async () => {
  const { pool, queries } = presetPool([
    presetRow({
      preset_key: "claude-sonnet-4-6-zdr-v1",
      model: "openrouter/anthropic/claude-sonnet-4.6",
      routing: { zeroDataRetention: true, providerAllowlist: ["anthropic"] },
    }),
  ]);
  const activated: unknown[] = [];
  const activator = createProjectModelPresetActivator({
    pool,
    credentialCipher,
    registry: {
      activate: (preset) => {
        activated.push(preset);
        return {
          key: preset.key,
          model: `openrouter-project-abc/${preset.model}`,
          approvedModel: preset.model,
          origin: "project" as const,
        };
      },
    },
    deploymentPresetKeys: new Set(["local-default"]),
  });
  const resolved = await activator.activate(tenant, "claude-sonnet-4-6-zdr-v1");
  assert.equal(resolved?.origin, "project");
  assert.deepEqual(activated, [
    {
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      key: "claude-sonnet-4-6-zdr-v1",
      providerId,
      providerType: "openrouter",
      apiKey: "sk-runtime-test-key",
      credentialVersion: 1,
      model: "openrouter/anthropic/claude-sonnet-4.6",
      routing: { zeroDataRetention: true, providerAllowlist: ["anthropic"] },
    },
  ]);
  const lookup = queries.find((query) =>
    query.text.includes("project_model_presets"),
  );
  assert.deepEqual(lookup?.values, [
    tenant.organizationId,
    tenant.projectId,
    "claude-sonnet-4-6-zdr-v1",
  ]);
});

test("an unknown or malformed preset never reaches the provider", async () => {
  const missing = createProjectModelPresetActivator({
    pool: presetPool([]).pool,
    registry: {
      activate: () => {
        throw new Error("must not activate");
      },
    },
    deploymentPresetKeys: new Set(["local-default"]),
  });
  await assert.rejects(
    missing.activate(tenant, "never-approved-v1"),
    /not approved/u,
  );

  const malformed = createProjectModelPresetActivator({
    pool: presetPool([
      presetRow({
        preset_key: "wire-names-v1",
        model: "openrouter/anthropic/claude-sonnet-4.6",
        routing: { allow_fallbacks: false },
      }),
    ]).pool,
    credentialCipher,
    registry: {
      activate: () => {
        throw new Error("must not activate");
      },
    },
    deploymentPresetKeys: new Set(["local-default"]),
  });
  await assert.rejects(malformed.activate(tenant, "wire-names-v1"));
});
