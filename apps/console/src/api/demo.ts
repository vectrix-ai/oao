import type { ProductEvent } from "@oao/contracts";
import type {
  AgentDetail,
  AgentSummary,
  AgentVersionConfig,
  ApiKeySummary,
  ConsoleApi,
  CreateApiKeyInput,
  CreateModelProviderInput,
  CreateModelPresetInput,
  CreateSandboxProviderInput,
  CreateSkillInput,
  CreateStorageProviderInput,
  CreatedApiKey,
  EventConnection,
  ListFilters,
  ModelCatalogEntry,
  ModelPreset,
  PageResult,
  PendingWork,
  ProjectContext,
  ProjectModelProvider,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  RunFileUpload,
  SessionDetail,
  SkillDetail,
  SkillDraft,
  SkillFileInput,
  SkillSummary,
  SettingsData,
  StorageObjectEntry,
  StorageObjectList,
  UpdateSandboxProviderConfigurationInput,
  McpServer,
  McpCredential,
  McpCredentialPolicy,
  McpToolset,
} from "./types";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const principalId = "33333333-3333-4333-8333-333333333333";
const OPENROUTER_PROVIDER_ID = "55555555-5555-4555-8555-555555555555";
const ANTHROPIC_PROVIDER_ID = "56565656-5656-4565-8565-565656565656";
const XAI_PROVIDER_ID = "57575757-5757-4575-8575-575757575757";
const DAYTONA_PROVIDER_ID = "66666666-6666-4666-8666-666666666666";
const DAYTONA_SNAPSHOT_ID = "77777777-7777-4777-8777-777777777777";
const DAYTONA_LARGE_SNAPSHOT_ID = "78787878-7878-4787-8787-787878787878";

function demoRunFiles(files: readonly RunFileUpload[], messageId: string) {
  return files.map((file, index) => ({
    id: `${messageId}-file-${index + 1}`,
    name: file.name,
    contentType: file.contentType,
    sizeBytes:
      Math.floor((file.dataBase64.length * 3) / 4) -
      (file.dataBase64.endsWith("==")
        ? 2
        : file.dataBase64.endsWith("=")
          ? 1
          : 0),
    sha256: "demo",
  }));
}

const supportConfig: AgentVersionConfig = {
  systemPrompt:
    "You are a careful support operations agent. Verify the customer and summarize only the information needed to resolve the request. Never disclose secrets or internal reasoning.",
  modelPreset: "claude-sonnet-4-6-zdr-v1",
  tools: [
    {
      name: "lookup_customer",
      description: "Find a customer record by a safe external identifier.",
      owner: "platform",
      approval: "never",
      inputSchema: {
        type: "object",
        properties: { customer_ref: { type: "string" } },
        required: ["customer_ref"],
      },
      outputSchema: {
        type: "object",
        properties: { found: { type: "boolean" } },
        required: ["found"],
      },
    },
    {
      name: "issue_refund",
      description:
        "Request a refund through the caller-owned billing workflow.",
      owner: "caller",
      approval: "always",
      inputSchema: {
        type: "object",
        properties: {
          amount: { type: "number" },
          currency: { type: "string" },
        },
        required: ["amount", "currency"],
      },
      outputSchema: {
        type: "object",
        properties: { accepted: { type: "boolean" } },
        required: ["accepted"],
      },
    },
  ],
  harnessOperations: [
    {
      key: "extract_shipment",
      description:
        "Inspect the available shipment documents when a structured shipment record is needed.",
      instructions:
        "Read the materialized shipment documents from the shared workspace. Activate any relevant Agent-level Skill, verify each extracted fact, and return only the structured result.",
      resultSchema: {
        type: "object",
        properties: {
          shipmentReference: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["shipmentReference", "confidence"],
        additionalProperties: false,
      },
      timeoutMs: 120_000,
    },
  ],
  sandbox: {
    enabled: true,
    provider: "daytona-primary",
    snapshotId: DAYTONA_SNAPSHOT_ID,
    network: "restricted",
    capabilities: ["filesystem_read", "filesystem_write", "shell", "browser"],
  },
  limits: { maxTurns: 32, timeoutMs: 300_000 },
};

/** A session lists the pinned agent version's tools, without their schemas. */
function sessionTools(config: AgentVersionConfig): SessionDetail["tools"] {
  return config.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    owner: tool.owner,
    approval: tool.approval,
  }));
}

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
    latestVersionId: "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sandbox: supportConfig.sandbox,
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
        config: supportConfig,
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
    latestVersionId: "bbbbbbb5-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sandbox: supportConfig.sandbox,
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
          systemPrompt:
            "Extract verifiable facts from provided documents. Cite the source page. Do not infer missing values.",
          modelPreset: "claude-sonnet-4-6-zdr-v1",
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
    latestVersionId: "ccccccc1-cccc-4ccc-8ccc-cccccccccccc",
    sandbox: supportConfig.sandbox,
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
          systemPrompt:
            "Classify incoming orders into standard, exception, or needs review.",
          modelPreset: "claude-sonnet-4-6-zdr-v1",
        },
      },
    ],
  },
];

