import type { ProductEvent } from "@oao/contracts";
import type {
  AgentDetail,
  AgentSummary,
  AgentVersionConfig,
  ConsoleApi,
  EventConnection,
  ListFilters,
  PageResult,
  PendingWork,
  SessionDetail,
  SettingsData,
} from "./types";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const principalId = "33333333-3333-4333-8333-333333333333";

const supportConfig: AgentVersionConfig = {
  systemInstructions:
    "You are a careful support operations agent. Verify the customer and summarize only the information needed to resolve the request. Never disclose secrets or internal reasoning.",
  modelPreset: "balanced-reasoning-v2",
  tools: [
    {
      id: "tool-lookup",
      name: "lookup_customer",
      description: "Find a customer record by a safe external identifier.",
      owner: "platform",
      approval: "never",
      inputSchema:
        '{\n  "type": "object",\n  "properties": { "customer_ref": { "type": "string" } },\n  "required": ["customer_ref"]\n}',
    },
    {
      id: "tool-refund",
      name: "issue_refund",
      description:
        "Request a refund through the caller-owned billing workflow.",
      owner: "caller",
      approval: "always",
      inputSchema:
        '{\n  "type": "object",\n  "properties": { "amount": { "type": "number" }, "currency": { "type": "string" } },\n  "required": ["amount", "currency"]\n}',
    },
  ],
  sandbox: {
    enabled: true,
    target: "local",
    timeoutSeconds: 300,
    networkPolicy: "restricted",
  },
};

const agentsSeed: AgentDetail[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Support operator",
    key: "support-operator",
    description:
      "Resolves customer requests with approval-gated billing actions.",
    model: "Balanced reasoning v2",
    status: "published",
    version: 3,
    createdAt: "2026-08-12T08:40:00.000Z",
    updatedAt: "2026-08-20T07:18:00.000Z",
    versions: [
      {
        id: "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        version: 3,
        contentHash: "8fd2e5d2bfe74a12",
        createdAt: "2026-08-20T07:18:00.000Z",
        createdBy: "Demo Operator",
        config: supportConfig,
      },
      {
        id: "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        version: 2,
        contentHash: "e2804314b2df993d",
        createdAt: "2026-08-17T16:04:00.000Z",
        createdBy: "Demo Operator",
        config: { ...supportConfig, modelPreset: "fast-routing-v1" },
      },
      {
        id: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        version: 1,
        contentHash: "f827b8f782e0396c",
        createdAt: "2026-08-12T08:40:00.000Z",
        createdBy: "Demo Operator",
        config: { ...supportConfig, tools: supportConfig.tools.slice(0, 1) },
      },
    ],
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Document analyst",
    key: "document-analyst",
    description: "Extracts structured facts from uploaded documents.",
    model: "Long context v1",
    status: "published",
    version: 5,
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-19T15:42:00.000Z",
    versions: [
      {
        id: "bbbbbbb5-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        version: 5,
        contentHash: "9c9dd72a233c0b85",
        createdAt: "2026-08-19T15:42:00.000Z",
        createdBy: "Maya Chen",
        config: {
          ...supportConfig,
          systemInstructions:
            "Extract verifiable facts from provided documents. Cite the source page. Do not infer missing values.",
          modelPreset: "long-context-v1",
          tools: [],
        },
      },
    ],
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    name: "Order triage",
    key: "order-triage",
    description: "Classifies incoming orders and routes exceptions.",
    model: "Fast routing v1",
    status: "draft",
    version: 1,
    createdAt: "2026-08-19T09:12:00.000Z",
    updatedAt: "2026-08-19T09:12:00.000Z",
    versions: [
      {
        id: "ccccccc1-cccc-4ccc-8ccc-cccccccccccc",
        version: 1,
        contentHash: "15302b77e958df18",
        createdAt: "2026-08-19T09:12:00.000Z",
        createdBy: "Demo Operator",
        config: {
          ...supportConfig,
          systemInstructions:
            "Classify incoming orders into standard, exception, or needs review.",
          modelPreset: "fast-routing-v1",
        },
      },
    ],
  },
];

