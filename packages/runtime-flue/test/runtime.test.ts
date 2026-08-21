import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PgPool } from "@oao/db-postgres";
import type { OrganizationId, ProjectId } from "@oao/domain";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import {
  FLUE_PACKAGE_VERSIONS,
  PostgresSkillRegistry,
  createManagedRunDeliveredMessage,
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

const delivery = {
  version: "1" as const,
  runId: "00000000-0000-4000-8000-000000000011",
  sessionId: "00000000-0000-4000-8000-000000000012",
  snapshotHash: "a".repeat(64),
};

test("files use their admitted model-visible text", () => {
  const message = createManagedRunDeliveredMessage({
    delivery,
    message: "Review this file.",
    files: [
      {
        id: "00000000-0000-4000-8000-000000000013",
        name: "entry.ts",
        contentType: "application/typescript",
        sizeBytes: Buffer.byteLength("export const x=1;", "utf8"),
        sha256: "b".repeat(64),
        bytes: Buffer.from("export const x=1;", "utf8"),
        modelText: "export const x=1;",
      },
    ],
  });
  assert.equal(message.kind, "signal");
  assert.match(message.body, /Attached file: entry\.ts/u);
  assert.match(message.body, /export const x=1;/u);
  assert.deepEqual(
    message.kind === "signal" ? message.attributes : {},
    delivery,
  );
});

test("image files use Flue image attachments without putting bytes in metadata", () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const message = createManagedRunDeliveredMessage({
    delivery,
    message: "Describe this image.",
    files: [
      {
        id: "00000000-0000-4000-8000-000000000014",
        name: "diagram.png",
        contentType: "image/png",
        sizeBytes: bytes.byteLength,
        sha256: "c".repeat(64),
        bytes,
      },
    ],
  });
  assert.equal(message.kind, "user");
  assert.equal(message.attachments?.[0]?.data, bytes.toString("base64"));
  assert.equal(message.attachments?.[0]?.mimeType, "image/png");
  assert.match(message.attachments?.[0]?.filename ?? "", /^oao-run-v1\./u);
  assert.doesNotMatch(message.body, new RegExp(bytes.toString("base64"), "u"));
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

test("PostgreSQL Skill versions become verified immutable Flue definitions", async () => {
  const skillId = "00000000-0000-4000-8000-000000000021";
  const skillVersionId = "00000000-0000-4000-8000-000000000022";
  const instructions = "Read the reference only when this procedure applies.";
  const canonical = {
    schemaVersion: 1,
    name: "shipment-intake",
    description: "Process shipment documents using the approved flow.",
    instructions,
    metadata: {},
    files: [],
  };
  const contentHash = createHash("sha256")
    .update(stableJson(canonical))
    .digest("hex");
  const queries: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (text: string) => {
        queries.push(text);
        if (text.includes("FROM oao.skill_versions version"))
          return {
            rowCount: 1,
            rows: [
              {
                skill_id: skillId,
                id: skillVersionId,
                version: 1,
                skill_name: canonical.name,
                description: canonical.description,
                instructions,
                license: null,
                compatibility: null,
                metadata: {},
                allowed_tools: null,
                content_hash: Buffer.from(contentHash, "hex"),
                total_bytes: Buffer.byteLength(instructions),
                status: "active",
              },
            ],
          };
        if (text.includes("FROM oao.skill_version_files"))
          return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      },
      release: () => undefined,
    }),
  } as unknown as PgPool;
  const registry = new PostgresSkillRegistry(pool);
  const binding = {
    skillId,
    skillVersionId,
    version: 1,
    name: canonical.name,
    description: canonical.description,
    contentHash,
  };
  await registry.activate(tenant, [binding]);
  const definition = registry.resolve(tenant, binding);
  assert.equal(definition.name, "shipment-intake");
  assert.equal(definition.description, canonical.description);
  assert.equal(definition.instructions, instructions);
  assert.equal(
    queries.filter((query) => query.includes("skill_versions version")).length,
    1,
  );
  await registry.activate(tenant, [binding]);
  assert.equal(
    queries.filter((query) => query.includes("skill_versions version")).length,
    1,
  );
});
