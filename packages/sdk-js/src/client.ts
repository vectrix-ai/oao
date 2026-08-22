import type {
  AgentDefinition,
  AgentVersion,
  AgentDelegation,
  Approval,
  Message,
  Organization,
  Page,
  ProductEvent,
  Project,
  Run,
  Session,
  Thread,
  ToolCall,
} from "@oao/contracts";

import { createRoutes, type Routes } from "./routes.js";
import { parseEventStream } from "./sse.js";
import type {
  AgentToolInput,
  AuditEntry,
  AuditExport,
  AuthLogoutResult,
  AuthSession,
  CreateAgentInput,
  CreateProjectMemberInput,
  CreatedSession,
  DelegationMessageResult,
  CreateSessionInput,
  CreatedPlatformApiKey,
  CreateModelPresetInput,
  CreateProjectModelProviderInput,
  CreateProjectSandboxProviderInput,
  CreateProjectStorageProviderInput,
  HealthStatus,
  Member,
  ModelCatalogPage,
  ModelPreset,
  ModelPresetPage,
  PaginationOptions,
  PlatformApiKey,
  ProjectModelProvider,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  ProjectEventFrame,
  ProjectEventStreamOptions,
  PublishAgentVersionInput,
  PublishSkillVersionInput,
  CreateSkillInput,
  RotateProjectModelProviderCredentialInput,
  RotateProjectSandboxProviderCredentialInput,
  RotateProjectStorageProviderCredentialInput,
  ReadinessStatus,
  RequestOptions,
  SkillDetail,
  SkillDraft,
  SkillDraftValidation,
  SkillExport,
  SkillSummary,
  SkillVersionView,
  UpdateSkillDraftInput,
  RunInput,
  RunTimelineEntry,
  SandboxPolicyInput,
  SandboxProviderPage,
  SandboxSnapshotList,
  StorageObjectList,
  StorageProviderList,
  ToolClaim,
  ToolResultEnvelope,
  ToolResultSubmission,
  UpdateProjectMemberInput,
  UpdateProjectSandboxProviderConfigurationInput,
  WriteOptions,
  McpServer,
  McpCredential,
  McpCredentialPolicy,
  McpToolset,
  McpServerList,
  McpCredentialList,
  McpCredentialPolicyList,
  McpToolsetList,
  CreateMcpServerInput,
  DiscoverMcpServerInput,
  CreateMcpCredentialInput,
  RotateMcpCredentialInput,
  CreateMcpCredentialPolicyInput,
  CreateMcpToolsetInput,
} from "./types.js";

type Credential =
  string | (() => string | undefined | Promise<string | undefined>);

export interface OaoClientOptions {
  readonly baseUrl: string;
  readonly apiPrefix?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly bearerToken?: Credential;
  readonly apiKey?: Credential;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
}

interface InternalRequestOptions extends RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class OaoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "OaoApiError";
  }
}

export class OaoClient {
  readonly routes: Routes;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #bearerToken: Credential | undefined;
  readonly #apiKey: Credential | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #credentials: RequestCredentials;

  constructor(options: OaoClientOptions) {
    if (!/^https?:\/\//u.test(options.baseUrl)) {
      throw new TypeError("baseUrl must be an absolute HTTP(S) URL");
    }
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#bearerToken = options.bearerToken;
    this.#apiKey = options.apiKey;
    this.#headers = options.headers ?? {};
    this.#credentials = options.credentials ?? "same-origin";
    this.routes = createRoutes(options.apiPrefix);
  }

  health(options?: RequestOptions): Promise<HealthStatus> {
    return this.#request(this.routes.health, options);
  }

  readiness(options?: RequestOptions): Promise<ReadinessStatus> {
    return this.#request(this.routes.readiness, options);
  }