const sessionsSeed: SessionDetail[] = [
  {
    id: "session_01J5QTXE7W9M2R6C4A8K3N1P0V",
    title: "Refund request · Northwind #4831",
    status: "waiting_for_approval",
    agentId: agentsSeed[0]!.id,
    agentName: agentsSeed[0]!.name,
    inputTokens: 2841,
    outputTokens: 612,
    observedCostUsd: 0.0184,
    costProvenance: "provider_observed",
    createdAt: "2026-08-20T07:02:10.000Z",
    lastActivityAt: "2026-08-20T07:05:44.000Z",
    runId: "run_01J5QV1FPZ19TR2D7QXG8B0N6K",
    agentVersion: 3,
    startedAt: "2026-08-20T07:02:11.000Z",
    completedAt: null,
    attempt: 1,
    capabilities: { canCancel: true, canResume: false, canBranchReplay: false },
    events: [
      {
        id: "event-user-1",
        kind: "user",
        title: "User",
        summary:
          "Customer Northwind #4831 says the expedited shipment was charged twice. Verify the account and prepare the appropriate refund.",
        createdAt: "2026-08-20T07:02:11.000Z",
        durationMs: null,
        status: "success",
      },
      {
        id: "event-model-1",
        kind: "assistant",
        title: "Assistant",
        summary:
          "I’ll verify the customer and the duplicate charge before preparing a refund request.",
        createdAt: "2026-08-20T07:02:13.000Z",
        durationMs: 1840,
        status: "success",
        tokens: { input: 1204, output: 91 },
        costUsd: 0.0061,
      },
      {
        id: "event-tool-1",
        kind: "tool",
        title: "lookup_customer",
        summary: "Customer record and two matching charges found.",
        createdAt: "2026-08-20T07:02:16.000Z",
        durationMs: 482,
        status: "success",
        payload: {
          rendered: {
            customer_ref: "NW-4831",
            result: "2 matching charges",
            account_status: "active",
          },
          raw: '{"customer_ref":"NW-4831","result":"2 matching charges","account_status":"active"}',
          redacted: false,
        },
      },
      {
        id: "event-error-1",
        kind: "error",
        title: "Provider request failed",
        summary:
          "Transient upstream timeout. The run remained durable and was scheduled for recovery.",
        createdAt: "2026-08-20T07:02:21.000Z",
        durationMs: 10_004,
        status: "error",
        payload: {
          rendered: {
            code: "upstream_timeout",
            retryable: true,
            authorization: "[REDACTED]",
          },
          raw: null,
          redacted: true,
          redactionReason:
            "Authorization and provider payload are not retained in the public event stream.",
        },
      },
      {
        id: "event-retry-1",
        kind: "retry",
        title: "Attempt 2",
        summary: "Recovered from the durable checkpoint after 2.0 seconds.",
        createdAt: "2026-08-20T07:02:33.000Z",
        durationMs: 2010,
        status: "info",
      },
      {
        id: "event-approval-1",
        kind: "approval",
        title: "Refund approval requested",
        summary: "Approve a USD 84.50 refund to the original payment method.",
        createdAt: "2026-08-20T07:05:44.000Z",
        durationMs: null,
        status: "pending",
        payload: {
          rendered: {
            amount: 84.5,
            currency: "USD",
            destination: "original payment method",
          },
          raw: null,
          redacted: true,
          redactionReason:
            "Sensitive payment identifiers are available only to the authorized caller workflow.",
        },
      },
    ],
  },
  {
    id: "session_01J5PDRS7WZTP4H3F6M2A9B8CX",
    title: "Q3 contract extraction",
    status: "completed",
    agentId: agentsSeed[1]!.id,
    agentName: agentsSeed[1]!.name,
    inputTokens: 12941,
    outputTokens: 1833,
    observedCostUsd: 0.1042,
    costProvenance: "provider_observed",
    createdAt: "2026-08-19T14:20:00.000Z",
    lastActivityAt: "2026-08-19T14:24:38.000Z",
    runId: "run_01J5PDS4BR20P60BMSAT00W8PV",
    agentVersion: 5,
    startedAt: "2026-08-19T14:20:01.000Z",
    completedAt: "2026-08-19T14:24:38.000Z",
    attempt: 1,
    capabilities: { canCancel: false, canResume: false, canBranchReplay: true },
    events: [
      {
        id: "event-user-2",
        kind: "user",
        title: "User",
        summary:
          "Extract renewal dates, notice periods, and contracting entities from the uploaded Q3 agreements.",
        createdAt: "2026-08-19T14:20:01.000Z",
        durationMs: null,
        status: "success",
      },
      {
        id: "event-tool-2",
        kind: "tool",
        title: "sandbox.read_documents",
        summary: "Read 14 source documents in the isolated sandbox.",
        createdAt: "2026-08-19T14:20:05.000Z",
        durationMs: 137442,
        status: "success",
        payload: {
          rendered: { document_count: 14, pages: 186 },
          raw: null,
          redacted: true,
          redactionReason:
            "Document contents are retained inside the sandbox and artifact boundary.",
        },
      },
      {
        id: "event-assistant-2",
        kind: "assistant",
        title: "Assistant",
        summary:
          "Extracted 14 agreements. Two renewal dates require human review because the source scans are ambiguous.",
        createdAt: "2026-08-19T14:24:38.000Z",
        durationMs: 8341,
        status: "success",
        tokens: { input: 12941, output: 1833 },
        costUsd: 0.1042,
      },
    ],
  },
  {
    id: "session_01J5NZ9MZW5F2XVZ6QAYXG1C7E",
    title: "Inbound order batch 1182",
    status: "failed",
    agentId: agentsSeed[2]!.id,
    agentName: agentsSeed[2]!.name,
    inputTokens: 920,
    outputTokens: 0,
    observedCostUsd: null,
    costProvenance: "unavailable",
    createdAt: "2026-08-18T11:08:00.000Z",
    lastActivityAt: "2026-08-18T11:08:15.000Z",
    runId: "run_01J5NZAD4Z3HDBN4P8WCFJ7TQS",
    agentVersion: 1,
    startedAt: "2026-08-18T11:08:01.000Z",
    completedAt: "2026-08-18T11:08:15.000Z",
    attempt: 3,
    capabilities: { canCancel: false, canResume: true, canBranchReplay: true },
    events: [
      {
        id: "event-error-3",
        kind: "error",
        title: "Sandbox unavailable",
        summary:
          "The configured sandbox adapter did not become ready before the deadline.",
        createdAt: "2026-08-18T11:08:15.000Z",
        durationMs: 14002,
        status: "error",
        payload: {
          rendered: { code: "sandbox_start_timeout", retryable: true },
          raw: null,
          redacted: true,
          redactionReason:
            "Provider diagnostics were reduced to a safe public error.",
        },
      },
    ],
  },
];