const skillsSeed: SkillDetail[] = [
  {
    id: "44444444-4444-4444-8444-444444444444",
    key: "shipment-intake",
    displayName: "Shipment Intake",
    latestVersionId: "44444444-4444-4444-8444-444444444445",
    version: 1,
    name: "shipment-intake",
    description:
      "Process shipment documents using the approved intake sequence.",
    contentHash: "4".repeat(64),
    status: "active",
    fileCount: 0,
    versionIds: ["44444444-4444-4444-8444-444444444445"],
    createdAt: "2026-08-18T09:00:00.000Z",
    updatedAt: "2026-08-18T09:00:00.000Z",
    versions: [
      {
        id: "44444444-4444-4444-8444-444444444445",
        skillId: "44444444-4444-4444-8444-444444444444",
        version: 1,
        name: "shipment-intake",
        description:
          "Process shipment documents using the approved intake sequence.",
        instructions:
          "Identify the customer, load their instructions, analyze the files, and request approval before creating records.",
        contentHash: "4".repeat(64),
        totalBytes: 112,
        status: "active",
        files: [],
        createdAt: "2026-08-18T09:00:00.000Z",
      },
    ],
  },
  {
    id: "44444444-4444-4444-8444-444444444446",
    key: "carrier-codes",
    displayName: "Carrier Codes",
    latestVersionId: "44444444-4444-4444-8444-444444444447",
    version: 1,
    name: "carrier-codes",
    description:
      "Look up canonical carrier and service-level codes for shipment records.",
    contentHash: "5".repeat(64),
    status: "active",
    fileCount: 0,
    versionIds: ["44444444-4444-4444-8444-444444444447"],
    createdAt: "2026-08-18T09:05:00.000Z",
    updatedAt: "2026-08-18T09:05:00.000Z",
    versions: [
      {
        id: "44444444-4444-4444-8444-444444444447",
        skillId: "44444444-4444-4444-8444-444444444446",
        version: 1,
        name: "carrier-codes",
        description:
          "Look up canonical carrier and service-level codes for shipment records.",
        instructions:
          "Match the carrier name to its canonical code before writing shipment records.",
        contentHash: "5".repeat(64),
        totalBytes: 82,
        status: "active",
        files: [],
        createdAt: "2026-08-18T09:05:00.000Z",
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
    cacheReadTokens: 1536,
    cacheWriteTokens: 704,
    observedCostUsd: 0.0184,
    costProvenance: "provider_observed",
    createdAt: "2026-08-20T07:02:10.000Z",
    lastActivityAt: "2026-08-20T07:05:44.000Z",
    runId: "run_01J5QV1FPZ19TR2D7QXG8B0N6K",
    model: "hosted-sonnet",
    agentVersion: 3,
    startedAt: "2026-08-20T07:02:11.000Z",
    completedAt: null,
    attempt: 1,
    workspaceFiles: [],
    tools: sessionTools(supportConfig),
    skills: [
      {
        skillId: skillsSeed[0]!.id,
        skillVersionId: skillsSeed[0]!.latestVersionId,
        version: 1,
        name: "shipment-intake",
        description:
          "Process shipment documents using the approved intake sequence.",
        contentHash: "4".repeat(64),
        status: "active",
      },
      {
        skillId: skillsSeed[1]!.id,
        skillVersionId: skillsSeed[1]!.latestVersionId,
        version: 1,
        name: "carrier-codes",
        description:
          "Look up canonical carrier and service-level codes for shipment records.",
        contentHash: "5".repeat(64),
        status: "active",
      },
    ],
    delegations: [],
    capabilities: { canCancel: true, canResume: false, canBranchReplay: false },
    events: [
      {
        id: "event-user-1",
        kind: "user",
        source: "message",
        title: "User",
        summary:
          "Customer Northwind #4831 says the expedited shipment was charged twice. Verify the account and prepare the appropriate refund.",
        createdAt: "2026-08-20T07:02:11.000Z",
        durationMs: null,
        status: "success",
      },
      {
        id: "event-runtime-1",
        kind: "assistant",
        source: "runtime",
        title: "run.created",
        summary: "Run queued on the durable thread.",
        createdAt: "2026-08-20T07:02:11.400Z",
        durationMs: null,
        status: "info",
      },
      {
        id: "event-runtime-2",
        kind: "assistant",
        source: "runtime",
        title: "runtime.dispatch admitted",
        summary: "Admitted to the dispatcher under the run admission key.",
        createdAt: "2026-08-20T07:02:11.800Z",
        durationMs: 41,
        status: "info",
        payload: {
          rendered: { admission_key: "run:01J5QV1FPZ19TR2D7QXG8B0N6K" },
          raw: null,
          redacted: true,
          redactionReason:
            "Dispatcher internals are reduced to a safe public key.",
        },
      },
      {
        id: "event-model-1",
        kind: "assistant",
        source: "message",
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
        id: "event-skill-1",
        kind: "tool",
        source: "activity",
        title: "skill.activated",
        summary:
          "Activated Skill shipment-intake to load its full instructions.",
        createdAt: "2026-08-20T07:02:14.200Z",
        durationMs: 96,
        status: "success",
        payload: {
          rendered: { skill: "shipment-intake", success: true },
          raw: null,
          redacted: true,
          redactionReason:
            "Skill instructions are never copied into public events.",
        },
      },
      {
        id: "event-harness-1",
        kind: "tool",
        source: "activity",
        title: "Harness · extract_shipment",
        summary: "3 model turns · 2 tool steps · validated result",
        createdAt: "2026-08-20T07:02:14.300Z",
        durationMs: 1_612,
        status: "success",
        harness: {
          operationKey: "extract_shipment",
          toolCallId: "tool-call-harness-demo",
          phase: "completed",
          startedAt: "2026-08-20T07:02:14.300Z",
          completedAt: "2026-08-20T07:02:15.912Z",
          taskCharacters: 126,
          timeoutMs: 120_000,
          resultValidated: true,
          modelTurns: 3,
          toolSteps: 2,
          attribution: "partial",
          parallel: {
            groupId: "parallel:tool-call-harness-demo:tool-call-verify-demo",
            count: 2,
            index: 0,
          },
          steps: [
            {
              id: "event-harness-model-1",
              kind: "reasoning",
              title: "Model turn 1",
              summary: "The model completed an internal turn.",
              createdAt: "2026-08-20T07:02:14.320Z",
              durationMs: 284,
              status: "success",
              tokens: { input: 312, output: 44 },
            },
            {
              id: "event-harness-skill",
              kind: "tool",
              title: "Skill activated",
              summary: "shipment-intake",
              createdAt: "2026-08-20T07:02:14.610Z",
              durationMs: 18,
              status: "success",
            },
            {
              id: "event-harness-model-2",
              kind: "reasoning",
              title: "Model turn 2",
              summary: "The model completed an internal turn.",
              createdAt: "2026-08-20T07:02:14.640Z",
              durationMs: 302,
              status: "success",
              tokens: { input: 428, output: 51 },
            },
            {
              id: "event-harness-read",
              kind: "tool",
              title: "read",
              summary: "/workspace/shipments/order-4831.pdf",
              createdAt: "2026-08-20T07:02:14.950Z",
              durationMs: 36,
              status: "success",
            },
            {
              id: "event-harness-model-3",
              kind: "reasoning",
              title: "Model turn 3",
              summary: "The model completed an internal turn.",
              createdAt: "2026-08-20T07:02:15.000Z",
              durationMs: 874,
              status: "success",
              tokens: { input: 516, output: 63 },
            },
          ],
        },
        payload: {
          rendered: {
            operationKey: "extract_shipment",
            phase: "completed",
            toolCallId: "tool-call-harness-demo",
            taskCharacters: 126,
            timeoutMs: 120_000,
            durationMs: 1_612,
            resultValidated: true,
            modelTurns: 3,
            toolSteps: 2,
            parallelGroupId:
              "parallel:tool-call-harness-demo:tool-call-verify-demo",
            parallelCount: 2,
            parallelIndex: 0,
          },
          raw: null,
          redacted: true,
          redactionReason:
            "Harness prompts, structured results, and document contents are not copied into the session read model.",
        },
      },
      {
        id: "event-harness-2",
        kind: "tool",
        source: "activity",
        title: "Harness · verify_shipment",
        summary: "2 model turns · 1 tool step · validated result",
        createdAt: "2026-08-20T07:02:14.350Z",
        durationMs: 1_350,
        status: "success",
        harness: {
          operationKey: "verify_shipment",
          toolCallId: "tool-call-verify-demo",
          phase: "completed",
          startedAt: "2026-08-20T07:02:14.350Z",
          completedAt: "2026-08-20T07:02:15.700Z",
          taskCharacters: 98,
          timeoutMs: 120_000,
          resultValidated: true,
          modelTurns: 2,
          toolSteps: 1,
          attribution: "partial",
          parallel: {
            groupId: "parallel:tool-call-harness-demo:tool-call-verify-demo",
            count: 2,
            index: 1,
          },
          steps: [
            {
              id: "event-verify-model-1",
              kind: "reasoning",
              title: "Model turn 1",
              summary: "The model completed an internal turn.",
              createdAt: "2026-08-20T07:02:14.370Z",
              durationMs: 390,
              status: "success",
              tokens: { input: 298, output: 37 },
            },
            {
              id: "event-verify-bash",
              kind: "tool",
              title: "bash",
              summary: "verify shipment reference",
              createdAt: "2026-08-20T07:02:14.770Z",
              durationMs: 42,
              status: "success",
            },
            {
              id: "event-verify-model-2",
              kind: "reasoning",
              title: "Model turn 2",
              summary: "The model completed an internal turn.",
              createdAt: "2026-08-20T07:02:14.820Z",
              durationMs: 842,
              status: "success",
              tokens: { input: 384, output: 48 },
            },
          ],
        },
        payload: {
          rendered: {
            operationKey: "verify_shipment",
            phase: "completed",
            toolCallId: "tool-call-verify-demo",
            taskCharacters: 98,
            timeoutMs: 120_000,
            durationMs: 1_350,
            resultValidated: true,
            modelTurns: 2,
            toolSteps: 1,
            parallelGroupId:
              "parallel:tool-call-harness-demo:tool-call-verify-demo",
            parallelCount: 2,
            parallelIndex: 1,
          },
          raw: null,
          redacted: true,
          redactionReason:
            "Harness prompts, structured results, and document contents are not copied into the session read model.",
        },
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
            arguments: { customer_ref: "NW-4831" },
            result: {
              matches: 2,
              account_status: "active",
            },
          },
          raw: '{"arguments":{"customer_ref":"NW-4831"},"result":{"matches":2,"account_status":"active"}}',
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
    cacheReadTokens: 8440,
    cacheWriteTokens: 2150,
    observedCostUsd: 0.1042,
    costProvenance: "provider_observed",
    createdAt: "2026-08-19T14:20:00.000Z",
    lastActivityAt: "2026-08-19T14:24:38.000Z",
    runId: "run_01J5PDS4BR20P60BMSAT00W8PV",
    model: "hosted-sonnet",
    agentVersion: 5,
    startedAt: "2026-08-19T14:20:01.000Z",
    completedAt: "2026-08-19T14:24:38.000Z",
    attempt: 1,
    workspaceFiles: [],
    tools: [],
    skills: [],
    delegations: [],
    capabilities: { canCancel: false, canResume: false, canBranchReplay: true },
    events: [
      {
        id: "event-user-2",
        kind: "user",
        source: "message",
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
        source: "message",
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
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    observedCostUsd: null,
    costProvenance: "unavailable",
    createdAt: "2026-08-18T11:08:00.000Z",
    lastActivityAt: "2026-08-18T11:08:15.000Z",
    runId: "run_01J5NZAD4Z3HDBN4P8WCFJ7TQS",
    model: "claude-sonnet-4-6-zdr-v1",
    agentVersion: 1,
    startedAt: "2026-08-18T11:08:01.000Z",
    completedAt: "2026-08-18T11:08:15.000Z",
    attempt: 3,
    workspaceFiles: [],
    tools: sessionTools(supportConfig),
    skills: [],
    delegations: [],
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
    id: ORG_ID,
    name: "Example operations",
    slug: "example-operations",
    createdAt: "2026-07-14T09:00:00.000Z",
  },
  projects: [
    {
      id: PROJECT_ID,
      name: "Managed agents",
      slug: "managed-agents",
      createdAt: "2026-07-14T09:00:00.000Z",
      current: true,
    },
    {
      id: "23232323-2323-4232-8232-232323232323",
      name: "Evaluation lab",
      slug: "evaluation-lab",
      createdAt: "2026-08-01T09:00:00.000Z",
      current: false,
    },
  ],
  members: [
    {
      id: principalId,
      name: "Demo Operator",
      subject: "demo.operator@example.test",
      email: "demo.operator@example.test",
      role: "owner",
      scopes: ["*"],
      current: true,
    },
    {
      id: "34343434-3434-4343-8343-343434343434",
      name: "Review Operator",
      subject: "review.operator@example.test",
      email: "review.operator@example.test",
      role: "member",
      scopes: ["agent:read", "session:read", "run:read"],
      current: false,
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

/**
 * Deterministic stand-in for the provider catalog. It carries only public
 * metadata; the demo adapter never holds a provider credential.
 */
const modelCatalogSeed: readonly ModelCatalogEntry[] = [
  {
    providerType: "openrouter",
    model: "openrouter/anthropic/claude-sonnet-4.6",
    catalogId: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    reasoning: true,
  },
  {
    providerType: "openrouter",
    model: "openrouter/openai/gpt-5.1",
    catalogId: "openai/gpt-5.1",
    name: "GPT-5.1",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    reasoning: true,
  },
  {
    providerType: "openrouter",
    model: "openrouter/meta-llama/llama-4-maverick",
    catalogId: "meta-llama/llama-4-maverick",
    name: "Llama 4 Maverick",
    contextWindow: 1_048_576,
    maxOutputTokens: 16_384,
    reasoning: false,
  },
  {
    providerType: "openai",
    model: "openai/gpt-5.6-terra",
    catalogId: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    reasoning: true,
  },
  {
    providerType: "openai",
    model: "openai/gpt-5.1",
    catalogId: "gpt-5.1",
    name: "GPT-5.1",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    reasoning: true,
  },
  {
    providerType: "anthropic",
    model: "anthropic/claude-sonnet-5",
    catalogId: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    adaptiveThinking: true,
    thinkingCanBeDisabled: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    providerType: "xai",
    model: "xai/grok-4.6",
    catalogId: "grok-4.6",
    name: "Grok 4.6",
    contextWindow: 500_000,
    maxOutputTokens: null,
    reasoning: true,
  },
];

const modelProvidersSeed: readonly ProjectModelProvider[] = [
  {
    id: OPENROUTER_PROVIDER_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    key: "openrouter-primary",
    displayName: "OpenRouter primary",
    providerType: "openrouter",
    credentialConfigured: true,
    credentialFingerprint: "a1b2c3d4e5f6",
    credentialVersion: 1,
    createdByPrincipalId: principalId,
    createdAt: "2026-08-18T11:00:00.000Z",
    updatedAt: "2026-08-18T11:00:00.000Z",
  },
  {
    id: ANTHROPIC_PROVIDER_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    key: "anthropic-primary",
    displayName: "Anthropic primary",
    providerType: "anthropic",
    credentialConfigured: true,
    credentialFingerprint: "c3d4e5f6a1b2",
    credentialVersion: 1,
    createdByPrincipalId: principalId,
    createdAt: "2026-08-18T11:05:00.000Z",
    updatedAt: "2026-08-18T11:05:00.000Z",
  },
  {
    id: XAI_PROVIDER_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    key: "xai-primary",
    displayName: "xAI primary",
    providerType: "xai",
    credentialConfigured: true,
    credentialFingerprint: "d4e5f6a1b2c3",
    credentialVersion: 1,
    createdByPrincipalId: principalId,
    createdAt: "2026-08-18T11:10:00.000Z",
    updatedAt: "2026-08-18T11:10:00.000Z",
  },
];

const sandboxProvidersSeed: readonly ProjectSandboxProvider[] = [
  {
    id: DAYTONA_PROVIDER_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    key: "daytona-primary",
    displayName: "Daytona primary",
    providerType: "daytona",
    credentialConfigured: true,
    credentialFingerprint: "b2c3d4e5f6a1",
    credentialVersion: 1,
    target: null,
    restrictedEgress: {
      allowedDomains: ["*.example.com"],
      allowedCidrs: [],
    },
    createdByPrincipalId: principalId,
    createdAt: "2026-08-18T11:10:00.000Z",
    updatedAt: "2026-08-18T11:10:00.000Z",
  },
];

const modelPresetsSeed: readonly ModelPreset[] = [
  {
    id: "44444444-4444-4444-8444-444444444444",
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    key: "claude-sonnet-4-6-zdr-v1",
    displayName: "Claude Sonnet 4.6 (zero retention)",
    origin: "project",
    providerId: OPENROUTER_PROVIDER_ID,
    providerType: "openrouter",
    model: "openrouter/anthropic/claude-sonnet-4.6",
    routing: {
      zeroDataRetention: true,
      dataCollection: "deny",
      allowFallbacks: false,
      providerAllowlist: ["anthropic"],
    },
    settings: null,
    hosted: true,
    available: true,
    createdByPrincipalId: principalId,
    createdAt: "2026-08-18T11:20:00.000Z",
  },
];

export interface DemoApiOptions {
  readonly scenario?: "default" | "empty" | "error";
  readonly eventDelayMs?: number;
}

export class DemoConsoleApi implements ConsoleApi {
  #agents = structuredClone(agentsSeed);
  #skills = structuredClone(skillsSeed);
  #mcpServers: McpServer[] = [];
  #mcpCredentials: McpCredential[] = [];
  #mcpPolicies: McpCredentialPolicy[] = [];
  #mcpToolsets: McpToolset[] = [];
  #skillDrafts: SkillDraft[] = [];
  #skillFiles = new Map<string, readonly SkillFileInput[]>();
  #apiKeys = structuredClone(settingsSeed.apiKeys) as ApiKeySummary[];
  #members = structuredClone(
    settingsSeed.members,
  ) as SettingsData["members"][number][];
  #modelPresets = structuredClone(modelPresetsSeed) as ModelPreset[];
  #modelProviders = structuredClone(
    modelProvidersSeed,
  ) as ProjectModelProvider[];
  #sandboxProviders = structuredClone(
    sandboxProvidersSeed,
  ) as ProjectSandboxProvider[];
  #storageProviders: ProjectStorageProvider[] = [];
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

  async getContext(): Promise<ProjectContext> {
    return {
      organization: { id: ORG_ID, name: "Example operations" },
      project: { id: PROJECT_ID, name: "Managed agents" },
      currentPrincipal: {
        id: principalId,
        kind: "human" as const,
        subject: "demo.operator@example.test",
        displayName: "Demo Operator",
        role: "Platform Owner",
        scopes: ["*"],
      },
      organizations: [{ id: ORG_ID, name: "Example operations" }],
      projects: [
        { id: PROJECT_ID, name: "Managed agents" },
        { id: settingsSeed.projects[1]!.id, name: "Evaluation lab" },
      ],
    };
  }

  async logout(): Promise<void> {}

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

  #assertApprovedPreset(key: string): void {
    if (!this.#modelPresets.some((preset) => preset.key === key))
      throw new Error(
        `${key} is not an approved model preset for this project.`,
      );
  }

  async createAgent(input: {
    readonly name: string;
    readonly description: string;
    readonly initialConfig: AgentVersionConfig;
  }): Promise<AgentSummary> {
    this.#assertApprovedPreset(input.initialConfig.modelPreset);
    this.#counter += 1;
    const now = new Date().toISOString();
    const id = `dddddddd-dddd-4ddd-8ddd-${String(this.#counter).padStart(12, "0")}`;
    const versionId = `eeeeeeee-eeee-4eee-8eee-${String(this.#counter).padStart(12, "0")}`;
    const config = input.initialConfig;
    const detail: AgentDetail = {
      id,
      name: input.name,
      key: input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, ""),
      description: input.description,
      model: config.modelPreset,
      status: "draft",
      version: 1,
      latestVersionId: versionId,
      sandbox: config.sandbox,
      createdAt: now,
      updatedAt: now,
      versions: [
        {
          id: versionId,
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
    this.#assertApprovedPreset(config.modelPreset);
    const version = (agent.version ?? 0) + 1;
    const now = new Date().toISOString();
    const updated: AgentDetail = {
      ...agent,
      status: "published",
      version,
      latestVersionId: `version-${version}`,
      updatedAt: now,
      model: config.modelPreset,
      sandbox: config.sandbox,
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

  async listSkills(filters: ListFilters) {
    this.#guard();
    const data =
      this.#options.scenario === "empty"
        ? []
        : this.#filter(
            this.#skills,
            filters,
            (item) => `${item.displayName} ${item.key} ${item.description}`,
          );
    return this.#page(data as SkillSummary[], filters.page);
  }

  async getSkill(id: string) {
    this.#guard();
    const skill = this.#skills.find((item) => item.id === id);
    if (!skill) throw new Error("Skill not found");
    return structuredClone(skill);
  }

  async createSkill(input: CreateSkillInput) {
    this.#counter += 1;
    const now = new Date().toISOString();
    const id = `44444444-4444-4444-8444-${String(this.#counter).padStart(12, "0")}`;
    const versionId = `55555555-5555-4555-8555-${String(this.#counter).padStart(12, "0")}`;
    const detail: SkillDetail = {
      id,
      key: input.key ?? input.name,
      displayName: input.displayName,
      latestVersionId: versionId,
      version: 1,
      name: input.name,
      description: input.description,
      contentHash: "5".repeat(64),
      status: "active",
      fileCount: input.files?.length ?? 0,
      versionIds: [versionId],
      createdAt: now,
      updatedAt: now,
      versions: [
        {
          id: versionId,
          skillId: id,
          version: 1,
          name: input.name,
          description: input.description,
          instructions: input.instructions,
          contentHash: "5".repeat(64),
          totalBytes: input.instructions.length,
          status: "active",
          files: (input.files ?? []).map((file) => ({
            path: file.path,
            contentType: file.contentType,
            sizeBytes: atob(file.dataBase64).length,
            sha256: "a".repeat(64),
          })),
          createdAt: now,
        },
      ],
    };
    this.#skillFiles.set(versionId, structuredClone(input.files ?? []));
    this.#skills.unshift(detail);
    return structuredClone(detail);
  }

  async publishSkillVersion(
    id: string,
    input: Omit<CreateSkillInput, "key" | "displayName">,
  ) {
    const skill = this.#skills.find((item) => item.id === id);
    if (!skill) throw new Error("Skill not found");
    const version = skill.version + 1;
    const now = new Date().toISOString();
    const versionId = `skill-version-${version}`;
    const updated: SkillDetail = {
      ...skill,
      latestVersionId: versionId,
      version,
      name: input.name,
      description: input.description,
      contentHash: `${version}`.repeat(64).slice(0, 64),
      fileCount: input.files?.length ?? 0,
      versionIds: [...skill.versionIds, versionId],
      updatedAt: now,
      versions: [
        {
          id: versionId,
          skillId: id,
          version,
          name: input.name,
          description: input.description,
          instructions: input.instructions,
          contentHash: `${version}`.repeat(64).slice(0, 64),
          totalBytes: input.instructions.length,
          status: "active",
          files: (input.files ?? []).map((file) => ({
            path: file.path,
            contentType: file.contentType,
            sizeBytes: atob(file.dataBase64).length,
            sha256: "b".repeat(64),
          })),
          createdAt: now,
        },
        ...skill.versions,
      ],
    };
    this.#skills = this.#skills.map((item) =>
      item.id === id ? updated : item,
    );
    this.#skillFiles.set(versionId, structuredClone(input.files ?? []));
    return structuredClone(updated);
  }

  async exportSkillVersion(
    _skillId: string,
    versionId: string,
  ): Promise<{
    readonly files: readonly SkillFileInput[];
  }> {
    return {
      files: structuredClone(this.#skillFiles.get(versionId) ?? []),
    };
  }

  async createSkillDraft(
    input: {
      readonly skillId?: string;
      readonly sourceSkillVersionId?: string;
    } = {},
  ): Promise<SkillDraft> {
    this.#counter += 1;
    const now = new Date().toISOString();
    const skill = input.skillId
      ? this.#skills.find((entry) => entry.id === input.skillId)
      : undefined;
    if (input.skillId && !skill) throw new Error("Skill not found");
    const source = skill?.versions.find(
      (version) =>
        version.id === (input.sourceSkillVersionId ?? skill.latestVersionId),
    );
    if (skill && !source) throw new Error("Skill version not found");
    const sourceFiles = source
      ? (this.#skillFiles.get(source.id) ?? []).map((file) => ({
          path: file.path,
          kind: "file" as const,
          contentType: file.contentType,
          sizeBytes: atob(file.dataBase64).length,
          sha256: "c".repeat(64),
          dataBase64: file.dataBase64,
        }))
      : [];
    const directoryPaths = new Set<string>();
    for (const file of sourceFiles) {
      const segments = file.path.split("/");
      for (let index = 1; index < segments.length; index += 1)
        directoryPaths.add(segments.slice(0, index).join("/"));
    }
    const draft: SkillDraft = {
      id: `77777777-7777-4777-8777-${String(this.#counter).padStart(12, "0")}`,
      skillId: skill?.id ?? null,
      sourceSkillVersionId: source?.id ?? null,
      key: skill?.key ?? "",
      displayName: skill?.displayName ?? "",
      name: source?.name ?? "",
      description: source?.description ?? "",
      instructions: source?.instructions ?? "",
      revision: 1,
      status: "editing",
      publishedSkillVersionId: null,
      entries: [
        ...[...directoryPaths].map((path) => ({
          path,
          kind: "directory" as const,
          contentType: null,
          sizeBytes: null,
          sha256: null,
        })),
        ...sourceFiles,
      ].sort((left, right) => left.path.localeCompare(right.path)),
      createdAt: now,
      updatedAt: now,
    };
    this.#skillDrafts.unshift(draft);
    return structuredClone(draft);
  }

  async updateSkillDraft(
    draftId: string,
    input: Pick<
      SkillDraft,
      "key" | "displayName" | "name" | "description" | "instructions"
    >,
  ): Promise<SkillDraft> {
    const draft = this.#skillDrafts.find((entry) => entry.id === draftId);
    if (!draft || draft.status !== "editing")
      throw new Error("Skill draft is not editable");
    const updated: SkillDraft = {
      ...draft,
      ...input,
      revision: draft.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#skillDrafts = this.#skillDrafts.map((entry) =>
      entry.id === draftId ? updated : entry,
    );
    return structuredClone(updated);
  }

  async createSkillDraftDirectory(
    draftId: string,
    path: string,
  ): Promise<SkillDraft> {
    const draft = this.#skillDrafts.find((entry) => entry.id === draftId);
    if (!draft || draft.status !== "editing")
      throw new Error("Skill draft is not editable");
    const entries = [...draft.entries];
    const segments = path.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const directory = segments.slice(0, index).join("/");
      const existing = entries.find(
        (entry) => entry.path.toLowerCase() === directory.toLowerCase(),
      );
      if (existing?.kind === "file")
        throw new Error(`A file already occupies ${directory}`);
      if (!existing)
        entries.push({
          path: directory,
          kind: "directory",
          contentType: null,
          sizeBytes: null,
          sha256: null,
        });
    }
    const updated: SkillDraft = {
      ...draft,
      entries: entries.sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      revision: draft.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#skillDrafts = this.#skillDrafts.map((entry) =>
      entry.id === draftId ? updated : entry,
    );
    return structuredClone(updated);
  }

  async putSkillDraftFile(
    draftId: string,
    file: SkillFileInput,
  ): Promise<SkillDraft> {
    const draft = await this.createSkillDraftDirectory(
      draftId,
      file.path.includes("/")
        ? file.path.slice(0, file.path.lastIndexOf("/"))
        : "resources",
    );
    const entries = draft.entries.filter(
      (entry) => entry.path.toLowerCase() !== file.path.toLowerCase(),
    );
    if (!file.path.includes("/")) {
      const resourcesIndex = entries.findIndex(
        (entry) => entry.path === "resources" && entry.kind === "directory",
      );
      if (resourcesIndex >= 0) entries.splice(resourcesIndex, 1);
    }
    entries.push({
      path: file.path,
      kind: "file",
      contentType: file.contentType,
      sizeBytes: atob(file.dataBase64).length,
      sha256: "d".repeat(64),
      dataBase64: file.dataBase64,
    });
    const updated: SkillDraft = {
      ...draft,
      entries: entries.sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      revision: draft.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#skillDrafts = this.#skillDrafts.map((entry) =>
      entry.id === draftId ? updated : entry,
    );
    return structuredClone(updated);
  }

  async removeSkillDraftEntry(
    draftId: string,
    path: string,
    recursive: boolean,
  ): Promise<SkillDraft> {
    const draft = this.#skillDrafts.find((entry) => entry.id === draftId);
    if (!draft || draft.status !== "editing")
      throw new Error("Skill draft is not editable");
    if (
      !recursive &&
      draft.entries.some((entry) => entry.path.startsWith(`${path}/`))
    )
      throw new Error("Directory is not empty");
    const entries = draft.entries.filter(
      (entry) => entry.path !== path && !entry.path.startsWith(`${path}/`),
    );
    if (entries.length === draft.entries.length)
      throw new Error("Draft entry not found");
    const updated: SkillDraft = {
      ...draft,
      entries,
      revision: draft.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#skillDrafts = this.#skillDrafts.map((entry) =>
      entry.id === draftId ? updated : entry,
    );
    return structuredClone(updated);
  }

  async validateSkillDraft(draftId: string) {
    const draft = this.#skillDrafts.find((entry) => entry.id === draftId);
    if (
      !draft ||
      !draft.key ||
      !draft.displayName ||
      !draft.name ||
      !draft.description ||
      !draft.instructions
    )
      throw new Error("Complete the Skill overview and instructions");
    const files = draft.entries.filter((entry) => entry.kind === "file");
    return {
      valid: true as const,
      contentHash: "e".repeat(64),
      totalBytes:
        draft.instructions.length +
        files.reduce((total, file) => total + (file.sizeBytes ?? 0), 0),
      fileCount: files.length,
    };
  }

  async publishSkillDraft(draftId: string) {
    const draft = this.#skillDrafts.find((entry) => entry.id === draftId);
    if (!draft) throw new Error("Skill draft not found");
    await this.validateSkillDraft(draftId);
    const files = draft.entries
      .filter(
        (entry): entry is typeof entry & { readonly dataBase64: string } =>
          entry.kind === "file" && Boolean(entry.dataBase64),
      )
      .map((entry) => ({
        path: entry.path,
        contentType: entry.contentType ?? "text/markdown",
        dataBase64: entry.dataBase64,
      }));
    const published = draft.skillId
      ? await this.publishSkillVersion(draft.skillId, {
          name: draft.name,
          description: draft.description,
          instructions: draft.instructions,
          files,
        })
      : await this.createSkill({
          key: draft.key,
          displayName: draft.displayName,
          name: draft.name,
          description: draft.description,
          instructions: draft.instructions,
          files,
        });
    const versionId = published.latestVersionId;
    this.#skillDrafts = this.#skillDrafts.map((entry) =>
      entry.id === draftId
        ? {
            ...entry,
            skillId: published.id,
            status: "published",
            publishedSkillVersionId: versionId,
            revision: entry.revision + 1,
          }
        : entry,
    );
    return { skillId: published.id, versionId };
  }

  async discardSkillDraft(draftId: string): Promise<void> {
    const draft = this.#skillDrafts.find((entry) => entry.id === draftId);
    if (!draft || draft.status !== "editing") return;
    this.#skillDrafts = this.#skillDrafts.map((entry) =>
      entry.id === draftId ? { ...entry, status: "discarded" } : entry,
    );
  }

  async updateSkillVersionLifecycle(
    skillId: string,
    versionId: string,
    status: "deprecated" | "revoked",
  ) {
    const skill = this.#skills.find((item) => item.id === skillId);
    if (!skill) throw new Error("Skill not found");
    const current = skill.versions.find((version) => version.id === versionId);
    if (!current || current.status === "revoked")
      throw new Error("Skill version cannot make that lifecycle transition");
    if (status === "deprecated" && current.status !== "active")
      throw new Error("Skill version cannot make that lifecycle transition");
    const versions = skill.versions.map((version) =>
      version.id === versionId ? { ...version, status } : version,
    );
    const updated: SkillDetail = {
      ...skill,
      ...(skill.latestVersionId === versionId ? { status } : {}),
      versions,
      updatedAt: new Date().toISOString(),
    };
    this.#skills = this.#skills.map((item) =>
      item.id === skillId ? updated : item,
    );
    return structuredClone(updated);
  }

  async listMcpServers() {
    return {
      data: structuredClone(this.#mcpServers),
      credentialEncryptionConfigured: true,
    };
  }

  async createMcpServer(input: Parameters<ConsoleApi["createMcpServer"]>[0]) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const created: McpServer = {
      id,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      key: input.key,
      displayName: input.displayName,
      latestVersionId: crypto.randomUUID(),
      version: 1,
      endpointUrl: input.endpointUrl,
      transport: input.transport ?? "streamable_http",
      status: "active",
      tools: [],
      lastDiscoveredAt: null,
      createdByPrincipalId: principalId,
      createdAt: now,
      updatedAt: now,
    };
    this.#mcpServers.unshift(created);
    return structuredClone(created);
  }

  async discoverMcpServer(serverId: string) {
    const server = this.#mcpServers.find((item) => item.id === serverId);
    if (!server) throw new Error("MCP server not found");
    const discovered: McpServer = {
      ...server,
      tools: [
        {
          name: "lookup_trace",
          title: "Look up trace",
          description: "Find an observability trace by its immutable ID.",
          inputSchema: {
            type: "object",
            properties: { traceId: { type: "string" } },
            required: ["traceId"],
            additionalProperties: false,
          },
          outputSchema: null,
          schemaHash:
            "1111111111111111111111111111111111111111111111111111111111111111",
        },
        {
          name: "search_runs",
          title: "Search runs",
          description: "Search recent runs using a bounded text query.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: null,
          schemaHash:
            "2222222222222222222222222222222222222222222222222222222222222222",
        },
      ],
      lastDiscoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.#mcpServers = this.#mcpServers.map((item) =>
      item.id === serverId ? discovered : item,
    );
    return structuredClone(discovered);
  }

  async listMcpCredentials() {
    return {
      data: structuredClone(this.#mcpCredentials),
      credentialEncryptionConfigured: true,
    };
  }

  async createMcpCredential(
    input: Parameters<ConsoleApi["createMcpCredential"]>[0],
  ) {
    const now = new Date().toISOString();
    const created: McpCredential = {
      id: crypto.randomUUID(),
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      key: input.key,
      displayName: input.displayName,
      kind: input.kind,
      headerName: input.headerName ?? null,
      credentialConfigured: true,
      credentialFingerprint: "000000000000",
      credentialVersion: 1,
      status: "active",
      createdByPrincipalId: principalId,
      createdAt: now,
      updatedAt: now,
    };
    this.#mcpCredentials.unshift(created);
    return structuredClone(created);
  }

  async rotateMcpCredential(credentialId: string) {
    const credential = this.#mcpCredentials.find(
      (item) => item.id === credentialId,
    );
    if (!credential) throw new Error("MCP credential not found");
    const rotated = {
      ...credential,
      credentialVersion: credential.credentialVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#mcpCredentials = this.#mcpCredentials.map((item) =>
      item.id === credentialId ? rotated : item,
    );
    return structuredClone(rotated);
  }

  async revokeMcpCredential(credentialId: string) {
    const credential = this.#mcpCredentials.find(
      (item) => item.id === credentialId,
    );
    if (!credential) throw new Error("MCP credential not found");
    const revoked = {
      ...credential,
      status: "revoked" as const,
      updatedAt: new Date().toISOString(),
    };
    this.#mcpCredentials = this.#mcpCredentials.map((item) =>
      item.id === credentialId ? revoked : item,
    );
    return structuredClone(revoked);
  }

  async listMcpCredentialPolicies() {
    return { data: structuredClone(this.#mcpPolicies) };
  }

  async createMcpCredentialPolicy(
    input: Parameters<ConsoleApi["createMcpCredentialPolicy"]>[0],
  ) {
    const now = new Date().toISOString();
    const created: McpCredentialPolicy = {
      id: crypto.randomUUID(),
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      key: input.key,
      displayName: input.displayName,
      latestVersionId: crypto.randomUUID(),
      version: 1,
      credentialId: input.credentialId,
      exactOrigin: input.exactOrigin,
      pathPrefix: input.pathPrefix,
      timeoutMs: input.timeoutMs ?? 30_000,
      maximumResponseBytes: input.maximumResponseBytes ?? 1_048_576,
      status: "active",
      createdByPrincipalId: principalId,
      createdAt: now,
      updatedAt: now,
    };
    this.#mcpPolicies.unshift(created);
    return structuredClone(created);
  }

  async listMcpToolsets() {
    return { data: structuredClone(this.#mcpToolsets) };
  }

  async createMcpToolset(input: Parameters<ConsoleApi["createMcpToolset"]>[0]) {
    const server = this.#mcpServers.find(
      (item) => item.latestVersionId === input.serverVersionId,
    );
    if (!server) throw new Error("MCP server version not found");
    const now = new Date().toISOString();
    const created: McpToolset = {
      id: crypto.randomUUID(),
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      key: input.key,
      displayName: input.displayName,
      latestVersionId: crypto.randomUUID(),
      version: 1,
      serverVersionId: input.serverVersionId,
      status: "active",
      tools: input.tools.map((selected) => {
        const tool = server.tools.find(
          (item) => item.name === selected.remoteToolName,
        );
        return {
          remoteToolName: selected.remoteToolName,
          description: tool?.description ?? selected.remoteToolName,
          inputSchema: tool?.inputSchema ?? {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          outputSchema: tool?.outputSchema ?? null,
          approval: selected.approval ?? "always",
        };
      }),
      createdByPrincipalId: principalId,
      createdAt: now,
      updatedAt: now,
    };
    this.#mcpToolsets.unshift(created);
    return structuredClone(created);
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
    readonly initialMessage: string;
    readonly files?: readonly RunFileUpload[];
  }) {
    const agent = this.#agents.find((item) => item.id === input.agentId);
    if (!agent) throw new Error("Agent not found");
    if (agent.version == null)
      throw new Error("Publish an Agent version before creating a session");
    this.#counter += 1;
    const now = new Date().toISOString();
    const messageId = `message_demo_${this.#counter}`;
    const detail: SessionDetail = {
      id: `session_demo_${this.#counter}`,
      title: input.title,
      status: "queued",
      agentId: agent.id,
      agentName: agent.name,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      observedCostUsd: null,
      costProvenance: "unavailable",
      createdAt: now,
      lastActivityAt: now,
      runId: `run_demo_${this.#counter}`,
      agentVersion: agent.version,
      startedAt: now,
      completedAt: null,
      attempt: 1,
      workspaceFiles: [],
      tools: agent.versions[0] ? sessionTools(agent.versions[0].config) : [],
      delegations: [],
      events: [
        {
          id: messageId,
          kind: "user",
          title: "User",
          summary: input.initialMessage || "Review the attached file(s).",
          createdAt: now,
          durationMs: null,
          status: "success",
          ...(input.files?.length
            ? { files: demoRunFiles(input.files, messageId) }
            : {}),
        },
      ],
      capabilities: {
        canCancel: true,
        canResume: false,
        canBranchReplay: false,
      },
      skills: (agent.versions[0]?.config.skillVersionIds ?? []).flatMap(
        (versionId) => {
          const skill = this.#skills.find(
            (candidate) => candidate.latestVersionId === versionId,
          );
          return skill
            ? [
                {
                  skillId: skill.id,
                  skillVersionId: versionId,
                  version: skill.version,
                  name: skill.name,
                  description: skill.description,
                  contentHash: skill.contentHash,
                  status: skill.status,
                },
              ]
            : [];
        },
      ),
    };
    this.#sessions.unshift(detail);
    return detail;
  }

  async submitMessage(
    id: string,
    input: {
      readonly message: string;
      readonly files?: readonly RunFileUpload[];
    },
  ) {
    const session = this.#sessions.find((item) => item.id === id);
    if (!session) throw new Error("Session not found");
    this.#counter += 1;
    const now = new Date().toISOString();
    const messageId = `message_demo_${this.#counter}`;
    const updated: SessionDetail = {
      ...session,
      status: "queued",
      runId: `run_demo_${this.#counter}`,
      startedAt: now,
      completedAt: null,
      lastActivityAt: now,
      events: [
        ...session.events,
        {
          id: messageId,
          kind: "user",
          title: "User",
          summary: input.message || "Review the attached file(s).",
          createdAt: now,
          durationMs: null,
          status: "success",
          ...(input.files?.length
            ? { files: demoRunFiles(input.files, messageId) }
            : {}),
        },
      ],
      capabilities: {
        canCancel: true,
        canResume: false,
        canBranchReplay: false,
      },
    };
    this.#sessions = this.#sessions.map((item) =>
      item.id === id ? updated : item,
    );
    return updated;
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

  async submitToolResult(id: string, _fence: string) {
    void _fence;
    this.#pending = this.#pending.filter((work) => work.id !== id);
  }

  async decideApproval(id: string) {
    this.#pending = this.#pending.filter((work) => work.id !== id);
  }

  async listModelPresets() {
    this.#guard();
    return {
      data: structuredClone(this.#modelPresets),
      credentialEncryptionConfigured: true,
    };
  }

  async listModelProviders() {
    this.#guard();
    return structuredClone(this.#modelProviders);
  }

  async createModelProvider(
    input: CreateModelProviderInput,
  ): Promise<ProjectModelProvider> {
    this.#guard();
    this.#counter += 1;
    const created: ProjectModelProvider = {
      id: `55555555-5555-4555-8555-${String(this.#counter).padStart(12, "0")}`,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      key: input.key,
      displayName: input.displayName,
      providerType: input.providerType,
      credentialConfigured: true,
      credentialFingerprint: "d4e5f6a1b2c3",
      credentialVersion: 1,
      createdByPrincipalId: principalId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.#modelProviders = [...this.#modelProviders, created];
    return structuredClone(created);
  }

  async rotateModelProviderCredential(
    providerId: string,
    apiKey: string,
  ): Promise<ProjectModelProvider> {
    this.#guard();
    void apiKey;
    const current = this.#modelProviders.find(
      (entry) => entry.id === providerId,
    );
    if (!current) throw new Error("Model provider not found.");
    const updated = {
      ...current,
      credentialVersion: current.credentialVersion + 1,
      credentialFingerprint: "f6a1b2c3d4e5",
      updatedAt: new Date().toISOString(),
    };
    this.#modelProviders = this.#modelProviders.map((entry) =>
      entry.id === providerId ? updated : entry,
    );
    return structuredClone(updated);
  }

  async listSandboxProviders() {
    this.#guard();
    return {
      data: structuredClone(this.#sandboxProviders),
      credentialEncryptionConfigured: true,
    };
  }

  async listSandboxSnapshots(providerId: string) {
    this.#guard();
    const provider = this.#sandboxProviders.find(
      (entry) => entry.id === providerId,
    );
    if (!provider) throw new Error("Sandbox provider not found.");
    return {
      data: [
        {
          id: DAYTONA_SNAPSHOT_ID,
          providerType: "daytona" as const,
          name: "daytona-small",
          state: "active",
          available: true,
          imageName: "daytonaio/sandbox:0.9.0",
          general: true,
          cpu: 1,
          gpu: 0,
          memoryGiB: 1,
          diskGiB: 3,
          regionIds: ["eu", "us"],
          sandboxClass: "container",
          createdAt: "2026-07-28T14:58:11.540Z",
          updatedAt: "2026-08-20T15:26:23.838Z",
          lastUsedAt: "2026-08-20T15:26:23.827Z",
        },
        {
          id: DAYTONA_LARGE_SNAPSHOT_ID,
          providerType: "daytona" as const,
          name: "daytona-large",
          state: "active",
          available: true,
          imageName: "daytonaio/sandbox:0.9.0",
          general: true,
          cpu: 4,
          gpu: 0,
          memoryGiB: 8,
          diskGiB: 10,
          regionIds: ["eu", "us"],
          sandboxClass: "container",
          createdAt: "2026-07-28T14:58:11.540Z",
          updatedAt: "2026-08-20T15:26:23.838Z",
          lastUsedAt: "2026-08-20T15:26:23.827Z",
        },
      ],
      providerId,
      providerType: "daytona" as const,
    };
  }

  async createSandboxProvider(
    input: CreateSandboxProviderInput,
  ): Promise<ProjectSandboxProvider> {
    this.#guard();
    this.#counter += 1;
    const now = new Date().toISOString();
    const created: ProjectSandboxProvider = {
      id: `66666666-6666-4666-8666-${String(this.#counter).padStart(12, "0")}`,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      key: input.key,
      displayName: input.displayName,
      providerType: "daytona",
      credentialConfigured: true,
      credentialFingerprint: "c3d4e5f6a1b2",
      credentialVersion: 1,
      target: input.target,
      restrictedEgress: {
        allowedDomains: [...input.restrictedEgress.allowedDomains],
        allowedCidrs: [...input.restrictedEgress.allowedCidrs],
      },
      createdByPrincipalId: principalId,
      createdAt: now,
      updatedAt: now,
    };
    this.#sandboxProviders = [...this.#sandboxProviders, created];
    return structuredClone(created);
  }

  async rotateSandboxProviderCredential(
    providerId: string,
    apiKey: string,
  ): Promise<ProjectSandboxProvider> {
    this.#guard();
    void apiKey;
    const current = this.#sandboxProviders.find(
      (entry) => entry.id === providerId,
    );
    if (!current) throw new Error("Sandbox provider not found.");
    const updated = {
      ...current,
      credentialVersion: current.credentialVersion + 1,
      credentialFingerprint: "e5f6a1b2c3d4",
      updatedAt: new Date().toISOString(),
    };
    this.#sandboxProviders = this.#sandboxProviders.map((entry) =>
      entry.id === providerId ? updated : entry,
    );
    return structuredClone(updated);
  }

  async updateSandboxProviderConfiguration(
    providerId: string,
    input: UpdateSandboxProviderConfigurationInput,
  ): Promise<ProjectSandboxProvider> {
    this.#guard();
    const current = this.#sandboxProviders.find(
      (entry) => entry.id === providerId,
    );
    if (!current) throw new Error("Sandbox provider not found.");
    const updated = {
      ...current,
      target: input.target,
      restrictedEgress: {
        allowedDomains: [...input.restrictedEgress.allowedDomains],
        allowedCidrs: [...input.restrictedEgress.allowedCidrs],
      },
      updatedAt: new Date().toISOString(),
    };
    this.#sandboxProviders = this.#sandboxProviders.map((entry) =>
      entry.id === providerId ? updated : entry,
    );
    return structuredClone(updated);
  }

  async listStorageProviders() {
    this.#guard();
    return {
      data: structuredClone(this.#storageProviders),
      credentialEncryptionConfigured: true,
    };
  }

  async createStorageProvider(
    input: CreateStorageProviderInput,
  ): Promise<ProjectStorageProvider> {
    this.#guard();
    this.#counter += 1;
    const now = new Date().toISOString();
    const makeDefault = input.setDefault || this.#storageProviders.length === 0;
    if (makeDefault)
      this.#storageProviders = this.#storageProviders.map((provider) => ({
        ...provider,
        default: false,
      }));
    const created: ProjectStorageProvider = {
      id: `88888888-8888-4888-8888-${String(this.#counter).padStart(12, "0")}`,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      key: input.key,
      displayName: input.displayName,
      providerType: "s3",
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      prefix: input.prefix,
      forcePathStyle: input.forcePathStyle,
      default: makeDefault,
      credentialConfigured: true,
      credentialFingerprint: "a1b2c3d4e5f6",
      credentialVersion: 1,
      createdByPrincipalId: principalId,
      createdAt: now,
      updatedAt: now,
    };
    this.#storageProviders = [...this.#storageProviders, created];
    return structuredClone(created);
  }

  async rotateStorageProviderCredential(
    providerId: string,
    credential: Pick<
      CreateStorageProviderInput,
      "accessKeyId" | "secretAccessKey" | "sessionToken"
    >,
  ): Promise<ProjectStorageProvider> {
    this.#guard();
    void credential;
    const current = this.#storageProviders.find(
      (provider) => provider.id === providerId,
    );
    if (!current) throw new Error("Storage provider not found.");
    const updated = {
      ...current,
      credentialVersion: current.credentialVersion + 1,
      credentialFingerprint: "b2c3d4e5f6a1",
      updatedAt: new Date().toISOString(),
    };
    this.#storageProviders = this.#storageProviders.map((provider) =>
      provider.id === providerId ? updated : provider,
    );
    return structuredClone(updated);
  }

  async setDefaultStorageProvider(
    providerId: string,
  ): Promise<ProjectStorageProvider> {
    this.#guard();
    if (!this.#storageProviders.some((provider) => provider.id === providerId))
      throw new Error("Storage provider not found.");
    this.#storageProviders = this.#storageProviders.map((provider) => ({
      ...provider,
      default: provider.id === providerId,
      updatedAt:
        provider.id === providerId
          ? new Date().toISOString()
          : provider.updatedAt,
    }));
    return structuredClone(
      this.#storageProviders.find((provider) => provider.id === providerId)!,
    );
  }

  async listStorageObjects(
    providerId: string,
    query?: { readonly prefix?: string; readonly cursor?: string },
  ): Promise<StorageObjectList> {
    this.#guard();
    if (!this.#storageProviders.some((provider) => provider.id === providerId))
      throw new Error("Storage provider not found.");
    const demoObjects: readonly StorageObjectEntry[] = [
      {
        key: "run-files/runs/run-demo-0001/4f2a11aa-demo/quarterly-report.csv",
        sizeBytes: 48_213,
        lastModifiedAt: "2026-08-18T09:12:00.000Z",
      },
      {
        key: "run-files/runs/run-demo-0001/9c8b22bb-demo/customer-notes.md",
        sizeBytes: 5_120,
        lastModifiedAt: "2026-08-18T09:12:00.000Z",
      },
      {
        key: "workspace-backups/threads/thread-demo-0001/workspace.tar.gz",
        sizeBytes: 1_204_224,
        lastModifiedAt: "2026-08-19T16:40:00.000Z",
      },
      {
        key: "workspace-backups/threads/thread-demo-0001/workspace.manifest.json",
        sizeBytes: 2_048,
        lastModifiedAt: "2026-08-19T16:40:00.000Z",
      },
    ];
    const rawPrefix = query?.prefix ?? "";
    const prefix =
      rawPrefix && !rawPrefix.endsWith("/") ? `${rawPrefix}/` : rawPrefix;
    const folders = new Set<string>();
    const objects: StorageObjectEntry[] = [];
    for (const object of demoObjects) {
      if (!object.key.startsWith(prefix)) continue;
      const remainder = object.key.slice(prefix.length);
      const slash = remainder.indexOf("/");
      if (slash >= 0) folders.add(`${prefix}${remainder.slice(0, slash + 1)}`);
      else objects.push(object);
    }
    return {
      providerId,
      prefix,
      folders: [...folders].sort(),
      objects,
      truncated: false,
    };
  }

  async listModelCatalog(providerId: string, search?: string) {
    this.#guard();
    const provider = this.#modelProviders.find(
      (entry) => entry.id === providerId,
    );
    if (!provider) throw new Error("Model provider not found.");
    const term = search?.trim().toLowerCase();
    return {
      data: structuredClone(modelCatalogSeed).filter(
        (entry) =>
          entry.providerType === provider.providerType &&
          (!term ||
            entry.catalogId.toLowerCase().includes(term ?? "") ||
            entry.name.toLowerCase().includes(term ?? "")),
      ),
      providerId,
      providerType: provider.providerType,
    };
  }

  async createModelPreset(input: CreateModelPresetInput): Promise<ModelPreset> {
    this.#guard();
    if (this.#modelPresets.some((preset) => preset.key === input.key))
      throw new Error("Model preset key already exists in this project.");
    if (!modelCatalogSeed.some((entry) => entry.model === input.model))
      throw new Error("model is not present in the provider catalog.");
    this.#counter += 1;
    const created: ModelPreset = {
      id: `44444444-4444-4444-8444-${String(this.#counter).padStart(12, "0")}`,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      key: input.key,
      displayName: input.displayName,
      origin: "project",
      providerId: input.providerId,
      providerType:
        this.#modelProviders.find((entry) => entry.id === input.providerId)
          ?.providerType ?? null,
      model: input.model,
      routing: input.routing,
      settings: input.settings ?? null,
      hosted: true,
      available: true,
      createdByPrincipalId: principalId,
      createdAt: new Date().toISOString(),
    };
    this.#modelPresets = [...this.#modelPresets, created];
    return structuredClone(created);
  }

  async getSettings() {
    this.#guard();
    return structuredClone({
      ...settingsSeed,
      members: this.#members,
      apiKeys: this.#apiKeys,
    });
  }

  async addMember(
    input: Parameters<ConsoleApi["addMember"]>[0],
  ): Promise<void> {
    this.#guard();
    const existing = this.#members.find(
      (member) => member.subject === input.subject,
    );
    if (existing) {
      this.#members = this.#members.map((member) =>
        member.id === existing.id
          ? { ...member, role: input.role, scopes: [...input.scopes] }
          : member,
      );
      return;
    }
    const name = input.subject.includes("@")
      ? input.subject
          .slice(0, input.subject.indexOf("@"))
          .replaceAll(/[._-]+/gu, " ")
      : input.subject.replaceAll(/[._-]+/gu, " ");
    this.#members = [
      {
        id: crypto.randomUUID(),
        name: name || "Project member",
        subject: input.subject,
        ...(input.subject.includes("@") ? { email: input.subject } : {}),
        role: input.role,
        scopes: [...input.scopes],
        current: false,
      },
      ...this.#members,
    ];
  }

  async updateMemberRole(
    memberId: string,
    role: SettingsData["members"][number]["role"],
  ): Promise<void> {
    this.#guard();
    if (!this.#members.some((member) => member.id === memberId))
      throw new Error("Project member not found");
    this.#members = this.#members.map((member) =>
      member.id === memberId ? { ...member, role } : member,
    );
  }

  async removeMember(memberId: string): Promise<void> {
    this.#guard();
    const member = this.#members.find((entry) => entry.id === memberId);
    if (!member) throw new Error("Project member not found");
    if (member.current)
      throw new Error("The active principal cannot remove itself");
    this.#members = this.#members.filter((entry) => entry.id !== memberId);
  }

  async createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    this.#guard();
    this.#counter += 1;
    const suffix = String(this.#counter).padStart(10, "0");
    const key: ApiKeySummary = {
      id: `key_demo_${suffix}`,
      name: input.name,
      prefix: `demo${suffix}`,
      scopes: [...input.scopes],
      lastUsedAt: null,
    };
    this.#apiKeys = [key, ...this.#apiKeys];
    return {
      ...structuredClone(key),
      shown: true,
      secret: `oao_demo${suffix}_demo-only-secret-value-${suffix}`,
    };
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