  login(
    input: { readonly organizationHint?: string } = {},
    options?: RequestOptions,
  ): Promise<{ readonly redirectUrl: string }> {
    return this.#request(this.routes.auth.login, {
      ...options,
      method: "POST",
      body: input,
    });
  }

  developmentLogin(
    input: { readonly projectId?: string } = {},
    options?: RequestOptions,
  ): Promise<AuthSession> {
    return this.#request(this.routes.auth.developmentLogin, {
      ...options,
      method: "POST",
      body: input,
    });
  }

  refreshAuth(options?: RequestOptions): Promise<AuthSession> {
    return this.#request(this.routes.auth.refresh, {
      ...options,
      method: "POST",
    });
  }

  logout(options?: RequestOptions): Promise<AuthLogoutResult> {
    return this.#request(this.routes.auth.logout, {
      ...options,
      method: "POST",
    });
  }

  listOrganizations(
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Organization>> {
    return this.#request(
      this.#path(this.routes.organizations, pagination),
      options,
    );
  }

  getOrganization(
    organizationId: string,
    options?: RequestOptions,
  ): Promise<Organization> {
    return this.#request(this.routes.organization(organizationId), options);
  }

  listProjects(
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Project>> {
    return this.#request(this.#path(this.routes.projects, pagination), options);
  }

  getProject(projectId: string, options?: RequestOptions): Promise<Project> {
    return this.#request(this.routes.project(projectId), options);
  }

  listMembers(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Member>> {
    return this.#request(
      this.#path(this.routes.members(projectId), pagination),
      options,
    );
  }

  addMember(
    projectId: string,
    input: CreateProjectMemberInput,
    options: WriteOptions,
  ): Promise<Member> {
    return this.#write(this.routes.members(projectId), "POST", input, options);
  }

  updateMember(
    projectId: string,
    memberId: string,
    input: UpdateProjectMemberInput,
    options: WriteOptions,
  ): Promise<Member> {
    return this.#write(
      this.routes.member(projectId, memberId),
      "PATCH",
      input,
      options,
    );
  }

  removeMember(
    projectId: string,
    memberId: string,
    options: WriteOptions,
  ): Promise<void> {
    return this.#write(
      this.routes.member(projectId, memberId),
      "DELETE",
      undefined,
      options,
    );
  }

  listApiKeys(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<PlatformApiKey>> {
    return this.#request(
      this.#path(this.routes.apiKeys(projectId), pagination),
      options,
    );
  }

  createApiKey(
    projectId: string,
    input: { readonly name: string; readonly scopes: readonly string[] },
    options: WriteOptions,
  ): Promise<CreatedPlatformApiKey> {
    return this.#write(this.routes.apiKeys(projectId), "POST", input, options);
  }

  revokeApiKey(
    projectId: string,
    apiKeyId: string,
    options: WriteOptions,
  ): Promise<void> {
    return this.#write(
      this.routes.apiKey(projectId, apiKeyId),
      "DELETE",
      undefined,
      options,
    );
  }

  /** Lists deployment and project model presets an agent version may name. */
  listModelPresets(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<ModelPresetPage> {
    return this.#request(
      this.#path(this.routes.modelPresets(projectId), pagination),
      options,
    );
  }

  /** Lists the pinned model catalog a project provider preset may be built on. */
  listModelCatalog(
    projectId: string,
    query: {
      readonly providerId: string;
      readonly search?: string;
      readonly limit?: number;
    },
    options?: RequestOptions,
  ): Promise<ModelCatalogPage> {
    return this.#request(
      this.#path(this.routes.modelCatalog(projectId), query),
      options,
    );
  }

  listModelProviders(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<ProjectModelProvider>> {
    return this.#request(
      this.#path(this.routes.modelProviders(projectId), pagination),
      options,
    );
  }

  createModelProvider(
    projectId: string,
    input: CreateProjectModelProviderInput,
    options: WriteOptions,
  ): Promise<ProjectModelProvider> {
    return this.#write(
      this.routes.modelProviders(projectId),
      "POST",
      input,
      options,
    );
  }

  rotateModelProviderCredential(
    projectId: string,
    providerId: string,
    input: RotateProjectModelProviderCredentialInput,
    options: WriteOptions,
  ): Promise<ProjectModelProvider> {
    return this.#write(
      this.routes.modelProviderCredential(projectId, providerId),
      "PUT",
      input,
      options,
    );
  }

  listSandboxProviders(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<SandboxProviderPage> {
    return this.#request(
      this.#path(this.routes.sandboxProviders(projectId), pagination),
      options,
    );
  }

  listSandboxSnapshots(
    projectId: string,
    providerId: string,
    options?: RequestOptions,
  ): Promise<SandboxSnapshotList> {
    return this.#request(
      this.routes.sandboxProviderSnapshots(projectId, providerId),
      options,
    );
  }

  createSandboxProvider(
    projectId: string,
    input: CreateProjectSandboxProviderInput,
    options: WriteOptions,
  ): Promise<ProjectSandboxProvider> {
    return this.#write(
      this.routes.sandboxProviders(projectId),
      "POST",
      input,
      options,
    );
  }

  rotateSandboxProviderCredential(
    projectId: string,
    providerId: string,
    input: RotateProjectSandboxProviderCredentialInput,
    options: WriteOptions,
  ): Promise<ProjectSandboxProvider> {
    return this.#write(
      this.routes.sandboxProviderCredential(projectId, providerId),
      "PUT",
      input,
      options,
    );
  }

  listStorageProviders(
    projectId: string,
    options?: RequestOptions,
  ): Promise<StorageProviderList> {
    return this.#request(this.routes.storageProviders(projectId), options);
  }

  createStorageProvider(
    projectId: string,
    input: CreateProjectStorageProviderInput,
    options: WriteOptions,
  ): Promise<ProjectStorageProvider> {
    return this.#write(
      this.routes.storageProviders(projectId),
      "POST",
      input,
      options,
    );
  }

  rotateStorageProviderCredential(
    projectId: string,
    providerId: string,
    input: RotateProjectStorageProviderCredentialInput,
    options: WriteOptions,
  ): Promise<ProjectStorageProvider> {
    return this.#write(
      this.routes.storageProviderCredential(projectId, providerId),
      "PUT",
      input,
      options,
    );
  }

  setDefaultStorageProvider(
    projectId: string,
    providerId: string,
    options: WriteOptions,
  ): Promise<ProjectStorageProvider> {
    return this.#write(
      this.routes.defaultStorageProvider(projectId, providerId),
      "PUT",
      {},
      options,
    );
  }

  /** Lists objects and folder prefixes stored under a storage provider. */
  listStorageObjects(
    projectId: string,
    providerId: string,
    query: {
      readonly prefix?: string;
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
    options?: RequestOptions,
  ): Promise<StorageObjectList> {
    return this.#request(
      this.#path(
        this.routes.storageProviderObjects(projectId, providerId),
        query,
      ),
      options,
    );
  }

  updateSandboxProviderConfiguration(
    projectId: string,
    providerId: string,
    input: UpdateProjectSandboxProviderConfigurationInput,
    options: WriteOptions,
  ): Promise<ProjectSandboxProvider> {
    return this.#write(
      this.routes.sandboxProviderConfiguration(projectId, providerId),
      "PUT",
      input,
      options,
    );
  }

  createModelPreset(
    projectId: string,
    input: CreateModelPresetInput,
    options: WriteOptions,
  ): Promise<ModelPreset> {
    return this.#write(
      this.routes.modelPresets(projectId),
      "POST",
      input,
      options,
    );
  }

  listSkills(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<SkillSummary>> {
    return this.#request(
      this.#path(this.routes.skills(projectId), pagination),
      options,
    );
  }

  async listSkillDrafts(
    projectId: string,
    options?: RequestOptions,
  ): Promise<readonly SkillDraft[]> {
    const response = await this.#request<{
      readonly data: readonly SkillDraft[];
    }>(this.routes.skillDrafts(projectId), options);
    return response.data;
  }

  createSkillDraft(
    projectId: string,
    input: {
      readonly skillId?: string;
      readonly sourceSkillVersionId?: string;
    },
    options: WriteOptions,
  ): Promise<SkillDraft> {
    return this.#write(
      this.routes.skillDrafts(projectId),
      "POST",
      input,
      options,
    );
  }

  getSkillDraft(
    projectId: string,
    draftId: string,
    options?: RequestOptions,
  ): Promise<SkillDraft> {
    return this.#request(this.routes.skillDraft(projectId, draftId), options);
  }

  updateSkillDraft(
    projectId: string,
    draftId: string,
    input: UpdateSkillDraftInput,
    options: WriteOptions,
  ): Promise<SkillDraft> {
    return this.#write(
      this.routes.skillDraft(projectId, draftId),
      "PATCH",
      input,
      options,
    );
  }

  createSkillDraftDirectory(
    projectId: string,
    draftId: string,
    path: string,
    options: WriteOptions,
  ): Promise<SkillDraft> {
    return this.#write(
      this.routes.skillDraftDirectories(projectId, draftId),
      "POST",
      { path },
      options,
    );
  }

  putSkillDraftFile(
    projectId: string,
    draftId: string,
    input: {
      readonly path: string;
      readonly contentType?: "text/markdown";
      readonly dataBase64: string;
    },
    options: WriteOptions,
  ): Promise<SkillDraft> {
    return this.#write(
      this.routes.skillDraftFiles(projectId, draftId),
      "PUT",
      input,
      options,
    );
  }

  removeSkillDraftEntry(
    projectId: string,
    draftId: string,
    path: string,
    recursive: boolean,
    options: WriteOptions,
  ): Promise<SkillDraft> {
    const query = new URLSearchParams({ path, recursive: String(recursive) });
    return this.#write(
      `${this.routes.skillDraftEntries(projectId, draftId)}?${query.toString()}`,
      "DELETE",
      undefined,
      options,
    );
  }

  validateSkillDraft(
    projectId: string,
    draftId: string,
    options?: RequestOptions,
  ): Promise<SkillDraftValidation> {
    return this.#request(this.routes.validateSkillDraft(projectId, draftId), {
      ...options,
      method: "POST",
    });
  }

  publishSkillDraft(
    projectId: string,
    draftId: string,
    options: WriteOptions,
  ): Promise<{
    readonly skillId: string;
    readonly version: SkillVersionView;
  }> {
    return this.#write(
      this.routes.publishSkillDraft(projectId, draftId),
      "POST",
      {},
      options,
    );
  }

  discardSkillDraft(
    projectId: string,
    draftId: string,
    options: WriteOptions,
  ): Promise<{ readonly id: string; readonly status: "discarded" }> {
    return this.#write(
      this.routes.skillDraft(projectId, draftId),
      "DELETE",
      undefined,
      options,
    );
  }

  createSkill(
    projectId: string,
    input: CreateSkillInput,
    options: WriteOptions,
  ): Promise<SkillDetail> {
    return this.#write(this.routes.skills(projectId), "POST", input, options);
  }

  getSkill(
    projectId: string,
    skillId: string,
    options?: RequestOptions,
  ): Promise<SkillDetail> {
    return this.#request(this.routes.skill(projectId, skillId), options);
  }

  publishSkillVersion(
    projectId: string,
    skillId: string,
    input: PublishSkillVersionInput,
    options: WriteOptions,
  ): Promise<SkillVersionView> {
    return this.#write(
      this.routes.skillVersions(projectId, skillId),
      "POST",
      input,
      options,
    );
  }

  exportSkillVersion(
    projectId: string,
    skillId: string,
    versionId: string,
    options?: RequestOptions,
  ): Promise<SkillExport> {
    return this.#request(
      this.routes.skillVersionExport(projectId, skillId, versionId),
      options,
    );
  }

  updateSkillVersionLifecycle(
    projectId: string,
    skillId: string,
    versionId: string,
    status: "deprecated" | "revoked",
    options: WriteOptions,
  ): Promise<{ readonly skillVersionId: string; readonly status: string }> {
    return this.#write(
      this.routes.skillVersionLifecycle(projectId, skillId, versionId),
      "PATCH",
      { status },
      options,
    );
  }

  listMcpServers(
    projectId: string,
    options?: RequestOptions,
  ): Promise<McpServerList> {
    return this.#request(this.routes.mcpServers(projectId), options);
  }

  createMcpServer(
    projectId: string,
    input: CreateMcpServerInput,
    options: WriteOptions,
  ): Promise<McpServer> {
    return this.#write(
      this.routes.mcpServers(projectId),
      "POST",
      input,
      options,
    );
  }

  discoverMcpServer(
    projectId: string,
    serverId: string,
    input: DiscoverMcpServerInput,
    options: WriteOptions,
  ): Promise<McpServer> {
    return this.#write(
      this.routes.mcpServerDiscovery(projectId, serverId),
      "POST",
      input,
      options,
    );
  }

  listMcpCredentials(
    projectId: string,
    options?: RequestOptions,
  ): Promise<McpCredentialList> {
    return this.#request(this.routes.mcpCredentials(projectId), options);
  }

  createMcpCredential(
    projectId: string,
    input: CreateMcpCredentialInput,
    options: WriteOptions,
  ): Promise<McpCredential> {
    return this.#write(
      this.routes.mcpCredentials(projectId),
      "POST",
      input,
      options,
    );
  }

  rotateMcpCredential(
    projectId: string,
    credentialId: string,
    input: RotateMcpCredentialInput,
    options: WriteOptions,
  ): Promise<McpCredential> {
    return this.#write(
      this.routes.rotateMcpCredential(projectId, credentialId),
      "POST",
      input,
      options,
    );
  }

  revokeMcpCredential(
    projectId: string,
    credentialId: string,
    options: WriteOptions,
  ): Promise<McpCredential> {
    return this.#write(
      this.routes.mcpCredential(projectId, credentialId),
      "DELETE",
      undefined,
      options,
    );
  }

  listMcpCredentialPolicies(
    projectId: string,
    options?: RequestOptions,
  ): Promise<McpCredentialPolicyList> {
    return this.#request(this.routes.mcpCredentialPolicies(projectId), options);
  }

  createMcpCredentialPolicy(
    projectId: string,
    input: CreateMcpCredentialPolicyInput,
    options: WriteOptions,
  ): Promise<McpCredentialPolicy> {
    return this.#write(
      this.routes.mcpCredentialPolicies(projectId),
      "POST",
      input,
      options,
    );
  }

  listMcpToolsets(
    projectId: string,
    options?: RequestOptions,
  ): Promise<McpToolsetList> {
    return this.#request(this.routes.mcpToolsets(projectId), options);
  }

  createMcpToolset(
    projectId: string,
    input: CreateMcpToolsetInput,
    options: WriteOptions,
  ): Promise<McpToolset> {
    return this.#write(
      this.routes.mcpToolsets(projectId),
      "POST",
      input,
      options,
    );
  }

  listAgents(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<AgentDefinition>> {
    return this.#request(
      this.#path(this.routes.agents(projectId), pagination),
      options,
    );
  }

  createAgent(
    projectId: string,
    input: CreateAgentInput,
    options: WriteOptions,
  ): Promise<AgentDefinition> {
    return this.#write(this.routes.agents(projectId), "POST", input, options);
  }

  getAgent(
    projectId: string,
    agentId: string,
    options?: RequestOptions,
  ): Promise<AgentDefinition> {
    return this.#request(this.routes.agent(projectId, agentId), options);
  }

  publishAgentVersion(
    projectId: string,
    agentId: string,
    input: PublishAgentVersionInput,
    options: WriteOptions,
  ): Promise<AgentVersion> {
    return this.#write(
      this.routes.agentVersions(projectId, agentId),
      "POST",
      input,
      options,
    );
  }

  listAgentVersions(
    projectId: string,
    agentId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<AgentVersion>> {
    return this.#request(
      this.#path(this.routes.agentVersions(projectId, agentId), pagination),
      options,
    );
  }

  getAgentVersion(
    projectId: string,
    agentId: string,
    versionId: string,
    options?: RequestOptions,
  ): Promise<AgentVersion> {
    return this.#request(
      this.routes.agentVersion(projectId, agentId, versionId),
      options,
    );
  }

  listSessions(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Session>> {
    return this.#request(
      this.#path(this.routes.sessions(projectId), pagination),
      options,
    );
  }

  createSession(
    projectId: string,
    input: CreateSessionInput,
    options: WriteOptions,
  ): Promise<CreatedSession> {
    return this.#write(this.routes.sessions(projectId), "POST", input, options);
  }

  getSession(
    projectId: string,
    sessionId: string,
    options?: RequestOptions,
  ): Promise<Session> {
    return this.#request(this.routes.session(projectId, sessionId), options);
  }

  getDelegation(
    projectId: string,
    delegationId: string,
    options?: RequestOptions,
  ): Promise<AgentDelegation> {
    return this.#request(
      this.routes.delegation(projectId, delegationId),
      options,
    );
  }

  messageDelegation(
    projectId: string,
    delegationId: string,
    message: string,
    options: WriteOptions,
  ): Promise<DelegationMessageResult> {
    return this.#write(
      this.routes.delegationMessages(projectId, delegationId),
      "POST",
      { message },
      options,
    );
  }

  cancelDelegation(
    projectId: string,
    delegationId: string,
    options: WriteOptions,
  ): Promise<{ readonly delegationId: string; readonly state: "cancelled" }> {
    return this.#write(
      this.routes.cancelDelegation(projectId, delegationId),
      "POST",
      {},
      options,
    );
  }

  listThreads(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Thread>> {
    return this.#request(
      this.#path(this.routes.threads(projectId), pagination),
      options,
    );
  }

  getThread(
    projectId: string,
    threadId: string,
    options?: RequestOptions,
  ): Promise<Thread> {
    return this.#request(this.routes.thread(projectId, threadId), options);
  }

  listRuns(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Run>> {
    return this.#request(
      this.#path(this.routes.runs(projectId), pagination),
      options,
    );
  }

  submitRun(
    projectId: string,
    sessionId: string,
    input: RunInput,
    options: WriteOptions,
  ): Promise<Run> {
    return this.#write(
      this.routes.sessionRuns(projectId, sessionId),
      "POST",
      input,
      options,
    );
  }

  resumeRun(
    projectId: string,
    runId: string,
    input: RunInput,
    options: WriteOptions,
  ): Promise<Run> {
    return this.#write(
      this.routes.resumeRun(projectId, runId),
      "POST",
      input,
      options,
    );
  }

  getRun(
    projectId: string,
    runId: string,
    options?: RequestOptions,
  ): Promise<Run> {
    return this.#request(this.routes.run(projectId, runId), options);
  }

  cancelRun(
    projectId: string,
    runId: string,
    options: WriteOptions,
  ): Promise<Run> {
    return this.#write(
      this.routes.cancelRun(projectId, runId),
      "POST",
      {},
      options,
    );
  }

  listRunMessages(
    projectId: string,
    runId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<Message>> {
    return this.#request(
      this.#path(this.routes.runMessages(projectId, runId), pagination),
      options,
    );
  }

  listRunTimeline(
    projectId: string,
    runId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<RunTimelineEntry>> {
    return this.#request(
      this.#path(this.routes.runTimeline(projectId, runId), pagination),
      options,
    );
  }

  listToolCalls(
    projectId: string,
    pagination: PaginationOptions & { readonly runId?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<ToolCall>> {
    return this.#request(
      this.#path(this.routes.toolCalls(projectId), pagination),
      options,
    );
  }

  claimToolCall(
    projectId: string,
    toolCallId: string,
    input: { readonly leaseMs: number },
    options: WriteOptions,
  ): Promise<ToolClaim> {
    return this.#write(
      this.routes.claimToolCall(projectId, toolCallId),
      "POST",
      input,
      options,
    );
  }

  renewToolCall(
    projectId: string,
    toolCallId: string,
    input: { readonly fence: string; readonly leaseMs: number },
    options: WriteOptions,
  ): Promise<ToolClaim> {
    return this.#write(
      this.routes.renewToolCall(projectId, toolCallId),
      "POST",
      input,
      options,
    );
  }

  releaseToolCall(
    projectId: string,
    toolCallId: string,
    input: { readonly fence: string },
    options: WriteOptions,
  ): Promise<ToolClaim> {
    return this.#write(
      this.routes.releaseToolCall(projectId, toolCallId),
      "POST",
      input,
      options,
    );
  }

  submitToolResult(
    projectId: string,
    toolCallId: string,
    input: {
      readonly fence: string;
      readonly safeResult: ToolResultEnvelope;
    },
    options: WriteOptions,
  ): Promise<ToolResultSubmission> {
    return this.#write(
      this.routes.submitToolResult(projectId, toolCallId),
      "POST",
      input,
      options,
    );
  }

  listApprovals(
    projectId: string,
    pagination: PaginationOptions & { readonly runId?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<Approval>> {
    return this.#request(
      this.#path(this.routes.approvals(projectId), pagination),
      options,
    );
  }

  decideApproval(
    projectId: string,
    approvalId: string,
    input: { readonly status: "approved" | "denied"; readonly note?: string },
    options: WriteOptions,
  ): Promise<Approval> {
    return this.#write(
      this.routes.decideApproval(projectId, approvalId),
      "POST",
      input,
      options,
    );
  }

  listAuditEntries(
    projectId: string,
    pagination: PaginationOptions = {},
    options?: RequestOptions,
  ): Promise<Page<AuditEntry>> {
    return this.#request(
      this.#path(this.routes.audit(projectId), pagination),
      options,
    );
  }

  exportAudit(
    projectId: string,
    input: { readonly from?: string; readonly to?: string } = {},
    options: WriteOptions,
  ): Promise<AuditExport> {
    return this.#write(
      this.routes.auditExport(projectId),
      "POST",
      input,
      options,
    );
  }

  async *streamProjectEvents(
    projectId: string,
    options: ProjectEventStreamOptions = {},
  ): AsyncGenerator<ProjectEventFrame> {
    let lastEventId = options.lastEventId;
    let reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    do {
      throwIfAborted(options.signal);
      const headers = await this.#requestHeaders({
        accept: "text/event-stream",
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      });
      const response = await this.#fetch(
        this.#url(this.routes.events(projectId)),
        {
          method: "GET",
          headers,
          credentials: this.#credentials,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      if (!response.ok) await this.#throwResponseError(response);
      if (response.body === null) {
        throw new OaoApiError(
          response.status,
          "invalid_response",
          "SSE response has no body",
        );
      }
      for await (const frame of parseEventStream(response.body)) {
        if (frame.retry !== undefined) reconnectDelayMs = frame.retry;
        if (frame.id !== undefined) lastEventId = frame.id;
        let data: ProductEvent;
        try {
          data = JSON.parse(frame.data) as ProductEvent;
        } catch {
          throw new OaoApiError(
            response.status,
            "invalid_response",
            "SSE event contained invalid JSON",
          );
        }
        yield {
          id: frame.id ?? lastEventId ?? "",
          event: frame.event ?? "message",
          data,
        };
      }
      if (options.reconnect === false) return;
      await abortableDelay(reconnectDelayMs, options.signal);
    } while (true);
  }

  async #write<T>(
    path: string,
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    body: unknown,
    options: WriteOptions,
  ): Promise<T> {
    if (options.idempotencyKey.trim().length === 0) {
      throw new TypeError("idempotencyKey must not be empty");
    }
    return this.#request(path, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      method,
      body,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async #request<T>(
    path: string,
    options: InternalRequestOptions = {},
  ): Promise<T> {
    const headers = await this.#requestHeaders({
      accept: "application/json",
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { "idempotency-key": options.idempotencyKey }),
      ...options.headers,
    });
    const response = await this.#fetch(this.#url(path), {
      method: options.method ?? "GET",
      headers,
      credentials: this.#credentials,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) await this.#throwResponseError(response);
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new OaoApiError(
        response.status,
        "invalid_response",
        "API response was not JSON",
        response.headers.get("x-request-id") ?? undefined,
      );
    }
    return (await response.json()) as T;
  }

  async #throwResponseError(response: Response): Promise<never> {
    let envelope:
      | {
          readonly error?: {
            readonly code?: string;
            readonly message?: string;
            readonly requestId?: string;
            readonly details?: Readonly<Record<string, unknown>>;
          };
        }
      | undefined;
    if (
      (response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      try {
        envelope = (await response.json()) as typeof envelope;
      } catch {
        envelope = undefined;
      }
    }
    const requestId =
      envelope?.error?.requestId ??
      response.headers.get("x-request-id") ??
      undefined;
    throw new OaoApiError(
      response.status,
      envelope?.error?.code ?? "http_error",
      envelope?.error?.message ??
        `API request failed with status ${response.status}`,
      requestId,
      envelope?.error?.details,
    );
  }

  async #requestHeaders(
    requestHeaders: Readonly<Record<string, string>>,
  ): Promise<Headers> {
    const headers = new Headers(this.#headers);
    for (const [key, value] of Object.entries(requestHeaders))
      headers.set(key, value);
    const bearerToken = await resolveCredential(this.#bearerToken);
    const apiKey = await resolveCredential(this.#apiKey);
    if (bearerToken !== undefined && apiKey !== undefined) {
      throw new TypeError("Configure either bearerToken or apiKey, not both");
    }
    if (bearerToken !== undefined)
      headers.set("authorization", `Bearer ${bearerToken}`);
    if (apiKey !== undefined) headers.set("authorization", `Bearer ${apiKey}`);
    return headers;
  }

  #path(path: string, query: object): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const encoded = params.toString();
    return encoded.length === 0 ? path : `${path}?${encoded}`;
  }

  #url(path: string, query?: object): string {
    return `${this.#baseUrl}${query === undefined ? path : this.#path(path, query)}`;
  }
}

async function resolveCredential(
  credential: Credential | undefined,
): Promise<string | undefined> {
  const value =
    typeof credential === "function" ? await credential() : credential;
  return value === undefined || value.length === 0 ? undefined : value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  }
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError"),
        );
      },
      { once: true },
    );
  });
}

export type { AgentToolInput, SandboxPolicyInput };