const pendingSeed: PendingWork[] = [
  {
    kind: "approval",
    id: "approval_01J5QV18P0K28X9BG74P5N6M3C",
    runId: sessionsSeed[0]!.runId,
    sessionId: sessionsSeed[0]!.id,
    title: sessionsSeed[0]!.title,
    summary: "Refund USD 84.50 to the original payment method",
    status: "pending",
    createdAt: "2026-08-20T07:05:44.000Z",
    expiresAt: "2026-08-21T07:05:44.000Z",
  },
  {
    kind: "tool",
    id: "toolcall_01J5QWX7K4X2Y0CVB8T9AN13HF",
    runId: "run_01J5QWVXBT7Q4K9D86T2CG1N5M",
    sessionId: "session_01J5QWVZ43W6R1T8P0B9CMX2NK",
    title: "Freight quote · Rotterdam → Ghent",
    toolName: "request_carrier_quote",
    stage: "caller_pending",
    safeArguments: {
      origin: "Rotterdam",
      destination: "Ghent",
      pallets: 6,
      temperature_controlled: false,
    },
    claimedBy: null,
    claimFence: "0",
    createdAt: "2026-08-20T06:44:20.000Z",
    expiresAt: "2026-08-20T08:44:20.000Z",
  },
];

const settingsSeed: SettingsData = {
  organization: {
    name: "Example operations",
    slug: "example-operations",
    createdAt: "2026-07-14T09:00:00.000Z",
  },
  projects: [
    { id: PROJECT_ID, name: "Managed agents", slug: "managed-agents" },
    {
      id: "23232323-2323-4232-8232-232323232323",
      name: "Evaluation lab",
      slug: "evaluation-lab",
    },
  ],
  members: [
    {
      id: principalId,
      name: "Demo Operator",
      email: "demo.operator@example.test",
      role: "owner",
    },
    {
      id: "34343434-3434-4343-8343-343434343434",
      name: "Review Operator",
      email: "review.operator@example.test",
      role: "operator",
    },
  ],
  apiKeys: [
    {
      id: "key_1",
      name: "Local integration",
      prefix: "oao_local_…c72f",
      scopes: ["agents:read", "sessions:write"],
      lastUsedAt: "2026-08-20T06:51:00.000Z",
    },
  ],
  hosting: [
    {
      service: "API",
      status: "operational",
      region: "local",
      latencyMs: 18,
      checkedAt: "2026-08-20T07:10:00.000Z",
    },
    {
      service: "Runtime worker",
      status: "operational",
      region: "local",
      latencyMs: 24,
      checkedAt: "2026-08-20T07:10:00.000Z",
    },
    {
      service: "PostgreSQL",
      status: "operational",
      region: "local",
      latencyMs: 4,
      checkedAt: "2026-08-20T07:10:00.000Z",
    },
    {
      service: "Sandbox adapter",
      status: "degraded",
      region: "local fake",
      latencyMs: null,
      checkedAt: "2026-08-20T07:10:00.000Z",
    },
  ],
};

