import assert from "node:assert/strict";
import test from "node:test";
import * as v from "valibot";
import {
  ApiErrorSchema,
  AuthLogoutResultSchema,
  MODEL_PRESET_KEY_PATTERN,
  ModelCatalogEntrySchema,
  PLATFORM_MAX_TURNS,
  ProductEventSchema,
  ProjectMemberSchema,
  CreateProjectMemberInputSchema,
  UpdateProjectMemberInputSchema,
  PublicPrincipalSchema,
  RunSchema,
  SessionWorkspaceFileListSchema,
  SessionSchema,
  ToolCallSchema,
  parseCreateModelPresetInput,
  parseSetModelPresetPriceInput,
  parseSetModelPresetLimitsInput,
  parseCreateProjectSandboxProviderInput,
  parseCreateProjectStorageProviderInput,
  parseManagedAgentSnapshotForPublication,
  parseSessionVersionResolution,
  parseModelRoutingPolicy,
  validateToolJsonSchema,
  validateToolJsonValue,
  parseCreateMcpServerInput,
  parseCreateMcpCredentialInput,
  parseCreateMcpCredentialPolicyInput,
  parseRotateMcpCredentialInput,
  parseDiscoverMcpAuthorizationInput,
  McpCredentialTestResultSchema,
  McpServerUsageSchema,
  RemoveMcpServerResultSchema,
  mcpDestinationContains,
  mcpPathWithin,
  CreateProjectInputSchema,
} from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const timestamp = "2026-08-20T10:00:00.000Z";

test("authentication contracts expose optional presentation metadata and logout redirects", () => {
  const principal = v.parse(PublicPrincipalSchema, {
    id,
    organizationId: id,
    projectId: id,
    kind: "human",
    subject: "development-user",
    displayName: "Ben Selleslagh",
    scopes: ["*"],
  });
  assert.equal(principal.displayName, "Ben Selleslagh");
  assert.deepEqual(v.parse(AuthLogoutResultSchema, {}), {});
  assert.equal(
    v.parse(AuthLogoutResultSchema, {
      redirectUrl: "https://authkit.example.test/logout",
    }).redirectUrl,
    "https://authkit.example.test/logout",
  );
});

test("project creation input requires a kebab-case slug and bounded name", () => {
  assert.deepEqual(
    v.parse(CreateProjectInputSchema, { slug: "eval-lab", name: "Eval Lab" }),
    { slug: "eval-lab", name: "Eval Lab" },
  );
  assert.throws(() =>
    v.parse(CreateProjectInputSchema, { slug: "Eval Lab", name: "Eval Lab" }),
  );
  assert.throws(() =>
    v.parse(CreateProjectInputSchema, {
      slug: "eval-lab",
      name: "Eval Lab",
      organizationId: id,
    }),
  );
});

