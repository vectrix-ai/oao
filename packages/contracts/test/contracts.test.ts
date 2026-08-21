import assert from "node:assert/strict";
import test from "node:test";
import * as v from "valibot";
import {
  ApiErrorSchema,
  MODEL_PRESET_KEY_PATTERN,
  PLATFORM_MAX_TURNS,
  ProductEventSchema,
  RunSchema,
  ToolCallSchema,
  parseCreateModelPresetInput,
  parseCreateProjectSandboxProviderInput,
  parseCreateProjectStorageProviderInput,
  parseManagedAgentSnapshotForPublication,
  parseModelRoutingPolicy,
} from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const timestamp = "2026-08-20T10:00:00.000Z";

test("run and event public contracts accept safe wire representations", () => {
  assert.equal(
    v.parse(RunSchema, {
      id,
      organizationId: id,
      projectId: id,
      threadId: id,
      sessionId: id,
      agentVersionId: id,
      createdByPrincipalId: id,
      state: "queued",
      cancellationRequestedAt: null,
      admittedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).state,
    "queued",
  );
  assert.equal(
    v.parse(ProductEventSchema, {
      id,
      organizationId: id,
      projectId: id,
      aggregateType: "run",
      aggregateId: id,
      aggregateSequence: 1,
      projectPosition: "9007199254740993",
      kind: "sandbox.started",
      publicPayload: { region: "eu" },
      occurredAt: timestamp,
    }).projectPosition,
    "9007199254740993",
  );
});

test("sandbox publication and Daytona connections expose only safe policy", () => {
  const config = parseManagedAgentSnapshotForPublication({
    systemPrompt: "Use the sandbox only for the requested task.",
    modelPreset: "project-model-v1",
    tools: [],
    sandbox: {
      enabled: true,
      provider: "daytona-primary",
      snapshotId: id,
      network: "restricted",
      capabilities: ["filesystem_read", "shell", "browser"],
    },
    limits: { maxTurns: PLATFORM_MAX_TURNS, timeoutMs: 60_000 },
  });
  assert.deepEqual(config.sandbox.capabilities, [
    "filesystem_read",
    "shell",
    "browser",
  ]);
  assert.equal(config.sandbox.snapshotId, id);
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...config,
      sandbox: { ...config.sandbox, snapshotId: undefined },
    }),
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...config,
      sandbox: { ...config.sandbox, snapshotId: "not-a-snapshot-id" },
    }),
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...config,
      sandbox: {
        ...config.sandbox,
        capabilities: ["shell", "shell"],
      },
    }),
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...config,
      sandbox: { ...config.sandbox, provider: "local-fake" },
    }),
  );
  const provider = parseCreateProjectSandboxProviderInput({
    key: "daytona-primary",
    displayName: "Daytona primary",
    providerType: "daytona",
    apiKey: "daytona-secret-key",
    target: null,
    restrictedEgress: {
      allowedDomains: ["api.example.com", "*.example.net"],
      allowedCidrs: ["203.0.113.0/24"],
    },
  });
  assert.equal(provider.providerType, "daytona");
  assert.throws(() =>
    parseCreateProjectSandboxProviderInput({
      ...provider,
      key: "local-fake",
      restrictedEgress: {
        allowedDomains: ["https://example.com/path"],
        allowedCidrs: [],
      },
    }),
  );
});

test("S3-compatible storage configuration accepts safe relative prefixes", () => {
  const parsed = parseCreateProjectStorageProviderInput({
    key: "workspace-archive",
    displayName: "Workspace archive",
    providerType: "s3",
    endpoint: "https://s3.eu-central-1.amazonaws.com",
    region: "eu-central-1",
    bucket: "oao-workspaces",
    prefix: "production/oao",
    forcePathStyle: false,
    accessKeyId: "access-key",
    secretAccessKey: "secret-access-key",
  });
  assert.equal(parsed.setDefault, true);
  assert.equal(parsed.prefix, "production/oao");
  assert.throws(() =>
    parseCreateProjectStorageProviderInput({
      ...parsed,
      prefix: "../another-tenant",
    }),
  );
  assert.throws(() =>
    parseCreateProjectStorageProviderInput({
      ...parsed,
      endpoint: "file:///tmp/storage",
    }),
  );
  assert.throws(() =>
    parseCreateProjectStorageProviderInput({
      ...parsed,
      secretAccessKey: "secret-access-key",
      unexpectedCredential: "must-not-pass",
    }),
  );
});

test("API errors have a stable envelope", () => {
  const parsed = v.parse(ApiErrorSchema, {
    error: { code: "conflict", message: "already exists" },
  });
  assert.equal(parsed.error.code, "conflict");
});

test("tool claim fences remain precise above Number.MAX_SAFE_INTEGER", () => {
  const claimFence = "9007199254740993";
  const parsed = v.parse(ToolCallSchema, {
    id,
    organizationId: id,
    projectId: id,
    runId: id,
    toolName: "lookup",
    owner: "caller",
    stage: "caller_claimed",
    safeArguments: {},
    claimFence,
    createdAt: timestamp,
  });
  assert.equal(parsed.claimFence, claimFence);
  assert.throws(() =>
    v.parse(ToolCallSchema, { ...parsed, claimFence: "09007199254740993" }),
  );
});