export interface DemoApiOptions {
  readonly scenario?: "default" | "empty" | "error";
  readonly eventDelayMs?: number;
}

export class DemoConsoleApi implements ConsoleApi {
  #agents = structuredClone(agentsSeed);
  #sessions = structuredClone(sessionsSeed);
  #pending = structuredClone(pendingSeed);
  #counter = 0;
  readonly #options: DemoApiOptions;

  constructor(options: DemoApiOptions = {}) {
    this.#options = options;
  }

  #guard(): void {
    if (this.#options.scenario === "error")
      throw new Error("The demo service is temporarily unavailable.");
  }

  #page<T>(data: readonly T[], page = 1): PageResult<T> {
    const pageSize = 10;
    return {
      data: data.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: data.length,
    };
  }

  #filter<T extends { readonly status: string; readonly createdAt: string }>(
    data: readonly T[],
    filters: ListFilters,
    searchable: (item: T) => string,
  ): T[] {
    const term = filters.search?.toLowerCase().trim();
    return data.filter(
      (item) =>
        (!term || searchable(item).toLowerCase().includes(term)) &&
        (!filters.status || item.status === filters.status) &&
        (!filters.date || item.createdAt.slice(0, 10) === filters.date),
    );
  }

  async getContext() {
    return {
      organization: { id: ORG_ID, name: "Example operations" },
      project: { id: PROJECT_ID, name: "Managed agents" },
      currentPrincipal: {
        displayName: "Demo Operator",
        role: "Platform Owner",
      },
      organizations: [{ id: ORG_ID, name: "Example operations" }],
      projects: [
        { id: PROJECT_ID, name: "Managed agents" },
        { id: settingsSeed.projects[1]!.id, name: "Evaluation lab" },
      ],
    };
  }

  async listAgents(filters: ListFilters) {
    this.#guard();
    const data =
      this.#options.scenario === "empty"
        ? []
        : this.#filter(
            this.#agents,
            filters,
            (item) =>
              `${item.name} ${item.key} ${item.description} ${item.model}`,
          );
    return this.#page(data, filters.page);
  }

  async getAgent(id: string) {
    this.#guard();
    const value = this.#agents.find((agent) => agent.id === id);
    if (!value) throw new Error("Agent not found");
    return structuredClone(value);
  }

  async createAgent(input: {
    readonly name: string;
    readonly description: string;
  }): Promise<AgentSummary> {
    this.#counter += 1;
    const now = new Date().toISOString();
    const id = `dddddddd-dddd-4ddd-8ddd-${String(this.#counter).padStart(12, "0")}`;
    const config = { ...supportConfig, tools: [] };
    const detail: AgentDetail = {
      id,
      name: input.name,
      key: input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, ""),
      description: input.description,
      model: "Balanced reasoning v2",
      status: "draft",
      version: 1,
      createdAt: now,
      updatedAt: now,
      versions: [
        {
          id: `eeeeeeee-eeee-4eee-8eee-${String(this.#counter).padStart(12, "0")}`,
          version: 1,
          contentHash: "draft00000000000",
          createdAt: now,
          createdBy: "Demo Operator",
          config,
        },
      ],
    };
    this.#agents.unshift(detail);
    return detail;
  }

  async publishAgentVersion(id: string, config: AgentVersionConfig) {
    const agent = this.#agents.find((item) => item.id === id);
    if (!agent) throw new Error("Agent not found");
    const version = agent.version + 1;
    const now = new Date().toISOString();
    const updated: AgentDetail = {
      ...agent,
      status: "published",
      version,
      updatedAt: now,
      model: config.modelPreset,
      versions: [
        {
          id: `version-${version}`,
          version,
          contentHash: `demo${String(version).padStart(12, "0")}`,
          createdAt: now,
          createdBy: "Demo Operator",
          config,
        },
        ...agent.versions,
      ],
    };
    this.#agents = this.#agents.map((item) =>
      item.id === id ? updated : item,
    );
    return structuredClone(updated);
  }

  async listSessions(filters: ListFilters) {
    this.#guard();
    const data =
      this.#options.scenario === "empty"
        ? []
        : this.#filter(
            this.#sessions,
            filters,
            (item) => `${item.id} ${item.title} ${item.agentName}`,
          );
    return this.#page(data, filters.page);
  }

  async getSession(id: string) {
    this.#guard();
    const value = this.#sessions.find((session) => session.id === id);
    if (!value) throw new Error("Session not found");
    return structuredClone(value);
  }

  async createSession(input: {
    readonly agentId: string;
    readonly title: string;
  }) {
    const agent = this.#agents.find((item) => item.id === input.agentId);
    if (!agent) throw new Error("Agent not found");
    this.#counter += 1;
    const now = new Date().toISOString();
    const detail: SessionDetail = {
      id: `session_demo_${this.#counter}`,
      title: input.title,
      status: "queued",
      agentId: agent.id,
      agentName: agent.name,
      inputTokens: 0,
      outputTokens: 0,
      observedCostUsd: null,
      costProvenance: "unavailable",
      createdAt: now,
      lastActivityAt: now,
      runId: `run_demo_${this.#counter}`,
      agentVersion: agent.version,
      startedAt: now,
      completedAt: null,
      attempt: 1,
      events: [],
      capabilities: {
        canCancel: true,
        canResume: false,
        canBranchReplay: false,
      },
    };
    this.#sessions.unshift(detail);
    return detail;
  }

  async runSessionAction(
    id: string,
    action: "cancel" | "resume" | "branch-replay",
  ) {
    const session = this.#sessions.find((item) => item.id === id);
    if (!session) throw new Error("Session not found");
    const status = action === "cancel" ? "cancelled" : "queued";
    const updated: SessionDetail = {
      ...session,
      status,
      lastActivityAt: new Date().toISOString(),
      capabilities: {
        canCancel: status === "queued",
        canResume: false,
        canBranchReplay: status !== "queued",
      },
    };
    this.#sessions = this.#sessions.map((item) =>
      item.id === id ? updated : item,
    );
    return updated;
  }

  async listPendingWork() {
    this.#guard();
    return structuredClone(
      this.#options.scenario === "empty" ? [] : this.#pending,
    );
  }

  async claimTool(id: string) {
    this.#pending = this.#pending.map((work) =>
      work.kind === "tool" && work.id === id
        ? {
            ...work,
            stage: "caller_claimed",
            claimedBy: "Demo Operator",
            claimFence: String(Number(work.claimFence) + 1),
          }
        : work,
    );
  }

  async submitToolResult(id: string) {
    this.#pending = this.#pending.filter((work) => work.id !== id);
  }

  async decideApproval(id: string) {
    this.#pending = this.#pending.filter((work) => work.id !== id);
  }

  async getSettings() {
    this.#guard();
    return structuredClone(settingsSeed);
  }

  connectEvents(
    input: Parameters<ConsoleApi["connectEvents"]>[0],
  ): EventConnection {
    const delay = this.#options.eventDelayMs ?? 1200;
    const timer = setTimeout(() => {
      const event: ProductEvent = {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        aggregateType: "run",
        aggregateId: sessionsSeed[0]!.runId,
        aggregateSequence: 12,
        projectPosition: "42",
        kind: "run.state_changed",
        publicPayload: {
          state: "waiting_for_approval",
          sessionId: sessionsSeed[0]!.id,
        },
        occurredAt: "2026-08-20T07:05:44.000Z",
      };
      input.onCursor("djE6NDI");
      input.onEvent(event);
    }, delay);
    input.signal?.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
    return { close: () => clearTimeout(timer) };
  }
}

export function createDemoApiFromLocation(): DemoConsoleApi {
  const scenario = new URLSearchParams(window.location.search).get("demo");
  return new DemoConsoleApi({
    scenario:
      scenario === "empty" || scenario === "error" ? scenario : "default",
  });
}
