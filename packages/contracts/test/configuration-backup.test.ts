import assert from "node:assert/strict";
import test from "node:test";
import {
  agentVersionPublicationOrder,
  checkConfigurationBackupReferences,
  configurationBackupCounts,
  parseConfigurationBackup,
  parseConfigurationRestoreInput,
  type ConfigurationBackup,
} from "../src/index.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const HASH = "a".repeat(64);
const sandbox = {
  enabled: false,
  provider: "anything",
  network: "none",
  capabilities: [],
};

function fixture(): ConfigurationBackup {
  return {
    format: "oao.organization-configuration",
    formatVersion: 1,
    exportedAt: "2026-10-17T12:00:00.000Z",
    organization: { slug: "acme", name: "Acme" },
    modelProviders: [
      {
        id: id(1),
        key: "primary",
        displayName: "Primary",
        providerType: "openrouter",
        archived: false,
        credentialFingerprint: "0123456789ab",
      },
      {
        id: id(2),
        key: "primary",
        displayName: "Primary (retired)",
        providerType: "openrouter",
        archived: true,
        credentialFingerprint: null,
      },
    ],
    sandboxProviders: [],
    storageProviders: [],
    mcpServers: [
      {
        id: id(10),
        key: "traces",
        displayName: "Traces",
        versions: [
          {
            id: id(11),
            version: 1,
            endpointUrl: "https://mcp.example.test/mcp",
            transport: "streamable_http",
            status: "active",
            contentHash: HASH,
            tools: [
              {
                name: "lookup",
                title: null,
                description: "Look up.",
                inputSchema: { type: "object" },
                outputSchema: null,
                schemaHash: HASH,
              },
            ],
          },
        ],
      },
    ],
    mcpCredentials: [
      {
        id: id(20),
        key: "traces-token",
        displayName: "Token",
        kind: "static_bearer",
        headerName: null,
        destination: { origin: "https://mcp.example.test", pathPrefix: "/" },
        status: "active",
        credentialFingerprint: null,
      },
    ],
    mcpCredentialPolicies: [
      {
        id: id(30),
        key: "traces-egress",
        displayName: "Egress",
        versions: [
          {
            id: id(31),
            version: 1,
            credentialId: id(20),
            exactOrigin: "https://mcp.example.test",
            pathPrefix: "/",
            timeoutMs: 10_000,
            maximumResponseBytes: 65_536,
            status: "active",
            contentHash: HASH,
          },
        ],
      },
    ],
    projects: [
      {
        slug: "support",
        name: "Support",
        modelPresets: [
          {
            id: id(40),
            key: "fast-v1",
            displayName: "Fast",
            providerId: id(1),
            model: "openrouter/openai/gpt-5.4",
            routing: {},
            settings: null,
            archived: false,
          },
        ],
        skills: [
          {
            id: id(50),
            key: "triage",
            displayName: "Triage",
            disabled: false,
            archived: false,
            versions: [
              {
                id: id(51),
                version: 1,
                name: "triage",
                description: "Triage.",
                instructions: "Triage it.",
                license: null,
                compatibility: null,
                metadata: {},
                allowedTools: null,
                status: "active",
                files: [],
              },
            ],
          },
        ],
        mcpToolsets: [
          {
            id: id(60),
            key: "traces-readonly",
            displayName: "Read-only",
            versions: [
              {
                id: id(61),
                version: 1,
                serverVersionId: id(11),
                status: "active",
                contentHash: HASH,
                tools: [{ remoteToolName: "lookup", approval: "always" }],
              },
            ],
          },
        ],
        agents: [
          {
            id: id(70),
            key: "child",
            name: "Child",
            description: null,
            archived: false,
            versions: [
              {
                id: id(71),
                version: 1,
                publishedAt: "2026-10-01T00:00:00.000Z",
                config: { modelPreset: "fast-v1", sandbox },
              },
            ],
          },
          {
            id: id(80),
            key: "coordinator",
            name: "Coordinator",
            description: null,
            archived: false,
            versions: [
              {
                id: id(81),
                version: 1,
                publishedAt: "2026-10-02T00:00:00.000Z",
                config: {
                  modelPreset: "fast-v1",
                  sandbox,
                  skillVersionIds: [id(51)],
                  mcpBindings: [
                    {
                      toolsetVersionId: id(61),
                      credentialPolicyVersionId: id(31),
                      namespace: "traces",
                    },
                  ],
                  delegates: [
                    {
                      key: "child",
                      description: "Child.",
                      agentVersionId: id(71),
                    },
                  ],
                },
              },
            ],
          },
        ],
        eventWebhooks: [],
      },
    ],
  };
}

