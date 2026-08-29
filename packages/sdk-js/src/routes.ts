function segment(value: string): string {
  if (value.length === 0)
    throw new TypeError("Route identifier must not be empty");
  return encodeURIComponent(value);
}

function prefixPath(prefix: string): string {
  if (prefix === "" || prefix === "/") return "";
  return `/${prefix.replace(/^\/+|\/+$/gu, "")}`;
}

export function createRoutes(apiPrefix = "/v1") {
  const api = prefixPath(apiPrefix);
  const project = (projectId: string) =>
    `${api}/projects/${segment(projectId)}`;
  const run = (projectId: string, runId: string) =>
    `${project(projectId)}/runs/${segment(runId)}`;
  const toolCall = (projectId: string, toolCallId: string) =>
    `${project(projectId)}/tool-calls/${segment(toolCallId)}`;
  const approval = (projectId: string, approvalId: string) =>
    `${project(projectId)}/approvals/${segment(approvalId)}`;
  const delegation = (projectId: string, delegationId: string) =>
    `${project(projectId)}/delegations/${segment(delegationId)}`;

  return {
    health: "/healthz",
    readiness: "/readyz",
    context: `${api}/context`,
    auth: {
      login: `${api}/auth/login`,
      callback: `${api}/auth/callback`,
      refresh: `${api}/auth/refresh`,
      logout: `${api}/auth/logout`,
      developmentLogin: `${api}/auth/development/login`,
    },
    organizations: `${api}/organizations`,
    organization: (organizationId: string) =>
      `${api}/organizations/${segment(organizationId)}`,
    projects: `${api}/projects`,
    project,
    members: (projectId: string) => `${project(projectId)}/members`,
    member: (projectId: string, memberId: string) =>
      `${project(projectId)}/members/${segment(memberId)}`,
    apiKeys: (projectId: string) => `${project(projectId)}/api-keys`,
    apiKey: (projectId: string, apiKeyId: string) =>
      `${project(projectId)}/api-keys/${segment(apiKeyId)}`,
    modelPresets: (projectId: string) => `${project(projectId)}/model-presets`,
    modelPreset: (projectId: string, presetId: string) =>
      `${project(projectId)}/model-presets/${segment(presetId)}`,
    modelProviders: (projectId: string) =>
      `${project(projectId)}/model-providers`,
    modelProvider: (projectId: string, providerId: string) =>
      `${project(projectId)}/model-providers/${segment(providerId)}`,
    modelProviderCredential: (projectId: string, providerId: string) =>
      `${project(projectId)}/model-providers/${segment(providerId)}/credential`,
    sandboxProviders: (projectId: string) =>
      `${project(projectId)}/sandbox-providers`,
    sandboxProviderCredential: (projectId: string, providerId: string) =>
      `${project(projectId)}/sandbox-providers/${segment(providerId)}/credential`,
    sandboxProviderConfiguration: (projectId: string, providerId: string) =>
      `${project(projectId)}/sandbox-providers/${segment(providerId)}/configuration`,
    sandboxProviderSnapshots: (projectId: string, providerId: string) =>
      `${project(projectId)}/sandbox-providers/${segment(providerId)}/snapshots`,
    storageProviders: (projectId: string) =>
      `${project(projectId)}/storage-providers`,
    storageProviderCredential: (projectId: string, providerId: string) =>
      `${project(projectId)}/storage-providers/${segment(providerId)}/credential`,
    defaultStorageProvider: (projectId: string, providerId: string) =>
      `${project(projectId)}/storage-providers/${segment(providerId)}/default`,
    storageProviderObjects: (projectId: string, providerId: string) =>
      `${project(projectId)}/storage-providers/${segment(providerId)}/objects`,
    modelCatalog: (projectId: string) => `${project(projectId)}/model-catalog`,
    skills: (projectId: string) => `${project(projectId)}/skills`,
    skillDrafts: (projectId: string) => `${project(projectId)}/skill-drafts`,
    skillDraft: (projectId: string, draftId: string) =>
      `${project(projectId)}/skill-drafts/${segment(draftId)}`,
    skillDraftDirectories: (projectId: string, draftId: string) =>
      `${project(projectId)}/skill-drafts/${segment(draftId)}/directories`,
    skillDraftFiles: (projectId: string, draftId: string) =>
      `${project(projectId)}/skill-drafts/${segment(draftId)}/files`,
    skillDraftEntries: (projectId: string, draftId: string) =>
      `${project(projectId)}/skill-drafts/${segment(draftId)}/entries`,
    validateSkillDraft: (projectId: string, draftId: string) =>
      `${project(projectId)}/skill-drafts/${segment(draftId)}/validate`,
    publishSkillDraft: (projectId: string, draftId: string) =>
      `${project(projectId)}/skill-drafts/${segment(draftId)}/publish`,
    skill: (projectId: string, skillId: string) =>
      `${project(projectId)}/skills/${segment(skillId)}`,
    skillVersions: (projectId: string, skillId: string) =>
      `${project(projectId)}/skills/${segment(skillId)}/versions`,
    skillVersionExport: (
      projectId: string,
      skillId: string,
      versionId: string,
    ) =>
      `${project(projectId)}/skills/${segment(skillId)}/versions/${segment(versionId)}/export`,
    skillVersionLifecycle: (
      projectId: string,
      skillId: string,
      versionId: string,
    ) =>
      `${project(projectId)}/skills/${segment(skillId)}/versions/${segment(versionId)}/lifecycle`,
    mcpServers: (projectId: string) => `${project(projectId)}/mcp-servers`,
    mcpServerDiscovery: (projectId: string, serverId: string) =>
      `${project(projectId)}/mcp-servers/${segment(serverId)}/discover`,
    mcpCredentials: (projectId: string) =>
      `${project(projectId)}/mcp-credentials`,
    mcpCredential: (projectId: string, credentialId: string) =>
      `${project(projectId)}/mcp-credentials/${segment(credentialId)}`,
    rotateMcpCredential: (projectId: string, credentialId: string) =>
      `${project(projectId)}/mcp-credentials/${segment(credentialId)}/rotate`,
    mcpCredentialPolicies: (projectId: string) =>
      `${project(projectId)}/mcp-credential-policies`,
    mcpToolsets: (projectId: string) => `${project(projectId)}/mcp-toolsets`,
    agents: (projectId: string) => `${project(projectId)}/agents`,
    agent: (projectId: string, agentId: string) =>
      `${project(projectId)}/agents/${segment(agentId)}`,
    agentVersions: (projectId: string, agentId: string) =>
      `${project(projectId)}/agents/${segment(agentId)}/versions`,
    agentVersion: (projectId: string, agentId: string, versionId: string) =>
      `${project(projectId)}/agents/${segment(agentId)}/versions/${segment(versionId)}`,
    sessions: (projectId: string) => `${project(projectId)}/sessions`,
    session: (projectId: string, sessionId: string) =>
      `${project(projectId)}/sessions/${segment(sessionId)}`,
    sessionRuns: (projectId: string, sessionId: string) =>
      `${project(projectId)}/sessions/${segment(sessionId)}/runs`,
    delegation,
    delegationMessages: (projectId: string, delegationId: string) =>
      `${delegation(projectId, delegationId)}/messages`,
    cancelDelegation: (projectId: string, delegationId: string) =>
      `${delegation(projectId, delegationId)}/cancel`,
    threads: (projectId: string) => `${project(projectId)}/threads`,
    thread: (projectId: string, threadId: string) =>
      `${project(projectId)}/threads/${segment(threadId)}`,
    runs: (projectId: string) => `${project(projectId)}/runs`,
    run,
    resumeRun: (projectId: string, runId: string) =>
      `${run(projectId, runId)}/resume`,
    cancelRun: (projectId: string, runId: string) =>
      `${run(projectId, runId)}/cancel`,
    runMessages: (projectId: string, runId: string) =>
      `${run(projectId, runId)}/messages`,
    runTimeline: (projectId: string, runId: string) =>
      `${run(projectId, runId)}/timeline`,
    toolCalls: (projectId: string) => `${project(projectId)}/tool-calls`,
    toolCall,
    claimToolCall: (projectId: string, toolCallId: string) =>
      `${toolCall(projectId, toolCallId)}/claim`,
    renewToolCall: (projectId: string, toolCallId: string) =>
      `${toolCall(projectId, toolCallId)}/renew`,
    releaseToolCall: (projectId: string, toolCallId: string) =>
      `${toolCall(projectId, toolCallId)}/release`,
    submitToolResult: (projectId: string, toolCallId: string) =>
      `${toolCall(projectId, toolCallId)}/result`,
    approvals: (projectId: string) => `${project(projectId)}/approvals`,
    approval,
    decideApproval: (projectId: string, approvalId: string) =>
      `${approval(projectId, approvalId)}/decision`,
    events: (projectId: string) => `${project(projectId)}/events`,
    audit: (projectId: string) => `${project(projectId)}/audit`,
    auditExport: (projectId: string) => `${project(projectId)}/audit/export`,
  } as const;
}

export type Routes = ReturnType<typeof createRoutes>;
export const routes = createRoutes();