test("project member contracts preserve safe identity metadata and roles", () => {
  const member = v.parse(ProjectMemberSchema, {
    id,
    organizationId: id,
    projectId: id,
    principalId: id,
    kind: "human",
    subject: "development-user",
    displayName: "Ben Selleslagh",
    email: "developer@example.test",
    scopes: ["*"],
    role: "owner",
    createdAt: timestamp,
  });
  assert.equal(member.displayName, "Ben Selleslagh");
  const explicitMember = v.parse(CreateProjectMemberInputSchema, {
    subject: "reviewer@example.test",
    role: "viewer",
    scopes: ["agent:read"],
  });
  assert.ok("scopes" in explicitMember);
  assert.deepEqual(explicitMember.scopes, ["agent:read"]);
  assert.deepEqual(
    v.parse(CreateProjectMemberInputSchema, {
      email: "verified@example.test",
    }),
    { email: "verified@example.test" },
  );
  assert.equal(
    v.parse(UpdateProjectMemberInputSchema, { role: "admin" }).role,
    "admin",
  );
});

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
  const completedRun = {
    id,
    organizationId: id,
    projectId: id,
    threadId: id,
    sessionId: id,
    agentVersionId: id,
    createdByPrincipalId: id,
    state: "completed",
    cancellationRequestedAt: null,
    admittedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  // A run without a prompt suggestion reads as null; a response stored by an
  // older release has no field at all.
  assert.equal(v.parse(RunSchema, completedRun).suggestion, undefined);
  assert.equal(
    v.parse(RunSchema, { ...completedRun, suggestion: null }).suggestion,
    null,
  );
  assert.equal(
    v.parse(RunSchema, { ...completedRun, suggestion: "Release ORD-1592" })
      .suggestion,
    "Release ORD-1592",
  );
  assert.throws(() =>
    v.parse(RunSchema, { ...completedRun, suggestion: "x".repeat(501) }),
  );
  assert.equal(
    v.parse(ProductEventSchema, {
      id,
      organizationId: id,
      projectId: id,
      aggregateType: "run",
      aggregateId: id,
      aggregateSequence: 9,
      projectPosition: "12",
      kind: "run.suggestion_created",
      publicPayload: { sessionId: id },
      occurredAt: timestamp,
    }).kind,
    "run.suggestion_created",
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
  assert.equal(
    v.parse(ProductEventSchema, {
      id,
      organizationId: id,
      projectId: id,
      aggregateType: "run",
      aggregateId: id,
      aggregateSequence: 2,
      projectPosition: "9007199254740994",
      kind: "harness.operation_completed",
      publicPayload: {
        operationKey: "extract_shipment",
        resultValidated: true,
      },
      occurredAt: timestamp,
    }).kind,
    "harness.operation_completed",
  );
});

test("session workspace file contracts describe persisted backup contents", () => {
  const list = v.parse(SessionWorkspaceFileListSchema, {
    data: [{ name: "result.csv", path: "output/result.csv", sizeBytes: 42 }],
    generation: 3,
    backedUpAt: timestamp,
    lastRunId: id,
  });
  assert.equal(list.data[0]?.path, "output/result.csv");
  assert.equal(list.generation, 3);
  assert.throws(() =>
    v.parse(SessionWorkspaceFileListSchema, {
      data: [{ name: "result.csv", path: "output/result.csv", sizeBytes: -1 }],
      generation: 1,
      backedUpAt: timestamp,
      lastRunId: id,
    }),
  );
});