test("agent publication rejects JSON schema keywords the runtime cannot enforce", () => {
  const snapshot = {
    systemPrompt: "Be deterministic",
    modelPreset: "project-model-v1",
    tools: [
      {
        schemaVersion: 1 as const,
        name: "lookup",
        description: "Look up a value",
        owner: "caller",
        approval: "never",
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
    sandbox: {
      enabled: false,
      provider: "daytona-primary",
      network: "none",
    },
    limits: { maxTurns: PLATFORM_MAX_TURNS, timeoutMs: 60_000 },
  };
  assert.equal(
    parseManagedAgentSnapshotForPublication(snapshot).tools[0]?.name,
    "lookup",
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...snapshot,
      tools: [
        {
          ...snapshot.tools[0],
          inputSchema: {
            ...snapshot.tools[0]?.inputSchema,
            properties: {
              query: { type: "string", minLength: 1 },
            },
          },
        },
      ],
    }),
  );
});

test("model preset input requires a versioned key and supported routing", () => {
  const valid = parseCreateModelPresetInput({
    key: "claude-sonnet-4-6-zdr-v1",
    displayName: "Claude Sonnet 4.6 (zero retention)",
    providerId: "55555555-5555-4555-8555-555555555555",
    model: "openrouter/anthropic/claude-sonnet-4.6",
    routing: {
      zeroDataRetention: true,
      dataCollection: "deny",
      allowFallbacks: false,
      providerAllowlist: ["anthropic"],
      sort: "latency",
      maxPromptPriceUsdPerMillion: 12.5,
    },
  });
  assert.equal(valid.routing.providerAllowlist?.[0], "anthropic");
  assert.deepEqual(
    parseCreateModelPresetInput({
      key: "local-mirror-v2",
      displayName: "Local mirror",
      providerId: "55555555-5555-4555-8555-555555555555",
      model: "openrouter/openai/gpt-5.1",
    }).routing,
    {},
  );

  assert.ok(MODEL_PRESET_KEY_PATTERN.test("claude-sonnet-4-6-zdr-v1"));
  for (const key of [
    "no-version-suffix",
    "Upper-Case-v1",
    "-leading-hyphen-v1",
    "trailing-v0",
  ])
    assert.throws(
      () =>
        parseCreateModelPresetInput({
          key,
          displayName: "Rejected",
          model: "openrouter/openai/gpt-5.1",
        }),
      /version suffix/u,
      `expected ${key} to be rejected`,
    );

  // Provider wire names and credentials never enter the public contract.
  assert.throws(() =>
    parseCreateModelPresetInput({
      key: "wire-names-v1",
      displayName: "Wire names",
      model: "openrouter/openai/gpt-5.1",
      routing: { allow_fallbacks: false },
    }),
  );
  assert.throws(() =>
    parseCreateModelPresetInput({
      key: "credential-v1",
      displayName: "Credential",
      model: "openrouter/openai/gpt-5.1",
      apiKey: "never",
    }),
  );
  assert.throws(() =>
    parseModelRoutingPolicy({ providerAllowlist: ["Anthropic"] }),
  );
  assert.throws(() =>
    parseModelRoutingPolicy({ providerAllowlist: ["anthropic", "anthropic"] }),
  );
  assert.throws(() =>
    parseModelRoutingPolicy({ maxPromptPriceUsdPerMillion: -1 }),
  );
  assert.throws(() => parseModelRoutingPolicy({ sort: "cheapest" }));
});

test("agent publications pin a unique, bounded delegate roster", () => {
  const base = {
    systemPrompt: "Coordinate shipment analysis with approved child agents.",
    modelPreset: "coordinator-v1",
    tools: [],
    sandbox: {
      enabled: true,
      provider: "daytona-primary",
      snapshotId: id,
      network: "none" as const,
    },
    limits: { maxTurns: PLATFORM_MAX_TURNS, timeoutMs: 60_000 },
  };
  const parsed = parseManagedAgentSnapshotForPublication({
    ...base,
    delegates: [
      {
        key: "shipment-extraction",
        description: "Extract shipment facts into the shared workspace.",
        agentVersionId: "00000000-0000-4000-8000-000000000002",
        maxParallel: 2,
      },
    ],
  });
  assert.equal(parsed.delegates[0]?.key, "shipment-extraction");
  assert.equal(parsed.delegates[0]?.maxParallel, 2);
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      delegates: [
        {
          key: "shipment-extraction",
          description: "First binding",
          agentVersionId: "00000000-0000-4000-8000-000000000002",
        },
        {
          key: "shipment-extraction",
          description: "Duplicate key",
          agentVersionId: "00000000-0000-4000-8000-000000000003",
        },
      ],
    }),
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      tools: [
        {
          schemaVersion: 1,
          name: "delegate_agent",
          description: "Reserved",
          owner: "platform",
          approval: "never",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
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
    }),
  );
});
