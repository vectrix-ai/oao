import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type {
  AgentDefinition,
  CreatedSession,
  Message,
  ModelCatalogEntry,
  ModelPreset,
  Page,
  ProjectContext,
  ProjectModelProvider,
  Run,
} from "@oao/sdk-js";
import type { SetupIo } from "../src/io.js";
import { runSetup } from "../src/setup.js";
import type { SetupApi } from "../src/setup.js";
import type { LocalStackHandle } from "../src/stack.js";

const context: ProjectContext = {
  principal: {
    id: "principal-1",
    organizationId: "organization-1",
    projectId: "project-1",
    kind: "human",
    subject: "development-user",
    scopes: ["*"],
  },
  organization: {
    id: "organization-1",
    slug: "development",
    name: "Development organization",
    createdAt: "2026-08-27T00:00:00.000Z",
  },
  project: {
    id: "project-1",
    organizationId: "organization-1",
    slug: "default",
    name: "Default project",
    createdAt: "2026-08-27T00:00:00.000Z",
  },
  organizations: [],
  projects: [],
  activeModelPresets: [],
  authProvider: "development",
};

const run: Run = {
  id: "run-1",
  organizationId: "organization-1",
  projectId: "project-1",
  threadId: "thread-1",
  sessionId: "session-1",
  agentVersionId: "agent-version-1",
  createdByPrincipalId: "principal-1",
  state: "completed",
  cancellationRequestedAt: null,
  admittedAt: "2026-08-27T00:00:01.000Z",
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:02.000Z",
};

class FakeIo implements SetupIo {
  readonly output: string[] = [];
  readonly secrets: string[] = [];
  readonly questions: string[] = [];
  readonly selectPrompts: string[] = [];
  readonly searchPrompts: string[] = [];

  constructor(
    private readonly selections: string[],
    private readonly secretAnswers: string[],
    private readonly questionAnswers: string[],
  ) {}

  write(message: string): void {
    this.output.push(message);
  }

  async question(_prompt: string, defaultValue?: string): Promise<string> {
    this.questions.push(_prompt);
    return this.questionAnswers.shift() ?? defaultValue ?? "";
  }

  async secret(prompt: string): Promise<string> {
    this.secrets.push(prompt);
    return this.secretAnswers.shift() ?? "";
  }

  async select(prompt: string): Promise<string> {
    this.selectPrompts.push(prompt);
    const value = this.selections.shift();
    if (!value) throw new Error("No fake selection remains");
    return value;
  }

  async search(prompt: string): Promise<string> {
    this.searchPrompts.push(prompt);
    const value = this.selections.shift();
    if (!value) throw new Error("No fake selection remains");
    return value;
  }
}

class FakeApi implements SetupApi {
  providers: ProjectModelProvider[] = [];
  presets: ModelPreset[] = [];
  agents: AgentDefinition[] = [];
  sessionCreates = 0;
  catalogLimits: number[] = [];

  getContext: SetupApi["getContext"] = async () => context;

  listModelProviders: SetupApi["listModelProviders"] = async () =>
    page(this.providers);