test("session contract exposes non-negative cached token usage", () => {
  const session = {
    id,
    organizationId: id,
    projectId: id,
    threadId: id,
    agentVersionId: id,
    status: "active" as const,
    inputTokens: 120,
    outputTokens: 24,
    cacheReadTokens: 80,
    cacheWriteTokens: 16,
    createdAt: timestamp,
    lastActivityAt: timestamp,
  };
  assert.equal(v.parse(SessionSchema, session).cacheReadTokens, 80);
  assert.throws(() =>
    v.parse(SessionSchema, { ...session, cacheWriteTokens: -1 }),
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
  // Prompt suggestions are off unless a version turns them on, and a config
  // without the setting keeps its shape.
  assert.ok(!("promptSuggestions" in config));
  assert.equal(
    parseManagedAgentSnapshotForPublication({
      ...config,
      promptSuggestions: true,
    }).promptSuggestions,
    true,
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...config,
      promptSuggestions: "yes",
    }),
  );
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

test("agent publication accepts canonical rich tool schemas and rejects ignored features", () => {
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
          description: "Lookup arguments.",
          properties: {
            query: {
              type: "string",
              description: "Free-text lookup query.",
              minLength: 2,
              maxLength: 200,
            },
            filters: {
              type: ["object", "null"],
              description: "Optional dynamic filter values.",
            },
            scopes: {
              type: "array",
              items: {
                type: "string",
                enum: ["customer", "shipment"],
              },
              maxItems: 2,
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
    sandbox: {
      enabled: false,
      provider: "daytona-primary",
      network: "none",
    },
    limits: { maxTurns: PLATFORM_MAX_TURNS, timeoutMs: 60_000 },
  };
  const parsed = parseManagedAgentSnapshotForPublication(snapshot);
  assert.equal(parsed.tools[0]?.name, "lookup");
  assert.equal(
    parsed.tools[0]?.inputSchema.properties.query?.description,
    "Free-text lookup query.",
  );
  assert.deepEqual(parsed.tools[0]?.inputSchema.required, ["query"]);
  assert.equal(
    validateToolJsonValue(parsed.tools[0]!.inputSchema, {
      query: "shipment",
      filters: null,
      scopes: ["customer"],
    }).valid,
    true,
  );
  const invalidValue = validateToolJsonValue(parsed.tools[0]!.inputSchema, {
    query: "x",
    scopes: ["unknown"],
    unexpected: true,
  });
  assert.equal(invalidValue.valid, false);
  assert.deepEqual(
    invalidValue.issues.map((issue) => issue.path),
    ["$.query", "$.scopes[0]", "$.unexpected"],
  );

  for (const unsupported of [
    { type: "string", pattern: "(a+)+$" },
    { oneOf: [{ type: "string" }, { type: "number" }] },
    { $ref: "https://example.com/schema.json" },
    { type: "string", default: "surprising" },
    { type: "string", enum: ["a"], minLength: 1 },
  ]) {
    const validation = validateToolJsonSchema(unsupported);
    assert.equal(validation.valid, false);
    assert.match(
      validation.issues[0]?.message ?? "",
      /unsupported|requires|cannot be combined/u,
    );
  }
  assert.equal(
    validateToolJsonSchema({
      type: "object",
      properties: JSON.parse('{"__proto__":{"type":"string"}}'),
    }).valid,
    false,
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
  assert.deepEqual(
    parseCreateModelPresetInput({
      key: "gpt-5-6-terra-v1",
      displayName: "GPT-5.6 Terra",
      providerId: "55555555-5555-4555-8555-555555555555",
      model: "openai/gpt-5.6-terra",
      settings: {
        textFormat: "text",
        mode: "standard",
        effort: "medium",
        verbosity: "medium",
        summary: "auto",
      },
    }).settings,
    {
      textFormat: "text",
      mode: "standard",
      effort: "medium",
      verbosity: "medium",
      summary: "auto",
    },
  );
  assert.deepEqual(
    parseCreateModelPresetInput({
      key: "claude-sonnet-5-v1",
      displayName: "Claude Sonnet 5",
      providerId: "55555555-5555-4555-8555-555555555555",
      model: "anthropic/claude-sonnet-5",
      settings: {
        thinking: "adaptive",
        maxTokens: 20_000,
        effort: "high",
      },
    }).settings,
    { thinking: "adaptive", maxTokens: 20_000, effort: "high" },
  );
  assert.equal(
    parseCreateModelPresetInput({
      key: "grok-4-6-v1",
      displayName: "Grok 4.6",
      providerId: "55555555-5555-4555-8555-555555555555",
      model: "xai/grok-4.6",
    }).model,
    "xai/grok-4.6",
  );
  assert.equal(
    parseCreateModelPresetInput({
      key: "claude-sonnet-5-bedrock-v1",
      displayName: "Claude Sonnet 5 (Bedrock)",
      providerId: "55555555-5555-4555-8555-555555555555",
      model: "bedrock/eu.anthropic.claude-sonnet-5",
    }).model,
    "bedrock/eu.anthropic.claude-sonnet-5",
  );
  assert.equal(
    parseCreateModelPresetInput({
      key: "qwen-coder-v1",
      displayName: "Qwen Coder",
      providerId: "55555555-5555-4555-8555-555555555555",
      model: "bedrock/qwen.qwen3-coder-30b-a3b-v1:0",
    }).model,
    "bedrock/qwen.qwen3-coder-30b-a3b-v1:0",
  );
  assert.deepEqual(
    parseCreateModelPresetInput({
      key: "grok-4-6-low-v1",
      displayName: "Grok 4.6 low",
      providerId: "55555555-5555-4555-8555-555555555555",
      model: "xai/grok-4.6",
      settings: { textFormat: "text", effort: "low" },
    }).settings,
    { textFormat: "text", effort: "low" },
  );
  assert.throws(() =>
    parseCreateModelPresetInput({
      key: "claude-invalid-v1",
      displayName: "Invalid Claude",
      providerId: "55555555-5555-4555-8555-555555555555",
      model: "anthropic/claude-sonnet-5",
      settings: {
        thinking: "adaptive",
        maxTokens: 0,
        effort: "high",
      },
    }),
  );
  assert.throws(() =>
    parseCreateModelPresetInput({
      key: "gpt-invalid-settings-v1",
      displayName: "Invalid settings",
      providerId: "55555555-5555-4555-8555-555555555555",
      model: "openai/gpt-5.6-terra",
      settings: {
        textFormat: "text",
        mode: "turbo",
        effort: "medium",
        verbosity: "medium",
        summary: "auto",
      },
    }),
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

test("delegates and Skills pin a version or follow the latest one", () => {
  const base = {
    systemPrompt: "Coordinate shipment analysis with approved child agents.",
    modelPreset: "coordinator-v1",
    tools: [],
    sandbox: { enabled: false, provider: "daytona-primary", network: "none" },
    limits: { maxTurns: PLATFORM_MAX_TURNS, timeoutMs: 60_000 },
  };
  const agentId = "00000000-0000-4000-8000-000000000010";
  const versionId = "00000000-0000-4000-8000-000000000011";
  const skillId = "00000000-0000-4000-8000-000000000012";
  const skillVersionId = "00000000-0000-4000-8000-000000000013";
  const parsed = parseManagedAgentSnapshotForPublication({
    ...base,
    skillVersionIds: [skillVersionId],
    skillIds: [skillId],
    delegates: [
      {
        key: "pinned",
        description: "Pinned child.",
        agentVersionId: versionId,
      },
      { key: "latest", description: "Following child.", agentId },
    ],
  });
  assert.deepEqual(parsed.skillIds, [skillId]);
  assert.deepEqual(parsed.delegates, [
    {
      key: "pinned",
      description: "Pinned child.",
      agentVersionId: versionId,
      maxParallel: 1,
    },
    { key: "latest", description: "Following child.", agentId, maxParallel: 1 },
  ]);
  // A config that pins everything keeps the exact shape it always had.
  assert.equal(
    "skillIds" in parseManagedAgentSnapshotForPublication(base),
    false,
  );
  for (const delegates of [
    // Both targets, or neither.
    [{ key: "both", description: "Both.", agentId, agentVersionId: versionId }],
    [{ key: "neither", description: "Neither." }],
    // The same followed agent twice.
    [
      { key: "one", description: "One.", agentId },
      { key: "two", description: "Two.", agentId },
    ],
  ])
    assert.throws(
      () => parseManagedAgentSnapshotForPublication({ ...base, delegates }),
      v.ValiError,
      JSON.stringify(delegates),
    );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      skillIds: [skillId, skillId],
    }),
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      skillVersionIds: Array.from(
        { length: 60 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
      ),
      skillIds: Array.from(
        { length: 5 },
        (_, index) =>
          `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
      ),
    }),
  );
});

test("a session version resolution lists each agent version once", () => {
  const entry = {
    agentId: "00000000-0000-4000-8000-000000000020",
    agentVersionId: "00000000-0000-4000-8000-000000000021",
    version: 3,
    skills: [
      {
        skillId: "00000000-0000-4000-8000-000000000022",
        skillVersionId: "00000000-0000-4000-8000-000000000023",
        version: 4,
        name: "import-contract",
        followsLatest: true,
      },
    ],
    delegates: [],
  };
  const resolution = {
    schemaVersion: 1,
    rootSessionId: "00000000-0000-4000-8000-000000000024",
    rootAgentVersionId: entry.agentVersionId,
    resolvedAt: "2026-11-03T12:00:00.000Z",
    agentVersions: [entry],
  };
  assert.deepEqual(parseSessionVersionResolution(resolution), resolution);
  assert.throws(() =>
    parseSessionVersionResolution({
      ...resolution,
      agentVersions: [entry, entry],
    }),
  );
  assert.throws(() =>
    parseSessionVersionResolution({ ...resolution, agentVersions: [] }),
  );
});

test("agent publications pin focused Harness Operations with structured results", () => {
  const base = {
    systemPrompt: "Coordinate shipment extraction with focused operations.",
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
  const operation = {
    key: "extract_shipment",
    description: "Extract normalized shipment facts from mounted documents.",
    instructions:
      "Inspect the original mounted shipment documents and return verified facts.",
    resultSchema: {
      type: "object" as const,
      properties: {
        shipmentReference: { type: "string" },
      },
      required: ["shipmentReference"],
      additionalProperties: false,
    },
    timeoutMs: 45_000,
  };
  const parsed = parseManagedAgentSnapshotForPublication({
    ...base,
    harnessOperations: [operation],
  });
  assert.deepEqual(parsed.harnessOperations, [operation]);
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      harnessOperations: [operation, operation],
    }),
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      harnessOperations: [{ ...operation, key: "finish" }],
    }),
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      tools: [
        {
          schemaVersion: 1,
          name: operation.key,
          description: "Collides with the Harness Operation.",
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
      harnessOperations: [operation],
    }),
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      harnessOperations: [
        {
          ...operation,
          resultSchema: { type: "string" },
        },
      ],
    }),
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      harnessOperations: [
        {
          ...operation,
          resultSchema: {
            ...operation.resultSchema,
            examples: ["x".repeat(65_536)],
          },
        },
      ],
    }),
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      harnessOperations: [{ ...operation, timeoutMs: 300_001 }],
    }),
  );
});

test("MCP credentials pin an HTTPS destination that policies must lie inside", () => {
  const destination = {
    origin: "https://mcp.example.test",
    pathPrefix: "/mcp",
  };
  const pinned = parseCreateMcpCredentialInput({
    key: "pinned",
    displayName: "Pinned",
    kind: "static_bearer",
    destination,
    secret: "secret-value",
  });
  assert.ok(pinned.kind === "static_bearer");
  assert.deepEqual(pinned.destination, destination);
  assert.throws(() =>
    parseCreateMcpCredentialInput({
      key: "unpinned",
      displayName: "Unpinned",
      kind: "static_bearer",
      secret: "secret-value",
    }),
  );
  for (const unsafe of [
    { origin: "http://mcp.example.test", pathPrefix: "/" },
    { origin: "https://mcp.example.test/mcp", pathPrefix: "/" },
    { origin: "https://user@mcp.example.test", pathPrefix: "/" },
    { origin: "https://mcp.example.test", pathPrefix: "mcp" },
    { origin: "https://mcp.example.test", pathPrefix: "/mcp?x=1" },
  ])
    assert.throws(
      () =>
        parseCreateMcpCredentialInput({
          key: "unsafe",
          displayName: "Unsafe",
          kind: "static_bearer",
          destination: unsafe,
          secret: "secret-value",
        }),
      JSON.stringify(unsafe),
    );
  assert.equal(
    parseRotateMcpCredentialInput({ secret: "secret-value" }).destination,
    undefined,
  );

  assert.equal(mcpPathWithin("/mcp", "/mcp"), true);
  assert.equal(mcpPathWithin("/mcp/v2", "/mcp"), true);
  assert.equal(mcpPathWithin("/mcpx", "/mcp"), false);
  assert.equal(mcpPathWithin("/api/x", "/api/"), true);
  assert.equal(mcpPathWithin("/", "/mcp"), false);
  assert.equal(
    mcpDestinationContains(destination, {
      origin: "https://MCP.example.test:443/",
      pathPrefix: "/mcp/tools",
    }),
    true,
  );
  assert.equal(
    mcpDestinationContains(destination, {
      origin: "https://attacker.example.test",
      pathPrefix: "/mcp",
    }),
    false,
  );
  assert.equal(
    mcpDestinationContains(destination, {
      origin: "https://mcp.example.test",
      pathPrefix: "/",
    }),
    false,
  );
});

test("OAuth client-credentials MCP credentials pin a confirmed authorization configuration", () => {
  const oauth = {
    resource: "https://app.example.test/api/integrations/oao/extraction/mcp",
    resourceMetadataUrl:
      "https://app.example.test/.well-known/oauth-protected-resource/api/integrations/oao/extraction/mcp",
    issuer: "https://auth.example.test",
    tokenEndpoint: "https://auth.example.test/oauth2/token",
    clientId: "client_01EXAMPLE",
    scope: "extraction:mcp",
  };
  const parsed = parseCreateMcpCredentialInput({
    key: "extraction",
    displayName: "Extraction",
    kind: "oauth_client_credentials",
    oauth,
    secret: "client-secret-value",
  });
  assert.ok(parsed.kind === "oauth_client_credentials");
  assert.deepEqual(parsed.oauth, {
    ...oauth,
    tokenEndpointAuthMethod: "client_secret_post",
    sendResource: true,
  });
  for (const unsafe of [
    { tokenEndpoint: "http://auth.example.test/oauth2/token" },
    { issuer: "https://user@auth.example.test" },
    { scope: "extraction:mcp  extra" },
    { scope: 'quoted"scope' },
    { tokenEndpointAuthMethod: "private_key_jwt" },
    { clientId: "" },
  ])
    assert.throws(
      () =>
        parseCreateMcpCredentialInput({
          key: "extraction",
          displayName: "Extraction",
          kind: "oauth_client_credentials",
          oauth: { ...oauth, ...unsafe },
          secret: "client-secret-value",
        }),
      JSON.stringify(unsafe),
    );
  // The destination is the pinned resource; it cannot be given separately.
  assert.throws(() =>
    parseCreateMcpCredentialInput({
      key: "extraction",
      displayName: "Extraction",
      kind: "oauth_client_credentials",
      oauth,
      destination: { origin: "https://attacker.example.test", pathPrefix: "/" },
      secret: "client-secret-value",
    }),
  );
  assert.deepEqual(
    parseRotateMcpCredentialInput({
      secret: "next-client-secret",
      oauth: { clientId: "client_02EXAMPLE" },
    }).oauth,
    { clientId: "client_02EXAMPLE" },
  );
  assert.throws(() =>
    parseRotateMcpCredentialInput({
      secret: "next-client-secret",
      oauth: { resource: "https://attacker.example.test/mcp" },
    }),
  );
  assert.throws(() =>
    parseDiscoverMcpAuthorizationInput({ endpointUrl: "http://app.test/mcp" }),
  );
  assert.deepEqual(
    v.parse(McpCredentialTestResultSchema, {
      ok: false,
      errorCode: "credential_rejected",
    }),
    { ok: false, errorCode: "credential_rejected" },
  );
  assert.throws(() =>
    v.parse(McpCredentialTestResultSchema, { ok: false, errorCode: "leak" }),
  );
});

test("MCP server usage and removal results carry only identifiers and names", () => {
  const usage = v.parse(McpServerUsageSchema, {
    agents: [{ id, key: "triage", name: "Triage" }],
    otherProjects: [{ id, slug: "support", name: "Support", agentCount: 2 }],
    toolsets: [],
    credentialPolicies: [{ id, key: "egress", displayName: "Egress" }],
    credentials: [{ id, key: "token", displayName: "Token" }],
  });
  assert.equal(usage.otherProjects[0]?.agentCount, 2);
  assert.throws(() =>
    v.parse(RemoveMcpServerResultSchema, {
      revokedToolsetIds: ["not-a-uuid"],
      revokedCredentialPolicyIds: [],
      revokedCredentialIds: [],
    }),
  );
});

test("MCP call context is opt-in and its header namespace is reserved", () => {
  assert.equal(
    parseCreateMcpCredentialPolicyInput({
      key: "egress",
      displayName: "Egress",
      credentialId: id,
      exactOrigin: "https://mcp.example.test",
      pathPrefix: "/mcp",
    }).forwardCallContext,
    false,
  );
  assert.equal(
    parseCreateMcpCredentialPolicyInput({
      key: "egress",
      displayName: "Egress",
      credentialId: id,
      exactOrigin: "https://mcp.example.test",
      pathPrefix: "/mcp",
      forwardCallContext: true,
    }).forwardCallContext,
    true,
  );
  for (const headerName of ["X-OAO-Session-Id", "x-oao-anything"])
    assert.throws(
      () =>
        parseCreateMcpCredentialInput({
          key: "reserved",
          displayName: "Reserved",
          kind: "api_key_header",
          headerName,
          destination: { origin: "https://mcp.example.test", pathPrefix: "/" },
          secret: "secret-value",
        }),
      headerName,
    );
});

test("MCP contracts require HTTPS, safe credential headers, and unique bindings", () => {
  assert.equal(
    parseCreateMcpServerInput({
      key: "trace-server",
      displayName: "Trace server",
      endpointUrl: "https://mcp.example.test/mcp",
      transport: "streamable_http",
    }).transport,
    "streamable_http",
  );
  assert.throws(() =>
    parseCreateMcpServerInput({
      key: "metadata",
      displayName: "Metadata",
      endpointUrl: "http://169.254.169.254/latest",
    }),
  );
  assert.throws(() =>
    parseCreateMcpCredentialInput({
      key: "unsafe",
      displayName: "Unsafe",
      kind: "api_key_header",
      headerName: "Host",
      destination: { origin: "https://mcp.example.test", pathPrefix: "/" },
      secret: "secret-value",
    }),
  );
  assert.throws(() =>
    parseCreateMcpCredentialPolicyInput({
      key: "unsafe-origin",
      displayName: "Unsafe origin",
      credentialId: id,
      exactOrigin: "https://mcp.example.test/path",
      pathPrefix: "/mcp",
    }),
  );
  const base = {
    systemPrompt: "Use only the exact approved MCP toolset binding.",
    modelPreset: "mcp-agent-v1",
    tools: [],
    sandbox: {
      enabled: false,
      provider: "daytona-primary",
      network: "none" as const,
    },
    limits: { maxTurns: PLATFORM_MAX_TURNS, timeoutMs: 60_000 },
  };
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...base,
      mcpBindings: [
        {
          toolsetVersionId: id,
          credentialPolicyVersionId: id,
          namespace: "traces",
        },
        {
          toolsetVersionId: "00000000-0000-4000-8000-000000000002",
          credentialPolicyVersionId: "00000000-0000-4000-8000-000000000003",
          namespace: "traces",
        },
      ],
    }),
  );
});

test("model catalog preserves discovery-only status and accepts legacy entries", () => {
  const entry = {
    providerType: "openai",
    model: "openai/gpt-7-future",
    catalogId: "gpt-7-future",
    name: "Future",
    contextWindow: null,
    maxOutputTokens: null,
    reasoning: false,
  };
  assert.equal(
    v.parse(ModelCatalogEntrySchema, { ...entry, runtimeSupported: false })
      .runtimeSupported,
    false,
  );
  assert.equal(
    v.parse(ModelCatalogEntrySchema, entry).runtimeSupported,
    undefined,
  );
  assert.throws(() =>
    v.parse(ModelCatalogEntrySchema, { ...entry, runtimeSupported: "false" }),
  );
});

test("agent model turn budgets accept bounded integers and preserve the configured value", () => {
  const config = {
    systemPrompt: "Answer carefully using the configured model.",
    modelPreset: "project-model-v1",
    tools: [],
    sandbox: {
      enabled: false,
      provider: "daytona-primary",
      network: "none",
      capabilities: [],
    },
    limits: { maxTurns: 32, timeoutMs: 60_000 },
  };
  for (const maxTurns of [1, 32, 128, 256]) {
    assert.equal(
      parseManagedAgentSnapshotForPublication({
        ...config,
        limits: { ...config.limits, maxTurns },
      }).limits.maxTurns,
      maxTurns,
    );
  }
  for (const maxTurns of [0, -1, 1.5, 257, Infinity, NaN, "128", undefined]) {
    assert.throws(() =>
      parseManagedAgentSnapshotForPublication({
        ...config,
        limits: { ...config.limits, maxTurns },
      }),
    );
  }
});

test("public principal role metadata comes from persisted membership and remains optional", () => {
  const principal = {
    id,
    organizationId: id,
    projectId: id,
    kind: "human",
    subject: "iap:accounts.google.com:123",
    scopes: ["*"],
  };
  const parsed = v.parse(PublicPrincipalSchema, {
    ...principal,
    organizationRole: "member",
    projectRole: "admin",
  });
  assert.equal(parsed.organizationRole, "member");
  assert.equal(parsed.projectRole, "admin");
  assert.equal(
    v.parse(PublicPrincipalSchema, principal).organizationRole,
    undefined,
  );
  assert.throws(() =>
    v.parse(PublicPrincipalSchema, {
      ...principal,
      organizationRole: "superadmin",
    }),
  );
});

test("a model preset price is complete, non-negative, and may have long-context rates", () => {
  const price = {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteUsdPerMillion: 2.5,
    outputUsdPerMillion: 10,
  };
  assert.deepEqual(parseSetModelPresetPriceInput(price), {
    ...price,
    longContext: null,
  });
  assert.equal(
    parseSetModelPresetPriceInput({
      ...price,
      validFrom: "2026-11-22T00:00:00.000Z",
    }).validFrom,
    "2026-11-22T00:00:00.000Z",
  );
  assert.equal(
    parseSetModelPresetPriceInput({
      ...price,
      longContext: { aboveInputTokens: 272_000, ...price },
    }).longContext?.aboveInputTokens,
    272_000,
  );
  const partial: Partial<typeof price> = { ...price };
  delete partial.outputUsdPerMillion;
  assert.throws(() => parseSetModelPresetPriceInput(partial));
  assert.throws(() =>
    parseSetModelPresetPriceInput({ ...price, inputUsdPerMillion: -1 }),
  );
  assert.throws(() =>
    parseSetModelPresetPriceInput({
      ...price,
      longContext: { aboveInputTokens: 0, ...price },
    }),
  );
  assert.throws(() =>
    parseSetModelPresetPriceInput({ ...price, currency: "EUR" }),
  );
});

test("a model preset may be created with its first price", () => {
  const preset = {
    key: "gpt-6-1-sol-v1",
    displayName: "GPT-6.1 Sol",
    providerId: "11111111-1111-4111-8111-111111111111",
    model: "openai/gpt-6.1-sol",
  };
  assert.equal(parseCreateModelPresetInput(preset).price, null);
  assert.equal(
    parseCreateModelPresetInput({
      ...preset,
      price: {
        inputUsdPerMillion: 2,
        cachedInputUsdPerMillion: 0.1,
        cacheWriteUsdPerMillion: 2.5,
        outputUsdPerMillion: 10,
      },
    }).price?.outputUsdPerMillion,
    10,
  );
});

test("preset limits are optional token counts, with the output not above the window", () => {
  assert.deepEqual(parseSetModelPresetLimitsInput({}), {
    contextWindow: null,
    maxOutputTokens: null,
  });
  assert.deepEqual(
    parseSetModelPresetLimitsInput({
      contextWindow: 250_000,
      maxOutputTokens: 128_000,
    }),
    { contextWindow: 250_000, maxOutputTokens: 128_000 },
  );
  assert.deepEqual(
    parseSetModelPresetLimitsInput({ maxOutputTokens: 64_000 }),
    {
      contextWindow: null,
      maxOutputTokens: 64_000,
    },
  );
  for (const input of [
    { contextWindow: 1_023 },
    { contextWindow: 10_000_001 },
    { contextWindow: 250_000.5 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1_000_001 },
    { contextWindow: 100_000, maxOutputTokens: 100_001 },
    { contextWindow: "250000" },
    { contextWindow: 250_000, other: true },
  ])
    assert.throws(
      () => parseSetModelPresetLimitsInput(input),
      JSON.stringify(input),
    );
  // A preset created without limits reads as none.
  const created = parseCreateModelPresetInput({
    key: "sol-v1",
    displayName: "Sol",
    providerId: "00000000-0000-4000-8000-000000000001",
    model: "openrouter/@preset/azure-sol-61",
  });
  assert.equal(created.limits, null);
  assert.throws(() =>
    parseCreateModelPresetInput({
      key: "sol-v1",
      displayName: "Sol",
      providerId: "00000000-0000-4000-8000-000000000001",
      model: "openrouter/@preset/azure-sol-61",
      limits: { contextWindow: 1_000 },
    }),
  );
});
