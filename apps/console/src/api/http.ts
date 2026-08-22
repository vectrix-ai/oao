import type {
  AgentDetail,
  AgentSummary,
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
  ModelCatalogList,
  ModelPreset,
  ModelPresetList,
  PageResult,
  PendingWork,
  ProjectContext,
  ProjectModelProvider,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  SandboxProviderList,
  SandboxSnapshotList,
  StorageObjectList,
  StorageProviderList,
  SessionDetail,
  SessionSummary,
  SkillDetail,
  SkillFileInput,
  SkillDraft,
  SkillSummary,
  SettingsData,
  TimelineEvent,
  TimelineKind,
  UpdateSandboxProviderConfigurationInput,
  McpServer,
  McpCredential,
  McpCredentialPolicy,
  McpToolset,
  McpServerList,
  McpCredentialList,
  McpCredentialPolicyList,
  McpToolsetList,
} from "./types";
import { parseProductEvent, parseSseFrames } from "./sse";

interface CursorPage<T> {
  readonly data: readonly T[];
  readonly pageInfo?: {
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
  readonly page?: number;
  readonly pageSize?: number;
  readonly total?: number;
}

interface ContextResponse {
  readonly principal: {
    readonly id: string;
    readonly kind: "human" | "api_key" | "service";
    readonly subject: string;
    readonly scopes: readonly string[];
  };
  readonly organization: { readonly id: string; readonly name: string };
  readonly project: { readonly id: string; readonly name: string };
  readonly organizations: readonly {
    readonly id: string;
    readonly name: string;
  }[];
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly activeModelPresets?: readonly string[];
  readonly authProvider?: "development" | "workos";
}

class HttpConsoleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpConsoleError";
  }
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Debug collections that describe work the agent did, so they read as
 * transcript activity. Everything else is platform telemetry, which the
 * transcript drops and only the debug timeline shows.
 */
const CALLER_VISIBLE_DEBUG = new Set([
  "toolCalls",
  "approvals",
  "sandboxCommands",
  "sandboxes",
]);

/**
 * Event kinds the transcript keeps. A run envelope or a model invocation is
 * bookkeeping about the turn, not part of the story of the turn, so it is
 * telemetry however the read model happens to label it.
 */
const TRANSCRIPT_KINDS = new Set<TimelineKind>([
  "tool",
  "approval",
  "error",
  "retry",
  "recovery",
]);

function idempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `console-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function contextView(response: ContextResponse): ProjectContext {
  const subject = response.principal.subject;
  const displayName = subject.includes("@")
    ? subject.slice(0, subject.indexOf("@")).replaceAll(/[._-]+/gu, " ")
    : subject.replaceAll(/[._-]+/gu, " ");
  return {
    organization: response.organization,
    project: response.project,
    currentPrincipal: {
      ...response.principal,
      displayName: displayName || "Authenticated user",
      role: response.principal.scopes.includes("*")
        ? "Platform owner"
        : response.principal.kind.replaceAll("_", " "),
    },
    organizations: response.organizations,
    projects: response.projects,
    ...(response.activeModelPresets
      ? { activeModelPresets: response.activeModelPresets }
      : {}),
    ...(response.authProvider ? { authProvider: response.authProvider } : {}),
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timelineKind(value: unknown): TimelineKind {
  const kind = text(value).toLowerCase();
  if (kind.includes("reasoning")) return "reasoning";
  if (kind.includes("approval")) return "approval";
  if (kind.includes("tool") || kind.includes("sandbox")) return "tool";
  if (kind.includes("retry")) return "retry";
  if (kind.includes("recover")) return "recovery";
  if (kind.includes("error") || kind.includes("fail")) return "error";
  if (kind === "user") return "user";
  return "assistant";
}

function durationMs(startedAt: unknown, completedAt: unknown): number | null {
  if (!startedAt || !completedAt) return null;
  const duration = Date.parse(text(completedAt)) - Date.parse(text(startedAt));
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function safePayload(
  rendered: Readonly<Record<string, unknown>>,
): NonNullable<TimelineEvent["payload"]> {
  return {
    rendered,
    raw: null,
    redacted: true,
    redactionReason:
      "Only public, redacted metadata is available in this view.",
  };
}

function visiblePayload(
  rendered: Readonly<Record<string, unknown>>,
): NonNullable<TimelineEvent["payload"]> {
  return {
    rendered,
    raw: JSON.stringify(rendered, null, 2),
    redacted: false,
  };
}

function sessionSummary(
  value: Readonly<Record<string, unknown>>,
): SessionSummary {
  const costProvenance = text(
    value.costProvenance,
    "unavailable",
  ) as SessionSummary["costProvenance"];
  return {
    id: text(value.id),
    title: text(value.title, "Untitled session"),
    ...(value.parentSessionId === null || value.parentSessionId === undefined
      ? {}
      : { parentSessionId: text(value.parentSessionId) }),
    ...(value.delegateKey === null || value.delegateKey === undefined
      ? {}
      : { delegateKey: text(value.delegateKey) }),
    status: text(value.status, "queued") as SessionSummary["status"],
    agentId: text(value.agentId),
    agentName: text(value.agentName, "Managed agent"),
    inputTokens: numeric(value.inputTokens),
    outputTokens: numeric(value.outputTokens),
    observedCostUsd:
      costProvenance === "unavailable" ||
      value.costMicrounits === null ||
      value.costMicrounits === undefined
        ? null
        : numeric(value.costMicrounits) / 1_000_000,
    costProvenance,
    createdAt: text(value.createdAt),
    lastActivityAt: text(value.lastActivityAt ?? value.createdAt),
  };
}

const FILE_ARGUMENT_KEYS = new Set([
  "path",
  "file",
  "filePath",
  "filename",
  "outputPath",
  "destination",
]);
const SHELL_FILE_PATH =
  /(?:^|[\s"'=])((?:\/|\.{1,2}\/|\.oao\/)[^\s"'`|;&<>]+\.[a-z0-9][a-z0-9._-]*)/giu;