  createModelProvider: SetupApi["createModelProvider"] = async (
    _projectId,
    input,
  ) => {
    const provider: ProjectModelProvider = {
      id: "provider-1",
      organizationId: "organization-1",
      projectId: "project-1",
      key: input.key,
      displayName: input.displayName,
      providerType: input.providerType,
      credentialConfigured: true,
      credentialFingerprint: "0123456789ab",
      credentialVersion: 1,
      createdByPrincipalId: "principal-1",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    this.providers.push(provider);
    return provider;
  };

  rotateModelProviderCredential: SetupApi["rotateModelProviderCredential"] =
    async () => {
      const provider = this.providers[0];
      if (!provider) throw new Error("Provider missing");
      return provider;
    };

  listModelCatalog: SetupApi["listModelCatalog"] = async (
    _projectId,
    query,
  ) => {
    this.catalogLimits.push(query.limit ?? 0);
    return {
      ...page<ModelCatalogEntry>([
        {
          providerType: "openrouter",
          model: "openrouter/anthropic/claude-sonnet-4.6",
          catalogId: "anthropic/claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
          contextWindow: 200_000,
          maxOutputTokens: 64_000,
          reasoning: true,
        },
      ]),
      providerId: "provider-1",
      providerType: "openrouter",
    };
  };

  listModelPresets: SetupApi["listModelPresets"] = async () => ({
    ...page(this.presets),
    credentialEncryptionConfigured: true,
  });

  createModelPreset: SetupApi["createModelPreset"] = async (
    _projectId,
    input,
  ) => {
    const preset: ModelPreset = {
      id: "preset-1",
      organizationId: "organization-1",
      projectId: "project-1",
      key: input.key,
      displayName: input.displayName,
      origin: "project",
      providerId: input.providerId,
      providerType: "openrouter",
      model: input.model,
      routing: input.routing ?? {},
      settings: null,
      hosted: true,
      available: true,
      createdByPrincipalId: "principal-1",
      createdAt: "2026-08-27T00:00:00.000Z",
    };
    this.presets.push(preset);
    return preset;
  };

  listAgents: SetupApi["listAgents"] = async () => page(this.agents);

  createAgent: SetupApi["createAgent"] = async (_projectId, input) => {
    const agent: AgentDefinition = {
      id: "agent-1",
      organizationId: "organization-1",
      projectId: "project-1",
      key: input.key ?? "generated",
      name: input.name,
      description: input.description,
      latestVersionId: "agent-version-1",
      createdAt: "2026-08-27T00:00:00.000Z",
    };
    this.agents.push(agent);
    return agent;
  };

  createSession: SetupApi["createSession"] = async () => {
    this.sessionCreates += 1;
    const session: CreatedSession = {
      id: "session-1",
      organizationId: "organization-1",
      projectId: "project-1",
      threadId: "thread-1",
      agentVersionId: "agent-version-1",
      status: "completed",
      createdAt: "2026-08-27T00:00:00.000Z",
      lastActivityAt: "2026-08-27T00:00:02.000Z",
      latestRunId: "run-1",
      run,
    };
    return session;
  };

  getRun: SetupApi["getRun"] = async () => run;
  waitForRunSettled: SetupApi["waitForRunSettled"] = async () => run;
  listRunMessages: SetupApi["listRunMessages"] = async () =>
    page<Message>([
      {
        id: "message-1",
        organizationId: "organization-1",
        projectId: "project-1",
        threadId: "thread-1",
        runId: "run-1",
        role: "assistant",
        redactedContent: "I am ready.",
        createdAt: "2026-08-27T00:00:02.000Z",
      },
    ]);
}

function page<T>(data: readonly T[]): Page<T> {
  return { data, pageInfo: { hasMore: false, nextCursor: null } };
}

const stack: LocalStackHandle = {
  owned: true,
  addresses: {
    apiOrigin: "http://127.0.0.1:3000",
    runtimeOrigin: "http://127.0.0.1:8788",
    consoleOrigin: "http://127.0.0.1:8080",
  },
  stop: async () => {},
};

test("guided setup is resumable and never persists the provider credential", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "oao-cli-setup-"));
  const providerSecret = "provider-secret-that-must-not-persist";
  await writeFile(
    resolve(directory, ".env.example"),
    "AUTH_PROVIDER=development\nOAO_CREDENTIAL_ENCRYPTION_KEY=\n",
  );
  const api = new FakeApi();
  try {
    const firstIo = new FakeIo(
      ["openrouter", "openrouter/anthropic/claude-sonnet-4.6"],
      [providerSecret],
      ["Starter agent", "Hello"],
    );
    const first = await runSetup({
      repositoryRoot: directory,
      io: firstIo,
      createApi: () => api,
      startStack: async () => stack,
    });
    assert.equal(first.run.state, "completed");
    assert.equal(api.providers.length, 1);
    assert.equal(api.presets.length, 1);
    assert.equal(api.agents.length, 1);
    assert.equal(api.sessionCreates, 1);
    assert.deepEqual(api.catalogLimits, [200]);
    assert.deepEqual(firstIo.selectPrompts, ["Choose a model provider"]);
    assert.deepEqual(firstIo.searchPrompts, [
      "Choose the model for your first agent",
    ]);

    const second = await runSetup({
      repositoryRoot: directory,
      io: new FakeIo([], [], []),
      createApi: () => api,
      startStack: async () => stack,
    });
    assert.equal(second.run.id, "run-1");
    assert.equal(api.providers.length, 1);
    assert.equal(api.presets.length, 1);
    assert.equal(api.agents.length, 1);
    assert.equal(api.sessionCreates, 1);

    const persisted = `${await readFile(resolve(directory, ".env"), "utf8")}\n${await readFile(resolve(directory, ".oao/setup-state.json"), "utf8")}`;
    assert.equal(persisted.includes(providerSecret), false);
    assert.match(persisted, /OAO_CREDENTIAL_ENCRYPTION_KEY=[A-Za-z0-9+/]+=*/u);
    assert.equal((await stat(resolve(directory, ".env"))).mode & 0o777, 0o600);
    assert.equal(
      (await stat(resolve(directory, ".oao/setup-state.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
