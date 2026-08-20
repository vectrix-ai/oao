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

  return {
    health: "/healthz",
    readiness: "/readyz",
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