test("a consistent backup parses, has no problems, and is counted", () => {
  const backup = parseConfigurationBackup(fixture());
  // Archived entries may share a key with a live one.
  assert.deepEqual(checkConfigurationBackupReferences(backup), []);
  assert.deepEqual(configurationBackupCounts(backup), {
    projects: 1,
    modelProviders: 2,
    sandboxProviders: 0,
    storageProviders: 0,
    mcpServers: 1,
    mcpCredentials: 1,
    mcpCredentialPolicies: 1,
    modelPresets: 1,
    skills: 1,
    skillVersions: 1,
    mcpToolsets: 1,
    agents: 2,
    agentVersions: 2,
    eventWebhooks: 0,
  });
});

test("a backup made before credential destinations existed restores them unpinned", () => {
  const legacy = fixture() as unknown as {
    mcpCredentials: Record<string, unknown>[];
  };
  delete legacy.mcpCredentials[0]!.destination;
  const backup = parseConfigurationBackup(legacy);
  assert.equal(backup.mcpCredentials[0]?.destination, null);
  assert.deepEqual(checkConfigurationBackupReferences(backup), []);
});

test("the backup format and version numbering are enforced", () => {
  assert.throws(() =>
    parseConfigurationBackup({ ...fixture(), format: "something-else" }),
  );
  assert.throws(() =>
    parseConfigurationBackup({ ...fixture(), formatVersion: 2 }),
  );
  const gap = fixture();
  gap.projects[0]!.skills[0]!.versions[0]!.version = 2;
  assert.throws(() => parseConfigurationBackup(gap), /numbered 1, 2, 3/u);
  const extra = { ...fixture(), apiKeys: [] };
  assert.throws(() => parseConfigurationBackup(extra));
  // Any slug a project can be created with is accepted.
  const slugs = fixture();
  slugs.projects[0]!.slug = "support--team-";
  assert.equal(
    parseConfigurationBackup(slugs).projects[0]!.slug,
    "support--team-",
  );
});

test("references that cannot be restored are reported", () => {
  const backup = fixture();
  const project = backup.projects[0]!;
  const coordinator = project.agents[1]!.versions[0]!;
  coordinator.config = {
    ...coordinator.config,
    skillVersionIds: [id(999)],
    delegates: [
      { key: "child", description: "Child.", agentVersionId: id(71) },
    ],
    sandbox: { ...sandbox, enabled: true, provider: "missing-daytona" },
  };
  // The child delegating back to its coordinator closes a cycle.
  project.agents[0]!.versions[0]!.config = {
    ...project.agents[0]!.versions[0]!.config,
    delegates: [{ key: "back", description: "Back.", agentVersionId: id(81) }],
  };
  project.mcpToolsets[0]!.versions[0]!.tools = [
    { remoteToolName: "not-offered", approval: "never" },
  ];
  backup.modelProviders[1]!.archived = false;
  const problems = checkConfigurationBackupReferences(backup);
  for (const expected of [
    /Model provider key primary appears twice/u,
    /selects not-offered, which its server version does not offer/u,
    /uses a Skill version that is not in this project's backup/u,
    /agent versions delegate to each other in a cycle/u,
    /uses the sandbox provider missing-daytona, which is not in the backup/u,
  ])
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `missing ${expected}: ${problems.join(" | ")}`,
    );
});

test("restore credentials validate their formats", () => {
  const backup = fixture();
  assert.deepEqual(parseConfigurationRestoreInput({ backup }).credentials, {
    modelProviders: {},
    sandboxProviders: {},
    storageProviders: {},
    mcpCredentials: {},
    eventWebhooks: {},
  });
  assert.throws(() =>
    parseConfigurationRestoreInput({
      backup,
      credentials: { eventWebhooks: { [id(1)]: "not-a-signing-secret" } },
    }),
  );
  assert.throws(() =>
    parseConfigurationRestoreInput({
      backup,
      credentials: { storageProviders: { [id(1)]: { accessKeyId: "AKIA" } } },
    }),
  );
});

test("delegates are ordered before their coordinators even when timestamps tie", () => {
  const backup = fixture();
  const [child, coordinator] = backup.projects[0]!.agents;
  // The child's second version is the delegate; every timestamp is equal.
  child!.versions.push({
    id: id(72),
    version: 2,
    publishedAt: "2026-10-01T00:00:00.000Z",
    config: { modelPreset: "fast-v1", sandbox },
  });
  for (const agent of [child!, coordinator!])
    for (const version of agent.versions)
      version.publishedAt = "2026-10-01T00:00:00.000Z";
  coordinator!.versions[0]!.config = {
    ...coordinator!.versions[0]!.config,
    delegates: [
      { key: "child", description: "Child.", agentVersionId: id(72) },
    ],
  };
  const order = agentVersionPublicationOrder(backup.projects[0]!.agents);
  assert.deepEqual(
    order?.map(({ agent, version }) => `${agent.key}@${version.version}`),
    ["child@1", "child@2", "coordinator@1"],
  );
  assert.deepEqual(checkConfigurationBackupReferences(backup), []);
});