function workspacePath(
  value: string,
): { readonly name: string; readonly path: string } | null {
  const path = value.trim().replace(/[),:]+$/u, "");
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\n") ||
    path.endsWith("/") ||
    /[*?[\]]/u.test(path)
  )
    return null;
  const name = path.split("/").filter(Boolean).at(-1);
  if (!name || name === "." || name === "..") return null;
  return { name, path };
}

function commandFilePaths(command: string): readonly string[] {
  return [...command.matchAll(SHELL_FILE_PATH)]
    .map((match) => match[1])
    .filter((path): path is string => Boolean(path));
}

function argumentFilePaths(value: unknown, key = ""): readonly string[] {
  if (typeof value === "string") {
    if (key === "command") return commandFilePaths(value);
    return FILE_ARGUMENT_KEYS.has(key) ? [value] : [];
  }
  if (Array.isArray(value))
    return value.flatMap((item) => argumentFilePaths(item, key));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Readonly<Record<string, unknown>>).flatMap(
    ([nestedKey, nested]) => argumentFilePaths(nested, nestedKey),
  );
}

function workspaceFiles(
  debug: Readonly<Record<string, unknown>>,
  transcript: readonly Readonly<Record<string, unknown>>[],
): SessionDetail["workspaceFiles"] {
  const backupRecords = (
    Array.isArray(debug.workspaceBackups) ? debug.workspaceBackups : []
  ).map(record);
  const backups = backupRecords
    .map((backup) => text(backup.backedUpAt))
    .filter(Boolean)
    .sort();
  const latestBackup = [...backupRecords]
    .filter(
      (backup) => text(backup.storageProviderId) && text(backup.objectKey),
    )
    .sort((left, right) =>
      text(left.backedUpAt).localeCompare(text(right.backedUpAt)),
    )
    .at(-1);
  const latestBackupLocation = latestBackup
    ? {
        storageProviderId: text(latestBackup.storageProviderId),
        objectKey: text(latestBackup.objectKey),
      }
    : undefined;
  const files = new Map<string, SessionDetail["workspaceFiles"][number]>();
  let hasAuthoritativeManifest = false;
  for (const backup of backupRecords) {
    if (text(backup.manifestState) !== "available") continue;
    hasAuthoritativeManifest = true;
    const backedUpAt = text(backup.backedUpAt);
    const backupProviderId = text(backup.storageProviderId);
    const backupObjectKey = text(backup.objectKey);
    const manifestFiles = Array.isArray(backup.files) ? backup.files : [];
    for (const item of manifestFiles) {
      const manifestFile = record(item);
      const file = workspacePath(text(manifestFile.path));
      if (!file) continue;
      files.set(file.path, {
        ...file,
        sizeBytes: numeric(manifestFile.sizeBytes),
        backedUp: true,
        ...(backedUpAt ? { backedUpAt } : {}),
        ...(backupProviderId ? { storageProviderId: backupProviderId } : {}),
        ...(backupObjectKey ? { objectKey: backupObjectKey } : {}),
      });
    }
  }
  for (const message of transcript) {
    const runId = text(message.runId);
    if (!runId) continue;
    const attachments = Array.isArray(message.files) ? message.files : [];
    for (const item of attachments) {
      const attachment = record(item);
      const name = text(attachment.fileName ?? attachment.name);
      const file = workspacePath(`.oao/attachments/${runId}/${name}`);
      if (!file) continue;
      const existing = files.get(file.path);
      const storageProviderId = text(attachment.storageProviderId);
      const objectKey = text(attachment.objectKey);
      files.set(file.path, {
        ...file,
        sizeBytes: numeric(attachment.sizeBytes),
        uploaded: true,
        backedUp: existing?.backedUp ?? false,
        ...(existing?.backedUpAt ? { backedUpAt: existing.backedUpAt } : {}),
        ...(storageProviderId
          ? { storageProviderId }
          : existing?.storageProviderId
            ? { storageProviderId: existing.storageProviderId }
            : {}),
        ...(objectKey
          ? { objectKey }
          : existing?.objectKey
            ? { objectKey: existing.objectKey }
            : {}),
      });
    }
  }
  if (hasAuthoritativeManifest)
    return [...files.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  const commands = Array.isArray(debug.sandboxCommands)
    ? debug.sandboxCommands
    : [];
  for (const item of commands) {
    const command = record(item);
    if (text(command.state) !== "completed") continue;
    const safeCommand = record(command.safeCommand);
    const completedAt = text(
      command.completedAt ?? command.startedAt ?? command.createdAt,
    );
    const backedUpAt = backups.find((timestamp) => timestamp >= completedAt);
    const candidates = argumentFilePaths(safeCommand.arguments ?? safeCommand);
    for (const candidate of candidates) {
      const file = workspacePath(candidate);
      if (!file) continue;
      const existing = files.get(file.path);
      const backedUp = Boolean(backedUpAt) || Boolean(existing?.backedUp);
      const location = existing?.storageProviderId
        ? {
            storageProviderId: existing.storageProviderId,
            ...(existing.objectKey ? { objectKey: existing.objectKey } : {}),
          }
        : backedUp && latestBackupLocation
          ? latestBackupLocation
          : {};
      files.set(file.path, {
        ...file,
        ...(existing?.sizeBytes === undefined
          ? {}
          : { sizeBytes: existing.sizeBytes }),
        ...(existing?.uploaded ? { uploaded: true } : {}),
        backedUp,
        ...(backedUpAt
          ? { backedUpAt }
          : existing?.backedUpAt
            ? { backedUpAt: existing.backedUpAt }
            : {}),
        ...location,
      });
    }
  }
  return [...files.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function sessionDetail(
  value: Readonly<Record<string, unknown>>,
): SessionDetail {
  const summary = sessionSummary(value);
  const runs = Array.isArray(value.runs) ? value.runs.map(record) : [];
  const transcriptRecords = Array.isArray(value.transcript)
    ? value.transcript.map(record)
    : [];
  const debug = record(value.debug);
  const latestRunId = text(value.latestRunId ?? value.runId ?? runs.at(-1)?.id);
  const latestRun =
    runs.find((run) => text(run.id) === latestRunId) ?? runs.at(-1) ?? {};
  const transcript: TimelineEvent[] = transcriptRecords.map(
    (message, index) => {
      const role = text(message.role, "assistant");
      const files = (Array.isArray(message.files) ? message.files : []).map(
        (value, fileIndex) => {
          const file = record(value);
          return {
            id: text(file.id, `${text(message.id)}-file-${fileIndex}`),
            name: text(file.fileName ?? file.name, "Attached file"),
            contentType: text(file.contentType, "application/octet-stream"),
            sizeBytes: numeric(file.sizeBytes),
            sha256: text(file.sha256),
          };
        },
      );
      return {
        id: text(message.id, `message-${index}`),
        kind: timelineKind(role),
        source: "message",
        title:
          role === "user" ? "User" : role === "tool" ? "Tool" : "Assistant",
        summary: text(message.redactedContent, "Redacted message"),
        createdAt: text(message.createdAt, summary.createdAt),
        durationMs: null,
        status: "success",
        ...(files.length ? { files } : {}),
      };
    },
  );
  const timeline: TimelineEvent[] = (
    Array.isArray(value.timeline) ? value.timeline : []
  ).map((item, index) => {
    const entry = record(item);
    const type = text(entry.entryType, "runtime event");
    const detail = record(entry.safeDetail);
    const completedAt = entry.completedAt;
    return {
      id: `${text(entry.runId, latestRunId)}:timeline:${text(entry.entrySequence, String(index))}`,
      kind: timelineKind(type),
      source: TRANSCRIPT_KINDS.has(timelineKind(type)) ? "activity" : "runtime",
      title: type.replaceAll("_", " "),
      summary: text(
        detail.summary ?? detail.message ?? detail.model ?? detail.status,
        "Safe runtime metadata",
      ),
      createdAt: text(entry.startedAt, summary.createdAt),
      durationMs: durationMs(entry.startedAt, completedAt),
      status:
        timelineKind(type) === "error"
          ? "error"
          : completedAt
            ? "success"
            : "pending",
      payload: safePayload(detail),
    };
  });
  const reasoningTiming = (
    detail: Readonly<Record<string, unknown>>,
  ): { readonly createdAt: string; readonly durationMs: number | null } => {
    const rawStart = text(detail.startedAt, summary.createdAt);
    const rawDuration = durationMs(detail.startedAt, detail.completedAt);
    if (rawDuration !== null && rawDuration > 0)
      return { createdAt: rawStart, durationMs: rawDuration };
    const completed = Date.parse(text(detail.completedAt));
    const runId = text(detail.runId);
    if (!Number.isFinite(completed) || !runId)
      return { createdAt: rawStart, durationMs: rawDuration };
    const boundaries: number[] = [];
    const addBoundary = (candidate: unknown) => {
      const parsed = Date.parse(text(candidate));
      if (Number.isFinite(parsed) && parsed < completed)
        boundaries.push(parsed);
    };
    for (const run of runs)
      if (text(run.id) === runId) addBoundary(run.createdAt);
    for (const message of transcriptRecords)
      if (text(message.runId) === runId) addBoundary(message.createdAt);
    for (const collection of [
      "sandboxCommands",
      "toolCalls",
      "approvals",
      "modelInvocations",
    ]) {
      const records = debug[collection];
      if (!Array.isArray(records)) continue;
      for (const candidateValue of records) {
        const candidate = record(candidateValue);
        if (
          text(candidate.runId) !== runId ||
          text(candidate.id) === text(detail.id)
        )
          continue;
        addBoundary(
          candidate.completedAt ??
            candidate.resolvedAt ??
            candidate.updatedAt ??
            candidate.createdAt,
        );
      }
    }
    const inferredStart = Math.max(...boundaries);
    if (!Number.isFinite(inferredStart))
      return { createdAt: rawStart, durationMs: rawDuration };
    return {
      createdAt: new Date(inferredStart).toISOString(),
      durationMs: completed - inferredStart,
    };
  };
  const debugEvents: TimelineEvent[] = [];
  for (const [collection, items] of Object.entries(debug)) {
    if (!Array.isArray(items)) continue;
    items.forEach((item, index) => {
      const detail = record(item);
      if (collection === "modelInvocations") {
        const response = record(detail.safeResponse);
        const timing = reasoningTiming(detail);
        const thinking = text(response.thinking);
        const rendered = {
          ...(thinking ? { thinking } : {}),
          model: text(detail.modelKey),
          attempt: numeric(detail.attempt),
          finishReason: text(response.finishReason, "unknown"),
        };
        const state = text(detail.status, "completed");
        debugEvents.push({
          id: `debug:${collection}:${text(detail.id, String(index))}`,
          kind: "reasoning",
          source: "activity",
          title: "Reasoning",
          summary: thinking || "Model reasoning",
          createdAt: timing.createdAt,
          durationMs: timing.durationMs,
          status: state.includes("fail")
            ? "error"
            : state === "completed"
              ? "success"
              : "pending",
          tokens: {
            input: numeric(detail.inputTokens),
            output: numeric(detail.outputTokens),
          },
          ...(detail.costMicrounits !== undefined
            ? { costUsd: numeric(detail.costMicrounits) / 1_000_000 }
            : {}),
          payload: visiblePayload(rendered),
        });
        return;
      }
      const type = text(
        detail.eventKind ??
          detail.toolName ??
          detail.commandName ??
          detail.status ??
          collection,
        collection,
      );
      const state = text(detail.state ?? detail.status, "");
      const createdAt =
        detail.occurredAt ??
        detail.startedAt ??
        detail.createdAt ??
        summary.createdAt;
      const command = record(detail.safeCommand);
      const result = record(detail.safeResult);
      const arguments_ =
        collection === "toolCalls"
          ? record(detail.safeArguments)
          : (command.arguments ?? command);
      const toolPayload = {
        arguments: arguments_,
        ...(result.output !== undefined
          ? { result: result.output }
          : result.redactedOutput !== undefined
            ? { result: result.redactedOutput }
            : {}),
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      };
      const argumentsRecord = record(arguments_);
      const toolCallPayload = {
        arguments: arguments_,
        ...(detail.owner !== undefined ? { owner: text(detail.owner) } : {}),
        ...(detail.stage !== undefined ? { stage: text(detail.stage) } : {}),
      };
      debugEvents.push({
        id: `debug:${collection}:${text(detail.id, String(index))}`,
        kind: timelineKind(`${collection} ${type}`),
        source: CALLER_VISIBLE_DEBUG.has(collection) ? "activity" : "runtime",
        title: type.replaceAll("_", " "),
        summary: text(
          detail.path ??
            detail.commandName ??
            detail.origin ??
            detail.action ??
            argumentsRecord.path ??
            argumentsRecord.command ??
            argumentsRecord.url ??
            argumentsRecord.action ??
            detail.summary ??
            detail.message ??
            detail.modelKey ??
            detail.toolName,
          `${collection.replaceAll(/([A-Z])/gu, " $1").toLowerCase()} metadata`,
        ),
        createdAt: text(createdAt),
        durationMs: durationMs(
          detail.startedAt ?? detail.createdAt,
          detail.completedAt ?? detail.updatedAt,
        ),
        status:
          state.includes("fail") || type.includes("fail")
            ? "error"
            : ["reserved", "running"].includes(state)
              ? "pending"
              : state === "completed"
                ? "success"
                : "info",
        ...(detail.inputTokens !== undefined ||
        detail.outputTokens !== undefined
          ? {
              tokens: {
                input: numeric(detail.inputTokens),
                output: numeric(detail.outputTokens),
              },
            }
          : {}),
        ...(detail.costMicrounits !== undefined
          ? { costUsd: numeric(detail.costMicrounits) / 1_000_000 }
          : {}),
        payload:
          collection === "sandboxCommands"
            ? visiblePayload(toolPayload)
            : collection === "toolCalls"
              ? visiblePayload(toolCallPayload)
              : safePayload(detail),
      });
    });
  }
  const settled = ["completed", "failed", "cancelled", "timed_out"].includes(
    summary.status,
  );
  return {
    ...summary,
    runId: latestRunId,
    ...(value.model ? { model: text(value.model) } : {}),
    agentVersion: numeric(value.agentVersion),
    startedAt: text(value.startedAt ?? latestRun.createdAt, summary.createdAt),
    completedAt: value.completedAt
      ? text(value.completedAt)
      : latestRun.settledAt
        ? text(latestRun.settledAt)
        : null,
    attempt: Math.max(
      1,
      ...(
        (Array.isArray(debug.modelInvocations)
          ? debug.modelInvocations
          : []) as unknown[]
      ).map((item) => numeric(record(item).attempt)),
    ),
    events: [...transcript, ...timeline, ...debugEvents].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    workspaceFiles: workspaceFiles(debug, transcriptRecords),
    capabilities: {
      canCancel: !settled,
      canResume: false,
      canBranchReplay: false,
    },
    tools: (Array.isArray(value.tools) ? value.tools : []).map((entry) => {
      const tool = record(entry);
      return {
        name: text(tool.name),
        description: text(tool.description),
        owner: text(
          tool.owner,
          "caller",
        ) as SessionDetail["tools"][number]["owner"],
        approval:
          text(tool.approval, "always") === "never" ? "never" : "always",
      } as const;
    }),
    skills: (Array.isArray(value.skills) ? value.skills : []).map((entry) => {
      const skill = record(entry);
      return {
        skillId: text(skill.skillId),
        skillVersionId: text(skill.skillVersionId),
        version: numeric(skill.version),
        name: text(skill.name),
        description: text(skill.description),
        contentHash: text(skill.contentHash),
        status: text(skill.status, "active") as
          "active" | "deprecated" | "revoked",
      };
    }),
    delegations: (Array.isArray(value.delegations)
      ? value.delegations
      : []
    ).map((entry) => {
      const delegation = record(entry);
      return {
        id: text(delegation.id),
        delegateKey: text(delegation.delegateKey),
        direction: text(delegation.direction, "outgoing") as
          "outgoing" | "parent",
        parentSessionId: text(delegation.parentSessionId),
        childAgentVersionId: text(delegation.childAgentVersionId),
        childSessionId: text(delegation.childSessionId),
        latestChildRunId: text(delegation.latestChildRunId),
        latestChildRunState: text(
          delegation.latestChildRunState,
          "queued",
        ) as SessionDetail["delegations"][number]["latestChildRunState"],
        state: text(delegation.state, "active") as "active" | "cancelled",
      };
    }),
    runs,
    transcript: transcriptRecords,
    pendingWork: Array.isArray(value.pendingWork)
      ? value.pendingWork.map(record)
      : [],
    debug,
  };
}

export class HttpConsoleApi implements ConsoleApi {
  readonly #baseUrl: string;
  readonly #getAccessToken: () => Promise<string | null>;
  readonly #navigateTo: (url: string) => void;
  #contextPromise: Promise<ProjectContext> | undefined;

  constructor(
    input: {
      readonly baseUrl?: string;
      readonly getAccessToken?: () => Promise<string | null>;
      readonly navigateTo?: (url: string) => void;
    } = {},
  ) {
    this.#baseUrl = (input.baseUrl ?? "/v1").replace(/\/$/u, "");
    this.#getAccessToken = input.getAccessToken ?? (async () => null);
    this.#navigateTo =
      input.navigateTo ?? ((url) => globalThis.location.assign(url));
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.#getAccessToken();
    const method = (init.method ?? "GET").toUpperCase();
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(UNSAFE_METHODS.has(method)
          ? { "idempotency-key": idempotencyKey() }
          : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const body = (await response.json()) as {
          readonly error?: { readonly message?: string };
          readonly message?: string;
        };
        message = body.error?.message ?? body.message ?? message;
      } catch {
        // The status remains actionable when a proxy returns a non-JSON body.
      }
      throw new HttpConsoleError(response.status, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async #loadContext(): Promise<ProjectContext> {
    try {
      return contextView(await this.#request<ContextResponse>("/context"));
    } catch (error) {
      if (!(error instanceof HttpConsoleError) || error.status !== 401)
        throw error;
      try {
        await this.#request("/auth/development/login", {
          method: "POST",
          body: "{}",
        });
      } catch (loginError) {
        if (
          !(loginError instanceof HttpConsoleError) ||
          loginError.status !== 404
        )
          throw loginError;
        const login = await this.#request<{
          readonly authorizationUrl?: unknown;
        }>("/auth/login", { method: "POST", body: "{}" });
        if (
          typeof login.authorizationUrl !== "string" ||
          !login.authorizationUrl.startsWith("https://")
        )
          throw new Error(
            "The authentication provider returned an invalid URL.",
            { cause: loginError },
          );
        this.#navigateTo(login.authorizationUrl);
        throw new Error("Redirecting to WorkOS sign in.", {
          cause: loginError,
        });
      }
      return contextView(await this.#request<ContextResponse>("/context"));
    }
  }

  getContext = (): Promise<ProjectContext> => {
    if (!this.#contextPromise) {
      this.#contextPromise = this.#loadContext().catch((error: unknown) => {
        this.#contextPromise = undefined;
        throw error;
      });
    }
    return this.#contextPromise;
  };

  async #projectPath(path: string): Promise<string> {
    const context = await this.getContext();
    return `/projects/${encodeURIComponent(context.project.id)}${path}`;
  }

  async #projectRequest<T>(path: string, init?: RequestInit): Promise<T> {
    return this.#request<T>(await this.#projectPath(path), init);
  }

  #page<T extends { readonly status?: string; readonly createdAt?: string }>(
    response: CursorPage<T>,
    filters: ListFilters,
    searchable: (item: T) => string,
  ): PageResult<T> {
    if (
      response.page !== undefined &&
      response.pageSize !== undefined &&
      response.total !== undefined
    )
      return response as PageResult<T>;
    const term = filters.search?.trim().toLowerCase();
    const filtered = response.data.filter(
      (item) =>
        (!term || searchable(item).toLowerCase().includes(term)) &&
        (!filters.status || item.status === filters.status) &&
        (!filters.date || item.createdAt?.slice(0, 10) === filters.date),
    );
    const page = filters.page ?? 1;
    const pageSize = 10;
    return {
      data: filtered.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: filtered.length,
    };
  }

  listAgents = async (filters: ListFilters) => {
    const response =
      await this.#projectRequest<CursorPage<AgentSummary>>("/agents?limit=100");
    return this.#page(
      response,
      filters,
      (agent) =>
        `${agent.name} ${agent.key} ${agent.description} ${agent.model}`,
    );
  };

  getAgent = async (id: string): Promise<AgentDetail> => {
    const path = `/agents/${encodeURIComponent(id)}`;
    const agent = await this.#projectRequest<AgentDetail>(path);
    if (Array.isArray(agent.versions))
      return {
        ...agent,
        versions: agent.versions.map((version) => ({
          ...version,
          createdBy:
            version.createdBy ??
            text(
              (version as unknown as Record<string, unknown>)
                .createdByPrincipalId,
              "Unknown principal",
            ),
        })),
      };
    const versions = await this.#projectRequest<
      CursorPage<AgentDetail["versions"][number]>
    >(`${path}/versions?limit=100`);
    return { ...agent, versions: versions.data };
  };

  createAgent = async (input: Parameters<ConsoleApi["createAgent"]>[0]) => {
    const created = await this.#projectRequest<AgentSummary>("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        config: input.initialConfig,
      }),
    });
    return (await this.getAgent(created.id)) as AgentSummary;
  };

  publishAgentVersion = async (
    id: string,
    config: Parameters<ConsoleApi["publishAgentVersion"]>[1],
  ) => {
    await this.#projectRequest(`/agents/${encodeURIComponent(id)}/versions`, {
      method: "POST",
      body: JSON.stringify({ config }),
    });
    return this.getAgent(id);
  };

  listSkills = async (filters: ListFilters) => {
    const response =
      await this.#projectRequest<CursorPage<SkillSummary>>("/skills?limit=100");
    return this.#page(
      response,
      filters,
      (skill) => `${skill.displayName} ${skill.key} ${skill.description}`,
    );
  };

  getSkill = async (id: string): Promise<SkillDetail> =>
    this.#projectRequest(`/skills/${encodeURIComponent(id)}`);

  createSkill = async (input: CreateSkillInput): Promise<SkillDetail> => {
    const created = await this.#projectRequest<{ readonly id: string }>(
      "/skills",
      { method: "POST", body: JSON.stringify(input) },
    );
    return this.getSkill(created.id);
  };

  publishSkillVersion = async (
    id: string,
    input: Parameters<ConsoleApi["publishSkillVersion"]>[1],
  ): Promise<SkillDetail> => {
    await this.#projectRequest(`/skills/${encodeURIComponent(id)}/versions`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return this.getSkill(id);
  };

  exportSkillVersion = async (skillId: string, versionId: string) =>
    this.#projectRequest<{ readonly files: readonly SkillFileInput[] }>(
      `/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}/export`,
    );

  createSkillDraft = async (
    input: {
      readonly skillId?: string;
      readonly sourceSkillVersionId?: string;
    } = {},
  ) =>
    this.#projectRequest<SkillDraft>("/skill-drafts", {
      method: "POST",
      body: JSON.stringify(input),
    });

  updateSkillDraft = async (
    draftId: string,
    input: Parameters<ConsoleApi["updateSkillDraft"]>[1],
  ) =>
    this.#projectRequest<SkillDraft>(
      `/skill-drafts/${encodeURIComponent(draftId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );

  createSkillDraftDirectory = async (draftId: string, path: string) =>
    this.#projectRequest<SkillDraft>(
      `/skill-drafts/${encodeURIComponent(draftId)}/directories`,
      { method: "POST", body: JSON.stringify({ path }) },
    );

  putSkillDraftFile = async (draftId: string, file: SkillFileInput) =>
    this.#projectRequest<SkillDraft>(
      `/skill-drafts/${encodeURIComponent(draftId)}/files`,
      { method: "PUT", body: JSON.stringify(file) },
    );

  removeSkillDraftEntry = async (
    draftId: string,
    path: string,
    recursive: boolean,
  ) => {
    const query = new URLSearchParams({ path, recursive: String(recursive) });
    return this.#projectRequest<SkillDraft>(
      `/skill-drafts/${encodeURIComponent(draftId)}/entries?${query.toString()}`,
      { method: "DELETE" },
    );
  };

  validateSkillDraft = async (draftId: string) =>
    this.#projectRequest<{
      readonly valid: true;
      readonly contentHash: string;
      readonly totalBytes: number;
      readonly fileCount: number;
    }>(`/skill-drafts/${encodeURIComponent(draftId)}/validate`, {
      method: "POST",
    });

  publishSkillDraft = async (draftId: string) => {
    const published = await this.#projectRequest<{
      readonly skillId: string;
      readonly version: { readonly id: string };
    }>(`/skill-drafts/${encodeURIComponent(draftId)}/publish`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    return { skillId: published.skillId, versionId: published.version.id };
  };

  discardSkillDraft = async (draftId: string) => {
    await this.#projectRequest(`/skill-drafts/${encodeURIComponent(draftId)}`, {
      method: "DELETE",
    });
  };

  updateSkillVersionLifecycle = async (
    skillId: string,
    versionId: string,
    status: "deprecated" | "revoked",
  ): Promise<SkillDetail> => {
    await this.#projectRequest(
      `/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}/lifecycle`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
    return this.getSkill(skillId);
  };

  listMcpServers = async (): Promise<McpServerList> =>
    this.#projectRequest("/mcp-servers");

  createMcpServer = async (
    input: Parameters<ConsoleApi["createMcpServer"]>[0],
  ): Promise<McpServer> =>
    this.#projectRequest("/mcp-servers", {
      method: "POST",
      body: JSON.stringify(input),
    });

  discoverMcpServer = async (
    serverId: string,
    input: Parameters<ConsoleApi["discoverMcpServer"]>[1],
  ): Promise<McpServer> =>
    this.#projectRequest(
      `/mcp-servers/${encodeURIComponent(serverId)}/discover`,
      { method: "POST", body: JSON.stringify(input) },
    );

  listMcpCredentials = async (): Promise<McpCredentialList> =>
    this.#projectRequest("/mcp-credentials");

  createMcpCredential = async (
    input: Parameters<ConsoleApi["createMcpCredential"]>[0],
  ): Promise<McpCredential> =>
    this.#projectRequest("/mcp-credentials", {
      method: "POST",
      body: JSON.stringify(input),
    });

  rotateMcpCredential = async (
    credentialId: string,
    input: Parameters<ConsoleApi["rotateMcpCredential"]>[1],
  ): Promise<McpCredential> =>
    this.#projectRequest(
      `/mcp-credentials/${encodeURIComponent(credentialId)}/rotate`,
      { method: "POST", body: JSON.stringify(input) },
    );

  revokeMcpCredential = async (credentialId: string): Promise<McpCredential> =>
    this.#projectRequest(
      `/mcp-credentials/${encodeURIComponent(credentialId)}`,
      {
        method: "DELETE",
      },
    );

  listMcpCredentialPolicies = async (): Promise<McpCredentialPolicyList> =>
    this.#projectRequest("/mcp-credential-policies");

  createMcpCredentialPolicy = async (
    input: Parameters<ConsoleApi["createMcpCredentialPolicy"]>[0],
  ): Promise<McpCredentialPolicy> =>
    this.#projectRequest("/mcp-credential-policies", {
      method: "POST",
      body: JSON.stringify(input),
    });

  listMcpToolsets = async (): Promise<McpToolsetList> =>
    this.#projectRequest("/mcp-toolsets");

  createMcpToolset = async (
    input: Parameters<ConsoleApi["createMcpToolset"]>[0],
  ): Promise<McpToolset> =>
    this.#projectRequest("/mcp-toolsets", {
      method: "POST",
      body: JSON.stringify(input),
    });

  listSessions = async (filters: ListFilters) => {
    const response = await this.#projectRequest<
      CursorPage<Record<string, unknown>>
    >("/sessions?limit=100");
    return this.#page(
      { ...response, data: response.data.map(sessionSummary) },
      filters,
      (session) => `${session.id} ${session.title} ${session.agentName}`,
    );
  };

  getSession = async (id: string) =>
    sessionDetail(
      await this.#projectRequest<Record<string, unknown>>(
        `/sessions/${encodeURIComponent(id)}`,
      ),
    );

  createSession = async (input: Parameters<ConsoleApi["createSession"]>[0]) => {
    const agent = await this.getAgent(input.agentId);
    const agentVersionId = agent.versions.find(
      (version) => version.version === agent.version,
    )?.id;
    if (!agentVersionId)
      throw new Error("Publish the agent before creating a session.");
    const created = await this.#projectRequest<Record<string, unknown>>(
      "/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          agentId: input.agentId,
          agentVersionId,
          title: input.title,
          initialMessage: input.initialMessage,
          ...(input.files?.length ? { files: input.files } : {}),
        }),
      },
    );
    const sessionId = String(created.id ?? "");
    if (!sessionId) throw new Error("The API did not return a session id.");
    if (
      typeof created.runId !== "string" &&
      typeof created.latestRunId !== "string"
    )
      await this.#createRun(sessionId, {
        message: input.initialMessage,
        ...(input.files?.length ? { files: input.files } : {}),
      });
    return this.getSession(sessionId);
  };

  async #createRun(
    sessionId: string,
    input: Parameters<ConsoleApi["submitMessage"]>[1],
  ): Promise<void> {
    await this.#projectRequest(
      `/sessions/${encodeURIComponent(sessionId)}/runs`,
      {
        method: "POST",
        body: JSON.stringify({
          message: input.message,
          ...(input.files?.length ? { files: input.files } : {}),
        }),
      },
    );
  }

  submitMessage = async (
    id: string,
    input: Parameters<ConsoleApi["submitMessage"]>[1],
  ) => {
    await this.#createRun(id, input);
    return this.getSession(id);
  };

  runSessionAction = async (
    id: string,
    action: Parameters<ConsoleApi["runSessionAction"]>[1],
  ) => {
    if (action !== "cancel")
      throw new Error(
        `${action.replaceAll("-", " ")} is deferred in the local MVP.`,
      );
    const session = await this.getSession(id);
    await this.#projectRequest(
      `/runs/${encodeURIComponent(session.runId)}/cancel`,
      {
        method: "POST",
        body: "{}",
      },
    );
    return this.getSession(id);
  };

  listPendingWork = async (): Promise<readonly PendingWork[]> => {
    const response =
      await this.#projectRequest<CursorPage<Record<string, unknown>>>(
        "/pending-work",
      );
    const toolWork: PendingWork[] = response.data
      .filter((tool) => tool.kind === "tool")
      .filter((tool) =>
        ["caller_pending", "caller_claimed"].includes(String(tool.stage)),
      )
      .map((tool) => ({
        kind: "tool",
        id: String(tool.id),
        runId: String(tool.runId),
        sessionId: String(tool.sessionId ?? ""),
        title: String(tool.sessionTitle ?? tool.title ?? "Managed session"),
        toolName: String(tool.toolName),
        stage: tool.stage as Extract<PendingWork, { kind: "tool" }>["stage"],
        safeArguments: (tool.safeArguments ?? {}) as Readonly<
          Record<string, unknown>
        >,
        claimedBy:
          tool.claimedBy === null || tool.claimedBy === undefined
            ? null
            : String(tool.claimedBy),
        claimFence: String(tool.claimFence ?? "0"),
        createdAt: String(tool.createdAt),
        expiresAt: String(
          tool.leaseExpiresAt ?? tool.expiresAt ?? tool.createdAt,
        ),
      }));
    const approvalWork: PendingWork[] = response.data
      .filter((approval) => approval.kind === "approval")
      .filter((approval) => String(approval.status) === "pending")
      .map((approval) => ({
        kind: "approval",
        id: String(approval.id),
        runId: String(approval.runId),
        sessionId: String(approval.sessionId ?? ""),
        title: String(
          approval.sessionTitle ?? approval.title ?? "Managed session",
        ),
        summary: String(approval.summary),
        status: "pending",
        createdAt: String(approval.createdAt),
        expiresAt: String(approval.expiresAt ?? approval.createdAt),
      }));
    return [...toolWork, ...approvalWork];
  };

  claimTool = async (id: string) => {
    await this.#projectRequest(`/tool-calls/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      body: JSON.stringify({ leaseMs: 120_000 }),
    });
  };

  submitToolResult = async (
    id: string,
    fence: string,
    result: Readonly<Record<string, unknown>>,
  ) => {
    await this.#projectRequest(`/tool-calls/${encodeURIComponent(id)}/result`, {
      method: "POST",
      body: JSON.stringify({ fence, safeResult: result }),
    });
  };

  decideApproval = async (
    id: string,
    decision: Parameters<ConsoleApi["decideApproval"]>[1],
  ) => {
    await this.#projectRequest(
      `/approvals/${encodeURIComponent(id)}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ status: decision }),
      },
    );
  };

  listModelPresets = async (): Promise<ModelPresetList> => {
    const response = await this.#projectRequest<
      CursorPage<ModelPreset> & {
        readonly credentialEncryptionConfigured?: boolean;
      }
    >("/model-presets?limit=200");
    return {
      data: response.data,
      credentialEncryptionConfigured:
        response.credentialEncryptionConfigured === true,
    };
  };

  listModelProviders = async (): Promise<readonly ProjectModelProvider[]> => {
    const response = await this.#projectRequest<
      CursorPage<ProjectModelProvider>
    >("/model-providers?limit=200");
    return response.data;
  };

  createModelProvider = async (
    input: CreateModelProviderInput,
  ): Promise<ProjectModelProvider> =>
    this.#projectRequest<ProjectModelProvider>("/model-providers", {
      method: "POST",
      body: JSON.stringify(input),
    });

  rotateModelProviderCredential = async (
    providerId: string,
    apiKey: string,
  ): Promise<ProjectModelProvider> =>
    this.#projectRequest<ProjectModelProvider>(
      `/model-providers/${encodeURIComponent(providerId)}/credential`,
      { method: "PUT", body: JSON.stringify({ apiKey }) },
    );

  listSandboxProviders = async (): Promise<SandboxProviderList> => {
    const response = await this.#projectRequest<
      CursorPage<ProjectSandboxProvider> & {
        readonly credentialEncryptionConfigured?: boolean;
      }
    >("/sandbox-providers?limit=200");
    return {
      data: response.data,
      credentialEncryptionConfigured:
        response.credentialEncryptionConfigured === true,
    };
  };

  listSandboxSnapshots = async (
    providerId: string,
  ): Promise<SandboxSnapshotList> =>
    this.#projectRequest<SandboxSnapshotList>(
      `/sandbox-providers/${encodeURIComponent(providerId)}/snapshots`,
    );

  createSandboxProvider = async (
    input: CreateSandboxProviderInput,
  ): Promise<ProjectSandboxProvider> =>
    this.#projectRequest<ProjectSandboxProvider>("/sandbox-providers", {
      method: "POST",
      body: JSON.stringify(input),
    });

  rotateSandboxProviderCredential = async (
    providerId: string,
    apiKey: string,
  ): Promise<ProjectSandboxProvider> =>
    this.#projectRequest<ProjectSandboxProvider>(
      `/sandbox-providers/${encodeURIComponent(providerId)}/credential`,
      { method: "PUT", body: JSON.stringify({ apiKey }) },
    );

  updateSandboxProviderConfiguration = async (
    providerId: string,
    input: UpdateSandboxProviderConfigurationInput,
  ): Promise<ProjectSandboxProvider> =>
    this.#projectRequest<ProjectSandboxProvider>(
      `/sandbox-providers/${encodeURIComponent(providerId)}/configuration`,
      { method: "PUT", body: JSON.stringify(input) },
    );

  listStorageProviders = async (): Promise<StorageProviderList> =>
    this.#projectRequest<StorageProviderList>("/storage-providers");

  createStorageProvider = async (
    input: CreateStorageProviderInput,
  ): Promise<ProjectStorageProvider> =>
    this.#projectRequest<ProjectStorageProvider>("/storage-providers", {
      method: "POST",
      body: JSON.stringify(input),
    });

  rotateStorageProviderCredential = async (
    providerId: string,
    credential: Pick<
      CreateStorageProviderInput,
      "accessKeyId" | "secretAccessKey" | "sessionToken"
    >,
  ): Promise<ProjectStorageProvider> =>
    this.#projectRequest<ProjectStorageProvider>(
      `/storage-providers/${encodeURIComponent(providerId)}/credential`,
      { method: "PUT", body: JSON.stringify(credential) },
    );

  setDefaultStorageProvider = async (
    providerId: string,
  ): Promise<ProjectStorageProvider> =>
    this.#projectRequest<ProjectStorageProvider>(
      `/storage-providers/${encodeURIComponent(providerId)}/default`,
      { method: "PUT", body: JSON.stringify({}) },
    );

  listStorageObjects = async (
    providerId: string,
    query?: { readonly prefix?: string; readonly cursor?: string },
  ): Promise<StorageObjectList> => {
    const params = new URLSearchParams();
    if (query?.prefix) params.set("prefix", query.prefix);
    if (query?.cursor) params.set("cursor", query.cursor);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.#projectRequest<StorageObjectList>(
      `/storage-providers/${encodeURIComponent(providerId)}/objects${suffix}`,
    );
  };

  listModelCatalog = async (
    providerId: string,
    search?: string,
  ): Promise<ModelCatalogList> => {
    const query = search?.trim()
      ? `&search=${encodeURIComponent(search.trim())}`
      : "";
    const response = await this.#projectRequest<
      CursorPage<ModelCatalogEntry> & {
        readonly providerId: string;
        readonly providerType: "openrouter" | "openai";
      }
    >(
      `/model-catalog?limit=200&providerId=${encodeURIComponent(providerId)}${query}`,
    );
    return {
      data: response.data,
      providerId: response.providerId,
      providerType: response.providerType,
    };
  };

  createModelPreset = async (
    input: CreateModelPresetInput,
  ): Promise<ModelPreset> =>
    this.#projectRequest<ModelPreset>("/model-presets", {
      method: "POST",
      body: JSON.stringify(input),
    });

  createApiKey = async (input: CreateApiKeyInput): Promise<CreatedApiKey> => {
    const response = await this.#projectRequest<Record<string, unknown>>(
      "/api-keys",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    const common = {
      id: text(response.id),
      name: text(response.name),
      prefix: text(response.prefix),
      scopes: Array.isArray(response.scopes) ? response.scopes.map(String) : [],
      lastUsedAt: null,
    };
    if (response.shown !== true) return { ...common, shown: false };
    if (typeof response.secret !== "string" || response.secret.length === 0)
      throw new Error("The API created the key without returning its secret.");
    return { ...common, shown: true, secret: response.secret };
  };

  getSettings = async (): Promise<SettingsData> => {
    const context = await this.getContext();
    const [organization, members, apiKeys] = await Promise.all([
      this.#request<Record<string, unknown>>(
        `/organizations/${encodeURIComponent(context.organization.id)}`,
      ),
      this.#projectRequest<CursorPage<Record<string, unknown>>>(
        "/members?limit=100",
      ),
      this.#projectRequest<CursorPage<Record<string, unknown>>>(
        "/api-keys?limit=100",
      ),
    ]);
    return {
      organization: {
        name: String(organization.name ?? context.organization.name),
        slug: String(organization.slug ?? ""),
        createdAt: String(organization.createdAt ?? ""),
      },
      projects: context.projects.map((project) => ({ ...project, slug: "" })),
      members: members.data.map((member) => ({
        id: String(member.id ?? member.principalId),
        name: String(member.name ?? member.subject ?? "Project member"),
        email: String(member.email ?? member.subject ?? ""),
        role: String(member.role) as SettingsData["members"][number]["role"],
      })),
      apiKeys: apiKeys.data.map((key) => ({
        id: String(key.id),
        name: String(key.name),
        prefix: String(key.prefix),
        scopes: Array.isArray(key.scopes) ? key.scopes.map(String) : [],
        lastUsedAt: key.lastUsedAt ? String(key.lastUsedAt) : null,
      })),
      hosting: [],
    };
  };

  connectEvents(
    input: Parameters<ConsoleApi["connectEvents"]>[0],
  ): EventConnection {
    const controller = new AbortController();
    const close = () => controller.abort();
    input.signal?.addEventListener("abort", close, { once: true });
    void this.#streamEvents(input, controller.signal);
    return { close };
  }

  async #streamEvents(
    input: Parameters<ConsoleApi["connectEvents"]>[0],
    signal: AbortSignal,
  ): Promise<void> {
    let cursor = input.after;
    let retryMs = 750;
    while (!signal.aborted) {
      try {
        const token = await this.#getAccessToken();
        const response = await fetch(
          `${this.#baseUrl}${await this.#projectPath("/events")}`,
          {
            credentials: "include",
            headers: {
              accept: "text/event-stream",
              ...(cursor ? { "last-event-id": cursor } : {}),
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            signal,
          },
        );
        if (!response.ok || !response.body)
          throw new Error(`Event stream failed (${response.status})`);
        retryMs = 750;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const parsed = parseSseFrames(buffer);
          buffer = parsed.rest;
          for (const frame of parsed.frames) {
            const event = parseProductEvent(frame);
            if (event) input.onEvent(event);
            if (frame.id) {
              cursor = frame.id;
              input.onCursor(frame.id);
            }
          }
        }
      } catch (error) {
        if (!signal.aborted)
          input.onError(
            error instanceof Error ? error : new Error("Event stream failed"),
          );
      }
      if (!signal.aborted)
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  }
}
