import {
  readApprovalAwareDeadline,
  scheduleApprovalDeadline,
} from "@oao/db-postgres";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Provider } from "@earendil-works/pi-ai";
import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry";
import { postgres } from "@flue/postgres";
import {
  AgentInstanceExistsError,
  AgentRunError,
  defineTool,
  dispatch,
  defineSkill,
  getAgentInstance,
  init,
  instrument,
  observe,
  setProvider,
  useAgentFinish,
  useAgentStart,
  useDelivery,
  useInitialData,
  useModel,
  useSandbox,
  useSkill,
  useTool,
} from "@flue/runtime";
import type {
  DispatchReceipt,
  DeliveredMessage,
  FlueObservation,
  FlueExecutionContext,
  FlueExecutionOperation,
  Sandbox,
  SandboxFactory,
  SandboxToolFactory,
  SkillDefinition,
  ToolInputSchema,
  ToolOutputSchema,
} from "@flue/runtime";
import { start } from "@flue/runtime/node";
import type { Flue } from "@flue/runtime/node";
import {
  MAX_AGENT_MODEL_TURNS,
  ManagedAgentInstanceDataSchema,
  OAO_AGENT_TOOL_PREFIX,
  parseManagedAgentSnapshotForPublication,
  parseSessionVersionResolution,
  ManagedRunDeliverySchema,
  ManagedRunInputV1Schema,
  ModelGenerationSettingsSchema,
  ModelRoutingPolicySchema,
  TOOL_RETRY_POLICY,
  ToolResultFailureCodeSchema,
  type ManagedAgentSnapshot,
  type ManagedAgentOaoTools,
  type ManagedHarnessOperation,
  type ManagedMcpToolSnapshot,
  type ManagedSkillBindingSnapshot,
  type ManagedAgentPinnedDelegate,
  type ManagedAgentPublicationConfig,
  type SessionResolvedAgentVersion,
  type SessionVersionResolution,
  type ManagedAgentInstanceData,
  type ManagedRunDelivery,
  type ManagedRunInputV1,
  type ModelProviderType,
  type ModelGenerationSettings,
  type ModelRoutingPolicy,
} from "@oao/contracts";
import type {
  PgClient,
  PgPool,
  Queryable,
  TenantContext,
} from "@oao/db-postgres";
import {
  findRunModelPresetPrice,
  withTenantTransaction,
} from "@oao/db-postgres";
import type { ProviderCredentialCipher } from "@oao/provider-credentials";
import {
  McpRemoteError,
  type McpCredentialMaterial,
  type McpRemotePort,
  type McpToolResult,
} from "@oao/mcp-remote";
import { availableOaoTools } from "@oao/mcp-server";
import type {
  ModelUsageCounts,
  OrganizationId,
  ProjectArtifactStoreResolverPort,
  ProjectId,
  PublicValue,
  RunId,
  ThreadId,
} from "@oao/domain";
import {
  jsonbSafePublicValue,
  jsonbSafeText,
  priceModelCall,
  redactForPublic,
  serializeSkillPackageForHash,
  serializeLegacySkillPackageForHash,
} from "@oao/domain";
import type {
  EffectiveModelLimits,
  ModelPresetLimitsInput,
  ModelPresetTenant,
  ResolvedModelPreset,
} from "@oao/models-openrouter";
import {
  MODEL_CALL_TIMEOUT_MS,
  withModelCallTimeout,
  withModelPromptCacheScope,
  type ModelPromptCacheScope,
} from "@oao/models-openrouter";
import {
  MODEL_IMAGE_MAX_TOTAL_BYTES,
  MODEL_IMAGE_POLICY_VERSION,
  ModelImageError,
  isModelImageMimeType,
  prepareModelImage,
  type ModelImage,
} from "@oao/model-images";
import type { PostgresWakeQueue, RuntimeWakeJob } from "@oao/queue-postgres";
import {
  commitAssistantText,
  type AssistantTextCommitInput,
  type AssistantTextSegment,
  type PostgresToolBroker,
  type ToolObligationInput,
} from "@oao/tool-broker";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as v from "valibot";
import {
  PROMPT_SUGGESTION_INSTRUCTION,
  replySuggestion,
  withoutSuggestionLines,
} from "./prompt-suggestions.js";

export { PROMPT_SUGGESTION_INSTRUCTION } from "./prompt-suggestions.js";

export const FLUE_PACKAGE_VERSIONS = Object.freeze({
  runtime: "2.3.0",
  postgres: "2.3.0",
  opentelemetry: "2.3.0",
  piAi: "1.5.0",
});

import {
  oaoToolLedgerArguments,
  type OaoToolExecutionPort,
} from "./oao-tools.js";

export {
  createOaoToolExecutor,
  OAO_TOOL_RESULT_CHARACTERS,
  type OaoToolExecutionPort,
  type OaoToolResult,
} from "./oao-tools.js";

export type PlatformToolHandler = (
  arguments_: Readonly<Record<string, PublicValue>>,
  context: {
    readonly runId: RunId;
    readonly toolCallId: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  },
) => Promise<PublicValue>;

/**
 * Synchronous resolver the agent render uses. The models adapter's project
 * preset registry implements it, covering both deployment presets and durable
 * project presets that were activated before dispatch.
 */
export interface ModelPresetResolverPort {
  resolve(key: string, tenant: ModelPresetTenant): ResolvedModelPreset;
}

/** What the orchestrator needs to send image run files as native input. */
export interface ManagedRunImageInputOptions {
  /** Resolves the agent's runtime model to check image input support. */
  readonly presets: ModelPresetResolverPort;
  /** Object storage that holds run attachments. */
  readonly storage?: ProjectArtifactStoreResolverPort;
  /**
   * How long one image download attempt may take before it counts as a
   * storage error; {@link RUN_FILE_DOWNLOAD_TIMEOUT_MS} by default.
   */
  readonly downloadTimeoutMs?: number;
}

const RUN_MODEL_LIMITS_MAX_ENTRIES = 10_000;
// The limits each run started with, by run ID, so its model calls can record
// them. A run resolves its model once, so a later change to its preset's
// limits does not reach it. Oldest entries leave first.
const runModelLimits = new Map<string, EffectiveModelLimits>();

/**
 * Keeps the limits a run started with in this process, recorded when the run
 * renders and Flue resolves its model. A later render of the same run, or a
 * wake that activates the preset again with newer limits, does not change the
 * model its live execution holds, so the first record stands. After a
 * restart the map is empty, and the run's next render records the limits it
 * then resolves.
 */
function rememberRunModelLimits(
  runId: string,
  limits: EffectiveModelLimits | undefined,
): void {
  if (!limits || runModelLimits.has(runId)) return;
  runModelLimits.set(runId, limits);
  while (runModelLimits.size > RUN_MODEL_LIMITS_MAX_ENTRIES) {
    const oldest = runModelLimits.keys().next().value;
    if (oldest === undefined) break;
    runModelLimits.delete(oldest);
  }
}

/**
 * The limits a run's model calls run with, for each call's recorded details,
 * so the run's output size and compaction can be explained later. Empty when
 * the run's preset has no project definition, or another worker admitted it.
 */
function modelLimitsDetail(runId: string): {
  readonly modelLimits?: EffectiveModelLimits;
} {
  const limits = runModelLimits.get(runId);
  return limits ? { modelLimits: { ...limits } } : {};
}

/** Loads and activates a durable project preset before a run is dispatched. */
export interface ModelPresetActivationPort {
  activate(
    tenant: TenantContext,
    presetKey: string,
  ): Promise<ResolvedModelPreset | undefined>;
}

export interface SkillDefinitionResolverPort {
  resolve(
    tenant: TenantContext,
    binding: ManagedSkillBindingSnapshot,
  ): SkillDefinition;
}

export interface SkillDefinitionActivationPort {
  activate(
    tenant: TenantContext,
    bindings: readonly ManagedSkillBindingSnapshot[],
  ): Promise<void>;
}

export interface PersistableSandboxFactory extends SandboxFactory {
  persistWorkspace?(sandbox: Sandbox): Promise<void>;
}

export interface AgentDelegationResult {
  readonly delegationId: string;
  readonly childSessionId: string;
  readonly childRunId: string;
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly response: string;
}

export interface AgentDelegationPort {
  delegate(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly parentRunId: string;
    readonly parentThreadId: string;
    readonly parentSessionId: string;
    readonly parentAgentVersionId: string;
    readonly delegateKey: string;
    readonly prompt: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<AgentDelegationResult>;
  followUp(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly parentRunId: string;
    readonly parentSessionId: string;
    readonly delegationId: string;
    readonly prompt: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<AgentDelegationResult>;
}

export interface McpToolExecutionPort {
  execute(
    tenant: TenantContext & {
      readonly sessionId: string;
      readonly runId: RunId;
      readonly flueToolCallId: string;
    },
    tool: ManagedMcpToolSnapshot,
    arguments_: Readonly<Record<string, PublicValue>>,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, PublicValue>>>;
}

/**
 * Registers a provider with the Flue runtime. Keeping the call behind this
 * package preserves the single Flue seam: the worker never imports Flue.
 */
export function registerRuntimeModelProvider(provider: Provider): void {
  recordRuntimeModels(provider);
  setProvider(withModelCallTimeout(provider));
}

// Input modalities of every registered runtime model, keyed like Flue's
// `provider-id/model-id` model specifiers.
const runtimeModelInputs = new Map<string, readonly string[]>();

function recordRuntimeModels(provider: Provider): void {
  for (const model of provider.getModels())
    runtimeModelInputs.set(`${provider.id}/${model.id}`, model.input);
}

/**
 * Whether a registered runtime model accepts native image input, from the
 * same model metadata Flue uses. Unknown models count as text-only.
 */
export function runtimeModelAcceptsImages(model: string): boolean {
  return runtimeModelInputs.get(model)?.includes("image") ?? false;
}

interface ManagedAgentRuntimeConfig {
  readonly pool: PgPool;
  readonly presets: ModelPresetResolverPort;
  readonly broker: PostgresToolBroker;
  readonly platformTools: ReadonlyMap<string, PlatformToolHandler>;
  readonly skills?: SkillDefinitionResolverPort;
  readonly delegations?: AgentDelegationPort;
  readonly mcp?: McpToolExecutionPort;
  readonly oaoTools?: OaoToolExecutionPort;
  readonly runFileStorage?: ProjectArtifactStoreResolverPort;
  readonly sandboxFactory?: (
    initial: ManagedAgentInstanceData,
    delivery: ManagedRunDelivery,
  ) => PersistableSandboxFactory;
}

let managedRuntime: ManagedAgentRuntimeConfig | undefined;

export function configureManagedAgentRuntime(
  config: ManagedAgentRuntimeConfig,
): void {
  if (managedRuntime)
    throw new Error("ManagedAgent runtime is already configured");
  managedRuntime = Object.freeze({
    ...config,
    platformTools: new Map(config.platformTools),
  });
  stopObservingAssistantText ??= observe((event) =>
    pendingAssistantText.observe(event),
  );
}

export function resetManagedAgentRuntime(): void {
  managedRuntime = undefined;
  stopObservingAssistantText?.();
  stopObservingAssistantText = undefined;
}

function runtimeConfig(): ManagedAgentRuntimeConfig {
  if (!managedRuntime)
    throw new Error("ManagedAgent runtime is not configured");
  return managedRuntime;
}

type PublishedObjectSchema =
  ManagedAgentSnapshot["tools"][number]["inputSchema"];

interface ActiveHarnessOperationContext {
  readonly key: string;
  readonly toolCallId: string;
  nextStepIndex: number;
  readonly stepIndexes: Map<string, number>;
}

interface HarnessObservationCorrelation {
  readonly operationKey: string;
  readonly harnessToolCallId: string;
  readonly stepId: string;
  readonly stepIndex: number;
}

const activeHarnessOperation =
  new AsyncLocalStorage<ActiveHarnessOperationContext>();

function harnessObservationCorrelation(
  event: FlueObservation,
): HarnessObservationCorrelation | undefined {
  const active = activeHarnessOperation.getStore();
  if (!active) return undefined;
  const stepId =
    event.type === "turn"
      ? `turn:${event.turnId}`
      : event.type === "tool_start" || event.type === "tool"
        ? `tool:${event.toolCallId}`
        : undefined;
  if (!stepId) return undefined;
  let stepIndex = active.stepIndexes.get(stepId);
  if (stepIndex === undefined) {
    stepIndex = active.nextStepIndex;
    active.nextStepIndex += 1;
    active.stepIndexes.set(stepId, stepIndex);
  }
  return {
    operationKey: active.key,
    harnessToolCallId: active.toolCallId,
    stepId,
    stepIndex,
  };
}

// Flue joins the text parts of a submission's reply with a blank line;
// committed assistant messages use the same separator so they stay an exact
// prefix of the settled reply.
const REPLY_TEXT_SEPARATOR = "\n\n";
// Flue emits a turn right after persisting the completed assistant message and
// before executing its tool calls; this bounds the wait for that observation.
const PENDING_ASSISTANT_TEXT_WAIT_MS = 2_000;
// Submissions normally drop out on settlement; the cap only bounds memory when
// a settlement is never observed.
const PENDING_ASSISTANT_TEXT_MAX_SUBMISSIONS = 1_000;

interface PendingAssistantTextClaim {
  readonly text: string;
  /** Records whether the broker saved the text as a transcript message. */
  settle(persisted: boolean): void;
}

interface PendingSubmissionText {
  readonly parts: string[];
  /**
   * Turns that requested tool calls, in order: the first call names the turn
   * and `end` is the number of text parts through it.
   */
  readonly turns: { readonly toolCallId: string; readonly end: number }[];
  committed: number;
  reserved: number;
  /** The per-turn commit in flight, which a turn's parallel calls share. */
  publishing?: { readonly end: number; readonly done: Promise<void> };
}

/**
 * The assistant text of each running submission, captured synchronously from
 * Flue `turn` observations, so a tool call can commit the text the model wrote
 * ahead of it. Memory-only: after a worker restart the text simply stays in the
 * settled reply.
 */
class PendingAssistantText {
  readonly #submissions = new Map<string, PendingSubmissionText>();
  readonly #calls = new Map<
    string,
    { readonly submissionId: string; readonly end: number }
  >();
  readonly #waiters = new Map<string, Set<() => void>>();
  /** Runs whose agent version publishes text before every tool call. */
  readonly #publishingRuns = new Set<string>();
  /** Runs whose agent version has prompt suggestions on. */
  readonly #suggestingRuns = new Set<string>();

  observe(event: FlueObservation): void {
    if (
      event.type !== "turn" ||
      event.purpose !== "agent" ||
      event.isError ||
      !event.submissionId ||
      // Scratch turns inside a Harness Operation are not part of the reply.
      activeHarnessOperation.getStore()
    )
      return;
    const output: unknown = event.response.output;
    const content =
      output && typeof output === "object"
        ? (output as { readonly content?: unknown }).content
        : undefined;
    if (!Array.isArray(content)) return;
    let submission = this.#submissions.get(event.submissionId);
    if (!submission) {
      submission = { parts: [], turns: [], committed: 0, reserved: 0 };
      this.#submissions.set(event.submissionId, submission);
      this.#evictOverflow();
    }
    const callIds: string[] = [];
    for (const part of content as unknown[]) {
      if (!part || typeof part !== "object") continue;
      const { type, text, id } = part as {
        readonly type?: unknown;
        readonly text?: unknown;
        readonly id?: unknown;
      };
      if (type === "text" && typeof text === "string")
        submission.parts.push(text);
      else if (type === "toolCall" && typeof id === "string") callIds.push(id);
    }
    if (callIds[0] !== undefined)
      submission.turns.push({
        toolCallId: callIds[0],
        end: submission.parts.length,
      });
    for (const callId of callIds) {
      this.#calls.set(callId, {
        submissionId: event.submissionId,
        end: submission.parts.length,
      });
      for (const wake of this.#waiters.get(callId) ?? []) wake();
      this.#waiters.delete(callId);
    }
  }

  /** Marks a run whose agent version publishes text before every tool call. */
  publishBeforeToolCalls(runId: string): void {
    this.#publishingRuns.delete(runId);
    this.#publishingRuns.add(runId);
    for (const oldest of this.#publishingRuns) {
      if (this.#publishingRuns.size <= PENDING_ASSISTANT_TEXT_MAX_SUBMISSIONS)
        break;
      this.#publishingRuns.delete(oldest);
    }
  }

  publishesBeforeToolCalls(runId: string): boolean {
    return this.#publishingRuns.has(runId);
  }

  /** Marks a run whose model ends its final reply with a suggestion line. */
  cutSuggestionLines(runId: string): void {
    this.#suggestingRuns.delete(runId);
    this.#suggestingRuns.add(runId);
    for (const oldest of this.#suggestingRuns) {
      if (this.#suggestingRuns.size <= PENDING_ASSISTANT_TEXT_MAX_SUBMISSIONS)
        break;
      this.#suggestingRuns.delete(oldest);
    }
  }

  /**
   * Text of a run as it may be stored before the run settles: without a
   * suggestion line, which belongs only at the end of the final reply.
   */
  publishable(runId: string, text: string): string {
    return this.#suggestingRuns.has(runId)
      ? withoutSuggestionLines(text).trim()
      : text;
  }

  /**
   * Whether a submission's last turn wrote text of its own after its last tool
   * call, so that the reply ends with words of the final turn. A suggestion
   * line is not such text. Undefined when this worker did not observe the
   * submission.
   */
  endsWithReply(submissionId: string): boolean | undefined {
    const submission = this.#submissions.get(submissionId);
    if (!submission) return undefined;
    return submission.parts
      .slice(submission.turns.at(-1)?.end ?? 0)
      .some((part) => withoutSuggestionLines(part).trim().length > 0);
  }

  forgetRun(runId: string): void {
    this.#publishingRuns.delete(runId);
    this.#suggestingRuns.delete(runId);
  }

  /**
   * Reserves the text not yet committed, through the turn that requested
   * `toolCallId`. While a reservation is unsettled no other gate receives that
   * text, so parallel gates from one turn never commit it twice. Settling it
   * as not persisted releases the text for the next gate and the reply; an
   * earlier reservation that was never settled stays reserved.
   */
  async take(
    toolCallId: string,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<PendingAssistantTextClaim | undefined> {
    if (!this.#calls.has(toolCallId)) await this.#waitFor(toolCallId, signal);
    const call = this.#calls.get(toolCallId);
    const submission = call && this.#submissions.get(call.submissionId);
    if (!call || !submission) return undefined;
    const start = Math.max(submission.committed, submission.reserved);
    const written = submission.parts
      .slice(start, call.end)
      .join(REPLY_TEXT_SEPARATOR)
      .trim();
    const text = runId ? this.publishable(runId, written) : written;
    if (!text) return undefined;
    submission.reserved = call.end;
    return {
      text,
      settle(persisted) {
        if (persisted)
          submission.committed = Math.max(submission.committed, call.end);
        else if (submission.reserved === call.end) submission.reserved = start;
      },
    };
  }

  /**
   * Commits the text of every turn not yet committed, through the turn that
   * requested `toolCallId`, one message per turn. Each turn's text runs from
   * the end of the previous turn that called tools, so a message never
   * depends on which call commits it and the messages stay a prefix of the
   * reply. The parallel calls of one turn wait for one shared commit, so none
   * of them starts before its turn's message is saved. A failed commit is not
   * retried here: the next turn's commit or the settled reply keeps the text.
   */
  async publishThrough(
    toolCallId: string,
    commit: (segments: readonly AssistantTextSegment[]) => Promise<boolean>,
    options: {
      readonly signal?: AbortSignal | undefined;
      /** False when the turn has certainly been observed already. */
      readonly wait?: boolean;
      /** The run the text belongs to, when it may hold a suggestion line. */
      readonly runId?: string;
    } = {},
  ): Promise<void> {
    if (options.wait !== false && !this.#calls.has(toolCallId))
      await this.#waitFor(toolCallId, options.signal);
    const call = this.#calls.get(toolCallId);
    const submission = call && this.#submissions.get(call.submissionId);
    if (!call || !submission || submission.committed >= call.end) return;
    const shared = submission.publishing;
    if (shared && shared.end >= call.end) {
      await shared.done;
      return;
    }
    const segments: AssistantTextSegment[] = [];
    let from = submission.committed;
    for (const turn of submission.turns) {
      if (turn.end <= submission.committed) continue;
      if (turn.end > call.end) break;
      const written = submission.parts
        .slice(from, turn.end)
        .join(REPLY_TEXT_SEPARATOR)
        .trim();
      const text = options.runId
        ? this.publishable(options.runId, written)
        : written;
      if (text) segments.push({ toolCallId: turn.toolCallId, text });
      from = turn.end;
    }
    if (segments.length === 0) {
      submission.committed = call.end;
      return;
    }
    const publishing = {
      end: call.end,
      done: commit(segments).then(
        (persisted) => {
          if (persisted)
            submission.committed = Math.max(submission.committed, call.end);
        },
        () => undefined,
      ),
    };
    submission.publishing = publishing;
    await publishing.done;
    if (submission.publishing === publishing) delete submission.publishing;
  }

  #waitFor(toolCallId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(toolCallId) ?? new Set();
      this.#waiters.set(toolCallId, waiters);
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        waiters.delete(done);
        if (!waiters.size) this.#waiters.delete(toolCallId);
        resolve();
      };
      const timer = setTimeout(done, PENDING_ASSISTANT_TEXT_WAIT_MS);
      timer.unref?.();
      signal?.addEventListener("abort", done, { once: true });
      waiters.add(done);
    });
  }

  /**
   * Drops a settled submission. The runtime projection calls this once it has
   * projected the settlement, so a turn still queued for projection can commit
   * its text first; the submission cap bounds memory without a projection.
   */
  forget(submissionId: string): void {
    this.#forget(submissionId);
  }

  #forget(submissionId: string): void {
    this.#submissions.delete(submissionId);
    for (const [callId, call] of this.#calls)
      if (call.submissionId === submissionId) this.#calls.delete(callId);
  }

  #evictOverflow(): void {
    for (const submissionId of this.#submissions.keys()) {
      if (this.#submissions.size <= PENDING_ASSISTANT_TEXT_MAX_SUBMISSIONS)
        return;
      this.#forget(submissionId);
    }
  }
}

const pendingAssistantText = new PendingAssistantText();
let stopObservingAssistantText: (() => void) | undefined;

/**
 * The settled reply without the text already committed as earlier assistant
 * messages. Flue's reply joins every text part of the run, so committed
 * messages form its prefix; any other layout keeps the whole reply rather than
 * risk dropping text.
 */
function replyAfterCommittedText(
  reply: string,
  committed: readonly string[],
): string {
  if (committed.length === 0) return reply;
  let rest = reply;
  for (const message of committed) {
    const text = message.trim();
    const remaining = rest.trimStart();
    if (!text || !remaining.startsWith(text)) return reply;
    rest = remaining.slice(text.length);
  }
  return rest.trim();
}

type AssistantTextBroker = Pick<
  PostgresToolBroker,
  "hasPendingAssistantText" | "commitAssistantText"
>;

/**
 * Commits the text of the turns through the one that requested `toolCallId`,
 * for an agent version that publishes text before every tool call. A failed
 * commit never fails the tool call: the text stays for the next commit or the
 * settled reply.
 */
async function publishAssistantTextBefore(
  broker: Pick<PostgresToolBroker, "commitAssistantText">,
  run: Omit<AssistantTextCommitInput, "segments">,
  toolCallId: string,
  signal: AbortSignal | undefined,
  pending: PendingAssistantText = pendingAssistantText,
): Promise<void> {
  // A Harness Operation's scratch turns are not part of the reply.
  if (activeHarnessOperation.getStore()) return;
  await pending.publishThrough(
    toolCallId,
    (segments) =>
      broker.commitAssistantText({
        organizationId: run.organizationId,
        projectId: run.projectId,
        runId: run.runId,
        segments,
      }),
    { signal, runId: run.runId },
  );
}

/**
 * Publishes an obligation after the text the model wrote before requesting it.
 * With `publishText` every call first commits its turn's text as its own
 * message. Otherwise only a gated call carries the text, which the broker saves
 * in the gate's transaction; whether it did is then recorded, so text from a
 * publication that rolled back stays available to the next gate and the
 * settled reply.
 */
async function withPendingAssistantText<T>(
  broker: AssistantTextBroker,
  obligation: ToolObligationInput,
  signal: AbortSignal | undefined,
  publish: (obligation: ToolObligationInput) => Promise<T>,
  pending: PendingAssistantText = pendingAssistantText,
  publishText = false,
): Promise<T> {
  if (publishText) {
    await publishAssistantTextBefore(
      broker,
      obligation,
      obligation.flueToolCallId,
      signal,
      pending,
    );
    return publish(obligation);
  }
  if (obligation.approval !== "always") return publish(obligation);
  const claim = await pending.take(
    obligation.flueToolCallId,
    signal,
    obligation.runId,
  );
  if (!claim) return publish(obligation);
  // When the check itself fails the outcome is unknown, so the text stays
  // reserved: no later gate commits it twice, and if the publication rolled
  // back the settled reply still holds it.
  const settle = async () => {
    const persisted = await broker
      .hasPendingAssistantText(obligation)
      .catch(() => undefined);
    if (persisted !== undefined) claim.settle(persisted);
  };
  try {
    const result = await publish({
      ...obligation,
      pendingAssistantText: claim.text,
    });
    await settle();
    return result;
  } catch (error) {
    await settle();
    throw error;
  }
}

/**
 * Sandbox tools that commit their turn's text before the durable command
 * record, so the message precedes the command's events.
 */
function withAssistantTextBeforeSandboxTools(
  factory: PersistableSandboxFactory,
  publish: (toolCallId: string, signal?: AbortSignal) => Promise<void>,
): PersistableSandboxFactory {
  const tools = factory.tools;
  if (!tools) return factory;
  const wrapped: SandboxToolFactory = (sandbox, options) =>
    tools.call(factory, sandbox, options).map((tool) => ({
      ...tool,
      async execute(toolCallId, params, signal, onUpdate) {
        await publish(toolCallId, signal);
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
    }));
  return Object.assign(Object.create(factory) as PersistableSandboxFactory, {
    tools: wrapped,
  });
}

const HARNESS_OPERATION_TASK_MAX_CHARACTERS = 100_000;

function harnessOperationPrompt(
  operation: ManagedHarnessOperation,
  task: string,
): string {
  return [
    `Execute the Harness Operation ${JSON.stringify(operation.key)}.`,
    "",
    "Focused operation instructions:",
    operation.instructions,
    "",
    "Run-specific task:",
    task,
    "",
    "Use the current Agent's inherited model, tools, mounted Skill catalog, and live sandbox. Original session files are already materialized in that shared sandbox. Activate a relevant Agent-level Skill when helpful. Do not call any Harness Operation from this scratch conversation. Return the required structured result through Flue's result mechanism.",
  ].join("\n");
}

function harnessOperationSignal(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Builds one version-pinned Harness Operation as a Flue harness tool. Keeping
 * the prompt inside a durable step makes recovery replay the validated value
 * instead of repeating completed model work. `beforeRun` runs before the
 * scratch conversation starts, outside its context.
 */
export function createManagedHarnessOperationTool(
  operation: ManagedHarnessOperation,
  beforeRun?: (toolCallId: string, signal?: AbortSignal) => Promise<void>,
) {
  const result = compileObjectSchema(
    operation.resultSchema,
  ) as ToolOutputSchema;
  return defineTool({
    name: operation.key,
    description: operation.description,
    input: v.strictObject({
      task: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(HARNESS_OPERATION_TASK_MAX_CHARACTERS),
      ),
    }),
    output: result,
    harness: true,
    durable: true,
    async run({ data, harness, signal, step, log, toolCallId }) {
      const parent = activeHarnessOperation.getStore();
      if (parent)
        throw new Error(
          `Nested Harness Operation calls are not allowed (${parent.key} -> ${operation.key})`,
        );
      // Scratch tools record their own events, so the turn's text is
      // committed before any of them can run.
      await beforeRun?.(toolCallId, signal);
      const startedAt = Date.now();
      log.info("Harness Operation started", {
        operationKey: operation.key,
        taskCharacters: data.task.length,
        timeoutMs: operation.timeoutMs,
      });
      try {
        const output = await activeHarnessOperation.run(
          {
            key: operation.key,
            toolCallId,
            nextStepIndex: 0,
            stepIndexes: new Map(),
          },
          () =>
            step.do("harness-prompt", async () => {
              const response = await harness.prompt(
                harnessOperationPrompt(operation, data.task),
                {
                  result,
                  signal: harnessOperationSignal(operation.timeoutMs, signal),
                },
              );
              return response.data;
            }),
        );
        log.info("Harness Operation completed", {
          operationKey: operation.key,
          durationMs: Date.now() - startedAt,
          resultValidated: true,
        });
        return { output };
      } catch (error) {
        log.warn("Harness Operation failed", {
          operationKey: operation.key,
          durationMs: Date.now() - startedAt,
          outcome:
            error instanceof DOMException
              ? error.name === "TimeoutError"
                ? "timed_out"
                : "cancelled"
              : "failed",
        });
        throw error;
      }
    },
  });
}

function schemaType(schema: Record<string, unknown>): string | undefined {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type))
    return schema.type.find((entry) => entry !== "null") as string | undefined;
  return undefined;
}

const PROTOTYPE_POLLUTION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function hasSafeObjectKeys(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): boolean {
  if (!value || typeof value !== "object") return true;
  if (depth > 64 || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    return value.every((entry) => hasSafeObjectKeys(entry, seen, depth + 1));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value).every(
    ([key, nested]) =>
      !PROTOTYPE_POLLUTION_KEYS.has(key) &&
      hasSafeObjectKeys(nested, seen, depth + 1),
  );
}

function literalSchema(value: unknown): v.GenericSchema {
  if (value === null) return v.null();
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  )
    throw new TypeError("Tool schema literals must be primitive JSON values");
  return v.literal(value);
}

function compileEnumSchema(values: readonly unknown[]): v.GenericSchema {
  if (values.length === 0)
    throw new TypeError("Published enum schemas require values");
  if (
    values.every(
      (value): value is string | number =>
        typeof value === "string" || typeof value === "number",
    )
  )
    return v.picklist(values as [string | number, ...(string | number)[]]);
  const options = values.map(literalSchema);
  return options.length === 1
    ? options[0]!
    : v.union(
        options as [v.GenericSchema, v.GenericSchema, ...v.GenericSchema[]],
      );
}

function compilePipe(
  schema: v.GenericSchema,
  ...actions: readonly unknown[]
): v.GenericSchema {
  const pipe = v.pipe as unknown as (
    input: v.GenericSchema,
    ...items: readonly unknown[]
  ) => v.GenericSchema;
  return pipe(schema, ...actions);
}

function withSchemaMetadata(
  compiled: v.GenericSchema,
  schema: Record<string, unknown>,
): v.GenericSchema {
  const metadata = {
    ...(typeof schema.title === "string" ? { title: schema.title } : {}),
    ...(typeof schema.description === "string"
      ? { description: schema.description }
      : {}),
    ...(Array.isArray(schema.examples) ? { examples: schema.examples } : {}),
  };
  return Object.keys(metadata).length > 0
    ? compilePipe(compiled, v.metadata(metadata))
    : compiled;
}

function compilePropertySchema(
  schema: Record<string, unknown>,
): v.GenericSchema {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return withSchemaMetadata(compileEnumSchema(schema.enum), schema);
  }
  if ("const" in schema)
    return withSchemaMetadata(literalSchema(schema.const), schema);

  let compiled: v.GenericSchema;
  switch (schemaType(schema)) {
    case "string": {
      let stringSchema: v.GenericSchema = v.string();
      if (typeof schema.minLength === "number")
        stringSchema = compilePipe(
          stringSchema,
          v.minLength(schema.minLength),
        ) as v.GenericSchema;
      if (typeof schema.maxLength === "number")
        stringSchema = compilePipe(
          stringSchema,
          v.maxLength(schema.maxLength),
        ) as v.GenericSchema;
      switch (schema.format) {
        case "date":
          stringSchema = compilePipe(stringSchema, v.isoDate());
          break;
        case "date-time":
          stringSchema = compilePipe(
            stringSchema,
            v.isoTimestamp(),
          ) as v.GenericSchema;
          break;
        case "email":
          stringSchema = compilePipe(stringSchema, v.email());
          break;
        case "time":
          stringSchema = compilePipe(stringSchema, v.isoTime());
          break;
        case "uri":
          stringSchema = compilePipe(stringSchema, v.url());
          break;
        case "uuid":
          stringSchema = compilePipe(stringSchema, v.uuid());
          break;
        default:
          break;
      }
      compiled = stringSchema;
      break;
    }
    case "number": {
      let numberSchema: v.GenericSchema = v.pipe(v.number(), v.finite());
      if (typeof schema.minimum === "number")
        numberSchema = compilePipe(
          numberSchema,
          v.minValue(schema.minimum),
        ) as v.GenericSchema;
      if (typeof schema.maximum === "number")
        numberSchema = compilePipe(
          numberSchema,
          v.maxValue(schema.maximum),
        ) as v.GenericSchema;
      if (typeof schema.exclusiveMinimum === "number")
        numberSchema = compilePipe(
          numberSchema,
          v.gtValue(schema.exclusiveMinimum),
        ) as v.GenericSchema;
      if (typeof schema.exclusiveMaximum === "number")
        numberSchema = compilePipe(
          numberSchema,
          v.ltValue(schema.exclusiveMaximum),
        ) as v.GenericSchema;
      if (typeof schema.multipleOf === "number")
        numberSchema = compilePipe(
          numberSchema,
          v.multipleOf(schema.multipleOf),
        ) as v.GenericSchema;
      compiled = numberSchema;
      break;
    }
    case "integer":
      compiled = v.pipe(v.number(), v.safeInteger(), v.finite());
      if (typeof schema.minimum === "number")
        compiled = compilePipe(
          compiled,
          v.minValue(schema.minimum),
        ) as v.GenericSchema;
      if (typeof schema.maximum === "number")
        compiled = compilePipe(
          compiled,
          v.maxValue(schema.maximum),
        ) as v.GenericSchema;
      if (typeof schema.exclusiveMinimum === "number")
        compiled = compilePipe(
          compiled,
          v.gtValue(schema.exclusiveMinimum),
        ) as v.GenericSchema;
      if (typeof schema.exclusiveMaximum === "number")
        compiled = compilePipe(
          compiled,
          v.ltValue(schema.exclusiveMaximum),
        ) as v.GenericSchema;
      if (typeof schema.multipleOf === "number")
        compiled = compilePipe(
          compiled,
          v.multipleOf(schema.multipleOf),
        ) as v.GenericSchema;
      break;
    case "boolean":
      compiled = v.boolean();
      break;
    case "null":
      compiled = v.null();
      break;
    case "array": {
      if (!schema.items || typeof schema.items !== "object")
        throw new TypeError("Published array schemas require items");
      compiled = v.array(
        compilePropertySchema(schema.items as Record<string, unknown>),
      );
      if (typeof schema.minItems === "number")
        compiled = compilePipe(
          compiled,
          v.minLength(schema.minItems),
        ) as v.GenericSchema;
      if (typeof schema.maxItems === "number")
        compiled = compilePipe(
          compiled,
          v.maxLength(schema.maxItems),
        ) as v.GenericSchema;
      break;
    }
    case "object":
      compiled = compileObjectSchema(schema as PublishedObjectSchema);
      break;
    default:
      throw new TypeError("Unsupported published JSON schema type");
  }
  if (Array.isArray(schema.type) && schema.type.includes("null"))
    compiled = v.nullable(compiled);
  return withSchemaMetadata(compiled, schema);
}

function compileObjectSchema(schema: PublishedObjectSchema): ToolInputSchema {
  if (schemaType(schema as Record<string, unknown>) !== "object")
    throw new TypeError("Tool schemas must be objects");
  const required = new Set(schema.required ?? []);
  const entries: Record<string, v.GenericSchema> = Object.create(
    null,
  ) as Record<string, v.GenericSchema>;
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const compiled = compilePropertySchema(property);
    entries[key] = required.has(key) ? compiled : v.optional(compiled);
  }
  for (const key of required) {
    if (!(key in entries))
      throw new TypeError(`Required tool schema property is missing: ${key}`);
  }
  let compiled: ToolInputSchema;
  const additionalProperties = schema.additionalProperties ?? true;
  if (additionalProperties === false) {
    compiled = v.strictObject(entries);
  } else if (additionalProperties && typeof additionalProperties === "object") {
    compiled = v.objectWithRest(
      entries,
      compilePropertySchema(additionalProperties as Record<string, unknown>),
    );
  } else {
    compiled = v.looseObject(entries);
  }
  return compilePipe(
    compiled,
    v.check(
      hasSafeObjectKeys,
      "Object contains a prohibited prototype-pollution key",
    ),
  ) as ToolInputSchema;
}

function compileToolInputSchema(
  schema: PublishedObjectSchema,
): ToolInputSchema {
  return withSchemaMetadata(
    compileObjectSchema(schema),
    schema as Record<string, unknown>,
  ) as ToolInputSchema;
}

function compileToolOutputSchema(
  schema: PublishedObjectSchema,
): ToolOutputSchema {
  return v.variant("status", [
    v.object({
      version: v.literal(1),
      status: v.literal("success"),
      value: compileObjectSchema(schema),
    }),
    v.object({
      version: v.literal(1),
      status: v.literal("failure"),
      error: v.object({
        code: ToolResultFailureCodeSchema,
        message: v.string(),
      }),
    }),
  ]);
}

function safeArguments(value: unknown): Readonly<Record<string, PublicValue>> {
  const redacted = redactForPublic(value);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted))
    return {};
  return redacted as Readonly<Record<string, PublicValue>>;
}

/** A bounded label for Harness transcript UX; never copies document contents. */
function safeHarnessToolSummary(toolName: string, value: unknown): string {
  const arguments_ = safeArguments(value);
  for (const key of ["path", "name", "url", "action"]) {
    const candidate = arguments_[key];
    if (typeof candidate === "string" && candidate.trim())
      return `${toolName} · ${candidate.trim().slice(0, 240)}`;
  }
  const command = arguments_.command;
  if (typeof command === "string") {
    const executable = command.trim().split(/\s+/u)[0];
    if (executable) return `${toolName} · ${executable.slice(0, 80)}`;
  }
  return toolName;
}

const MANAGED_RUN_SIGNAL_TYPE = "oao.run.v1";
const MANAGED_RUN_TAG = "oao-run";
const MANAGED_RUN_ENVELOPE =
  /^<oao-run type="oao\.run\.v1" version="([^"]*)" runId="([^"]*)" sessionId="([^"]*)" snapshotHash="([^"]*)">\n/u;

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * A run with native image input is a Flue `user` message, which carries no
 * attributes. Its body is wrapped in the same `<oao-run>` envelope Flue renders
 * for the `oao.run.v1` signal, so the model reads identical text on both paths
 * and the agent recovers the delivery from the envelope's first line.
 */
function managedRunEnvelope(
  delivery: ManagedRunDelivery,
  body: string,
): string {
  return `<${MANAGED_RUN_TAG} type="${MANAGED_RUN_SIGNAL_TYPE}" version="${delivery.version}" runId="${delivery.runId}" sessionId="${delivery.sessionId}" snapshotHash="${delivery.snapshotHash}">\n${escapeXmlText(body)}\n</${MANAGED_RUN_TAG}>`;
}

/** Opens a run message whose stable prefix comes before its delivery IDs. */
const CACHED_RUN_OPENING = `<${MANAGED_RUN_TAG} type="${MANAGED_RUN_SIGNAL_TYPE}">\n`;
const CACHED_RUN_DELIVERY_TAG = "oao-run-delivery";
const CACHED_RUN_DELIVERY =
  /\n<oao-run-delivery version="([^"<>]*)" runId="([^"<>]*)" sessionId="([^"<>]*)" snapshotHash="([^"<>]*)" cachePrefixLength="([1-9][0-9]{0,6})"\/>\n<\/oao-run>$/u;

/**
 * A run message whose start other sessions share, for the prompt cache. The
 * first `cachePrefixLength` characters are the opening tag and the escaped
 * stable prefix of the message, with nothing run-specific in them. The rest of
 * the body follows, then the delivery IDs in an element the escaped body
 * cannot contain. The model reads the same body and IDs as in the other
 * envelopes, and the agent recovers the delivery from the last line.
 */
function cachedRunEnvelope(
  delivery: ManagedRunDelivery,
  prefix: string,
  rest: string,
): string {
  const head = `${CACHED_RUN_OPENING}${escapeXmlText(prefix)}`;
  return `${head}${escapeXmlText(rest)}\n<${CACHED_RUN_DELIVERY_TAG} version="${delivery.version}" runId="${delivery.runId}" sessionId="${delivery.sessionId}" snapshotHash="${delivery.snapshotHash}" cachePrefixLength="${head.length}"/>\n</${MANAGED_RUN_TAG}>`;
}

/**
 * The length of the stable start of a run message with a cached prefix, or
 * undefined for any other text. The model provider ends that start in a
 * prompt cache breakpoint, on the first run and on every follow-up run that
 * replays it.
 */
export function managedRunCachePrefixLength(text: string): number | undefined {
  if (!text.startsWith(CACHED_RUN_OPENING)) return undefined;
  const delivery = CACHED_RUN_DELIVERY.exec(text);
  if (!delivery) return undefined;
  const length = Number(delivery[5]);
  return length > CACHED_RUN_OPENING.length && length <= delivery.index
    ? length
    : undefined;
}

/**
 * How many characters at the start of `message` go before the delivery IDs.
 * A split never separates the two halves of a UTF-16 surrogate pair.
 */
function stablePrefixChars(message: string, requested = 0): number {
  const chars = Math.min(Math.max(0, Math.trunc(requested)), message.length);
  if (chars <= 0 || chars >= message.length) return chars;
  const before = message.charCodeAt(chars - 1);
  const after = message.charCodeAt(chars);
  return before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
    ? chars - 1
    : chars;
}

function deliveryContext(delivered: DeliveredMessage): ManagedRunDelivery {
  if (delivered.kind === "signal" && delivered.type === MANAGED_RUN_SIGNAL_TYPE)
    return v.parse(ManagedRunDeliverySchema, delivered.attributes);
  if (delivered.kind === "user") {
    const envelope =
      MANAGED_RUN_ENVELOPE.exec(delivered.body) ??
      (managedRunCachePrefixLength(delivered.body) === undefined
        ? undefined
        : CACHED_RUN_DELIVERY.exec(delivered.body));
    const parsed =
      envelope &&
      v.safeParse(ManagedRunDeliverySchema, {
        version: envelope[1],
        runId: envelope[2],
        sessionId: envelope[3],
        snapshotHash: envelope[4],
      });
    if (parsed?.success) return parsed.output;
  }
  throw new Error("ManagedAgent received an invalid delivery envelope");
}

/** How one image run file reaches the model. */
export type ManagedRunImage =
  | { readonly status: "attached"; readonly image: ModelImage }
  | { readonly status: "omitted"; readonly reason: string };

const RUN_FILES_INTRO =
  "The following original files were copied into the sandbox without preprocessing. Inspect the files with sandbox tools before answering; their contents are not included in this message.";
const RUN_FILES_WITH_IMAGES_INTRO =
  "The following original files were copied into the sandbox without preprocessing. Images marked as attached are also included in this message as image input, numbered in attachment order. Inspect every other file with sandbox tools before answering; its contents are not included in this message.";
const RUN_FILES_WITHOUT_IMAGES_NOTE =
  "The images among them could not be shown to you as image input, for the reason given with each image; inspect them with sandbox tools instead.";
export const MODEL_WITHOUT_IMAGE_INPUT =
  "the agent's model does not accept image input";

/** Run files that may reach the model as native image input. */
export function isImageRunFile(file: ManagedRunFileManifest): boolean {
  return isModelImageMimeType(file.contentType);
}

function runFileEntry(
  delivery: ManagedRunDelivery,
  file: ManagedRunFileManifest,
  imageInput?: string,
): string {
  return [
    `- path: ${JSON.stringify(managedRunFileSandboxPath(delivery.runId, file.name))}`,
    `  name: ${JSON.stringify(file.name)}`,
    `  content type: ${file.contentType}`,
    `  size: ${file.sizeBytes} bytes`,
    `  SHA-256: ${file.sha256}`,
    ...(imageInput ? [`  image input: ${imageInput}`] : []),
  ].join("\n");
}

function inputBody(
  message: string,
  delivery: ManagedRunDelivery,
  files: readonly ManagedRunFileManifest[],
  images?: ReadonlyMap<string, ManagedRunImage>,
): string {
  if (files.length === 0) return message;
  if (!images || images.size === 0)
    return [
      message,
      "",
      RUN_FILES_INTRO,
      ...files.map((file) => runFileEntry(delivery, file)),
    ].join("\n");
  let attached = 0;
  const entries = files.map((file) => {
    const image = images.get(file.id);
    if (!image) return runFileEntry(delivery, file);
    if (image.status === "omitted")
      return runFileEntry(delivery, file, `not attached: ${image.reason}`);
    attached += 1;
    const { converted, mimeType, width, height } = image.image;
    return runFileEntry(
      delivery,
      file,
      converted
        ? `attached as image ${attached}, converted to ${mimeType} at ${width}x${height} px`
        : `attached as image ${attached}`,
    );
  });
  return [
    message,
    "",
    attached > 0
      ? RUN_FILES_WITH_IMAGES_INTRO
      : `${RUN_FILES_INTRO} ${RUN_FILES_WITHOUT_IMAGES_NOTE}`,
    ...entries,
  ].join("\n");
}

function managedSystemPrompt(snapshot: ManagedAgentSnapshot): string {
  const retryInstructions =
    snapshot.tools.length + (snapshot.mcpTools?.length ?? 0)
      ? `\n\nTool retry policy: When a tool returns a retryable failure, call that tool again automatically. You may retry at most ${TOOL_RETRY_POLICY.maximumRetries} times after the initial failure (${TOOL_RETRY_POLICY.maximumAttempts} total attempts). Correct invalid arguments when guidance is available. Do not retry approval_denied, approval_expired, run_cancelled, or tool_retry_exhausted. After exhaustion, explain the failure instead of calling the tool again.`
      : "";
  const delegationInstructions =
    snapshot.delegates.length === 0
      ? ""
      : "\n\nYou may delegate work with delegate_agent. Keep the returned delegationId and use message_agent for later questions to that same isolated child thread.";
  const harnessOperationInstructions =
    (snapshot.harnessOperations?.length ?? 0) === 0
      ? ""
      : "\n\nFocused Harness Operations are available as tools. Call them with a detailed task when their descriptions match the work. Each call runs a temporary scratch agentic loop with this Agent's model, instructions, tools, full Skill catalog, and live sandbox, then returns a validated structured result. Calls may be sequential or submitted in one model tool batch. Harness Operations cannot call another Harness Operation.";
  const oaoInstructions = snapshot.oaoTools
    ? `\n\nThe ${OAO_AGENT_TOOL_PREFIX} tools read and manage this OAO project on behalf of the person or key that started this run. To ask another agent about its work, find its session with ${OAO_AGENT_TOOL_PREFIX}list_sessions, read it with ${OAO_AGENT_TOOL_PREFIX}get_session, and ask with ${OAO_AGENT_TOOL_PREFIX}send_message. Never send a message to your own session.`
    : "";
  const suggestionInstructions = snapshot.promptSuggestions
    ? `\n\n${PROMPT_SUGGESTION_INSTRUCTION}`
    : "";
  return `${snapshot.systemPrompt}${retryInstructions}${delegationInstructions}${harnessOperationInstructions}${oaoInstructions}${suggestionInstructions}`;
}

/**
 * The OAO tools an agent's grant offers. A run token is always restricted
 * to its project, so tools that change organization-shared resources are
 * left out.
 */
function oaoAgentTools(grant: ManagedAgentOaoTools) {
  return availableOaoTools(new Set(grant.scopes), { projectRestricted: true });
}

function mcpToolName(namespace: string, remoteToolName: string): string {
  const safeRemote = remoteToolName
    .replace(/[^a-zA-Z0-9_:-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_|_$/gu, "");
  if (!safeRemote) throw new Error("MCP tool name cannot be namespaced safely");
  const prefix = `mcp__${namespace}__`;
  if (prefix.length + safeRemote.length <= 200) return `${prefix}${safeRemote}`;
  const suffix = createHash("sha256")
    .update(remoteToolName)
    .digest("hex")
    .slice(0, 12);
  return `${prefix}${safeRemote.slice(0, 200 - prefix.length - suffix.length - 1)}_${suffix}`;
}

const MANAGED_RUN_FILE_DIRECTORY = ".oao/attachments";

/**
 * The Skill versions and delegates a session's agent version runs with. A
 * session that recorded a version resolution uses it, after checking that it
 * matches the agent version's pinned and followed links; a session from
 * before resolutions were recorded uses the version's pinned links, which is
 * all such a version can have.
 */
export function sessionBindings(
  publication: ManagedAgentPublicationConfig,
  agentVersionId: string,
  resolution: SessionVersionResolution | undefined,
): {
  readonly skillVersionIds: readonly string[];
  readonly delegates: readonly ManagedAgentPinnedDelegate[];
} {
  const followedSkillIds = publication.skillIds ?? [];
  if (!resolution) {
    if (
      followedSkillIds.length > 0 ||
      publication.delegates.some((delegate) => "agentId" in delegate)
    )
      throw new Error(
        "The session has no version resolution for an agent version that follows latest versions",
      );
    return {
      skillVersionIds: publication.skillVersionIds,
      delegates: publication.delegates as readonly ManagedAgentPinnedDelegate[],
    };
  }
  const entry = resolvedAgentVersion(resolution, agentVersionId);
  const pinned = entry.skills.filter((skill) => !skill.followsLatest);
  const followed = entry.skills.filter((skill) => skill.followsLatest);
  const sameSet = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
  if (
    !sameSet(
      pinned.map((skill) => skill.skillVersionId),
      publication.skillVersionIds,
    ) ||
    !sameSet(
      followed.map((skill) => skill.skillId),
      followedSkillIds,
    )
  )
    throw new Error(
      "The session's resolved Skills do not match the agent version",
    );
  if (entry.delegates.length !== publication.delegates.length)
    throw new Error(
      "The session's resolved delegates do not match the agent version",
    );
  const delegates = publication.delegates.map((delegate) => {
    const resolved = entry.delegates.find(
      (candidate) => candidate.key === delegate.key,
    );
    const matches =
      resolved !== undefined &&
      ("agentId" in delegate
        ? resolved.followsLatest && resolved.agentId === delegate.agentId
        : !resolved.followsLatest &&
          resolved.agentVersionId === delegate.agentVersionId);
    if (!matches)
      throw new Error(
        "The session's resolved delegates do not match the agent version",
      );
    return {
      key: delegate.key,
      description: delegate.description,
      agentVersionId: resolved.agentVersionId,
      maxParallel: delegate.maxParallel,
    } satisfies ManagedAgentPinnedDelegate;
  });
  return {
    skillVersionIds: entry.skills.map((skill) => skill.skillVersionId),
    delegates,
  };
}

function resolvedAgentVersion(
  resolution: SessionVersionResolution,
  agentVersionId: string,
): SessionResolvedAgentVersion {
  const entry = resolution.agentVersions.find(
    (candidate) => candidate.agentVersionId === agentVersionId,
  );
  if (!entry)
    throw new Error(
      "The session's version resolution does not cover its agent version",
    );
  return entry;
}

export function managedRunFileSandboxPath(runId: string, name: string): string {
  if (
    name === "." ||
    name === ".." ||
    /[/\\]/u.test(name) ||
    [...name].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  )
    throw new Error("Run file name cannot be materialized safely");
  return `${MANAGED_RUN_FILE_DIRECTORY}/${runId}/${name}`;
}

export async function materializeManagedRunFiles(
  sandbox: Sandbox,
  delivery: ManagedRunDelivery,
  files: readonly ManagedRunFileContent[],
): Promise<void> {
  for (const file of files) {
    const digest = createHash("sha256").update(file.bytes).digest("hex");
    if (digest !== file.sha256 || file.bytes.byteLength !== file.sizeBytes)
      throw new Error("Run file integrity validation failed");
    await sandbox.writeFile(
      managedRunFileSandboxPath(delivery.runId, file.name),
      file.bytes,
    );
  }
}

async function loadManagedRunFiles(
  pool: PgPool,
  resolver: ProjectArtifactStoreResolverPort | undefined,
  tenant: TenantContext & { readonly runId: RunId },
): Promise<readonly ManagedRunFileContent[]> {
  const expectedFiles = await withTenantTransaction(
    pool,
    tenant,
    async (transaction) => {
      const runResult = await transaction.query<{ input_public: unknown }>(
        `SELECT input_public FROM oao.runs
       WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
        [tenant.organizationId, tenant.projectId, tenant.runId],
      );
      const row = runResult.rows[0];
      if (!row) throw new Error("Run not found");
      return v.parse(ManagedRunInputV1Schema, row.input_public).files ?? [];
    },
  );
  return downloadManagedRunFiles(resolver, tenant, expectedFiles);
}

/** A run file fails the same way on every attempt: unconfigured, missing, or altered. */
class RunFileUnavailableError extends Error {}

/** Image downloads tried before admission fails the run, with growing pauses. */
const RUN_FILE_DOWNLOAD_ATTEMPTS = 3;
const RUN_FILE_DOWNLOAD_RETRY_MS = 1_000;
/**
 * Admission waits for image downloads while its wake holds the worker, and
 * object storage clients may set no request timeout, so each attempt is
 * bounded.
 */
const RUN_FILE_DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Rejects once `work` takes longer than `milliseconds`. The work itself is not
 * cancelled, because the artifact store port takes no abort signal.
 */
async function withinMilliseconds<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Run file download timed out after ${milliseconds} ms`),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Downloads run files from their bound object store and verifies them. */
async function downloadManagedRunFiles(
  resolver: ProjectArtifactStoreResolverPort | undefined,
  tenant: TenantContext,
  expectedFiles: readonly ManagedRunFileManifest[],
): Promise<readonly ManagedRunFileContent[]> {
  if (expectedFiles.length === 0) return [];
  if (!resolver)
    throw new RunFileUnavailableError("Run file object storage is unavailable");
  const stores = new Map<
    string,
    Awaited<ReturnType<ProjectArtifactStoreResolverPort["resolve"]>>
  >();
  const files: ManagedRunFileContent[] = [];
  for (const expected of expectedFiles) {
    let resolution = stores.get(expected.storageProviderId);
    if (resolution === undefined) {
      resolution = await resolver.resolve({
        tenant,
        providerId: expected.storageProviderId,
      });
      stores.set(expected.storageProviderId, resolution);
    }
    if (!resolution)
      throw new RunFileUnavailableError(
        "Run file storage provider is unavailable",
      );
    const stored = await resolution.store.get({
      tenant,
      key: expected.objectKey,
    });
    if (!stored)
      throw new RunFileUnavailableError(
        "Run file is missing from object storage",
      );
    const bytes = Buffer.from(stored.bytes);
    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    if (
      stored.contentType !== expected.contentType ||
      bytes.byteLength !== expected.sizeBytes ||
      actualDigest !== expected.sha256
    )
      throw new RunFileUnavailableError("Run file integrity validation failed");
    files.push({ ...expected, bytes });
  }
  return files;
}

/** Marks every image run file as not shown, for a model without image input. */
export function omittedManagedRunImages(
  files: readonly ManagedRunFileManifest[],
  reason: string,
): ReadonlyMap<string, ManagedRunImage> {
  return new Map(
    files
      .filter(isImageRunFile)
      .map((file) => [file.id, { status: "omitted", reason }] as const),
  );
}

/**
 * Prepares image run files as native model input. An image that cannot be
 * decoded or reduced, or that would exceed the per-message image budget, is
 * omitted with a reason the model can read. Every outcome depends only on the
 * verified file bytes, so a retried dispatch renders the same message.
 */
export async function prepareManagedRunImages(
  files: readonly ManagedRunFileContent[],
): Promise<ReadonlyMap<string, ManagedRunImage>> {
  const images = new Map<string, ManagedRunImage>();
  let totalBytes = 0;
  for (const file of files) {
    if (!isImageRunFile(file)) continue;
    let image: ModelImage;
    try {
      image = await prepareModelImage(file.bytes);
    } catch (error) {
      if (!(error instanceof ModelImageError)) throw error;
      images.set(file.id, {
        status: "omitted",
        reason: `the image could not be prepared (${error.message})`,
      });
      continue;
    }
    if (totalBytes + image.byteLength > MODEL_IMAGE_MAX_TOTAL_BYTES) {
      images.set(file.id, {
        status: "omitted",
        reason: "this message already carries the maximum image input",
      });
      continue;
    }
    totalBytes += image.byteLength;
    images.set(file.id, { status: "attached", image });
  }
  return images;
}

/**
 * Renders a run as a Flue delivery. Without image input it is the
 * `oao.run.v1` signal. When at least one image is attached it becomes a `user`
 * message whose attachments are the prepared images, in file order. When the
 * start of the message is shared with other sessions, it is a `user` message
 * that opens with that start and names the delivery after it.
 */
export function createManagedRunDeliveredMessage(input: {
  readonly delivery: ManagedRunDelivery;
  readonly message: string;
  readonly files: readonly ManagedRunFileManifest[];
  /** How each image run file reaches the model; absent for text-only delivery. */
  readonly images?: ReadonlyMap<string, ManagedRunImage>;
  /** Characters at the start of the message that other sessions share. */
  readonly cachePrefixChars?: number;
}): DeliveredMessage {
  const body = inputBody(
    input.message,
    input.delivery,
    input.files,
    input.images,
  );
  const prefixChars = stablePrefixChars(input.message, input.cachePrefixChars);
  const attachments = input.files.flatMap((file) => {
    const image = input.images?.get(file.id);
    return image?.status === "attached"
      ? [
          {
            type: "image" as const,
            data: image.image.data,
            mimeType: image.image.mimeType,
            filename: file.name,
          },
        ]
      : [];
  });
  // The body starts with the message, so the split is a position in both.
  if (prefixChars > 0)
    return {
      kind: "user",
      body: cachedRunEnvelope(
        input.delivery,
        body.slice(0, prefixChars),
        body.slice(prefixChars),
      ),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  if (attachments.length > 0)
    return {
      kind: "user",
      body: managedRunEnvelope(input.delivery, body),
      attachments,
    };
  return {
    kind: "signal",
    type: MANAGED_RUN_SIGNAL_TYPE,
    tagName: MANAGED_RUN_TAG,
    body,
    attributes: input.delivery,
  };
}

/**
 * The request an existing admission is held to. An image run reserved before
 * native image input stored the hash of its text-only signal, so recovery
 * keeps that identity and delivers the text-only message it was admitted with.
 */
function recoveredAdmissionRequest(input: {
  readonly requestHash: Uint8Array;
  readonly textOnlyRequestHash: Uint8Array | undefined;
  readonly storedRequestHash: Uint8Array;
}): { readonly requestHash: Uint8Array; readonly textOnlyDelivery: boolean } {
  return input.textOnlyRequestHash &&
    Buffer.from(input.storedRequestHash).equals(
      Buffer.from(input.textOnlyRequestHash),
    )
    ? { requestHash: input.textOnlyRequestHash, textOnlyDelivery: true }
    : { requestHash: input.requestHash, textOnlyDelivery: false };
}

const MANAGED_RUN_IMAGE_REQUEST = "oao.run.v1+images";

/**
 * The value an admission's request hash covers. A run without image files
 * hashes its exact delivered message, unchanged from before native image
 * input. A run with image files hashes the inputs its message is rendered
 * from instead: the message, the file manifest whose SHA-256 values pin the
 * bytes, and the image policy version. Admission recovery then never has to
 * download images or depend on encoder output.
 */
export function managedRunRequestIdentity(input: {
  readonly delivery: ManagedRunDelivery;
  readonly message: string;
  readonly files: readonly ManagedRunFileManifest[];
  readonly cachePrefixChars?: number;
}): unknown {
  if (!input.files.some(isImageRunFile))
    return createManagedRunDeliveredMessage(input);
  const prefixChars = stablePrefixChars(input.message, input.cachePrefixChars);
  return {
    type: MANAGED_RUN_IMAGE_REQUEST,
    imagePolicyVersion: MODEL_IMAGE_POLICY_VERSION,
    delivery: input.delivery,
    message: input.message,
    // Only when set, so other image runs keep their identity.
    ...(prefixChars > 0 ? { cachePrefixChars: prefixChars } : {}),
    files: input.files.map((file) => ({
      id: file.id,
      name: file.name,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })),
  };
}

/**
 * The prompt cache key of a session without one of its own. Every session of
 * an agent version shares it, so they read the cached instructions and tools.
 */
function agentVersionPromptCacheKey(agentVersionId: string): string {
  return `oao-agent-version:${agentVersionId}`;
}

// Prompt cache keys of the thread instances this process renders, by Flue
// instance ID. Flue runs a model call in the process that renders its
// instance, and every render records the key again.
const PROMPT_CACHE_KEY_ENTRIES = 10_000;
const promptCacheKeys = new Map<string, string>();

function rememberPromptCacheKey(instanceId: string, key: string): void {
  promptCacheKeys.delete(instanceId);
  promptCacheKeys.set(instanceId, key);
  if (promptCacheKeys.size > PROMPT_CACHE_KEY_ENTRIES) {
    const oldest = promptCacheKeys.keys().next().value;
    if (oldest !== undefined) promptCacheKeys.delete(oldest);
  }
}

/**
 * The prompt cache scope of a model call of a thread instance: the session's
 * key, and the stable start of a run message with a cached prefix.
 */
function managedPromptCacheScope(
  instanceId: string | undefined,
): ModelPromptCacheScope {
  const key = instanceId ? promptCacheKeys.get(instanceId) : undefined;
  return {
    ...(key ? { key } : {}),
    stablePrefixLength: managedRunCachePrefixLength,
  };
}

export function ManagedAgent(): string {
  const initial = useInitialData<ManagedAgentInstanceData>();
  const delivered = useDelivery();
  const delivery = deliveryContext(delivered);
  if (delivery.snapshotHash !== digestHex(initial.snapshot))
    throw new Error(
      "ManagedAgent delivery snapshot does not match its instance",
    );
  rememberPromptCacheKey(
    threadInstanceId({
      organizationId: initial.organizationId as OrganizationId,
      projectId: initial.projectId as ProjectId,
      threadId: initial.threadId as ThreadId,
    }),
    initial.promptCacheKey ??
      agentVersionPromptCacheKey(initial.snapshot.agentVersionId),
  );
  const config = runtimeConfig();
  const preset = config.presets.resolve(initial.snapshot.modelPreset, {
    organizationId: initial.organizationId,
    projectId: initial.projectId,
  });
  // Flue resolves the model during this render, from the same registration,
  // so these are the limits the run's calls use. Another run may register
  // newer limits between this run's admission and its render.
  rememberRunModelLimits(delivery.runId, preset.limits);
  useModel(preset.model, {
    ...(preset.settings
      ? {
          thinkingLevel:
            preset.settings.effort === "none"
              ? ("off" as const)
              : preset.settings.effort,
        }
      : {}),
  });
  // Each run follows its own agent version, so a delegated child decides
  // for itself whether its text is published before its tool calls.
  const publishText = initial.snapshot.publishTextBeforeToolCalls === true;
  const run = {
    organizationId: initial.organizationId as OrganizationId,
    projectId: initial.projectId as ProjectId,
    runId: delivery.runId as RunId,
  };
  const publishTextBefore = (toolCallId: string, signal?: AbortSignal) =>
    publishAssistantTextBefore(config.broker, run, toolCallId, signal);
  if (publishText) pendingAssistantText.publishBeforeToolCalls(run.runId);
  // The model ends its final reply with a suggestion line; text published
  // before then must not show one the model wrote too early.
  if (initial.snapshot.promptSuggestions === true)
    pendingAssistantText.cutSuggestionLines(run.runId);
  const withTextBefore = <T>(
    obligation: ToolObligationInput,
    signal: AbortSignal | undefined,
    publish: (obligation: ToolObligationInput) => Promise<T>,
  ) =>
    withPendingAssistantText(
      config.broker,
      obligation,
      signal,
      publish,
      pendingAssistantText,
      publishText,
    );
  if (initial.snapshot.sandbox.enabled && config.sandboxFactory) {
    const sandbox = config.sandboxFactory(initial, delivery);
    useSandbox(
      publishText
        ? withAssistantTextBeforeSandboxTools(sandbox, publishTextBefore)
        : sandbox,
    );
    if (sandbox.persistWorkspace)
      useAgentFinish(async ({ harness }) =>
        sandbox.persistWorkspace?.(harness.sandbox),
      );
  }
  useAgentStart(async ({ harness, log }) => {
    const files = await loadManagedRunFiles(
      config.pool,
      config.runFileStorage,
      {
        organizationId: initial.organizationId as OrganizationId,
        projectId: initial.projectId as ProjectId,
        runId: delivery.runId as RunId,
      },
    );
    if (files.length === 0) return;
    if (!initial.snapshot.sandbox.enabled || !config.sandboxFactory)
      throw new Error("Run files require a sandbox-enabled agent");
    if (
      !initial.snapshot.sandbox.capabilities.some((capability) =>
        ["filesystem_read", "shell"].includes(capability),
      )
    )
      throw new Error(
        "Run files require the filesystem_read or shell sandbox capability",
      );
    await materializeManagedRunFiles(harness.sandbox, delivery, files);
    log.info("Materialized run files in the sandbox", {
      runId: delivery.runId,
      fileCount: files.length,
    });
  });

  if (initial.snapshot.skills.length > 0 && !config.skills)
    throw new Error("ManagedAgent Skill registry is not configured");
  for (const binding of initial.snapshot.skills)
    useSkill(
      config.skills!.resolve(
        {
          organizationId: initial.organizationId as OrganizationId,
          projectId: initial.projectId as ProjectId,
        },
        binding,
      ),
    );

  for (const operation of initial.snapshot.harnessOperations)
    useTool(
      createManagedHarnessOperationTool(
        operation,
        publishText ? publishTextBefore : undefined,
      ),
    );

  const delegationValue = v.strictObject({
    delegationId: v.string(),
    childSessionId: v.string(),
    childRunId: v.string(),
    status: v.picklist(["completed", "failed", "cancelled", "timed_out"]),
    response: v.string(),
  });
  const delegationOutput = v.variant("status", [
    v.strictObject({
      version: v.literal(1),
      status: v.literal("success"),
      value: delegationValue,
    }),
    v.strictObject({
      version: v.literal(1),
      status: v.literal("failure"),
      error: v.strictObject({
        code: ToolResultFailureCodeSchema,
        message: v.string(),
      }),
    }),
  ]);
  if (initial.snapshot.delegates.length > 0) {
    if (!config.delegations)
      throw new Error("ManagedAgent delegation coordinator is not configured");
    const roster = initial.snapshot.delegates
      .map(
        (delegate) =>
          `${delegate.key}: ${delegate.description} (max parallel ${delegate.maxParallel})`,
      )
      .join("\n");
    useTool({
      name: "delegate_agent",
      description: `Start a persistent child-agent thread. Read its delegationId from the successful result value. Available delegates:\n${roster}`,
      input: v.strictObject({
        agent: v.picklist(
          initial.snapshot.delegates.map((delegate) => delegate.key) as [
            string,
            ...string[],
          ],
        ),
        prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
      }),
      output: delegationOutput,
      durable: true,
      async run({ data, signal, step, toolCallId }) {
        const obligation: ToolObligationInput = {
          organizationId: initial.organizationId as OrganizationId,
          projectId: initial.projectId as ProjectId,
          runId: delivery.runId as RunId,
          flueToolCallId: toolCallId,
          toolName: "delegate_agent",
          safeArguments: {
            agent: data.agent,
            promptCharacters: data.prompt.length,
          },
          approval: "never",
        };
        const outcome = await step.do("execute-delegation", () =>
          withTextBefore(obligation, signal, (gated) =>
            config.broker.executePlatform(
              gated,
              async (executeSignal) => {
                const result = await config.delegations!.delegate({
                  organizationId: initial.organizationId,
                  projectId: initial.projectId,
                  parentRunId: delivery.runId,
                  parentThreadId: initial.threadId,
                  parentSessionId: initial.sessionId,
                  parentAgentVersionId: initial.snapshot.agentVersionId,
                  delegateKey: data.agent,
                  prompt: data.prompt,
                  idempotencyKey: `delegate:${delivery.runId}:${toolCallId}`,
                  ...(executeSignal ? { signal: executeSignal } : {}),
                });
                return { ...result } as Readonly<Record<string, PublicValue>>;
              },
              signal,
            ),
          ),
        );
        return { output: outcome };
      },
    });
    useTool({
      name: "message_agent",
      description:
        "Send a follow-up message to an existing persistent child-agent thread returned by delegate_agent.",
      input: v.strictObject({
        delegationId: v.pipe(v.string(), v.uuid()),
        prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
      }),
      output: delegationOutput,
      durable: true,
      async run({ data, signal, step, toolCallId }) {
        const obligation: ToolObligationInput = {
          organizationId: initial.organizationId as OrganizationId,
          projectId: initial.projectId as ProjectId,
          runId: delivery.runId as RunId,
          flueToolCallId: toolCallId,
          toolName: "message_agent",
          safeArguments: {
            delegationId: data.delegationId,
            promptCharacters: data.prompt.length,
          },
          approval: "never",
        };
        const outcome = await step.do("execute-delegation-follow-up", () =>
          withTextBefore(obligation, signal, (gated) =>
            config.broker.executePlatform(
              gated,
              async (executeSignal) => {
                const result = await config.delegations!.followUp({
                  organizationId: initial.organizationId,
                  projectId: initial.projectId,
                  parentRunId: delivery.runId,
                  parentSessionId: initial.sessionId,
                  delegationId: data.delegationId,
                  prompt: data.prompt,
                  idempotencyKey: `delegate-follow-up:${delivery.runId}:${toolCallId}`,
                  ...(executeSignal ? { signal: executeSignal } : {}),
                });
                return { ...result } as Readonly<Record<string, PublicValue>>;
              },
              signal,
            ),
          ),
        );
        return { output: outcome };
      },
    });
  }

  if (initial.snapshot.mcpTools.length > 0 && !config.mcp)
    throw new Error("ManagedAgent MCP executor is not configured");
  const mcpOutput = v.variant("status", [
    v.strictObject({
      version: v.literal(1),
      status: v.literal("success"),
      value: v.strictObject({
        content: v.string(),
        isError: v.boolean(),
      }),
    }),
    v.strictObject({
      version: v.literal(1),
      status: v.literal("failure"),
      error: v.strictObject({
        code: ToolResultFailureCodeSchema,
        message: v.string(),
      }),
    }),
  ]);
  for (const tool of initial.snapshot.mcpTools)
    useTool({
      name: tool.name,
      description: tool.description,
      input: compileToolInputSchema(tool.inputSchema),
      output: mcpOutput,
      durable: true,
      async run({ data, signal, step, toolCallId }) {
        const obligation: ToolObligationInput = {
          organizationId: initial.organizationId as OrganizationId,
          projectId: initial.projectId as ProjectId,
          runId: delivery.runId as RunId,
          flueToolCallId: toolCallId,
          toolName: tool.name,
          safeArguments: safeArguments(data),
          approval: tool.approval,
        };
        const retryBlocked = await config.broker.retryAdmission(obligation);
        if (retryBlocked) return { output: retryBlocked };
        const outcome = await step.do("execute-mcp-obligation", () =>
          withTextBefore(obligation, signal, (gated) =>
            config.broker.executePlatform(
              gated,
              (executeSignal) =>
                config.mcp!.execute(
                  {
                    organizationId: initial.organizationId as OrganizationId,
                    projectId: initial.projectId as ProjectId,
                    sessionId: initial.sessionId,
                    runId: delivery.runId as RunId,
                    flueToolCallId: toolCallId,
                  },
                  tool,
                  obligation.safeArguments,
                  executeSignal,
                ),
              signal,
            ),
          ),
        );
        return { output: outcome };
      },
    });

  const oaoGrant = initial.snapshot.oaoTools;
  for (const tool of oaoGrant ? oaoAgentTools(oaoGrant) : [])
    useTool({
      name: `${OAO_AGENT_TOOL_PREFIX}${tool.name}`,
      description: tool.description,
      input: tool.input,
      output: mcpOutput,
      durable: true,
      async run({ data, signal, step, toolCallId }) {
        const arguments_ = data as Readonly<Record<string, unknown>>;
        const obligation: ToolObligationInput = {
          organizationId: initial.organizationId as OrganizationId,
          projectId: initial.projectId as ProjectId,
          runId: delivery.runId as RunId,
          flueToolCallId: toolCallId,
          toolName: `${OAO_AGENT_TOOL_PREFIX}${tool.name}`,
          safeArguments: safeArguments(oaoToolLedgerArguments(arguments_)),
          // Reading never waits for a person; changing OAO follows the grant.
          approval: tool.readOnly ? "never" : oaoGrant!.approval,
        };
        const retryBlocked = await config.broker.retryAdmission(obligation);
        if (retryBlocked) return { output: retryBlocked };
        const outcome = await step.do("execute-oao-obligation", () =>
          withTextBefore(obligation, signal, (gated) =>
            config.broker.executePlatform(
              gated,
              async (executeSignal) => {
                if (!config.oaoTools)
                  throw new Error(
                    "OAO tools are not configured on this runtime worker",
                  );
                return {
                  ...(await config.oaoTools.execute(
                    {
                      organizationId: initial.organizationId as OrganizationId,
                      projectId: initial.projectId as ProjectId,
                      runId: delivery.runId as RunId,
                      flueToolCallId: toolCallId,
                    },
                    tool,
                    oaoGrant!,
                    arguments_,
                    executeSignal,
                  )),
                };
              },
              signal,
            ),
          ),
        );
        return { output: outcome };
      },
    });

  for (const tool of initial.snapshot.tools) {
    const outputValueSchema = compileObjectSchema(tool.outputSchema);
    useTool({
      name: tool.name,
      description: tool.description,
      input: compileToolInputSchema(tool.inputSchema),
      output: compileToolOutputSchema(tool.outputSchema),
      durable: true,
      async run({ data, signal, step, toolCallId }) {
        const obligation: ToolObligationInput = {
          organizationId: initial.organizationId as OrganizationId,
          projectId: initial.projectId as ProjectId,
          runId: delivery.runId as RunId,
          flueToolCallId: toolCallId,
          toolName: tool.name,
          safeArguments: safeArguments(data),
          approval: tool.approval,
        };
        const retryBlocked = await config.broker.retryAdmission(obligation);
        if (retryBlocked) return { output: retryBlocked };
        if (tool.owner === "caller") {
          await step.do("publish-caller-obligation", () =>
            withTextBefore(obligation, signal, (gated) =>
              config.broker.publishCaller(gated),
            ),
          );
          const outcome = await step.do("commit-caller-result", () =>
            config.broker.waitForCaller(obligation, signal, (value) => {
              const validation = v.safeParse(outputValueSchema, value);
              return {
                valid: validation.success,
                ...(validation.success
                  ? {}
                  : { message: "Tool returned an invalid result" }),
              };
            }),
          );
          return { output: outcome };
        }
        const handler = config.platformTools.get(tool.name);
        const outcome = await step.do("execute-platform-obligation", () =>
          withTextBefore(obligation, signal, (gated) =>
            config.broker.executePlatform(
              gated,
              async (executeSignal) => {
                if (!handler)
                  throw new Error("Platform tool handler unavailable");
                const result = await handler(obligation.safeArguments, {
                  runId: obligation.runId,
                  toolCallId,
                  idempotencyKey: `platform:${obligation.runId}:${toolCallId}`,
                  ...(executeSignal ? { signal: executeSignal } : {}),
                });
                return v.parse(outputValueSchema, result) as PublicValue;
              },
              signal,
            ),
          ),
        );
        return { output: outcome };
      },
    });
  }
  return managedSystemPrompt(initial.snapshot);
}

ManagedAgent.agentName = "ManagedAgent";
ManagedAgent.initialData = ManagedAgentInstanceDataSchema;
// Flue supervises total wall time independently of OAO's execution budget.
// Leave room for a full 24-hour approval pause and subsequent execution.
ManagedAgent.durability = { maxAttempts: 10, timeoutMs: 48 * 60 * 60 * 1000 };

export function createFluePostgresAdapter(pool: PgPool) {
  return postgres({
    query: async (text, params) => (await pool.query(text, params)).rows,
    transaction: async (callback) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await callback({
          query: async (text, params) =>
            (await client.query(text, params)).rows,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => undefined,
  });
}

interface RunContext extends TenantContext {
  readonly hasRevokedSkills: boolean;
  readonly hasAdmissionReceipt: boolean;
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly agentVersionId: string;
  readonly state: string;
  readonly cancellationRequested: boolean;
  readonly inputPublic: ManagedRunInputV1;
  readonly files: readonly ManagedRunFileManifest[];
  readonly snapshot: ManagedAgentSnapshot;
  readonly workspace: NonNullable<ManagedAgentInstanceData["workspace"]>;
  /** The session's prompt cache key, when its creator gave one. */
  readonly promptCacheKey?: string;
  /** Characters at the start of this run's message that other sessions share. */
  readonly cachePrefixChars: number;
}

export type ManagedRunFileManifest = NonNullable<
  ManagedRunInputV1["files"]
>[number];

export type ManagedRunFileContent = ManagedRunFileManifest & {
  readonly bytes: Buffer;
};

interface DispatchRow {
  organization_id: OrganizationId;
  project_id: ProjectId;
  run_id: RunId;
  thread_id: ThreadId;
  admission_key: string;
  request_hash: Uint8Array;
  snapshot_hash: Uint8Array;
  state: string;
  fence: string;
  flue_conversation_id: string;
  flue_submission_id: string | null;
  flue_instance_uid: string | null;
  flue_accepted_at: Date | null;
  deadline_at: Date;
  timeout_requested_at: Date | null;
}

interface ThreadInstanceRow {
  organization_id: OrganizationId;
  project_id: ProjectId;
  thread_id: ThreadId;
  session_id: string;
  agent_version_id: string;
  snapshot_hash: Buffer;
  flue_instance_id: string;
  flue_instance_uid: string | null;
  state: "ready" | "corrupt";
}

class FlueIncarnationCorruptionError extends Error {}

/** Only permanent, locally verified Skill errors use this safe public failure. */
export class SkillPackageUnavailableError extends Error {
  readonly code = "skill_package_unavailable";
  constructor() {
    super(
      "A bound Skill package is missing, revoked, or failed integrity validation. Publish a corrected Skill and agent version, then start a new session.",
    );
    this.name = "SkillPackageUnavailableError";
  }
}

/**
 * Object storage kept failing while the run's images were prepared. Admission
 * fails the run before anything is sent, so no later attempt can deliver a
 * different first message for it.
 */
export class RunFileStorageUnavailableError extends Error {
  readonly code = "run_file_storage_unavailable";
  constructor(options?: ErrorOptions) {
    super(
      "Object storage did not return the run's image files. Start the run again once storage is available.",
      options,
    );
    this.name = "RunFileStorageUnavailableError";
  }
}

/**
 * The run can never start: its preset was never approved for the project or
 * the provider connection behind it was removed. Retrying the wake cannot
 * help, so admission fails the run visibly instead of exhausting attempts.
 */
export class ModelPresetUnavailableError extends Error {
  constructor(
    readonly code: "model_preset_unavailable" | "model_provider_removed",
    message: string,
  ) {
    super(message);
    this.name = "ModelPresetUnavailableError";
  }
}

function threadInstanceId(
  input: TenantContext & { readonly threadId: ThreadId },
): string {
  return `oao:v1:${input.organizationId}:${input.projectId}:${input.threadId}`;
}

function digestJson(value: unknown): Uint8Array {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function digestHex(value: unknown): string {
  return Buffer.from(digestJson(value)).toString("hex");
}

function eventUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * What a model call cost and where the rates came from. The price set on the
 * run's model preset wins; otherwise the price list built into the model
 * catalog, which knows nothing about OpenRouter presets or Bedrock. The rates
 * go into the invocation, so a later price change leaves this call as it is.
 * `pricing_snapshot` rejects keys that name tokens, so the keys avoid the word.
 */
export async function modelCallPricing(
  transaction: Queryable,
  dispatch: Pick<DispatchRow, "organization_id" | "project_id" | "run_id">,
  usage: ModelUsageCounts & {
    readonly cost: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly total: number;
    };
  },
  startedAt: Date,
  model: string,
): Promise<{
  readonly costMicrounits: number;
  readonly snapshot: Record<string, PublicValue>;
}> {
  const price = await findRunModelPresetPrice(transaction, {
    organizationId: dispatch.organization_id,
    projectId: dispatch.project_id,
    runId: dispatch.run_id,
    at: startedAt,
  });
  if (price) {
    const { costMicrounits, costByKind, tier, longContext } = priceModelCall(
      price.rates,
      usage,
    );
    return {
      costMicrounits,
      snapshot: {
        model,
        source: "preset_price",
        costByKind: { ...costByKind },
        priceId: price.id,
        inputUsdPerMillion: tier.inputUsdPerMillion,
        cachedInputUsdPerMillion: tier.cachedInputUsdPerMillion,
        cacheWriteUsdPerMillion: tier.cacheWriteUsdPerMillion,
        outputUsdPerMillion: tier.outputUsdPerMillion,
        longContext,
      },
    };
  }
  const costMicrounits = Math.round(usage.cost.total * 1_000_000);
  if (costMicrounits === 0)
    return { costMicrounits, snapshot: { model, source: "none" } };
  return {
    costMicrounits,
    snapshot: {
      model,
      source: "catalog",
      // The catalog's parts, so a cost from it splits by kind too.
      costByKind: {
        inputMicrounits: Math.round(usage.cost.input * 1_000_000),
        cacheReadMicrounits: Math.round(usage.cost.cacheRead * 1_000_000),
        cacheWriteMicrounits: Math.round(usage.cost.cacheWrite * 1_000_000),
        outputMicrounits: Math.round(usage.cost.output * 1_000_000),
      },
    },
  };
}

/** Flue stamps completed turn observations; recover the actual model window. */
function turnWindow(event: {
  readonly timestamp: string;
  readonly durationMs: number;
}): { readonly startedAt: Date; readonly completedAt: Date } {
  const completedAt = new Date(event.timestamp);
  const durationMs = Number.isFinite(event.durationMs)
    ? Math.max(0, event.durationMs)
    : 0;
  return {
    startedAt: new Date(completedAt.getTime() - durationMs),
    completedAt,
  };
}

/** Provider thinking text is transcript data; provider signatures stay private. */
function turnThinking(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const content = (output as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const thinking = content
    .filter(
      (
        part,
      ): part is { readonly type: "thinking"; readonly thinking: string } =>
        Boolean(
          part &&
          typeof part === "object" &&
          (part as { readonly type?: unknown }).type === "thinking" &&
          typeof (part as { readonly thinking?: unknown }).thinking ===
            "string",
        ),
    )
    .map((part) => part.thinking.trim())
    .filter(Boolean)
    .join("\n\n");
  return thinking ? jsonbSafeText(thinking) : undefined;
}

/**
 * Describe an inner model turn without publishing its scratch text, prompt,
 * arguments, result, Skill contents, or document contents.
 */
function harnessModelActionSummary(output: unknown, isError: boolean): string {
  if (isError) return "The scratch model invocation failed.";
  if (!output || typeof output !== "object")
    return "The scratch model produced an internal response.";
  const content = (output as { readonly content?: unknown }).content;
  if (!Array.isArray(content))
    return "The scratch model produced an internal response.";
  const toolNames = [
    ...new Set(
      content
        .filter(
          (
            part,
          ): part is { readonly type: "toolCall"; readonly name: string } =>
            Boolean(
              part &&
              typeof part === "object" &&
              (part as { readonly type?: unknown }).type === "toolCall" &&
              typeof (part as { readonly name?: unknown }).name === "string",
            ),
        )
        .map((part) => part.name.trim())
        .filter((name) => /^[a-z0-9][a-z0-9_.:/-]{0,127}$/iu.test(name))
        .slice(0, 8),
    ),
  ];
  if (toolNames.length === 0)
    return "The scratch model produced an internal response without requesting a tool.";
  if (toolNames.length === 1 && toolNames[0] === "finish")
    return "Returned the structured result for validation.";
  return toolNames.length === 1
    ? `Requested ${toolNames[0]}.`
    : `Requested ${toolNames.join(", ")} in one tool batch.`;
}

/** Keep exact provider finish values public only when they are bounded tokens. */
function publicProviderFinishReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const reason = value.trim();
  return /^[a-z0-9][a-z0-9._:/-]{0,119}$/iu.test(reason) ? reason : undefined;
}

/**
 * Project provider failure diagnostics without persisting raw provider errors.
 *
 * pi-ai exposes standardized finish errors as messages such as
 * `Provider finish_reason: content_filter` (Chat Completions) or
 * `Response incomplete: content_filter` (Responses); newer Flue providers can supply the
 * exact value directly as `providerFinishReason`. Both paths are restricted to
 * the same token grammar before they enter a public payload.
 */
function modelInvocationDiagnostics(
  response: {
    readonly finishReason?: string;
    readonly providerFinishReason?: string;
    readonly error?: { readonly message?: string };
  },
  isError: boolean,
): Readonly<Record<string, string>> {
  const limitMatch = /^Model turn limit exceeded \(([0-9]{1,3})\)$/.exec(
    response.error?.message ?? "",
  );
  if (
    isError &&
    limitMatch &&
    Number(limitMatch[1]) >= 1 &&
    Number(limitMatch[1]) <= MAX_AGENT_MODEL_TURNS
  ) {
    return {
      finishReason: "error",
      errorCode: "model_turn_limit_exceeded",
      errorExplanation: `The run reached its maximum of ${limitMatch[1]} model turns. ${Number(limitMatch[1]) < MAX_AGENT_MODEL_TURNS ? "Publish a new agent version with a higher limit and start a new session to continue." : "Split the work into smaller runs and start a new session."} The run timeout still applies.`,
    };
  }
  const finishReason =
    publicProviderFinishReason(response.finishReason) ?? "unknown";
  const standardizedReason =
    typeof response.error?.message === "string"
      ? /^(?:Provider (?:finish_reason|stopped with)|Response incomplete):\s*([a-z0-9][a-z0-9._:/-]{0,119})$/iu.exec(
          response.error.message.trim(),
        )?.[1]
      : undefined;
  const providerFinishReason =
    publicProviderFinishReason(response.providerFinishReason) ??
    publicProviderFinishReason(standardizedReason);
  const errorExplanation = !isError
    ? undefined
    : /^Model call timed out after \d+ms$/u.test(response.error?.message ?? "")
      ? "The model attempt exceeded its deadline and was aborted. OAO retries it when the retry budget and run deadline permit."
      : providerFinishReason === "content_filter"
        ? "The provider stopped the response because its content filter was triggered, so OAO treated the partial response as incomplete and failed the run."
        : providerFinishReason === "network_error"
          ? "The provider reported a network error before producing a complete response, so OAO failed the run."
          : providerFinishReason
            ? `The provider ended the response with "${providerFinishReason}", which OAO treats as an incomplete model response and a failed run.`
            : "The model invocation ended before a complete response was returned, so OAO failed the run.";
  return {
    finishReason,
    ...(providerFinishReason ? { providerFinishReason } : {}),
    ...(errorExplanation ? { errorExplanation } : {}),
  };
}

async function appendEventOnce(
  transaction: Queryable,
  input: TenantContext & {
    readonly id: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly kind: string;
    readonly payload: Readonly<Record<string, PublicValue>>;
  },
): Promise<void> {
  const exists = await transaction.query(
    "SELECT 1 FROM oao.product_events WHERE organization_id=$1 AND project_id=$2 AND id=$3",
    [input.organizationId, input.projectId, input.id],
  );
  if (exists.rowCount) return;
  await transaction.query(
    "SELECT oao.append_product_event($1,$2,$3,$4,$5,$6,$7,clock_timestamp())",
    [
      input.organizationId,
      input.projectId,
      input.id,
      input.aggregateType,
      input.aggregateId,
      input.kind,
      input.payload,
    ],
  );
}

const TERMINAL_CHILD_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

function delegationPrompt(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100_000)
    throw new TypeError(
      "Delegation prompt must contain 1 to 100000 characters",
    );
  const redacted = redactForPublic(trimmed);
  return typeof redacted === "string" ? redacted : "[redacted]";
}

/** PostgreSQL-authoritative coordinator for persistent child-agent sessions. */
export class PostgresAgentDelegationCoordinator implements AgentDelegationPort {
  constructor(
    private readonly pool: PgPool,
    private readonly queue: PostgresWakeQueue,
  ) {}

  async delegate(
    input: Parameters<AgentDelegationPort["delegate"]>[0],
  ): Promise<AgentDelegationResult> {
    const prompt = delegationPrompt(input.prompt);
    const requestHash = digestJson({
      parentRunId: input.parentRunId,
      delegateKey: input.delegateKey,
      prompt,
    });
    const created = await withTenantTransaction(
      this.pool,
      {
        organizationId: input.organizationId as OrganizationId,
        projectId: input.projectId as ProjectId,
      },
      async (transaction) => {
        const replay = await transaction.query<{
          id: string;
          child_session_id: string;
          child_run_id: string;
          request_hash: Buffer;
        }>(
          `SELECT delegation.id,delegation.child_session_id,run.child_run_id,
                  delegation.request_hash
             FROM oao.agent_delegations delegation
             JOIN oao.delegation_runs run
               ON run.organization_id=delegation.organization_id
              AND run.project_id=delegation.project_id
              AND run.delegation_id=delegation.id AND run.ordinal=1
            WHERE delegation.organization_id=$1 AND delegation.project_id=$2
              AND delegation.request_key=$3`,
          [input.organizationId, input.projectId, input.idempotencyKey],
        );
        const existing = replay.rows[0];
        if (existing) {
          if (
            Buffer.compare(Buffer.from(existing.request_hash), requestHash) !==
            0
          )
            throw new Error("Delegation idempotency conflict");
          return {
            delegationId: existing.id,
            childSessionId: existing.child_session_id,
            childRunId: existing.child_run_id,
          };
        }

        const parentResult = await transaction.query<{
          created_by_principal_id: string;
          child_agent_version_id: string | null;
          max_parallel: number;
          workspace_id: string;
          resolution: unknown;
        }>(
          `SELECT parent.created_by_principal_id,delegate.child_agent_version_id,
                  delegate.max_parallel,binding.workspace_id,
                  resolution.resolution
             FROM oao.runs parent
             JOIN oao.agent_version_delegates delegate
               ON delegate.organization_id=parent.organization_id
              AND delegate.project_id=parent.project_id
              AND delegate.parent_agent_version_id=parent.agent_version_id
              AND delegate.delegate_key=$7
             JOIN oao.thread_workspace_bindings binding
               ON binding.organization_id=parent.organization_id
              AND binding.project_id=parent.project_id
              AND binding.thread_id=parent.thread_id
             LEFT JOIN oao.session_version_resolutions resolution
               ON resolution.organization_id=parent.organization_id
              AND resolution.project_id=parent.project_id
              AND resolution.session_id=parent.session_id
            WHERE parent.organization_id=$1 AND parent.project_id=$2
              AND parent.id=$3 AND parent.thread_id=$4 AND parent.session_id=$5
              AND parent.agent_version_id=$6
            FOR UPDATE OF parent`,
          [
            input.organizationId,
            input.projectId,
            input.parentRunId,
            input.parentThreadId,
            input.parentSessionId,
            input.parentAgentVersionId,
            input.delegateKey,
          ],
        );
        const parent = parentResult.rows[0];
        if (!parent)
          throw new Error("Delegate is not allowed for this agent version");
        // The child runs the version the session tree resolved when it
        // started, even if the delegate's agent has published since.
        const resolution =
          parent.resolution === null || parent.resolution === undefined
            ? undefined
            : parseSessionVersionResolution(parent.resolution);
        let childAgentVersionId: string;
        let childSkillVersionIds: readonly string[] | undefined;
        if (resolution) {
          const resolved = resolvedAgentVersion(
            resolution,
            input.parentAgentVersionId,
          ).delegates.find((delegate) => delegate.key === input.delegateKey);
          if (!resolved)
            throw new Error(
              "The session's version resolution does not cover this delegate",
            );
          childAgentVersionId = resolved.agentVersionId;
          childSkillVersionIds = resolvedAgentVersion(
            resolution,
            childAgentVersionId,
          ).skills.map((skill) => skill.skillVersionId);
        } else {
          if (!parent.child_agent_version_id)
            throw new Error(
              "The delegate follows the latest version, but the session has no version resolution",
            );
          childAgentVersionId = parent.child_agent_version_id;
        }
        const activeResult = await transaction.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM oao.agent_delegations delegation
            WHERE delegation.organization_id=$1 AND delegation.project_id=$2
              AND delegation.parent_session_id=$3 AND delegation.delegate_key=$4
              AND delegation.state='active'
              AND EXISTS (
                SELECT 1 FROM oao.delegation_runs link
                JOIN oao.runs child ON child.organization_id=link.organization_id
                  AND child.project_id=link.project_id AND child.id=link.child_run_id
                WHERE link.organization_id=delegation.organization_id
                  AND link.project_id=delegation.project_id
                  AND link.delegation_id=delegation.id
                  AND child.state NOT IN ('completed','failed','cancelled','timed_out')
              )`,
          [
            input.organizationId,
            input.projectId,
            input.parentSessionId,
            input.delegateKey,
          ],
        );
        if (Number(activeResult.rows[0]?.count ?? 0) >= parent.max_parallel)
          throw new Error("Delegate parallelism limit reached");

        const delegationId = eventUuid(`delegation:${input.idempotencyKey}`);
        const childThreadId = eventUuid(`delegation-thread:${delegationId}`);
        const childSessionId = eventUuid(`delegation-session:${delegationId}`);
        const childRunId = eventUuid(`delegation-run:${delegationId}:1`);
        const messageId = eventUuid(`delegation-message:${delegationId}:1`);
        await transaction.query(
          `INSERT INTO oao.threads (organization_id,project_id,id,title)
           VALUES ($1,$2,$3,$4)`,
          [
            input.organizationId,
            input.projectId,
            childThreadId,
            `Delegated: ${input.delegateKey}`,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.sessions
             (organization_id,project_id,id,thread_id,agent_version_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            input.organizationId,
            input.projectId,
            childSessionId,
            childThreadId,
            childAgentVersionId,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.thread_workspace_bindings
             (organization_id,project_id,thread_id,workspace_id,role)
           VALUES ($1,$2,$3,$4,'child')`,
          [
            input.organizationId,
            input.projectId,
            childThreadId,
            parent.workspace_id,
          ],
        );
        await transaction.query(
          // A child of a run another agent started keeps that origin, so
          // delegation cannot lift the rule that such runs only read.
          `INSERT INTO oao.runs
             (organization_id,project_id,id,thread_id,session_id,agent_version_id,
              created_by_principal_id,idempotency_key,input_public,requested_by_run_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
             (SELECT requested_by_run_id FROM oao.runs
               WHERE organization_id=$1 AND project_id=$2 AND id=$10))`,
          [
            input.organizationId,
            input.projectId,
            childRunId,
            childThreadId,
            childSessionId,
            childAgentVersionId,
            parent.created_by_principal_id,
            input.idempotencyKey,
            { message: prompt },
            input.parentRunId,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.messages
             (organization_id,project_id,id,thread_id,run_id,role,redacted_content)
           VALUES ($1,$2,$3,$4,$5,'user',$6)`,
          [
            input.organizationId,
            input.projectId,
            messageId,
            childThreadId,
            childRunId,
            prompt,
          ],
        );
        if (resolution && childSkillVersionIds) {
          // The child carries the root's resolution, so its own delegates
          // resolve to the same versions when it delegates in turn.
          await transaction.query(
            `INSERT INTO oao.session_version_resolutions
               (organization_id,project_id,session_id,resolution)
             VALUES ($1,$2,$3,$4)`,
            [input.organizationId, input.projectId, childSessionId, resolution],
          );
          await transaction.query(
            `INSERT INTO oao.session_skill_bindings (
               organization_id,project_id,session_id,agent_version_id,
               skill_version_id,skill_name
             )
             SELECT $1,$2,$3,$4,sv.id,sv.skill_name
               FROM oao.skill_versions sv
              WHERE sv.organization_id=$1 AND sv.project_id=$2
                AND sv.id=ANY($5::uuid[])`,
            [
              input.organizationId,
              input.projectId,
              childSessionId,
              childAgentVersionId,
              childSkillVersionIds,
            ],
          );
        } else
          await transaction.query(
            `INSERT INTO oao.session_skill_bindings (
               organization_id,project_id,session_id,agent_version_id,
               skill_version_id,skill_name
             )
             SELECT organization_id,project_id,$3,agent_version_id,
                    skill_version_id,skill_name
               FROM oao.agent_version_skill_bindings
              WHERE organization_id=$1 AND project_id=$2 AND agent_version_id=$4`,
            [
              input.organizationId,
              input.projectId,
              childSessionId,
              childAgentVersionId,
            ],
          );
        await transaction.query(
          `INSERT INTO oao.session_mcp_bindings (
             organization_id,project_id,session_id,agent_version_id,
             toolset_version_id,credential_policy_version_id,namespace
           )
           SELECT organization_id,project_id,$3,agent_version_id,
                  toolset_version_id,credential_policy_version_id,namespace
             FROM oao.agent_version_mcp_bindings
            WHERE organization_id=$1 AND project_id=$2 AND agent_version_id=$4`,
          [
            input.organizationId,
            input.projectId,
            childSessionId,
            childAgentVersionId,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.agent_delegations (
             organization_id,project_id,id,parent_run_id,parent_thread_id,
             parent_session_id,parent_agent_version_id,delegate_key,
             child_agent_version_id,child_thread_id,child_session_id,
             workspace_id,request_key,request_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            input.organizationId,
            input.projectId,
            delegationId,
            input.parentRunId,
            input.parentThreadId,
            input.parentSessionId,
            input.parentAgentVersionId,
            input.delegateKey,
            childAgentVersionId,
            childThreadId,
            childSessionId,
            parent.workspace_id,
            input.idempotencyKey,
            requestHash,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.delegation_runs (
             organization_id,project_id,delegation_id,ordinal,
             requested_by_run_id,child_run_id,request_key,request_hash
           ) VALUES ($1,$2,$3,1,$4,$5,$6,$7)`,
          [
            input.organizationId,
            input.projectId,
            delegationId,
            input.parentRunId,
            childRunId,
            input.idempotencyKey,
            requestHash,
          ],
        );
        await appendEventOnce(transaction, {
          organizationId: input.organizationId as OrganizationId,
          projectId: input.projectId as ProjectId,
          id: eventUuid(`event:${delegationId}:created`),
          aggregateType: "delegation",
          aggregateId: delegationId,
          kind: "delegation.created",
          payload: {
            delegateKey: input.delegateKey,
            childSessionId,
            childRunId,
            childAgentVersionId,
          },
        });
        await appendEventOnce(transaction, {
          organizationId: input.organizationId as OrganizationId,
          projectId: input.projectId as ProjectId,
          id: eventUuid(`event:${childRunId}:created`),
          aggregateType: "run",
          aggregateId: childRunId,
          kind: "run.created",
          payload: { state: "queued", sessionId: childSessionId },
        });
        await transaction.query(
          "SELECT oao.append_audit_entry($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())",
          [
            input.organizationId,
            input.projectId,
            eventUuid(`audit:${delegationId}:created`),
            parent.created_by_principal_id,
            "delegation.created",
            "delegation",
            delegationId,
            {
              delegateKey: input.delegateKey,
              childSessionId,
              childRunId,
              promptCharacters: prompt.length,
            },
          ],
        );
        await this.queue.enqueue(transaction, {
          organizationId: input.organizationId as OrganizationId,
          projectId: input.projectId as ProjectId,
          id: eventUuid(`wake:admit:${childRunId}`),
          runId: childRunId as RunId,
          dispatchKey: `admit:${childRunId}`,
          kind: "admit",
          payload: { reason: "agent_delegation" },
        });
        return { delegationId, childSessionId, childRunId };
      },
    );
    return this.waitForChild({ ...input, ...created });
  }

  async followUp(
    input: Parameters<AgentDelegationPort["followUp"]>[0],
  ): Promise<AgentDelegationResult> {
    const prompt = delegationPrompt(input.prompt);
    const requestHash = digestJson({
      delegationId: input.delegationId,
      parentRunId: input.parentRunId,
      prompt,
    });
    const created = await withTenantTransaction(
      this.pool,
      {
        organizationId: input.organizationId as OrganizationId,
        projectId: input.projectId as ProjectId,
      },
      async (transaction) => {
        const replay = await transaction.query<{
          child_run_id: string;
          child_session_id: string;
          request_hash: Buffer;
        }>(
          `SELECT link.child_run_id,delegation.child_session_id,link.request_hash
             FROM oao.delegation_runs link
             JOIN oao.agent_delegations delegation
               ON delegation.organization_id=link.organization_id
              AND delegation.project_id=link.project_id
              AND delegation.id=link.delegation_id
            WHERE link.organization_id=$1 AND link.project_id=$2
              AND link.request_key=$3`,
          [input.organizationId, input.projectId, input.idempotencyKey],
        );
        const existing = replay.rows[0];
        if (existing) {
          if (
            Buffer.compare(Buffer.from(existing.request_hash), requestHash) !==
            0
          )
            throw new Error("Delegation follow-up idempotency conflict");
          return {
            delegationId: input.delegationId,
            childSessionId: existing.child_session_id,
            childRunId: existing.child_run_id,
          };
        }
        const delegationResult = await transaction.query<{
          child_thread_id: string;
          child_session_id: string;
          child_agent_version_id: string;
          state: string;
          created_by_principal_id: string;
        }>(
          `SELECT delegation.child_thread_id,delegation.child_session_id,
                  delegation.child_agent_version_id,delegation.state,
                  parent.created_by_principal_id
             FROM oao.agent_delegations delegation
             JOIN oao.runs parent ON parent.organization_id=delegation.organization_id
              AND parent.project_id=delegation.project_id AND parent.id=$4
              AND parent.session_id=delegation.parent_session_id
              AND parent.agent_version_id=delegation.parent_agent_version_id
            WHERE delegation.organization_id=$1 AND delegation.project_id=$2
              AND delegation.id=$3 AND delegation.parent_session_id=$5
            FOR UPDATE OF delegation`,
          [
            input.organizationId,
            input.projectId,
            input.delegationId,
            input.parentRunId,
            input.parentSessionId,
          ],
        );
        const delegation = delegationResult.rows[0];
        if (!delegation)
          throw new Error("Delegation not found for this session");
        if (delegation.state !== "active")
          throw new Error("Delegation is cancelled");
        const priorResult = await transaction.query<{
          ordinal: number;
          state: string;
        }>(
          `SELECT link.ordinal,child.state::text AS state
             FROM oao.delegation_runs link
             JOIN oao.runs child ON child.organization_id=link.organization_id
              AND child.project_id=link.project_id AND child.id=link.child_run_id
            WHERE link.organization_id=$1 AND link.project_id=$2
              AND link.delegation_id=$3
            ORDER BY link.ordinal DESC LIMIT 1`,
          [input.organizationId, input.projectId, input.delegationId],
        );
        const prior = priorResult.rows[0];
        if (!prior || !TERMINAL_CHILD_STATES.has(prior.state))
          throw new Error("The child agent is still running");
        const ordinal = prior.ordinal + 1;
        const childRunId = eventUuid(
          `delegation-run:${input.delegationId}:${ordinal}`,
        );
        const messageId = eventUuid(
          `delegation-message:${input.delegationId}:${ordinal}`,
        );
        await transaction.query(
          `INSERT INTO oao.runs
             (organization_id,project_id,id,thread_id,session_id,agent_version_id,
              created_by_principal_id,idempotency_key,input_public,requested_by_run_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
             (SELECT requested_by_run_id FROM oao.runs
               WHERE organization_id=$1 AND project_id=$2 AND id=$10))`,
          [
            input.organizationId,
            input.projectId,
            childRunId,
            delegation.child_thread_id,
            delegation.child_session_id,
            delegation.child_agent_version_id,
            delegation.created_by_principal_id,
            input.idempotencyKey,
            { message: prompt },
            input.parentRunId,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.messages
             (organization_id,project_id,id,thread_id,run_id,role,redacted_content)
           VALUES ($1,$2,$3,$4,$5,'user',$6)`,
          [
            input.organizationId,
            input.projectId,
            messageId,
            delegation.child_thread_id,
            childRunId,
            prompt,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.delegation_runs (
             organization_id,project_id,delegation_id,ordinal,
             requested_by_run_id,child_run_id,request_key,request_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            input.organizationId,
            input.projectId,
            input.delegationId,
            ordinal,
            input.parentRunId,
            childRunId,
            input.idempotencyKey,
            requestHash,
          ],
        );
        await transaction.query(
          `UPDATE oao.sessions SET last_activity_at=clock_timestamp()
            WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [input.organizationId, input.projectId, delegation.child_session_id],
        );
        await transaction.query(
          `UPDATE oao.agent_delegations SET updated_at=clock_timestamp()
            WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [input.organizationId, input.projectId, input.delegationId],
        );
        await appendEventOnce(transaction, {
          organizationId: input.organizationId as OrganizationId,
          projectId: input.projectId as ProjectId,
          id: eventUuid(`event:${childRunId}:delegation-follow-up`),
          aggregateType: "delegation",
          aggregateId: input.delegationId,
          kind: "delegation.follow_up_created",
          payload: {
            childSessionId: delegation.child_session_id,
            childRunId,
            ordinal,
          },
        });
        await appendEventOnce(transaction, {
          organizationId: input.organizationId as OrganizationId,
          projectId: input.projectId as ProjectId,
          id: eventUuid(`event:${childRunId}:created`),
          aggregateType: "run",
          aggregateId: childRunId,
          kind: "run.created",
          payload: { state: "queued", sessionId: delegation.child_session_id },
        });
        await transaction.query(
          "SELECT oao.append_audit_entry($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())",
          [
            input.organizationId,
            input.projectId,
            eventUuid(`audit:${childRunId}:delegation-follow-up`),
            delegation.created_by_principal_id,
            "delegation.follow_up_created",
            "delegation",
            input.delegationId,
            {
              childSessionId: delegation.child_session_id,
              childRunId,
              ordinal,
              promptCharacters: prompt.length,
            },
          ],
        );
        await this.queue.enqueue(transaction, {
          organizationId: input.organizationId as OrganizationId,
          projectId: input.projectId as ProjectId,
          id: eventUuid(`wake:admit:${childRunId}`),
          runId: childRunId as RunId,
          dispatchKey: `admit:${childRunId}`,
          kind: "admit",
          payload: { reason: "delegation_follow_up" },
        });
        return {
          delegationId: input.delegationId,
          childSessionId: delegation.child_session_id,
          childRunId,
        };
      },
    );
    return this.waitForChild({ ...input, ...created });
  }

  private async waitForChild(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly delegationId: string;
    readonly childSessionId: string;
    readonly childRunId: string;
    readonly signal?: AbortSignal;
  }): Promise<AgentDelegationResult> {
    for (;;) {
      if (input.signal?.aborted)
        throw input.signal.reason ?? new Error("Delegation wait was aborted");
      const result = await withTenantTransaction(
        this.pool,
        {
          organizationId: input.organizationId as OrganizationId,
          projectId: input.projectId as ProjectId,
        },
        (transaction) =>
          transaction.query<{
            state: AgentDelegationResult["status"];
            response: string | null;
          }>(
            // A child that paused for approval holds its reply in several
            // assistant messages; the parent receives all of them in order.
            `SELECT run.state::text AS state,
                    (SELECT string_agg(message.redacted_content, E'\\n\\n'
                              ORDER BY message.created_at,message.id)
                       FROM oao.messages message
                      WHERE message.organization_id=run.organization_id
                        AND message.project_id=run.project_id
                        AND message.run_id=run.id AND message.role='assistant') AS response
               FROM oao.runs run
              WHERE run.organization_id=$1 AND run.project_id=$2 AND run.id=$3`,
            [input.organizationId, input.projectId, input.childRunId],
          ),
      );
      const row = result.rows[0];
      if (!row) throw new Error("Delegated child run disappeared");
      if (TERMINAL_CHILD_STATES.has(row.state)) {
        await withTenantTransaction(
          this.pool,
          {
            organizationId: input.organizationId as OrganizationId,
            projectId: input.projectId as ProjectId,
          },
          (transaction) =>
            appendEventOnce(transaction, {
              organizationId: input.organizationId as OrganizationId,
              projectId: input.projectId as ProjectId,
              id: eventUuid(`event:${input.childRunId}:delegation-settled`),
              aggregateType: "delegation",
              aggregateId: input.delegationId,
              kind:
                row.state === "completed"
                  ? "delegation.completed"
                  : "delegation.failed",
              payload: { childRunId: input.childRunId, state: row.state },
            }),
        );
        return {
          delegationId: input.delegationId,
          childSessionId: input.childSessionId,
          childRunId: input.childRunId,
          status: row.state,
          response: row.response ?? "",
        };
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(
            input.signal?.reason ?? new Error("Delegation wait was aborted"),
          );
        };
        const timer = setTimeout(() => {
          input.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 250);
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

async function closeRunObligations(
  transaction: Queryable,
  input: TenantContext & { readonly runId: RunId },
  state: "completed" | "failed" | "cancelled" | "timed_out",
): Promise<void> {
  await transaction.query(
    `UPDATE oao.approvals SET status='expired',resolved_at=clock_timestamp(),
       resolution_note=$4
     WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND status='pending'`,
    [input.organizationId, input.projectId, input.runId, `run_${state}`],
  );
  await transaction.query(
    `UPDATE oao.tool_calls SET stage='cancelled',claim_fence=claim_fence+1,
       lease_holder_principal_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
     WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
       AND stage IN ('caller_pending','caller_claimed','platform_ready','platform_executing','result_submitted')`,
    [input.organizationId, input.projectId, input.runId],
  );
}

export class ManagedRuntimeOrchestrator {
  constructor(
    private readonly pool: PgPool,
    private readonly queue: PostgresWakeQueue,
    private readonly trackAdmission?: (
      input: TenantContext & { readonly runId: RunId },
    ) => void,
    private readonly modelPresets?: ModelPresetActivationPort,
    private readonly skills?: SkillDefinitionActivationPort,
    private readonly imageInput?: ManagedRunImageInputOptions,
  ) {}

  async handleWake(job: RuntimeWakeJob): Promise<void> {
    if (job.kind === "cancel") {
      await this.cancel(job);
      return;
    }
    if (job.kind === "deadline") {
      await this.deadline(job);
      return;
    }
    await this.admit(job);
  }

  async enqueueRecovery(): Promise<number> {
    const heads = await this.pool.query<{
      organization_id: OrganizationId;
      project_id: ProjectId;
      run_id: RunId;
    }>("SELECT * FROM oao.list_runtime_recovery_heads()");
    for (const head of heads.rows) {
      await withTenantTransaction(
        this.pool,
        {
          organizationId: head.organization_id,
          projectId: head.project_id,
        },
        (transaction) =>
          this.queue.enqueue(transaction, {
            organizationId: head.organization_id,
            projectId: head.project_id,
            id: eventUuid(`recovery:${head.run_id}`),
            runId: head.run_id,
            dispatchKey: `reconcile:${head.run_id}`,
            kind: "reconcile",
            payload: { reason: "startup_recovery" },
          }),
      );
    }
    return heads.rowCount ?? 0;
  }

  async admit(job: RuntimeWakeJob): Promise<void> {
    const run = await this.loadRun(job);
    // A durable receipt lets cancellation abort without rendering again. An
    // ambiguous dispatch still needs activation on a fresh worker so recovery
    // can render and obtain its receipt before aborting the incarnation.
    if (!run.cancellationRequested || !run.hasAdmissionReceipt) {
      if (run.hasRevokedSkills) {
        await this.failBeforeDispatch(run, new SkillPackageUnavailableError());
        return;
      }
      // Flue resolves `useModel` synchronously during the agent render, so a
      // durable project preset must be loaded and registered before dispatch.
      try {
        await this.modelPresets?.activate(run, run.snapshot.modelPreset);
      } catch (error) {
        if (!(error instanceof ModelPresetUnavailableError)) throw error;
        await this.failBeforeDispatch(run, error);
        return;
      }
      try {
        await this.skills?.activate(run, run.snapshot.skills);
      } catch (error) {
        if (!(error instanceof SkillPackageUnavailableError)) throw error;
        await this.failBeforeDispatch(run, error);
        return;
      }
    }
    const admissionKey = `run:${run.runId}`;
    const snapshotHash = digestJson(run.snapshot);
    const requestInput = {
      delivery: this.delivery(run),
      message: run.inputPublic.message,
      files: run.files,
      cachePrefixChars: run.cachePrefixChars,
    };
    const admissionRequestHash = (deliveredMessage: unknown) =>
      digestJson({
        runId: run.runId,
        snapshotHash: Buffer.from(snapshotHash).toString("hex"),
        deliveredMessage,
      });
    let requestHash = admissionRequestHash(
      managedRunRequestIdentity(requestInput),
    );
    // An image run admitted before native image input hashed its text-only
    // signal; recovery keeps delivering exactly that message.
    const textOnlyRequestHash = run.files.some(isImageRunFile)
      ? admissionRequestHash(createManagedRunDeliveredMessage(requestInput))
      : undefined;
    // Prepare image input before reserving the thread. If storage stays
    // unavailable, the run fails here before anything is sent. A run admitted
    // with its text-only signal is delivered without images.
    let images: ReadonlyMap<string, ManagedRunImage> | undefined;
    if (
      !run.hasAdmissionReceipt &&
      !(await this.hasTextOnlyAdmission(run, textOnlyRequestHash))
    ) {
      try {
        images = await this.deliveryImages(run);
      } catch (error) {
        if (!(error instanceof RunFileStorageUnavailableError)) throw error;
        // A reserved run rethrows here and retries its wake instead.
        await this.failBeforeDispatch(run, error);
        return;
      }
    }
    let textOnlyDelivery = false;
    const flueInstanceId = threadInstanceId(run);
    let runtimeDispatch: DispatchRow;
    try {
      runtimeDispatch = await withTenantTransaction(
        this.pool,
        run,
        async (transaction) => {
          await transaction.query(
            `INSERT INTO oao.runtime_thread_instances (
              organization_id,project_id,thread_id,session_id,agent_version_id,
              snapshot_hash,flue_instance_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (organization_id,project_id,thread_id) DO NOTHING`,
            [
              run.organizationId,
              run.projectId,
              run.threadId,
              run.sessionId,
              run.agentVersionId,
              snapshotHash,
              flueInstanceId,
            ],
          );
          const instanceResult = await transaction.query<ThreadInstanceRow>(
            `SELECT * FROM oao.runtime_thread_instances
             WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3 FOR UPDATE`,
            [run.organizationId, run.projectId, run.threadId],
          );
          const instance = instanceResult.rows[0];
          if (
            !instance ||
            instance.state !== "ready" ||
            instance.session_id !== run.sessionId ||
            instance.agent_version_id !== run.agentVersionId ||
            instance.flue_instance_id !== flueInstanceId ||
            !Buffer.from(instance.snapshot_hash).equals(
              Buffer.from(snapshotHash),
            )
          )
            throw new FlueIncarnationCorruptionError(
              "Thread runtime identity or immutable snapshot mismatch",
            );
          const existingResult = await transaction.query<DispatchRow>(
            `SELECT * FROM oao.runtime_dispatches
             WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 FOR UPDATE`,
            [run.organizationId, run.projectId, run.runId],
          );
          const existing = existingResult.rows[0];
          if (existing) {
            ({ requestHash, textOnlyDelivery } = recoveredAdmissionRequest({
              requestHash,
              textOnlyRequestHash,
              storedRequestHash: existing.request_hash,
            }));
            const headResult = await transaction.query<{
              run_id: RunId;
              admission_key: string;
              request_hash: Uint8Array;
              fence: string;
            }>(
              `SELECT run_id,admission_key,request_hash,fence
               FROM oao.thread_admission_heads
               WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3 FOR UPDATE`,
              [run.organizationId, run.projectId, run.threadId],
            );
            const head = headResult.rows[0];
            if (
              !head ||
              head.run_id !== run.runId ||
              head.admission_key !== admissionKey ||
              !Buffer.from(head.request_hash).equals(
                Buffer.from(requestHash),
              ) ||
              existing.thread_id !== run.threadId ||
              existing.admission_key !== admissionKey ||
              !Buffer.from(existing.request_hash).equals(
                Buffer.from(requestHash),
              ) ||
              !Buffer.from(existing.snapshot_hash).equals(
                Buffer.from(snapshotHash),
              ) ||
              existing.fence !== head.fence ||
              existing.flue_conversation_id !== flueInstanceId ||
              (existing.flue_instance_uid !== null &&
                existing.flue_instance_uid !== instance.flue_instance_uid)
            )
              throw new FlueIncarnationCorruptionError(
                "Existing admission recovery correlation mismatch",
              );
          } else {
            const headResult = await transaction.query<{ fence: string }>(
              "SELECT (oao.reserve_thread_admission($1,$2,$3,$4,$5,$6)).*",
              [
                run.organizationId,
                run.projectId,
                run.threadId,
                run.runId,
                admissionKey,
                requestHash,
              ],
            );
            const head = headResult.rows[0];
            if (!head)
              throw new Error("Admission reservation did not return a head");
            await transaction.query(
              `INSERT INTO oao.runtime_dispatches (
          organization_id,project_id,run_id,thread_id,admission_key,request_hash,
          snapshot_hash,state,fence,flue_conversation_id,deadline_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,
          clock_timestamp()+($10 || ' milliseconds')::interval)
        ON CONFLICT (organization_id,project_id,run_id) DO NOTHING`,
              [
                run.organizationId,
                run.projectId,
                run.runId,
                run.threadId,
                admissionKey,
                requestHash,
                snapshotHash,
                head.fence,
                flueInstanceId,
                run.snapshot.limits.timeoutMs,
              ],
            );
          }
          const result = await transaction.query(
            `UPDATE oao.runtime_dispatches SET state=CASE WHEN flue_submission_id IS NULL
          THEN 'dispatching'::oao.runtime_dispatch_state ELSE state END,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 RETURNING *`,
            [run.organizationId, run.projectId, run.runId],
          );
          await transaction.query(
            `UPDATE oao.thread_admission_heads SET state=CASE WHEN state='reserved'
          THEN 'ambiguous'::oao.admission_state ELSE state END,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
            [run.organizationId, run.projectId, run.runId],
          );
          await appendEventOnce(transaction, {
            ...run,
            id: eventUuid(`event:${run.runId}:dispatch-reserved`),
            aggregateType: "run",
            aggregateId: run.runId,
            kind: "runtime.dispatch_reserved",
            payload: { admissionKey },
          });
          return result.rows[0] as DispatchRow;
        },
      );
    } catch (error) {
      if (error instanceof FlueIncarnationCorruptionError) {
        await this.terminalizeCorruption(run);
        return;
      }
      throw error;
    }

    if (!runtimeDispatch.flue_submission_id) {
      try {
        const receipt = await this.dispatchFenced(
          run,
          runtimeDispatch,
          createManagedRunDeliveredMessage(
            images && !textOnlyDelivery
              ? { ...requestInput, images }
              : requestInput,
          ),
        );
        runtimeDispatch = await this.commitAdmission(run, receipt);
      } catch (error) {
        if (error instanceof FlueIncarnationCorruptionError) {
          await this.terminalizeCorruption(run);
          return;
        }
        throw error;
      }
    }
    this.trackAdmission?.(run);
    if (run.cancellationRequested) {
      try {
        await this.abortAdmitted(run, runtimeDispatch);
      } catch (error) {
        if (error instanceof FlueIncarnationCorruptionError) {
          await this.terminalizeCorruption(run);
          return;
        }
        throw error;
      }
    }
  }

  private async dispatchFenced(
    run: RunContext,
    runtimeDispatch: DispatchRow,
    message: DeliveredMessage,
  ): Promise<DispatchReceipt> {
    let instance = await this.loadThreadInstance(run);
    if (!instance.flue_instance_uid) {
      try {
        const receipt = await dispatch(ManagedAgent, {
          id: instance.flue_instance_id,
          uid: null,
          idempotencyKey: runtimeDispatch.admission_key,
          message,
          initialData: {
            organizationId: run.organizationId,
            projectId: run.projectId,
            threadId: run.threadId,
            sessionId: run.sessionId,
            workspace: run.workspace,
            snapshot: run.snapshot,
            ...(run.promptCacheKey
              ? { promptCacheKey: run.promptCacheKey }
              : {}),
          } satisfies ManagedAgentInstanceData,
        });
        await this.bindThreadUid(run, receipt.uid);
        return receipt;
      } catch (error) {
        if (!(error instanceof AgentInstanceExistsError)) throw error;
        await this.bindThreadUid(run, error.uid);
        instance = await this.loadThreadInstance(run);
      }
    }
    const uid = instance.flue_instance_uid;
    if (!uid)
      throw new FlueIncarnationCorruptionError(
        "Flue incarnation UID was not durably bound",
      );
    await this.assertFlueIncarnation(instance.flue_instance_id, uid);
    const receipt = await dispatch(ManagedAgent, {
      id: instance.flue_instance_id,
      uid,
      idempotencyKey: runtimeDispatch.admission_key,
      message,
    });
    if (receipt.uid !== uid)
      throw new FlueIncarnationCorruptionError(
        "Flue dispatch receipt UID does not match the thread binding",
      );
    return receipt;
  }

  private async loadThreadInstance(
    run: RunContext,
  ): Promise<ThreadInstanceRow> {
    const result = await withTenantTransaction(this.pool, run, (transaction) =>
      transaction.query<ThreadInstanceRow>(
        `SELECT * FROM oao.runtime_thread_instances
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3`,
        [run.organizationId, run.projectId, run.threadId],
      ),
    );
    const instance = result.rows[0];
    if (!instance || instance.state !== "ready")
      throw new FlueIncarnationCorruptionError(
        "Thread runtime identity is unavailable",
      );
    return instance;
  }

  private async bindThreadUid(run: RunContext, uid: string): Promise<void> {
    const result = await withTenantTransaction(this.pool, run, (transaction) =>
      transaction.query(
        `UPDATE oao.runtime_thread_instances SET flue_instance_uid=$4,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3
           AND state='ready' AND (flue_instance_uid IS NULL OR flue_instance_uid=$4)
         RETURNING thread_id`,
        [run.organizationId, run.projectId, run.threadId, uid],
      ),
    );
    if (!result.rowCount)
      throw new FlueIncarnationCorruptionError(
        "Flue incarnation UID compare-and-set failed",
      );
  }

  private async assertFlueIncarnation(id: string, uid: string): Promise<void> {
    const current = await getAgentInstance(ManagedAgent, id);
    if (!current || current.uid !== uid)
      throw new FlueIncarnationCorruptionError(
        "Stored Flue incarnation UID does not match the durable instance",
      );
  }

  private async cascadeDelegations(job: RuntimeWakeJob): Promise<void> {
    await withTenantTransaction(this.pool, job, async (transaction) => {
      const children = await transaction.query<{
        delegation_id: string;
        child_run_id: RunId;
      }>(
        `SELECT delegation.id AS delegation_id,latest.child_run_id
           FROM oao.agent_delegations delegation
           JOIN LATERAL (
             SELECT link.child_run_id
               FROM oao.delegation_runs link
               JOIN oao.runs child ON child.organization_id=link.organization_id
                AND child.project_id=link.project_id AND child.id=link.child_run_id
              WHERE link.organization_id=delegation.organization_id
                AND link.project_id=delegation.project_id
                AND link.delegation_id=delegation.id
                AND child.state NOT IN ('completed','failed','cancelled','timed_out')
              ORDER BY link.ordinal DESC LIMIT 1
           ) latest ON true
          WHERE delegation.organization_id=$1 AND delegation.project_id=$2
            AND delegation.state='active'
            AND (
              delegation.parent_run_id=$3
              OR EXISTS (
                SELECT 1 FROM oao.delegation_runs requested
                 WHERE requested.organization_id=delegation.organization_id
                   AND requested.project_id=delegation.project_id
                   AND requested.delegation_id=delegation.id
                   AND requested.requested_by_run_id=$3
              )
            )
          FOR UPDATE OF delegation`,
        [job.organizationId, job.projectId, job.runId],
      );
      for (const child of children.rows) {
        await transaction.query(
          `UPDATE oao.agent_delegations SET state='cancelled',
             cancelled_at=clock_timestamp(),updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND state='active'`,
          [job.organizationId, job.projectId, child.delegation_id],
        );
        await transaction.query(
          "SELECT oao.request_run_cancellation($1,$2,$3)",
          [job.organizationId, job.projectId, child.child_run_id],
        );
        await appendEventOnce(transaction, {
          organizationId: job.organizationId,
          projectId: job.projectId,
          id: eventUuid(`event:${child.delegation_id}:cancelled`),
          aggregateType: "delegation",
          aggregateId: child.delegation_id,
          kind: "delegation.cancelled",
          payload: { childRunId: child.child_run_id, parentRunId: job.runId },
        });
        await this.queue.enqueue(transaction, {
          organizationId: job.organizationId,
          projectId: job.projectId,
          id: eventUuid(`wake:cancel:${child.child_run_id}`),
          runId: child.child_run_id,
          dispatchKey: `cancel:${child.child_run_id}`,
          kind: "cancel",
          payload: { reason: "parent_cancelled" },
        });
      }
    });
  }

  private async cancel(job: RuntimeWakeJob): Promise<void> {
    await this.cascadeDelegations(job);
    const outcome = await withTenantTransaction(
      this.pool,
      job,
      async (transaction) => {
        const result = await transaction.query(
          "SELECT oao.request_run_cancellation($1,$2,$3) AS outcome",
          [job.organizationId, job.projectId, job.runId],
        );
        return (result.rows[0] as { outcome: string }).outcome;
      },
    );
    if (outcome !== "reconcile_and_abort") return;
    await this.admit(job);
  }

  private async deadline(job: RuntimeWakeJob): Promise<void> {
    const run = await this.loadRun(job);
    const dispatchResult = await withTenantTransaction(
      this.pool,
      run,
      async (transaction) => {
        const deadline = await readApprovalAwareDeadline(transaction, run);
        if (!deadline) return undefined;
        if (!deadline.expired) {
          await scheduleApprovalDeadline(transaction, run, deadline.checkAt);
          return undefined;
        }
        const result = await transaction.query<DispatchRow>(
          `UPDATE oao.runtime_dispatches SET timeout_requested_at=COALESCE(timeout_requested_at,clock_timestamp()),
             state=CASE WHEN state='settled' THEN state ELSE 'aborting'::oao.runtime_dispatch_state END,
             updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
             AND state <> 'settled'
           RETURNING *`,
          [run.organizationId, run.projectId, run.runId],
        );
        if (result.rowCount) {
          await transaction.query(
            `UPDATE oao.thread_admission_heads
             SET draining_at=COALESCE(draining_at,clock_timestamp()),updated_at=clock_timestamp()
             WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
            [run.organizationId, run.projectId, run.runId],
          );
          await appendEventOnce(transaction, {
            ...run,
            id: eventUuid(`event:${run.runId}:deadline-draining`),
            aggregateType: "run",
            aggregateId: run.runId,
            kind: "runtime.cancellation_draining",
            payload: { reason: "deadline_exceeded" },
          });
        }
        return result;
      },
    );
    const runtimeDispatch = dispatchResult?.rows[0];
    if (!runtimeDispatch) return;
    await this.cascadeDelegations(job);
    await this.abortFlueIncarnation(runtimeDispatch);
    this.trackAdmission?.(run);
  }

  private async abortAdmitted(
    run: RunContext,
    runtimeDispatch: DispatchRow,
  ): Promise<void> {
    await withTenantTransaction(this.pool, run, async (transaction) => {
      await transaction.query(
        `UPDATE oao.thread_admission_heads SET draining_at=COALESCE(draining_at,clock_timestamp())
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [run.organizationId, run.projectId, run.runId],
      );
      await appendEventOnce(transaction, {
        ...run,
        id: eventUuid(`event:${run.runId}:cancellation-draining`),
        aggregateType: "run",
        aggregateId: run.runId,
        kind: "runtime.cancellation_draining",
        payload: {
          submissionId: runtimeDispatch.flue_submission_id ?? "pending",
        },
      });
      await transaction.query(
        `UPDATE oao.runtime_dispatches SET state='aborting',updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [run.organizationId, run.projectId, run.runId],
      );
    });
    await this.abortFlueIncarnation(runtimeDispatch);
  }

  private async abortFlueIncarnation(
    runtimeDispatch: DispatchRow,
  ): Promise<void> {
    const uid = runtimeDispatch.flue_instance_uid;
    if (!uid)
      throw new FlueIncarnationCorruptionError(
        "Cannot abort an admitted run without a bound Flue UID",
      );
    await this.assertFlueIncarnation(runtimeDispatch.flue_conversation_id, uid);
    await init(ManagedAgent, {
      id: runtimeDispatch.flue_conversation_id,
      uid,
    }).abort();
  }

  private async terminalizeCorruption(run: RunContext): Promise<void> {
    await withTenantTransaction(this.pool, run, async (transaction) => {
      const safeError = {
        code: "flue_incarnation_mismatch",
        message: "The durable conversation identity could not be verified",
      } as const;
      const headResult = await transaction.query<{ run_id: RunId }>(
        `SELECT run_id FROM oao.thread_admission_heads
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3 FOR UPDATE`,
        [run.organizationId, run.projectId, run.threadId],
      );
      const affectedRunId = headResult.rows[0]?.run_id ?? run.runId;
      await transaction.query(
        `UPDATE oao.runtime_thread_instances SET state='corrupt',safe_error=$4,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3`,
        [run.organizationId, run.projectId, run.threadId, safeError],
      );
      await transaction.query(
        `UPDATE oao.runtime_dispatches SET state='aborting',safe_error=$4,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND state <> 'settled'`,
        [run.organizationId, run.projectId, affectedRunId, safeError],
      );
      await transaction.query(
        `UPDATE oao.runs SET state='failed',settled_at=COALESCE(settled_at,clock_timestamp()),
           updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND id=$3
           AND state NOT IN ('completed','failed','cancelled','timed_out')`,
        [run.organizationId, run.projectId, affectedRunId],
      );
      const affectedRun = { ...run, runId: affectedRunId };
      await closeRunObligations(transaction, affectedRun, "failed");
      await transaction.query(
        `UPDATE oao.thread_admission_heads SET state='ambiguous',
           draining_at=COALESCE(draining_at,clock_timestamp()),updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [run.organizationId, run.projectId, affectedRunId],
      );
      await appendEventOnce(transaction, {
        ...affectedRun,
        id: eventUuid(`event:${affectedRunId}:incarnation-corrupt`),
        aggregateType: "run",
        aggregateId: affectedRunId,
        kind: "runtime.recovery_completed",
        payload: { outcome: "failed", code: safeError.code },
      });
    });
  }

  /**
   * Settles a run that cannot be admitted at all. Mirrors `settle` for a run
   * that never reached Flue: no dispatch or thread instance exists yet, so the
   * run, its timeline head, obligations, and session summary are closed here
   * and the thread's next queued run is woken.
   */
  private async failBeforeDispatch(
    run: RunContext,
    error:
      | ModelPresetUnavailableError
      | SkillPackageUnavailableError
      | RunFileStorageUnavailableError,
  ): Promise<void> {
    await withTenantTransaction(this.pool, run, async (transaction) => {
      // Admission reservation and cancellation also lock this run. Recheck
      // after taking that lock so a concurrent admission cannot be orphaned.
      const current = await transaction.query<{
        state: string;
        cancellation_requested_at: Date | null;
      }>(
        `SELECT state,cancellation_requested_at FROM oao.runs
         WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
        [run.organizationId, run.projectId, run.runId],
      );
      const row = current.rows[0];
      if (
        !row ||
        ["completed", "failed", "cancelled", "timed_out"].includes(row.state)
      )
        return;
      if (
        !["queued", "retry_scheduled"].includes(row.state) ||
        row.cancellation_requested_at
      )
        throw error;
      const reserved = await transaction.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM oao.thread_admission_heads
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
           UNION ALL
           SELECT 1 FROM oao.runtime_dispatches
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
         ) AS exists`,
        [run.organizationId, run.projectId, run.runId],
      );
      if (reserved.rows[0]?.exists) throw error;
      const updated = await transaction.query(
        `UPDATE oao.runs SET state='failed',settled_at=COALESCE(settled_at,clock_timestamp()),
           updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND id=$3
           AND state IN ('queued','retry_scheduled')`,
        [run.organizationId, run.projectId, run.runId],
      );
      if (!updated.rowCount) return;
      await transaction.query(
        `UPDATE oao.timeline_entries SET completed_at=clock_timestamp(),safe_detail=$4
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND entry_sequence=1`,
        [
          run.organizationId,
          run.projectId,
          run.runId,
          { status: "failed", code: error.code, message: error.message },
        ],
      );
      await transaction.query(
        `INSERT INTO oao.session_summaries (
          organization_id,project_id,session_id,run_count
        ) VALUES ($1,$2,$3,1)
        ON CONFLICT (organization_id,project_id,session_id) DO UPDATE SET
          summary_version=oao.session_summaries.summary_version+1,
          run_count=oao.session_summaries.run_count+1,updated_at=clock_timestamp()`,
        [run.organizationId, run.projectId, run.sessionId],
      );
      await appendEventOnce(transaction, {
        organizationId: run.organizationId,
        projectId: run.projectId,
        id: eventUuid(`event:${run.runId}:run-settled`),
        aggregateType: "run",
        aggregateId: run.runId,
        kind: "run.state_changed",
        payload: { state: "failed", code: error.code },
      });
      await appendEventOnce(transaction, {
        organizationId: run.organizationId,
        projectId: run.projectId,
        id: eventUuid(`event:${run.runId}:session-summary`),
        aggregateType: "session",
        aggregateId: run.sessionId,
        kind: "session.summary_changed",
        payload: { runId: run.runId, state: "failed" },
      });
      await closeRunObligations(transaction, run, "failed");
      const successor = await transaction.query<{ id: RunId }>(
        `SELECT id FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3
          AND state IN ('queued','retry_scheduled') AND cancellation_requested_at IS NULL
          ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [run.organizationId, run.projectId, run.threadId],
      );
      const next = successor.rows[0];
      if (next)
        await this.queue.enqueue(transaction, {
          organizationId: run.organizationId,
          projectId: run.projectId,
          id: eventUuid(`wake:admit:${next.id}`),
          runId: next.id,
          dispatchKey: `admit:${next.id}`,
          kind: "admit",
          payload: {},
        });
    });
  }

  private async commitAdmission(
    run: RunContext,
    receipt: DispatchReceipt,
  ): Promise<DispatchRow> {
    return withTenantTransaction(this.pool, run, async (transaction) => {
      const bound = await transaction.query(
        `UPDATE oao.runtime_thread_instances SET updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3
           AND state='ready' AND flue_instance_uid=$4 RETURNING thread_id`,
        [run.organizationId, run.projectId, run.threadId, receipt.uid],
      );
      if (!bound.rowCount)
        throw new FlueIncarnationCorruptionError(
          "Flue receipt UID did not match the thread control record",
        );
      const result = await transaction.query(
        `UPDATE oao.runtime_dispatches SET state=CASE WHEN state='settled' THEN state
          ELSE 'admitted'::oao.runtime_dispatch_state END,flue_submission_id=$4,
          flue_instance_uid=$5,flue_accepted_at=$6,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 RETURNING *`,
        [
          run.organizationId,
          run.projectId,
          run.runId,
          receipt.submissionId,
          receipt.uid,
          new Date(receipt.acceptedAt),
        ],
      );
      await appendEventOnce(transaction, {
        ...run,
        id: eventUuid(`event:${run.runId}:dispatch-admitted`),
        aggregateType: "run",
        aggregateId: run.runId,
        kind: "runtime.dispatch_admitted",
        payload: { submissionId: receipt.submissionId },
      });
      await transaction.query(
        `UPDATE oao.thread_admission_heads SET state='admitted',canonical_run_ref=$4,
          updated_at=clock_timestamp() WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [run.organizationId, run.projectId, run.runId, receipt.submissionId],
      );
      if (run.state === "queued" || run.state === "retry_scheduled") {
        await transaction.query(
          "UPDATE oao.runs SET state='running' WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND state IN ('queued','retry_scheduled')",
          [run.organizationId, run.projectId, run.runId],
        );
      }
      await appendEventOnce(transaction, {
        ...run,
        id: eventUuid(`event:${run.runId}:running`),
        aggregateType: "run",
        aggregateId: run.runId,
        kind: "run.state_changed",
        payload: { state: "running", reason: "dispatch_admitted" },
      });
      await transaction.query(
        `INSERT INTO oao.messages (
          organization_id,project_id,id,thread_id,run_id,role,redacted_content,flue_message_ref
        ) SELECT $1,$2,$3,$4,$5,'user',$6,$7
          WHERE NOT EXISTS (
            SELECT 1 FROM oao.messages
            WHERE organization_id=$1 AND project_id=$2 AND run_id=$5 AND role='user'
          )
        ON CONFLICT DO NOTHING`,
        [
          run.organizationId,
          run.projectId,
          eventUuid(`message:${run.runId}:user`),
          run.threadId,
          run.runId,
          this.inputText(run.inputPublic),
          `input:${receipt.submissionId}`,
        ],
      );
      await transaction.query(
        `INSERT INTO oao.timeline_entries (
          organization_id,project_id,run_id,entry_sequence,entry_type,started_at,safe_detail
        ) VALUES ($1,$2,$3,1,'run',clock_timestamp(),$4) ON CONFLICT DO NOTHING`,
        [run.organizationId, run.projectId, run.runId, { status: "admitted" }],
      );
      const admitted = result.rows[0] as DispatchRow;
      await this.queue.enqueue(transaction, {
        organizationId: run.organizationId,
        projectId: run.projectId,
        id: eventUuid(`wake:deadline:${run.runId}`),
        runId: run.runId,
        dispatchKey: `deadline:${run.runId}`,
        kind: "deadline",
        payload: { reason: "product_deadline" },
        availableAt: new Date(admitted.deadline_at),
      });
      return admitted;
    });
  }

  private async loadRun(
    tenant: TenantContext & { readonly runId: RunId },
  ): Promise<RunContext> {
    return withTenantTransaction(this.pool, tenant, async (transaction) => {
      const result = await transaction.query(
        `SELECT r.id,r.thread_id,r.session_id,r.state,r.input_public,r.cancellation_requested_at,
          EXISTS (SELECT 1 FROM oao.runtime_dispatches dispatch
            WHERE dispatch.organization_id=r.organization_id AND dispatch.project_id=r.project_id
              AND dispatch.run_id=r.id AND dispatch.flue_submission_id IS NOT NULL) AS has_admission_receipt,
          EXISTS (SELECT 1 FROM oao.agent_delegations delegation
            WHERE delegation.organization_id=r.organization_id AND delegation.project_id=r.project_id
              AND delegation.child_session_id=r.session_id) AS delegated,
          v.id AS agent_version_id,v.config,encode(v.content_hash,'hex') AS content_hash,
          workspace.id AS workspace_id,workspace.owner_thread_id,
          COALESCE(workspace.owner_session_id,r.session_id) AS owner_session_id,
          COALESCE(workspace.owner_run_id,r.id) AS owner_run_id,
          prompt_cache.cache_key AS prompt_cache_key,
          CASE WHEN prompt_cache.initial_run_id=r.id
            THEN prompt_cache.initial_prefix_chars ELSE 0 END AS prompt_cache_prefix_chars
         FROM oao.runs r JOIN oao.agent_versions v
           ON v.organization_id=r.organization_id AND v.project_id=r.project_id AND v.id=r.agent_version_id
         JOIN oao.thread_workspace_bindings binding
           ON binding.organization_id=r.organization_id AND binding.project_id=r.project_id
          AND binding.thread_id=r.thread_id
         JOIN oao.agent_workspaces workspace
           ON workspace.organization_id=binding.organization_id AND workspace.project_id=binding.project_id
          AND workspace.id=binding.workspace_id
         LEFT JOIN oao.session_prompt_caches prompt_cache
           ON prompt_cache.organization_id=r.organization_id AND prompt_cache.project_id=r.project_id
          AND prompt_cache.session_id=r.session_id
         WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=$3`,
        [tenant.organizationId, tenant.projectId, tenant.runId],
      );
      if (!result.rowCount) throw new Error("Run not found");
      const row = result.rows[0] as Record<string, unknown>;
      const publication = parseManagedAgentSnapshotForPublication(row.config);
      const resolutionResult = await transaction.query<{
        resolution: unknown;
      }>(
        `SELECT resolution FROM oao.session_version_resolutions
          WHERE organization_id=$1 AND project_id=$2 AND session_id=$3`,
        [tenant.organizationId, tenant.projectId, row.session_id],
      );
      const stored = resolutionResult.rows[0]?.resolution;
      const bindings = sessionBindings(
        publication,
        String(row.agent_version_id),
        stored === undefined
          ? undefined
          : parseSessionVersionResolution(stored),
      );
      const skillResult = await transaction.query<{
        skill_id: string;
        skill_version_id: string;
        version: number;
        skill_name: string;
        description: string;
        content_hash: Buffer;
        status: "active" | "deprecated" | "revoked";
      }>(
        `SELECT version.skill_id,binding.skill_version_id,version.version,
                version.skill_name,version.description,version.content_hash,
                lifecycle.status
         FROM oao.session_skill_bindings binding
         JOIN oao.skill_versions version
           ON version.organization_id=binding.organization_id
          AND version.project_id=binding.project_id
          AND version.id=binding.skill_version_id
         JOIN oao.skill_version_lifecycle lifecycle
           ON lifecycle.organization_id=version.organization_id
          AND lifecycle.project_id=version.project_id
          AND lifecycle.skill_version_id=version.id
         WHERE binding.organization_id=$1 AND binding.project_id=$2
           AND binding.session_id=$3
         ORDER BY binding.skill_name`,
        [tenant.organizationId, tenant.projectId, row.session_id],
      );
      const expectedSkillIds = [...bindings.skillVersionIds].sort();
      const boundSkillIds = skillResult.rows
        .map((binding) => binding.skill_version_id)
        .sort();
      if (
        expectedSkillIds.length !== boundSkillIds.length ||
        expectedSkillIds.some((id, index) => id !== boundSkillIds[index])
      )
        throw new Error(
          "Session Skill bindings do not match the agent version",
        );
      // Skill-level disable/remove gates publication only: the thread
      // incarnation pins this snapshot's hash, so the bound Skill set must
      // stay byte-identical across every run of the thread.
      const hasRevokedSkills = skillResult.rows.some(
        (binding) => binding.status === "revoked",
      );
      const skills = skillResult.rows.map(
        (binding) =>
          ({
            skillId: binding.skill_id,
            skillVersionId: binding.skill_version_id,
            version: binding.version,
            name: binding.skill_name,
            description: binding.description,
            contentHash: Buffer.from(binding.content_hash).toString("hex"),
          }) satisfies ManagedSkillBindingSnapshot,
      );
      const harnessResult = await transaction.query<{
        operation_key: string;
        description: string;
        instructions: string;
        result_schema: ManagedHarnessOperation["resultSchema"];
        timeout_ms: number;
      }>(
        `SELECT operation_key,description,instructions,result_schema,timeout_ms
           FROM oao.agent_version_harness_operations
          WHERE organization_id=$1 AND project_id=$2 AND agent_version_id=$3
          ORDER BY operation_key`,
        [tenant.organizationId, tenant.projectId, row.agent_version_id],
      );
      const harnessOperations = harnessResult.rows.map(
        (operation) =>
          ({
            key: operation.operation_key,
            description: operation.description,
            instructions: operation.instructions,
            resultSchema: operation.result_schema,
            timeoutMs: operation.timeout_ms,
          }) satisfies ManagedHarnessOperation,
      );
      const expectedHarnessOperations = [...publication.harnessOperations].sort(
        (left, right) => left.key.localeCompare(right.key),
      );
      if (
        stableJson(harnessOperations) !== stableJson(expectedHarnessOperations)
      )
        throw new Error(
          "Normalized Harness Operations do not match the agent version",
        );
      const mcpResult = await transaction.query<{
        toolset_version_id: string;
        credential_policy_version_id: string;
        namespace: string;
        server_version_id: string;
        remote_tool_name: string;
        description: string;
        input_schema: ManagedMcpToolSnapshot["inputSchema"];
        output_schema: ManagedMcpToolSnapshot["outputSchema"];
        approval: "never" | "always";
        timeout_ms: number;
        maximum_response_bytes: number;
        toolset_status: "active" | "deprecated" | "revoked";
        server_status: "active" | "deprecated" | "revoked";
        policy_status: "active" | "deprecated" | "revoked";
        credential_status: "active" | "deprecated" | "revoked";
      }>(
        `SELECT binding.toolset_version_id,binding.credential_policy_version_id,
                binding.namespace,toolset.server_version_id,
                selection.remote_tool_name,tool.description,tool.input_schema,
                tool.output_schema,
                selection.approval,policy.timeout_ms,policy.maximum_response_bytes,
                toolset_lifecycle.status AS toolset_status,
                server_lifecycle.status AS server_status,
                policy_lifecycle.status AS policy_status,
                credential_lifecycle.status AS credential_status
           FROM oao.session_mcp_bindings binding
           JOIN oao.mcp_toolset_versions toolset
             ON toolset.organization_id=binding.organization_id
            AND toolset.project_id=binding.project_id
            AND toolset.id=binding.toolset_version_id
           JOIN oao.mcp_toolset_version_lifecycle toolset_lifecycle
             ON toolset_lifecycle.organization_id=toolset.organization_id
            AND toolset_lifecycle.project_id=toolset.project_id
            AND toolset_lifecycle.toolset_version_id=toolset.id
           JOIN oao.mcp_toolset_version_tools selection
             ON selection.organization_id=toolset.organization_id
            AND selection.project_id=toolset.project_id
            AND selection.toolset_version_id=toolset.id
           JOIN oao.mcp_server_version_tools tool
             ON tool.organization_id=selection.organization_id
            AND tool.server_version_id=selection.server_version_id
            AND tool.remote_tool_name=selection.remote_tool_name
           JOIN oao.mcp_server_version_lifecycle server_lifecycle
             ON server_lifecycle.organization_id=tool.organization_id
            AND server_lifecycle.server_version_id=tool.server_version_id
           JOIN oao.mcp_credential_policy_versions policy
             ON policy.organization_id=binding.organization_id
            AND policy.id=binding.credential_policy_version_id
           JOIN oao.mcp_credential_policy_version_lifecycle policy_lifecycle
             ON policy_lifecycle.organization_id=policy.organization_id
            AND policy_lifecycle.policy_version_id=policy.id
           JOIN oao.mcp_credentials credential
             ON credential.organization_id=policy.organization_id
            AND credential.id=policy.credential_id
           JOIN oao.mcp_credential_version_lifecycle credential_lifecycle
             ON credential_lifecycle.organization_id=credential.organization_id
            AND credential_lifecycle.credential_version_id=credential.active_version_id
          WHERE binding.organization_id=$1 AND binding.project_id=$2
            AND binding.session_id=$3
          ORDER BY binding.namespace,selection.remote_tool_name`,
        [tenant.organizationId, tenant.projectId, row.session_id],
      );
      const expectedMcpBindings = publication.mcpBindings
        .map(
          (binding) =>
            `${binding.namespace}:${binding.toolsetVersionId}:${binding.credentialPolicyVersionId}`,
        )
        .sort();
      const boundMcpBindings = [
        ...new Set(
          mcpResult.rows.map(
            (binding) =>
              `${binding.namespace}:${binding.toolset_version_id}:${binding.credential_policy_version_id}`,
          ),
        ),
      ].sort();
      if (
        expectedMcpBindings.length !== boundMcpBindings.length ||
        expectedMcpBindings.some(
          (binding, index) => binding !== boundMcpBindings[index],
        )
      )
        throw new Error("Session MCP bindings do not match the agent version");
      if (
        mcpResult.rows.some(
          (binding) =>
            binding.toolset_status !== "active" ||
            binding.server_status !== "active" ||
            binding.policy_status !== "active" ||
            binding.credential_status !== "active",
        )
      )
        throw new Error("A bound MCP resource is no longer active");
      const mcpTools = mcpResult.rows.map(
        (binding) =>
          ({
            serverVersionId: binding.server_version_id,
            toolsetVersionId: binding.toolset_version_id,
            credentialPolicyVersionId: binding.credential_policy_version_id,
            namespace: binding.namespace,
            remoteToolName: binding.remote_tool_name,
            name: mcpToolName(binding.namespace, binding.remote_tool_name),
            description: binding.description,
            approval: binding.approval,
            inputSchema: binding.input_schema,
            outputSchema: binding.output_schema,
            timeoutMs: binding.timeout_ms,
            maximumResponseBytes: binding.maximum_response_bytes,
          }) satisfies ManagedMcpToolSnapshot,
      );
      const visibleToolNames = [
        ...publication.tools.map((tool) => tool.name),
        ...harnessOperations.map((operation) => operation.key),
        ...mcpTools.map((tool) => tool.name),
        ...(publication.delegates.length
          ? ["delegate_agent", "message_agent"]
          : []),
        ...(publication.oaoTools
          ? oaoAgentTools(publication.oaoTools).map(
              (tool) => `${OAO_AGENT_TOOL_PREFIX}${tool.name}`,
            )
          : []),
      ];
      if (new Set(visibleToolNames).size !== visibleToolNames.length)
        throw new Error("MCP tool namespace collides with another agent tool");
      const runInput = v.parse(ManagedRunInputV1Schema, row.input_public);
      const runtimeConfig = {
        systemPrompt: publication.systemPrompt,
        modelPreset: publication.modelPreset,
        tools: publication.tools,
        harnessOperations,
        mcpTools,
        delegates: bindings.delegates,
        ...(publication.oaoTools ? { oaoTools: publication.oaoTools } : {}),
        // Only when on, so existing snapshots keep their exact shape.
        ...(publication.publishTextBeforeToolCalls
          ? { publishTextBeforeToolCalls: true }
          : {}),
        // Nobody types in a delegated child session, so it is not asked for
        // a suggestion and its reply to the parent carries no suggestion line.
        ...(publication.promptSuggestions && row.delegated !== true
          ? { promptSuggestions: true }
          : {}),
        sandbox: publication.sandbox,
        limits: publication.limits,
      };
      const parsed = v.parse(ManagedAgentInstanceDataSchema.entries.snapshot, {
        ...runtimeConfig,
        skills,
        agentVersionId: row.agent_version_id,
        contentHash: row.content_hash,
      });
      return {
        ...tenant,
        runId: row.id as RunId,
        hasRevokedSkills,
        hasAdmissionReceipt: row.has_admission_receipt === true,
        threadId: row.thread_id as ThreadId,
        sessionId: row.session_id as string,
        agentVersionId: row.agent_version_id as string,
        state: row.state as string,
        cancellationRequested: row.cancellation_requested_at !== null,
        inputPublic: runInput,
        files: runInput.files ?? [],
        snapshot: parsed,
        workspace: {
          id: row.workspace_id as string,
          ownerThreadId: row.owner_thread_id as string,
          ownerSessionId: row.owner_session_id as string,
          ownerRunId: row.owner_run_id as string,
        },
        ...(typeof row.prompt_cache_key === "string"
          ? { promptCacheKey: row.prompt_cache_key }
          : {}),
        cachePrefixChars: Number(row.prompt_cache_prefix_chars ?? 0),
      };
    });
  }

  private inputText(input: ManagedRunInputV1): string {
    return input.message;
  }

  private delivery(run: RunContext): ManagedRunDelivery {
    return {
      version: "1",
      runId: run.runId,
      sessionId: run.sessionId,
      snapshotHash: digestHex(run.snapshot),
    };
  }

  /**
   * Whether this run's existing admission holds the hash of its text-only
   * signal, which an image run reserved before native image input stored.
   */
  private async hasTextOnlyAdmission(
    run: RunContext,
    textOnlyRequestHash: Uint8Array | undefined,
  ): Promise<boolean> {
    if (!textOnlyRequestHash) return false;
    const result = await withTenantTransaction(this.pool, run, (transaction) =>
      transaction.query<{ request_hash: Uint8Array }>(
        `SELECT request_hash FROM oao.runtime_dispatches
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [run.organizationId, run.projectId, run.runId],
      ),
    );
    const stored = result.rows[0]?.request_hash;
    return (
      stored !== undefined &&
      Buffer.from(stored).equals(Buffer.from(textOnlyRequestHash))
    );
  }

  /**
   * How each image run file reaches the model, or undefined without images.
   * Image run files are downloaded and prepared as native image input only
   * when the agent's model accepts images; otherwise the message says why
   * they are not shown.
   */
  private async deliveryImages(
    run: RunContext,
  ): Promise<ReadonlyMap<string, ManagedRunImage> | undefined> {
    const imageFiles = run.files.filter(isImageRunFile);
    if (imageFiles.length === 0) return undefined;
    const acceptsImages =
      this.imageInput !== undefined &&
      runtimeModelAcceptsImages(
        this.imageInput.presets.resolve(run.snapshot.modelPreset, run).model,
      );
    if (!acceptsImages)
      return omittedManagedRunImages(imageFiles, MODEL_WITHOUT_IMAGE_INPUT);
    let downloaded: readonly ManagedRunFileContent[] | undefined;
    for (let attempt = 0; downloaded === undefined; attempt += 1) {
      try {
        downloaded = await withinMilliseconds(
          downloadManagedRunFiles(this.imageInput?.storage, run, imageFiles),
          this.imageInput?.downloadTimeoutMs ?? RUN_FILE_DOWNLOAD_TIMEOUT_MS,
        );
      } catch (error) {
        // A file that fails the same way on every attempt fails the run when
        // the sandbox materializes it, so here its images are only omitted.
        if (error instanceof RunFileUnavailableError)
          return omittedManagedRunImages(
            imageFiles,
            "the image could not be loaded from object storage",
          );
        if (attempt + 1 >= RUN_FILE_DOWNLOAD_ATTEMPTS)
          throw new RunFileStorageUnavailableError({ cause: error });
        await sleep(RUN_FILE_DOWNLOAD_RETRY_MS * (attempt + 1));
      }
    }
    return prepareManagedRunImages(downloaded);
  }
}

function firstToolCallId(output: unknown): string | undefined {
  const content =
    output && typeof output === "object"
      ? (output as { readonly content?: unknown }).content
      : undefined;
  if (!Array.isArray(content)) return undefined;
  for (const part of content as unknown[]) {
    if (!part || typeof part !== "object") continue;
    const { type, id } = part as {
      readonly type?: unknown;
      readonly id?: unknown;
    };
    if (type === "toolCall" && typeof id === "string") return id;
  }
  return undefined;
}

/** Skip stream deltas before they enter the serialized database projection queue. */
function shouldProjectObservation(event: FlueObservation): boolean {
  switch (event.type) {
    case "turn_request":
    case "turn":
    case "tool_start":
    case "tool":
    case "submission_recovery":
    case "submission_settled":
      return true;
    case "log":
      return (
        event.message === "[flue:model-retry] Retrying transient model error"
      );
    default:
      return false;
  }
}

export class RuntimeProjection {
  #pending = Promise.resolve();
  #unsubscribe: (() => void) | undefined;
  readonly #watching = new Map<string, Promise<void>>();
  readonly #skillToolCalls = new Map<
    string,
    {
      readonly toolName: "activate_skill" | "read_skill_resource";
      readonly args: Readonly<Record<string, PublicValue>>;
    }
  >();
  readonly #harnessToolCalls = new Map<
    string,
    {
      readonly operationKey: string;
      readonly taskCharacters: number;
      readonly timeoutMs: number;
    }
  >();
  readonly #harnessStepToolStarts = new Map<
    string,
    { readonly summary: string }
  >();
  readonly #lastTurns = new Map<
    RunId,
    {
      readonly dispatch: DispatchRow;
      readonly event: Extract<FlueObservation, { type: "turn" }>;
    }
  >();
  readonly #abort = new AbortController();

  constructor(
    private readonly pool: PgPool,
    private readonly queue: PostgresWakeQueue,
  ) {}

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = observe((event) => {
      if (!event.conversationId || !shouldProjectObservation(event)) return;
      const harnessCorrelation = harnessObservationCorrelation(event);
      this.#pending = this.#pending
        .then(() => this.project(event, harnessCorrelation))
        .catch(() => undefined)
        .then(() => {
          // Every earlier turn of the submission has been projected by now.
          if (event.type === "submission_settled")
            pendingAssistantText.forget(event.submissionId);
        });
    });
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#abort.abort(new Error("Runtime projection stopped"));
    await this.#pending;
    await Promise.all(this.#watching.values());
  }

  trackAdmission(input: TenantContext & { readonly runId: RunId }): void {
    const key = `${input.organizationId}/${input.projectId}/${input.runId}`;
    if (this.#watching.has(key)) return;
    const watching = this.watchAdmission(input).finally(() => {
      this.#watching.delete(key);
    });
    this.#watching.set(key, watching);
  }

  async replayLastTurn(runId: RunId): Promise<boolean> {
    const observed = this.#lastTurns.get(runId);
    if (!observed) return false;
    await this.projectTurn(observed.dispatch, observed.event);
    return true;
  }

  private async project(
    event: FlueObservation,
    harnessCorrelation?: HarnessObservationCorrelation,
  ): Promise<void> {
    const dispatchResult = await this.pool.query<DispatchRow>(
      "SELECT * FROM oao.find_runtime_dispatch($1,$2)",
      [event.submissionId ?? "", event.conversationId ?? ""],
    );
    const runtimeDispatch = dispatchResult.rows[0];
    if (!runtimeDispatch) return;
    if (event.type === "turn_request") {
      await this.appendModelStart(runtimeDispatch, event);
      return;
    }
    if (
      event.type === "log" &&
      event.message === "[flue:model-retry] Retrying transient model error"
    ) {
      const attempt = event.attributes?.attempt;
      const delayMs = event.attributes?.delayMs;
      if (typeof attempt === "number" && typeof delayMs === "number")
        await this.appendPublicEvent(
          runtimeDispatch,
          event,
          "model.retry_scheduled",
          {
            retry: attempt,
            maximumRetries: 3,
            delayMs,
            timeoutMs: MODEL_CALL_TIMEOUT_MS,
          },
        );
      return;
    }
    if (event.type === "tool_start" && harnessCorrelation) {
      this.#harnessStepToolStarts.set(
        `${harnessCorrelation.harnessToolCallId}:${event.toolCallId}`,
        { summary: safeHarnessToolSummary(event.toolName, event.args) },
      );
    }
    if (event.type === "tool_start" && !harnessCorrelation) {
      const operation = await this.harnessOperation(
        runtimeDispatch,
        event.toolName,
      );
      if (operation) {
        const args = safeArguments(event.args);
        const taskCharacters =
          typeof args.task === "string" ? args.task.length : 0;
        this.#harnessToolCalls.set(event.toolCallId, {
          operationKey: operation.key,
          taskCharacters,
          timeoutMs: operation.timeoutMs,
        });
        await this.appendPublicEvent(
          runtimeDispatch,
          event,
          "harness.operation_started",
          {
            operationKey: operation.key,
            toolCallId: event.toolCallId,
            taskCharacters,
            timeoutMs: operation.timeoutMs,
          },
          `harness:${event.toolCallId}:started`,
        );
        return;
      }
    }
    if (event.type === "tool" && harnessCorrelation) {
      const startKey = `${harnessCorrelation.harnessToolCallId}:${event.toolCallId}`;
      const start = this.#harnessStepToolStarts.get(startKey);
      this.#harnessStepToolStarts.delete(startKey);
      await this.appendPublicEvent(
        runtimeDispatch,
        event,
        "harness.operation_step",
        {
          operationKey: harnessCorrelation.operationKey,
          harnessToolCallId: harnessCorrelation.harnessToolCallId,
          stepKind: "tool",
          stepId: harnessCorrelation.stepId,
          stepIndex: harnessCorrelation.stepIndex,
          toolName: event.toolName,
          summary: start?.summary ?? event.toolName,
          status: event.isError ? "error" : "success",
          durationMs: event.durationMs,
        },
        `harness:${harnessCorrelation.harnessToolCallId}:${harnessCorrelation.stepId}`,
      );
    }
    if (
      event.type === "tool_start" &&
      (event.toolName === "activate_skill" ||
        event.toolName === "read_skill_resource")
    ) {
      this.#skillToolCalls.set(event.toolCallId, {
        toolName: event.toolName,
        args: safeArguments(event.args),
      });
      return;
    }
    if (event.type === "tool") {
      const harnessCall = this.#harnessToolCalls.get(event.toolCallId);
      if (harnessCall) {
        this.#harnessToolCalls.delete(event.toolCallId);
        const errorType = event.errorInfo?.type ?? event.errorInfo?.name ?? "";
        const outcome = !event.isError
          ? "completed"
          : /timeout/iu.test(errorType)
            ? "timed_out"
            : /abort|cancel/iu.test(errorType)
              ? "cancelled"
              : "failed";
        await this.appendPublicEvent(
          runtimeDispatch,
          event,
          `harness.operation_${outcome}`,
          {
            operationKey: harnessCall.operationKey,
            toolCallId: event.toolCallId,
            taskCharacters: harnessCall.taskCharacters,
            timeoutMs: harnessCall.timeoutMs,
            durationMs: event.durationMs,
            resultValidated: !event.isError,
          },
          `harness:${event.toolCallId}:settled`,
        );
        return;
      }
      const call = this.#skillToolCalls.get(event.toolCallId);
      if (call) {
        this.#skillToolCalls.delete(event.toolCallId);
        await this.appendPublicEvent(
          runtimeDispatch,
          event,
          call.toolName === "activate_skill"
            ? "skill.activated"
            : "skill.resource_read",
          {
            ...call.args,
            success: !event.isError,
            durationMs: event.durationMs,
          },
        );
        return;
      }
    }
    if (event.type === "turn") {
      this.#lastTurns.set(runtimeDispatch.run_id, {
        dispatch: runtimeDispatch,
        event,
      });
      await this.projectTurn(runtimeDispatch, event, harnessCorrelation);
      if (!harnessCorrelation)
        await this.publishTurnText(runtimeDispatch, event);
      if (harnessCorrelation) {
        const usage = event.response.usage;
        const actionSummary = harnessModelActionSummary(
          event.response.output,
          event.isError,
        );
        await this.appendPublicEvent(
          runtimeDispatch,
          event,
          "harness.operation_step",
          {
            operationKey: harnessCorrelation.operationKey,
            harnessToolCallId: harnessCorrelation.harnessToolCallId,
            stepKind: "model",
            stepId: harnessCorrelation.stepId,
            stepIndex: harnessCorrelation.stepIndex,
            summary: actionSummary,
            status: event.isError ? "error" : "success",
            durationMs: event.durationMs,
            inputTokens: usage?.input ?? 0,
            outputTokens: usage?.output ?? 0,
            cacheReadTokens: usage?.cacheRead ?? 0,
            cacheWriteTokens: usage?.cacheWrite ?? 0,
          },
          `harness:${harnessCorrelation.harnessToolCallId}:${harnessCorrelation.stepId}`,
        );
      }
      return;
    }
    if (event.type === "submission_recovery") {
      await this.appendPublicEvent(
        runtimeDispatch,
        event,
        "runtime.recovery_started",
        {
          outcome: event.outcome,
          operation: event.operation,
        },
      );
      return;
    }
    if (event.type === "submission_settled")
      await this.settle(runtimeDispatch, event.outcome, event.submissionId);
  }

  /**
   * Commits a tool-calling turn's text for an agent version that publishes
   * text before tool calls. A tool call usually commits it first; this covers
   * the calls that commit nothing themselves (Skill and Harness Operation
   * tools). Projections are serialized, so the message precedes the events
   * projected for the turn's tool calls.
   */
  private async publishTurnText(
    runtimeDispatch: DispatchRow,
    event: Extract<FlueObservation, { type: "turn" }>,
  ): Promise<void> {
    if (
      event.purpose !== "agent" ||
      event.isError ||
      !pendingAssistantText.publishesBeforeToolCalls(runtimeDispatch.run_id)
    )
      return;
    const toolCallId = firstToolCallId(event.response.output);
    if (!toolCallId) return;
    // The turn was observed before it was queued for projection, and its
    // submission stays known until its settlement has been projected. A run
    // that already settled refuses the commit; its reply holds the text.
    await pendingAssistantText.publishThrough(
      toolCallId,
      (segments) =>
        commitAssistantText(this.pool, {
          organizationId: runtimeDispatch.organization_id,
          projectId: runtimeDispatch.project_id,
          runId: runtimeDispatch.run_id,
          segments,
        }),
      { wait: false, runId: runtimeDispatch.run_id },
    );
  }

  private async watchAdmission(
    input: TenantContext & { readonly runId: RunId },
  ): Promise<void> {
    const result = await withTenantTransaction(
      this.pool,
      input,
      (transaction) =>
        transaction.query<DispatchRow>(
          `SELECT * FROM oao.runtime_dispatches WHERE organization_id=$1
           AND project_id=$2 AND run_id=$3 AND flue_submission_id IS NOT NULL`,
          [input.organizationId, input.projectId, input.runId],
        ),
    );
    const runtimeDispatch = result.rows[0];
    if (
      !runtimeDispatch?.flue_submission_id ||
      runtimeDispatch.state === "settled"
    )
      return;
    try {
      const receipt = await this.receiptFor(runtimeDispatch);
      const reply = await init(ManagedAgent, {
        id: runtimeDispatch.flue_conversation_id,
        uid: receipt.uid,
      }).read(receipt, { signal: this.#abort.signal });
      await this.settle(
        runtimeDispatch,
        "completed",
        runtimeDispatch.flue_submission_id,
        reply.text,
      );
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      const outcome = error instanceof AgentRunError ? error.outcome : "failed";
      if (error instanceof FlueIncarnationCorruptionError) {
        await this.recordCorruption(runtimeDispatch);
        return;
      }
      await this.settle(
        runtimeDispatch,
        outcome,
        runtimeDispatch.flue_submission_id,
      );
    }
  }

  private async receiptFor(
    runtimeDispatch: DispatchRow,
  ): Promise<DispatchReceipt> {
    const uid = runtimeDispatch.flue_instance_uid;
    const submissionId = runtimeDispatch.flue_submission_id;
    const acceptedAt = runtimeDispatch.flue_accepted_at;
    if (!uid || !submissionId || !acceptedAt)
      throw new FlueIncarnationCorruptionError(
        "Persisted Flue receipt is incomplete",
      );
    const current = await getAgentInstance(
      ManagedAgent,
      runtimeDispatch.flue_conversation_id,
    );
    if (!current || current.uid !== uid)
      throw new FlueIncarnationCorruptionError(
        "Persisted Flue receipt UID does not match the instance",
      );
    return {
      submissionId,
      uid,
      acceptedAt: new Date(acceptedAt).toISOString(),
    };
  }

  private async recordCorruption(runtimeDispatch: DispatchRow): Promise<void> {
    await withTenantTransaction(
      this.pool,
      {
        organizationId: runtimeDispatch.organization_id,
        projectId: runtimeDispatch.project_id,
      },
      async (transaction) => {
        const safeError = {
          code: "flue_incarnation_mismatch",
          message: "The durable conversation identity could not be verified",
        } as const;
        await transaction.query(
          `UPDATE oao.runtime_thread_instances SET state='corrupt',safe_error=$4,
             updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.thread_id,
            safeError,
          ],
        );
        await transaction.query(
          `UPDATE oao.runtime_dispatches SET state='aborting',safe_error=$4,
             updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND state <> 'settled'`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
            safeError,
          ],
        );
        await transaction.query(
          `UPDATE oao.runs SET state='failed',
             settled_at=COALESCE(settled_at,clock_timestamp()),updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND id=$3
             AND state NOT IN ('completed','failed','cancelled','timed_out')`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
          ],
        );
        await closeRunObligations(
          transaction,
          {
            organizationId: runtimeDispatch.organization_id,
            projectId: runtimeDispatch.project_id,
            runId: runtimeDispatch.run_id,
          },
          "failed",
        );
        await transaction.query(
          `UPDATE oao.thread_admission_heads SET state='ambiguous',
             draining_at=COALESCE(draining_at,clock_timestamp()),updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
          ],
        );
      },
    );
  }

  private appendModelStart(
    runtimeDispatch: DispatchRow,
    event: Extract<FlueObservation, { type: "turn_request" | "turn" }>,
  ): Promise<void> {
    return this.appendPublicEvent(
      runtimeDispatch,
      event.type === "turn"
        ? { ...event, timestamp: turnWindow(event).startedAt.toISOString() }
        : event,
      "model.invocation_started",
      {
        turnId: event.turnId,
        model: event.request.requestedModel,
        provider: event.request.providerId,
        timeoutMs: MODEL_CALL_TIMEOUT_MS,
      },
      `model:${event.turnId}:started`,
    );
  }

  private async projectTurn(
    runtimeDispatch: DispatchRow,
    event: Extract<FlueObservation, { type: "turn" }>,
    harnessCorrelation?: HarnessObservationCorrelation,
  ): Promise<void> {
    // A request observation can precede the committed dispatch correlation.
    // Repair a missing start from its outcome; the stable turn key deduplicates
    // normal requests, delayed observations and replayed outcomes.
    await this.appendModelStart(runtimeDispatch, event);
    const usage = event.response.usage;
    const timing = turnWindow(event);
    const thinking = turnThinking(event.response.output);
    const harnessActionSummary = harnessCorrelation
      ? harnessModelActionSummary(event.response.output, event.isError)
      : undefined;
    const diagnostics = modelInvocationDiagnostics(
      event.response,
      event.isError,
    );
    const invocationId = eventUuid(
      `turn:${runtimeDispatch.run_id}:${event.turnId}`,
    );
    let costMicrounits = 0;
    await withTenantTransaction(
      this.pool,
      {
        organizationId: runtimeDispatch.organization_id,
        projectId: runtimeDispatch.project_id,
      },
      async (transaction) => {
        const attemptResult = await transaction.query(
          "SELECT COALESCE(MAX(attempt),0)+1 AS attempt FROM oao.model_invocations WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
          ],
        );
        const attempt = Number(
          (attemptResult.rows[0] as { attempt: string }).attempt,
        );
        const pricing = usage
          ? await modelCallPricing(
              transaction,
              runtimeDispatch,
              usage,
              timing.startedAt,
              event.request.requestedModel,
            )
          : {
              costMicrounits: 0,
              snapshot: { model: event.request.requestedModel, source: "none" },
            };
        costMicrounits = pricing.costMicrounits;
        const inserted = await transaction.query<{ attempt: string }>(
          `INSERT INTO oao.model_invocations (
          organization_id,project_id,id,run_id,attempt,provider_key,model_key,status,
          input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
          cost_microunits,safe_request,safe_response,
          started_at,completed_at,usage_source,pricing_snapshot,provider_route
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT (organization_id,project_id,id) DO NOTHING
        RETURNING attempt`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            invocationId,
            runtimeDispatch.run_id,
            attempt,
            event.request.providerId,
            event.request.requestedModel,
            event.isError ? "failed" : "completed",
            usage?.input ?? 0,
            usage?.output ?? 0,
            usage?.cacheRead ?? 0,
            usage?.cacheWrite ?? 0,
            costMicrounits,
            {
              purpose: event.purpose,
              ...modelLimitsDetail(runtimeDispatch.run_id),
              ...(harnessCorrelation
                ? {
                    harnessOperationKey: harnessCorrelation.operationKey,
                    harnessToolCallId: harnessCorrelation.harnessToolCallId,
                    harnessStepId: harnessCorrelation.stepId,
                    harnessStepIndex: harnessCorrelation.stepIndex,
                    ...(harnessActionSummary ? { harnessActionSummary } : {}),
                  }
                : {}),
            },
            {
              ...diagnostics,
              ...(thinking ? { thinking } : {}),
            },
            timing.startedAt,
            timing.completedAt,
            usage ? "estimated" : "unavailable",
            pricing.snapshot,
            { provider: event.request.providerId },
          ],
        );
        if (!inserted.rowCount) return;
        const stableAttempt = Number(inserted.rows[0]?.attempt ?? attempt);
        await transaction.query(
          `INSERT INTO oao.timeline_entries (
            organization_id,project_id,run_id,entry_sequence,entry_type,
            started_at,completed_at,safe_detail
          ) VALUES ($1,$2,$3,$4,'model_invocation',$5,$6,$7)
          ON CONFLICT DO NOTHING`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
            stableAttempt + 1,
            timing.startedAt,
            timing.completedAt,
            {
              status: event.isError ? "failed" : "completed",
              model: event.request.requestedModel,
              provider: event.request.providerId,
              ...diagnostics,
            },
          ],
        );
        await transaction.query(
          `INSERT INTO oao.session_summaries (
          organization_id,project_id,session_id,input_tokens,output_tokens,
          cache_read_tokens,cache_write_tokens,cost_microunits
        ) SELECT organization_id,project_id,session_id,$4,$5,$6,$7,$8 FROM oao.runs
          WHERE organization_id=$1 AND project_id=$2 AND id=$3
        ON CONFLICT (organization_id,project_id,session_id) DO UPDATE SET
          summary_version=oao.session_summaries.summary_version+1,
          input_tokens=oao.session_summaries.input_tokens+EXCLUDED.input_tokens,
          output_tokens=oao.session_summaries.output_tokens+EXCLUDED.output_tokens,
          cache_read_tokens=oao.session_summaries.cache_read_tokens+EXCLUDED.cache_read_tokens,
          cache_write_tokens=oao.session_summaries.cache_write_tokens+EXCLUDED.cache_write_tokens,
          cost_microunits=oao.session_summaries.cost_microunits+EXCLUDED.cost_microunits,
          updated_at=clock_timestamp()`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
            usage?.input ?? 0,
            usage?.output ?? 0,
            usage?.cacheRead ?? 0,
            usage?.cacheWrite ?? 0,
            costMicrounits,
          ],
        );
      },
    );
    await this.appendPublicEvent(
      runtimeDispatch,
      event,
      event.isError ? "model.invocation_failed" : "model.invocation_completed",
      {
        model: event.request.requestedModel,
        provider: event.request.providerId,
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        cacheReadTokens: usage?.cacheRead ?? 0,
        cacheWriteTokens: usage?.cacheWrite ?? 0,
        costMicrounits,
        ...(harnessCorrelation
          ? {
              harnessOperationKey: harnessCorrelation.operationKey,
              harnessToolCallId: harnessCorrelation.harnessToolCallId,
              harnessStepId: harnessCorrelation.stepId,
              harnessStepIndex: harnessCorrelation.stepIndex,
              ...(harnessActionSummary ? { harnessActionSummary } : {}),
            }
          : {}),
        ...diagnostics,
      },
    );
  }

  private async settle(
    runtimeDispatch: DispatchRow,
    outcome: "completed" | "failed" | "aborted",
    submissionId: string,
    projectedReply?: string,
  ): Promise<void> {
    const tenant = {
      organizationId: runtimeDispatch.organization_id,
      projectId: runtimeDispatch.project_id,
    };
    const runResult = await withTenantTransaction(
      this.pool,
      tenant,
      (transaction) =>
        transaction.query<{
          cancellation_requested_at: Date | null;
          timeout_requested_at: Date | null;
          session_id: string;
          thread_id: ThreadId;
          thread_instance_state: "ready" | "corrupt";
          suggests: boolean;
        }>(
          `SELECT r.cancellation_requested_at,r.session_id,r.thread_id,d.timeout_requested_at,
             i.state AS thread_instance_state,
             -- The agent version asks for a suggestion line, and the session
             -- is one somebody types in rather than a delegated child.
             COALESCE((
               SELECT version.config->'promptSuggestions'='true'::jsonb
                 FROM oao.agent_versions version
                WHERE version.organization_id=r.organization_id
                  AND version.project_id=r.project_id
                  AND version.id=r.agent_version_id
             ),false) AND NOT EXISTS (
               SELECT 1 FROM oao.agent_delegations delegation
                WHERE delegation.organization_id=r.organization_id
                  AND delegation.project_id=r.project_id
                  AND delegation.child_session_id=r.session_id
             ) AS suggests
           FROM oao.runs r JOIN oao.runtime_dispatches d
             ON d.organization_id=r.organization_id AND d.project_id=r.project_id AND d.run_id=r.id
           JOIN oao.runtime_thread_instances i
             ON i.organization_id=r.organization_id AND i.project_id=r.project_id
            AND i.thread_id=r.thread_id
           WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=$3`,
          [tenant.organizationId, tenant.projectId, runtimeDispatch.run_id],
        ),
    );
    const run = runResult.rows[0];
    if (!run) return;
    pendingAssistantText.forgetRun(runtimeDispatch.run_id);
    const state =
      outcome === "completed"
        ? "completed"
        : outcome === "aborted" && run.timeout_requested_at
          ? "timed_out"
          : outcome === "aborted" && run.cancellation_requested_at
            ? "cancelled"
            : "failed";
    const productState =
      run.thread_instance_state === "corrupt" ? "failed" : state;
    let redactedReply =
      run.thread_instance_state === "corrupt" ? "" : (projectedReply ?? "");
    if (
      run.thread_instance_state !== "corrupt" &&
      outcome === "completed" &&
      projectedReply === undefined
    ) {
      const receipt = await this.receiptFor(runtimeDispatch);
      const reply = await init(ManagedAgent, {
        id: runtimeDispatch.flue_conversation_id,
        uid: receipt.uid,
      }).read(receipt);
      redactedReply = reply.text;
    }
    // The model ends a reply with its suggestion for the user's next message.
    // The line is cut out of everything stored, whatever the run's outcome;
    // only a completed run keeps it, as its suggestion.
    let suggestion: string | undefined;
    if (run.suggests && redactedReply) {
      // Only the final turn's own last line counts. When that turn wrote
      // nothing, the reply ends with text from before a tool call, and a
      // line there predates the tool's result. A worker that did not observe
      // the final turn cannot tell, so the run then has no suggestion.
      if (
        productState === "completed" &&
        pendingAssistantText.endsWithReply(submissionId) === true
      )
        suggestion = replySuggestion(redactedReply);
      redactedReply = withoutSuggestionLines(redactedReply).trimEnd();
    }
    // PostgreSQL text rejects NUL, which a model reply can contain.
    redactedReply = jsonbSafeText(redactedReply);
    await withTenantTransaction(this.pool, tenant, async (transaction) => {
      const fence = await transaction.query(
        `UPDATE oao.runtime_dispatches SET state='settled',updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND state <> 'settled'
         RETURNING run_id`,
        [tenant.organizationId, tenant.projectId, runtimeDispatch.run_id],
      );
      if (!fence.rowCount) return;
      await transaction.query(
        "UPDATE oao.runs SET state=$4 WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND state NOT IN ('completed','failed','cancelled','timed_out')",
        [
          tenant.organizationId,
          tenant.projectId,
          runtimeDispatch.run_id,
          productState,
        ],
      );
      await transaction.query(
        `UPDATE oao.timeline_entries SET completed_at=clock_timestamp(),safe_detail=$4
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 AND entry_sequence=1`,
        [
          tenant.organizationId,
          tenant.projectId,
          runtimeDispatch.run_id,
          { status: productState },
        ],
      );
      const finalMessageId = eventUuid(
        `message:${runtimeDispatch.run_id}:assistant`,
      );
      if (redactedReply) {
        // Text committed ahead of approval gates is already in the transcript.
        const committed = await transaction.query<{
          redacted_content: string;
        }>(
          `SELECT redacted_content FROM oao.messages
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
             AND role='assistant' AND id<>$4
           ORDER BY created_at,id`,
          [
            tenant.organizationId,
            tenant.projectId,
            runtimeDispatch.run_id,
            finalMessageId,
          ],
        );
        redactedReply = replyAfterCommittedText(
          redactedReply,
          committed.rows.map((row) => row.redacted_content),
        );
      }
      if (redactedReply) {
        await transaction.query(
          `INSERT INTO oao.messages (
            organization_id,project_id,id,thread_id,run_id,role,redacted_content,flue_message_ref
          ) VALUES ($1,$2,$3,$4,$5,'assistant',$6,$7) ON CONFLICT DO NOTHING`,
          [
            tenant.organizationId,
            tenant.projectId,
            finalMessageId,
            run.thread_id,
            runtimeDispatch.run_id,
            redactedReply,
            submissionId,
          ],
        );
        await appendEventOnce(transaction, {
          ...tenant,
          id: eventUuid(`event:${runtimeDispatch.run_id}:assistant-message`),
          aggregateType: "run",
          aggregateId: runtimeDispatch.run_id,
          kind: "message.created",
          payload: { role: "assistant", messageId: finalMessageId },
        });
        // The suggestion is on the run before the run reads as completed
        // anywhere, and is announced beside the reply it follows. A reply
        // without text of its own has nothing to follow.
        if (suggestion) {
          const stored = await transaction.query(
            `UPDATE oao.runs run SET suggestion=$4
              WHERE run.organization_id=$1 AND run.project_id=$2 AND run.id=$3
                AND run.state='completed' AND run.suggestion IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM oao.runs newer
                   WHERE newer.organization_id=run.organization_id
                     AND newer.project_id=run.project_id
                     AND newer.thread_id=run.thread_id
                     AND (newer.created_at,newer.id)>(run.created_at,run.id)
                )`,
            [
              tenant.organizationId,
              tenant.projectId,
              runtimeDispatch.run_id,
              suggestion,
            ],
          );
          // The event names the run; readers and webhooks attach the text.
          if (stored.rowCount)
            await appendEventOnce(transaction, {
              ...tenant,
              id: eventUuid(`event:${runtimeDispatch.run_id}:suggestion`),
              aggregateType: "run",
              aggregateId: runtimeDispatch.run_id,
              kind: "run.suggestion_created",
              payload: { sessionId: run.session_id },
            });
        }
      }
      await transaction.query(
        `INSERT INTO oao.session_summaries (
          organization_id,project_id,session_id,run_count
        ) VALUES ($1,$2,$3,1)
        ON CONFLICT (organization_id,project_id,session_id) DO UPDATE SET
          summary_version=oao.session_summaries.summary_version+1,
          run_count=oao.session_summaries.run_count+1,updated_at=clock_timestamp()`,
        [tenant.organizationId, tenant.projectId, run.session_id],
      );
      await appendEventOnce(transaction, {
        ...tenant,
        id: eventUuid(`event:${runtimeDispatch.run_id}:run-settled`),
        aggregateType: "run",
        aggregateId: runtimeDispatch.run_id,
        kind: "run.state_changed",
        payload: { state: productState },
      });
      await appendEventOnce(transaction, {
        ...tenant,
        id: eventUuid(`event:${runtimeDispatch.run_id}:session-summary`),
        aggregateType: "session",
        aggregateId: run.session_id,
        kind: "session.summary_changed",
        payload: { runId: runtimeDispatch.run_id, state: productState },
      });
      await closeRunObligations(
        transaction,
        {
          ...tenant,
          runId: runtimeDispatch.run_id,
        },
        productState,
      );
      if (run.thread_instance_state === "corrupt") {
        await transaction.query(
          `UPDATE oao.thread_admission_heads SET state='ambiguous',
             draining_at=COALESCE(draining_at,clock_timestamp()),updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
          [tenant.organizationId, tenant.projectId, runtimeDispatch.run_id],
        );
        return;
      }
      await transaction.query(
        "DELETE FROM oao.thread_admission_heads WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
        [tenant.organizationId, tenant.projectId, runtimeDispatch.run_id],
      );
      const successor = await transaction.query<{ id: RunId }>(
        `SELECT id FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3
          AND state IN ('queued','retry_scheduled') AND cancellation_requested_at IS NULL
          ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [tenant.organizationId, tenant.projectId, run.thread_id],
      );
      const next = successor.rows[0];
      if (next) {
        await this.queue.enqueue(transaction, {
          ...tenant,
          id: eventUuid(`wake:admit:${next.id}`),
          runId: next.id,
          dispatchKey: `admit:${next.id}`,
          kind: "admit",
          payload: { reason: "predecessor_settled" },
        });
      }
    });
  }

  private async harnessOperation(
    runtimeDispatch: DispatchRow,
    toolName: string,
  ): Promise<{ readonly key: string; readonly timeoutMs: number } | undefined> {
    return withTenantTransaction(
      this.pool,
      {
        organizationId: runtimeDispatch.organization_id,
        projectId: runtimeDispatch.project_id,
      },
      async (transaction) => {
        const result = await transaction.query<{
          operation_key: string;
          timeout_ms: string;
        }>(
          `SELECT operation->>'key' AS operation_key,
                  operation->>'timeoutMs' AS timeout_ms
             FROM oao.runs run
             JOIN oao.agent_versions version
               ON version.organization_id=run.organization_id
              AND version.project_id=run.project_id
              AND version.id=run.agent_version_id
             CROSS JOIN LATERAL jsonb_array_elements(
               COALESCE(version.config->'harnessOperations','[]'::jsonb)
             ) operation
            WHERE run.organization_id=$1 AND run.project_id=$2
              AND run.id=$3 AND operation->>'key'=$4
            LIMIT 1`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
            toolName,
          ],
        );
        const row = result.rows[0];
        return row
          ? { key: row.operation_key, timeoutMs: Number(row.timeout_ms) }
          : undefined;
      },
    );
  }

  private async appendPublicEvent(
    runtimeDispatch: DispatchRow,
    event: FlueObservation,
    kind: string,
    payload: Readonly<Record<string, PublicValue>>,
    stableKey?: string,
  ): Promise<void> {
    const eventId = eventUuid(
      stableKey
        ? `flue:${runtimeDispatch.run_id}:${stableKey}`
        : `flue:${runtimeDispatch.run_id}:${event.eventIndex}:${kind}`,
    );
    await withTenantTransaction(
      this.pool,
      {
        organizationId: runtimeDispatch.organization_id,
        projectId: runtimeDispatch.project_id,
      },
      async (transaction) => {
        const exists = await transaction.query(
          "SELECT 1 FROM oao.product_events WHERE organization_id=$1 AND project_id=$2 AND id=$3",
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            eventId,
          ],
        );
        if (exists.rowCount) return;
        await transaction.query(
          "SELECT oao.append_product_event($1,$2,$3,'run',$4,$5,$6,$7)",
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            eventId,
            runtimeDispatch.run_id,
            kind,
            // Payloads quote model arguments, which jsonb may not accept as-is.
            jsonbSafePublicValue(payload),
            new Date(event.timestamp),
          ],
        );
      },
    );
  }
}

/** Reserve one durable model turn against the run's immutable agent version. */
export async function reserveRunModelTurn(
  pool: PgPool,
  input: TenantContext & { readonly runId: RunId; readonly turnId: string },
): Promise<void> {
  const reservationId = eventUuid(`turn:${input.runId}:${input.turnId}`);
  const limit = await withTenantTransaction(
    pool,
    input,
    async (transaction) => {
      const result = await transaction.query<{ max_turns: number }>(
        `SELECT (v.config->'limits'->>'maxTurns')::integer AS max_turns
       FROM oao.runs r JOIN oao.agent_versions v
         ON v.organization_id=r.organization_id AND v.project_id=r.project_id AND v.id=r.agent_version_id
       WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=$3 FOR UPDATE OF r`,
        [input.organizationId, input.projectId, input.runId],
      );
      const maximum = result.rows[0]?.max_turns;
      if (!maximum) throw new Error("Model turn budget is unavailable");
      // Adopt invocations from before the budget ledger existed, within the
      // same tenant transaction and run lock. Normal reservations deduplicate.
      await transaction.query(
        `INSERT INTO oao.run_model_turns (organization_id,project_id,run_id,turn_id)
         SELECT organization_id,project_id,run_id,id::text FROM oao.model_invocations
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
           AND safe_response->>'errorCode' IS DISTINCT FROM 'model_turn_limit_exceeded'
         ON CONFLICT DO NOTHING`,
        [input.organizationId, input.projectId, input.runId],
      );
      const turns = await transaction.query<{
        count: string;
        reserved: boolean;
      }>(
        `SELECT count(*)::text AS count, COALESCE(bool_or(turn_id=$4),false) AS reserved
       FROM oao.run_model_turns WHERE organization_id=$1 AND project_id=$2 AND run_id=$3`,
        [input.organizationId, input.projectId, input.runId, reservationId],
      );
      if (turns.rows[0]?.reserved) return undefined;
      if (Number(turns.rows[0]?.count) >= maximum) return maximum;
      await transaction.query(
        `INSERT INTO oao.run_model_turns (organization_id,project_id,run_id,turn_id) VALUES ($1,$2,$3,$4)`,
        [input.organizationId, input.projectId, input.runId, reservationId],
      );
      return undefined;
    },
  );
  if (limit !== undefined)
    throw new Error(`Model turn limit exceeded (${limit})`);
}

/**
 * Flue reuses the model operation object when intercepting stream creation,
 * every iterator read, and result(). Admit once, including concurrent readers.
 * A new operation (retry or recovery) still checks the durable ledger. Weak
 * keys let settled streams be collected without retaining run identities.
 */
function createModelTurnAdmission(pool: PgPool) {
  const reservations = new WeakMap<object, Promise<void>>();
  return (
    operation: FlueExecutionOperation,
    context: FlueExecutionContext,
  ): Promise<void> => {
    if (operation.type !== "model") return Promise.resolve();
    let reservation = reservations.get(operation);
    if (!reservation) {
      reservation = (async () => {
        const dispatches = await pool.query<DispatchRow>(
          "SELECT * FROM oao.find_runtime_dispatch($1,$2)",
          [context.submissionId ?? "", context.instanceId ?? ""],
        );
        const dispatch = dispatches.rows[0];
        if (!dispatch || dispatch.state === "settled")
          throw new Error("Model turn run identity is unavailable");
        await reserveRunModelTurn(pool, {
          organizationId: dispatch.organization_id,
          projectId: dispatch.project_id,
          runId: dispatch.run_id,
          turnId: operation.turnId,
        });
      })();
      // Keep failures too: later reads must not bypass a rejected admission.
      reservations.set(operation, reservation);
    }
    return reservation;
  };
}

/**
 * Runs a model operation with the prompt cache scope of its thread instance,
 * so the provider sends the session's cache key and breakpoints. Flue starts
 * the provider stream inside the interceptor chain.
 */
function withManagedPromptCacheScope<T>(
  operation: FlueExecutionOperation,
  context: FlueExecutionContext,
  next: () => Promise<T>,
): Promise<T> {
  if (operation.type !== "model") return next();
  return withModelPromptCacheScope(
    managedPromptCacheScope(context.instanceId),
    next,
  );
}

export async function configureVendorNeutralTelemetry(
  input: {
    readonly pool?: PgPool;
    readonly endpoint?: string;
    readonly serviceName?: string;
  } = {},
): Promise<() => Promise<void>> {
  let sdk: NodeSDK | undefined;
  if (input.endpoint) {
    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        "service.name": input.serviceName ?? "oao-runtime-worker",
      }),
      traceExporter: new OTLPTraceExporter({ url: input.endpoint }),
    });
    sdk.start();
  }
  const telemetry = createOpenTelemetryInstrumentation({ content: false });
  const admitModelTurn = input.pool
    ? createModelTurnAdmission(input.pool)
    : undefined;
  const disposeInstrumentation = instrument({
    ...telemetry,
    async interceptor(operation, context, next) {
      await admitModelTurn?.(operation, context);
      return withManagedPromptCacheScope(operation, context, () =>
        telemetry.interceptor(operation, context, next),
      );
    },
  });
  return async () => {
    await disposeInstrumentation();
    await sdk?.shutdown();
  };
}

interface McpExecutionRow {
  endpoint_url: string;
  exact_origin: string;
  path_prefix: string;
  transport: "streamable_http" | "legacy_sse";
  timeout_ms: number;
  maximum_response_bytes: number;
  forward_call_context: boolean;
  run_idempotency_key: string;
  credential_id: string;
  credential_version_id: string;
  credential_kind:
    "static_bearer" | "api_key_header" | "oauth_client_credentials";
  header_name: string | null;
  destination_origin: string | null;
  destination_path_prefix: string | null;
  oauth_issuer: string | null;
  oauth_token_endpoint: string | null;
  oauth_client_id: string | null;
  oauth_token_endpoint_auth_method:
    "client_secret_post" | "client_secret_basic" | null;
  oauth_scope: string | null;
  oauth_resource: string | null;
  oauth_resource_metadata_url: string | null;
  oauth_send_resource: boolean | null;
  encrypted_secret: Buffer;
  encryption_nonce: Buffer;
  encryption_tag: Buffer;
  encryption_key_version: number;
}

/** The decrypted material of the credential version an execution row pins. */
function mcpCredentialMaterial(
  row: McpExecutionRow,
  organizationId: string,
  secret: string,
): McpCredentialMaterial {
  if (row.credential_kind === "api_key_header")
    return { kind: "api_key_header", headerName: row.header_name!, secret };
  if (row.credential_kind === "static_bearer")
    return { kind: "static_bearer", secret };
  return {
    kind: "oauth_client_credentials",
    organizationId,
    credentialVersionId: row.credential_version_id,
    issuer: row.oauth_issuer!,
    tokenEndpoint: row.oauth_token_endpoint!,
    clientId: row.oauth_client_id!,
    clientSecret: secret,
    tokenEndpointAuthMethod: row.oauth_token_endpoint_auth_method!,
    scope: row.oauth_scope!,
    resource: row.oauth_resource!,
    resourceMetadataUrl: row.oauth_resource_metadata_url!,
    sendResource: row.oauth_send_resource!,
  };
}

/** A safe error code for a failed remote call: never a remote message. */
function mcpFailureCode(error: unknown): string {
  return error instanceof McpRemoteError ? error.code : "remote_call_failed";
}

export function createPostgresMcpToolExecutor(input: {
  readonly pool: PgPool;
  readonly credentialCipher: ProviderCredentialCipher;
  readonly remote: McpRemotePort;
}): McpToolExecutionPort {
  return {
    async execute(tenant, tool, arguments_, signal) {
      const toolCallId = eventUuid(
        `tool:${tenant.runId}:${tenant.flueToolCallId}`,
      );
      const requestHash = Buffer.from(
        digestJson({
          runId: tenant.runId,
          toolCallId: tenant.flueToolCallId,
          serverVersionId: tool.serverVersionId,
          toolsetVersionId: tool.toolsetVersionId,
          credentialPolicyVersionId: tool.credentialPolicyVersionId,
          remoteToolName: tool.remoteToolName,
          arguments: arguments_,
        }),
      );
      // Refuses a tool call that already has an attempt, after recording a
      // started attempt's outcome as unknown.
      const blockedByPriorAttempt = async (
        transaction: PgClient,
      ): Promise<{ readonly blocked_state: string } | undefined> => {
        const prior = await transaction.query<{ state: string }>(
          `SELECT state FROM oao.mcp_call_attempts
              WHERE organization_id=$1 AND project_id=$2
                AND tool_call_id=$3 AND attempt=1 FOR UPDATE`,
          [tenant.organizationId, tenant.projectId, toolCallId],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].state === "started")
            await transaction.query(
              `UPDATE oao.mcp_call_attempts
                    SET state='unknown',safe_error_code='outcome_unknown',
                        completed_at=clock_timestamp()
                  WHERE organization_id=$1 AND project_id=$2
                    AND tool_call_id=$3 AND attempt=1`,
              [tenant.organizationId, tenant.projectId, toolCallId],
            );
          await appendEventOnce(transaction, {
            organizationId: tenant.organizationId as OrganizationId,
            projectId: tenant.projectId as ProjectId,
            id: eventUuid(`event:mcp:${toolCallId}:recovery-blocked`),
            aggregateType: "tool_call",
            aggregateId: toolCallId,
            kind: "mcp.call_failed",
            payload: {
              runId: tenant.runId,
              serverVersionId: tool.serverVersionId,
              remoteToolName: tool.remoteToolName,
              errorCode:
                prior.rows[0].state === "started"
                  ? "outcome_unknown"
                  : "attempt_already_executed",
            },
          });
          return { blocked_state: prior.rows[0].state };
        }
        return undefined;
      };
      const loadExecution = async (
        transaction: PgClient,
      ): Promise<McpExecutionRow> => {
        const result = await transaction.query<McpExecutionRow>(
          `SELECT server.endpoint_url,server.transport,policy.exact_origin,
                    policy.path_prefix,policy.timeout_ms,
                    policy.maximum_response_bytes,policy.forward_call_context,
                    run.idempotency_key AS run_idempotency_key,
                    credential.id AS credential_id,
                    version.id AS credential_version_id,
                    credential.credential_kind,credential.header_name,
                    version.destination_origin,version.destination_path_prefix,
                    version.oauth_issuer,version.oauth_token_endpoint,
                    version.oauth_client_id,version.oauth_token_endpoint_auth_method,
                    version.oauth_scope,version.oauth_resource,
                    version.oauth_resource_metadata_url,version.oauth_send_resource,
                    version.encrypted_secret,version.encryption_nonce,
                    version.encryption_tag,version.encryption_key_version
               FROM oao.session_mcp_bindings binding
               JOIN oao.mcp_toolset_versions toolset
                 ON toolset.organization_id=binding.organization_id
                AND toolset.project_id=binding.project_id
                AND toolset.id=binding.toolset_version_id
               JOIN oao.mcp_toolset_version_lifecycle toolset_lifecycle
                 ON toolset_lifecycle.organization_id=toolset.organization_id
                AND toolset_lifecycle.project_id=toolset.project_id
                AND toolset_lifecycle.toolset_version_id=toolset.id
                AND toolset_lifecycle.status='active'
               JOIN oao.mcp_toolset_version_tools selection
                 ON selection.organization_id=toolset.organization_id
                AND selection.project_id=toolset.project_id
                AND selection.toolset_version_id=toolset.id
                AND selection.remote_tool_name=$8
               JOIN oao.mcp_server_versions server
                 ON server.organization_id=toolset.organization_id
                AND server.id=toolset.server_version_id
                AND server.id=$6
               JOIN oao.mcp_server_version_lifecycle server_lifecycle
                 ON server_lifecycle.organization_id=server.organization_id
                AND server_lifecycle.server_version_id=server.id
                AND server_lifecycle.status='active'
               JOIN oao.mcp_credential_policy_versions policy
                 ON policy.organization_id=binding.organization_id
                AND policy.id=binding.credential_policy_version_id
                AND policy.id=$7
                AND oao.mcp_endpoint_matches_policy(
                  server.endpoint_url,policy.exact_origin,policy.path_prefix
                )
               JOIN oao.mcp_credential_policy_version_lifecycle policy_lifecycle
                 ON policy_lifecycle.organization_id=policy.organization_id
                AND policy_lifecycle.policy_version_id=policy.id
                AND policy_lifecycle.status='active'
               JOIN oao.mcp_credentials credential
                 ON credential.organization_id=policy.organization_id
                AND credential.id=policy.credential_id
               JOIN oao.mcp_credential_versions version
                 ON version.organization_id=credential.organization_id
                AND version.id=credential.active_version_id
                AND (
                  version.destination_origin IS NULL
                  OR oao.mcp_policy_within_destination(
                    policy.exact_origin,policy.path_prefix,
                    version.destination_origin,version.destination_path_prefix
                  )
                )
               JOIN oao.mcp_credential_version_lifecycle credential_lifecycle
                 ON credential_lifecycle.organization_id=version.organization_id
                AND credential_lifecycle.credential_version_id=version.id
                AND credential_lifecycle.status='active'
               JOIN oao.runs run
                 ON run.organization_id=binding.organization_id
                AND run.project_id=binding.project_id
                AND run.id=$4 AND run.session_id=binding.session_id
               JOIN oao.principals principal
                 ON principal.organization_id=run.organization_id
                AND principal.project_id=run.project_id
                AND principal.id=run.created_by_principal_id
               LEFT JOIN oao.project_members member
                 ON member.organization_id=principal.organization_id
                AND member.project_id=principal.project_id
                AND member.principal_id=principal.id
               LEFT JOIN oao.api_keys api_key
                 ON api_key.organization_id=principal.organization_id
                AND 'api-key:'||api_key.id::text=principal.subject
                AND api_key.revoked_at IS NULL
                AND (api_key.expires_at IS NULL OR api_key.expires_at>clock_timestamp())
              WHERE binding.organization_id=$1 AND binding.project_id=$2
                AND binding.session_id=$3 AND binding.agent_version_id=run.agent_version_id
                AND binding.toolset_version_id=$5
                AND (principal.kind<>'human' OR member.principal_id IS NOT NULL)
                AND (principal.kind<>'api_key' OR api_key.id IS NOT NULL)
                AND ('*'=ANY(principal.scopes) OR 'mcp:execute'=ANY(principal.scopes))`,
          [
            tenant.organizationId,
            tenant.projectId,
            tenant.sessionId,
            tenant.runId,
            tool.toolsetVersionId,
            tool.serverVersionId,
            tool.credentialPolicyVersionId,
            tool.remoteToolName,
          ],
        );
        const execution = result.rows[0];
        if (!execution)
          throw new Error(
            "MCP binding, authorization, or credential is no longer active",
          );
        return execution;
      };
      const recordStarted = async (
        transaction: PgClient,
        execution: McpExecutionRow,
      ): Promise<void> => {
        try {
          await transaction.query(
            `INSERT INTO oao.mcp_call_attempts (
                 organization_id,project_id,tool_call_id,run_id,attempt,
                 server_version_id,toolset_version_id,
                 credential_policy_version_id,credential_version_id,
                 remote_tool_name,request_hash,state
               ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,'started')`,
            [
              tenant.organizationId,
              tenant.projectId,
              toolCallId,
              tenant.runId,
              tool.serverVersionId,
              tool.toolsetVersionId,
              tool.credentialPolicyVersionId,
              execution.credential_version_id,
              tool.remoteToolName,
              requestHash,
            ],
          );
          await appendEventOnce(transaction, {
            organizationId: tenant.organizationId as OrganizationId,
            projectId: tenant.projectId as ProjectId,
            id: eventUuid(`event:mcp:${toolCallId}:started`),
            aggregateType: "tool_call",
            aggregateId: toolCallId,
            kind: "mcp.call_started",
            payload: {
              runId: tenant.runId,
              serverVersionId: tool.serverVersionId,
              toolsetVersionId: tool.toolsetVersionId,
              remoteToolName: tool.remoteToolName,
            },
          });
        } catch (error) {
          // A concurrent executor recorded the attempt first.
          if ((error as { readonly code?: unknown }).code === "23505")
            throw new Error("MCP call attempt has already been executed", {
              cause: error,
            });
          throw error;
        }
      };
      const blockedError = (state: string) =>
        new Error(
          state === "started"
            ? "MCP call outcome is unknown after recovery"
            : "MCP call attempt has already been executed",
        );

      const loaded = await withTenantTransaction<
        McpExecutionRow | { readonly blocked_state: string }
      >(input.pool, tenant, async (transaction) => {
        const blocked = await blockedByPriorAttempt(transaction);
        if (blocked) return blocked;
        const execution = await loadExecution(transaction);
        // An OAuth credential records its attempt only once it has a token.
        if (execution.credential_kind !== "oauth_client_credentials")
          await recordStarted(transaction, execution);
        return execution;
      });
      if ("blocked_state" in loaded) throw blockedError(loaded.blocked_state);
      let row = loaded;
      const secret = input.credentialCipher.decrypt(
        {
          ciphertext: row.encrypted_secret,
          nonce: row.encryption_nonce,
          tag: row.encryption_tag,
          keyVersion: row.encryption_key_version,
        },
        {
          organizationId: tenant.organizationId,
          providerId: row.credential_id,
          providerType: "mcp",
        },
      );
      const credential = mcpCredentialMaterial(
        row,
        tenant.organizationId,
        secret,
      );
      if (credential.kind === "oauth_client_credentials") {
        // The token is obtained before the attempt is recorded, outside any
        // transaction: a crash while the authorization server answers leaves
        // no outcome-unknown attempt, and a refused token is recorded as a
        // failed attempt that never reached the MCP server.
        try {
          await input.remote.prepareCredential?.(
            credential,
            signal,
            row.timeout_ms,
          );
        } catch (error) {
          const cancelled = signal?.aborted === true;
          const errorCode = cancelled
            ? "request_cancelled"
            : error instanceof McpRemoteError
              ? error.code
              : "credential_token_failed";
          await withTenantTransaction(
            input.pool,
            tenant,
            async (transaction) => {
              const inserted = await transaction.query(
                `INSERT INTO oao.mcp_call_attempts (
                   organization_id,project_id,tool_call_id,run_id,attempt,
                   server_version_id,toolset_version_id,
                   credential_policy_version_id,credential_version_id,
                   remote_tool_name,request_hash,state,safe_error_code,
                   completed_at
                 ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp())
                 ON CONFLICT DO NOTHING`,
                [
                  tenant.organizationId,
                  tenant.projectId,
                  toolCallId,
                  tenant.runId,
                  tool.serverVersionId,
                  tool.toolsetVersionId,
                  tool.credentialPolicyVersionId,
                  row.credential_version_id,
                  tool.remoteToolName,
                  requestHash,
                  cancelled ? "cancelled" : "failed",
                  errorCode,
                ],
              );
              if (!inserted.rowCount) return;
              await appendEventOnce(transaction, {
                organizationId: tenant.organizationId as OrganizationId,
                projectId: tenant.projectId as ProjectId,
                id: eventUuid(
                  `event:mcp:${toolCallId}:${cancelled ? "cancelled" : "failed"}`,
                ),
                aggregateType: "tool_call",
                aggregateId: toolCallId,
                kind: cancelled ? "mcp.call_cancelled" : "mcp.call_failed",
                payload: {
                  runId: tenant.runId,
                  serverVersionId: tool.serverVersionId,
                  remoteToolName: tool.remoteToolName,
                  errorCode,
                },
              });
            },
          );
          throw error;
        }
        // Authorization is re-checked against the same credential version
        // the token was obtained for before the attempt is recorded.
        const confirmed = await withTenantTransaction<
          McpExecutionRow | { readonly blocked_state: string }
        >(input.pool, tenant, async (transaction) => {
          const blocked = await blockedByPriorAttempt(transaction);
          if (blocked) return blocked;
          const execution = await loadExecution(transaction);
          if (execution.credential_version_id !== loaded.credential_version_id)
            throw new Error(
              "MCP credential was rotated while the call was being authorized",
            );
          await recordStarted(transaction, execution);
          return execution;
        });
        if ("blocked_state" in confirmed)
          throw blockedError(confirmed.blocked_state);
        row = confirmed;
      }
      let result: McpToolResult;
      try {
        result = await input.remote.call(
          {
            endpointUrl: row.endpoint_url,
            exactOrigin: row.exact_origin,
            pathPrefix: row.path_prefix,
            transport: row.transport,
            timeoutMs: row.timeout_ms,
            maximumResponseBytes: row.maximum_response_bytes,
            credential,
            // Opted in per policy version. The tool-call ID is OAO's
            // derived one, so it is stable across recovery.
            ...(row.forward_call_context
              ? {
                  context: {
                    organizationId: tenant.organizationId,
                    projectId: tenant.projectId,
                    call: {
                      sessionId: tenant.sessionId,
                      runId: tenant.runId,
                      toolCallId,
                      runKeySha256: createHash("sha256")
                        .update(row.run_idempotency_key)
                        .digest("hex"),
                    },
                  },
                }
              : {}),
            ...(row.destination_origin && row.destination_path_prefix
              ? {
                  credentialDestination: {
                    origin: row.destination_origin,
                    pathPrefix: row.destination_path_prefix,
                  },
                }
              : {}),
          },
          {
            tool: {
              name: tool.remoteToolName,
              description: tool.description,
              inputSchema: tool.inputSchema,
              ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
            },
            arguments: arguments_,
          },
          signal,
        );
      } catch (error) {
        const cancelled = signal?.aborted === true;
        const errorCode = cancelled
          ? "request_cancelled"
          : mcpFailureCode(error);
        await withTenantTransaction(input.pool, tenant, async (transaction) => {
          await transaction.query(
            `UPDATE oao.mcp_call_attempts
                SET state=$4,safe_error_code=$5,completed_at=clock_timestamp()
              WHERE organization_id=$1 AND project_id=$2
                AND tool_call_id=$3 AND attempt=1 AND state='started'`,
            [
              tenant.organizationId,
              tenant.projectId,
              toolCallId,
              cancelled ? "cancelled" : "failed",
              errorCode,
            ],
          );
          await appendEventOnce(transaction, {
            organizationId: tenant.organizationId as OrganizationId,
            projectId: tenant.projectId as ProjectId,
            id: eventUuid(
              `event:mcp:${toolCallId}:${cancelled ? "cancelled" : "failed"}`,
            ),
            aggregateType: "tool_call",
            aggregateId: toolCallId,
            kind: cancelled ? "mcp.call_cancelled" : "mcp.call_failed",
            payload: {
              runId: tenant.runId,
              serverVersionId: tool.serverVersionId,
              remoteToolName: tool.remoteToolName,
              errorCode,
            },
          });
        });
        throw error;
      }
      await withTenantTransaction(input.pool, tenant, async (transaction) => {
        await transaction.query(
          `UPDATE oao.mcp_call_attempts
              SET state='completed',response_bytes=$4,completed_at=clock_timestamp()
            WHERE organization_id=$1 AND project_id=$2
              AND tool_call_id=$3 AND attempt=1 AND state='started'`,
          [
            tenant.organizationId,
            tenant.projectId,
            toolCallId,
            result.responseBytes,
          ],
        );
        await appendEventOnce(transaction, {
          organizationId: tenant.organizationId as OrganizationId,
          projectId: tenant.projectId as ProjectId,
          id: eventUuid(`event:mcp:${toolCallId}:completed`),
          aggregateType: "tool_call",
          aggregateId: toolCallId,
          kind: "mcp.call_completed",
          payload: {
            runId: tenant.runId,
            serverVersionId: tool.serverVersionId,
            remoteToolName: tool.remoteToolName,
            responseBytes: result.responseBytes,
            remoteError: result.isError,
          },
        });
      });
      return { content: result.content, isError: result.isError };
    },
  };
}

interface ProjectModelPresetRow {
  preset_key: string;
  model: string;
  routing: unknown;
  settings: unknown;
  provider_id: string;
  provider_type: ModelProviderType;
  encrypted_api_key: Buffer;
  encryption_nonce: Buffer;
  encryption_tag: Buffer;
  encryption_key_version: number;
  provider_removed: boolean;
  limits_id: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  limits_created_at: Date | null;
}

/**
 * Reads a durable project preset and activates it in the process registry.
 *
 * The project table is checked before a deployment key is accepted. This
 * preserves an older durable preset if a later deployment configuration
 * introduces the same key. Activation re-validates the stored model against
 * the provider catalog inside the models adapter, which keeps an unapproved model
 * string from ever reaching the provider.
 */
export function createProjectModelPresetActivator(input: {
  readonly pool: PgPool;
  readonly credentialCipher?: ProviderCredentialCipher;
  readonly registry: {
    activate(
      preset: ModelPresetTenant & {
        readonly key: string;
        readonly providerId: string;
        readonly providerType: ModelProviderType;
        readonly apiKey: string;
        readonly credentialVersion: number;
        readonly model: string;
        readonly routing: ModelRoutingPolicy;
        readonly settings?: ModelGenerationSettings | null;
        readonly limits?: ModelPresetLimitsInput | null;
      },
    ): ResolvedModelPreset;
  };
  readonly deploymentPresetKeys: ReadonlySet<string>;
}): ModelPresetActivationPort {
  return {
    async activate(tenant, presetKey) {
      const result = await withTenantTransaction(
        input.pool,
        tenant,
        (transaction) =>
          transaction.query<ProjectModelPresetRow>(
            `SELECT p.preset_key,p.model,p.routing,p.settings,p.provider_id,
                    c.provider_type,c.encrypted_api_key,c.encryption_nonce,
                    c.encryption_tag,c.encryption_key_version,
                    (c.archived_at IS NOT NULL) AS provider_removed,
                    l.id AS limits_id,l.context_window,l.max_output_tokens,
                    l.created_at AS limits_created_at
             FROM oao.project_model_presets p
             JOIN oao.project_model_providers c
               ON c.organization_id=p.organization_id
              AND c.id=p.provider_id
             LEFT JOIN LATERAL (
               SELECT latest.id,latest.context_window,latest.max_output_tokens,
                      latest.created_at
                 FROM oao.model_preset_limits latest
                WHERE latest.organization_id=p.organization_id
                  AND latest.project_id=p.project_id
                  AND latest.preset_id=p.id
                ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1
             ) l ON true
             WHERE p.organization_id=$1 AND p.project_id=$2 AND p.preset_key=$3`,
            [tenant.organizationId, tenant.projectId, presetKey],
          ),
      );
      const row = result.rows[0];
      if (!row && input.deploymentPresetKeys.has(presetKey)) return undefined;
      if (!row)
        throw new ModelPresetUnavailableError(
          "model_preset_unavailable",
          `Model preset is not approved: ${presetKey}`,
        );
      if (row.provider_removed)
        throw new ModelPresetUnavailableError(
          "model_provider_removed",
          `The provider connection behind model preset ${presetKey} was removed`,
        );
      if (!input.credentialCipher)
        throw new Error("Provider credential decryption is not configured");
      const apiKey = input.credentialCipher.decrypt(
        {
          ciphertext: row.encrypted_api_key,
          nonce: row.encryption_nonce,
          tag: row.encryption_tag,
          keyVersion: row.encryption_key_version,
        },
        {
          organizationId: tenant.organizationId,
          providerId: row.provider_id,
          providerType: row.provider_type,
        },
      );
      return input.registry.activate({
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        key: row.preset_key,
        providerId: row.provider_id,
        providerType: row.provider_type,
        apiKey,
        credentialVersion: row.encryption_key_version,
        model: row.model,
        routing: v.parse(ModelRoutingPolicySchema, row.routing ?? {}),
        settings:
          row.settings == null
            ? null
            : v.parse(ModelGenerationSettingsSchema, row.settings),
        // The latest limits apply from this run on; null leaves the model's.
        limits:
          row.limits_id == null
            ? null
            : {
                id: row.limits_id,
                contextWindow: row.context_window,
                maxOutputTokens: row.max_output_tokens,
                createdAt:
                  row.limits_created_at instanceof Date
                    ? row.limits_created_at.toISOString()
                    : (row.limits_created_at ?? null),
              },
      });
    },
  };
}

interface StoredSkillVersionRow {
  skill_id: string;
  id: string;
  version: number;
  skill_name: string;
  description: string;
  instructions: string;
  license: string | null;
  compatibility: string | null;
  metadata: unknown;
  allowed_tools: string | null;
  content_hash: Buffer;
  total_bytes: number;
  status: "active" | "deprecated" | "revoked";
}

interface StoredSkillFileRow {
  file_path: string;
  content_type: string;
  size_bytes: number;
  content_sha256: Buffer;
  content_bytes: Buffer;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function skillCacheKey(tenant: TenantContext, skillVersionId: string): string {
  return `${tenant.organizationId}/${tenant.projectId}/${skillVersionId}`;
}

/**
 * Loads exact, session-bound Skill versions from PostgreSQL before Flue's
 * synchronous agent render. The cache is only an immutable content cache;
 * lifecycle admission and integrity checks happen on every first load.
 */
export class PostgresSkillRegistry
  implements SkillDefinitionResolverPort, SkillDefinitionActivationPort
{
  readonly #cache = new Map<
    string,
    { readonly contentHash: string; readonly definition: SkillDefinition }
  >();

  constructor(
    private readonly pool: PgPool,
    private readonly maximumEntries = 256,
  ) {}

  resolve(
    tenant: TenantContext,
    binding: ManagedSkillBindingSnapshot,
  ): SkillDefinition {
    const cached = this.#cache.get(
      skillCacheKey(tenant, binding.skillVersionId),
    );
    if (!cached || cached.contentHash !== binding.contentHash)
      throw new Error(`Skill version is not activated: ${binding.name}`);
    return cached.definition;
  }

  async activate(
    tenant: TenantContext,
    bindings: readonly ManagedSkillBindingSnapshot[],
  ): Promise<void> {
    for (const binding of bindings) {
      const key = skillCacheKey(tenant, binding.skillVersionId);
      const cached = this.#cache.get(key);
      if (cached?.contentHash === binding.contentHash) continue;
      const loaded = await withTenantTransaction(
        this.pool,
        tenant,
        async (transaction) => {
          const versionResult = await transaction.query<StoredSkillVersionRow>(
            `SELECT version.skill_id,version.id,version.version,
                    version.skill_name,version.description,
                    version.instructions,version.license,
                    version.compatibility,version.metadata,
                    version.allowed_tools,version.content_hash,
                    version.total_bytes,lifecycle.status
             FROM oao.skill_versions version
             JOIN oao.skill_version_lifecycle lifecycle
               ON lifecycle.organization_id=version.organization_id
              AND lifecycle.project_id=version.project_id
              AND lifecycle.skill_version_id=version.id
             WHERE version.organization_id=$1 AND version.project_id=$2
               AND version.id=$3`,
            [tenant.organizationId, tenant.projectId, binding.skillVersionId],
          );
          const version = versionResult.rows[0];
          if (!version) throw new SkillPackageUnavailableError();
          if (version.status === "revoked")
            throw new SkillPackageUnavailableError();
          const storedHash = Buffer.from(version.content_hash).toString("hex");
          if (
            version.skill_id !== binding.skillId ||
            version.version !== binding.version ||
            version.skill_name !== binding.name ||
            version.description !== binding.description ||
            storedHash !== binding.contentHash
          )
            throw new SkillPackageUnavailableError();
          const fileResult = await transaction.query<StoredSkillFileRow>(
            `SELECT file_path,content_type,size_bytes,content_sha256,content_bytes
             FROM oao.skill_version_files
             WHERE organization_id=$1 AND project_id=$2
               AND skill_version_id=$3
             ORDER BY file_path`,
            [tenant.organizationId, tenant.projectId, binding.skillVersionId],
          );
          return { version, files: fileResult.rows };
        },
      );
      const metadata = loaded.version.metadata;
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        Object.values(metadata).some((value) => typeof value !== "string")
      )
        throw new SkillPackageUnavailableError();
      const files: Record<string, Uint8Array> = {};
      let totalBytes = Buffer.byteLength(loaded.version.instructions, "utf8");
      const manifest = loaded.files.map((file) => {
        const bytes = Buffer.from(file.content_bytes);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (
          bytes.byteLength !== file.size_bytes ||
          Buffer.from(file.content_sha256).toString("hex") !== digest
        )
          throw new SkillPackageUnavailableError();
        totalBytes += bytes.byteLength;
        files[file.file_path] = bytes;
        return {
          path: file.file_path,
          contentType: file.content_type,
          sizeBytes: file.size_bytes,
          sha256: digest,
        };
      });
      if (totalBytes !== loaded.version.total_bytes)
        throw new SkillPackageUnavailableError();
      const canonical = {
        name: loaded.version.skill_name,
        description: loaded.version.description,
        instructions: loaded.version.instructions,
        ...(loaded.version.license ? { license: loaded.version.license } : {}),
        ...(loaded.version.compatibility
          ? { compatibility: loaded.version.compatibility }
          : {}),
        metadata: metadata as Record<string, string>,
        ...(loaded.version.allowed_tools
          ? { allowedTools: loaded.version.allowed_tools }
          : {}),
        files: manifest,
      };
      const computedHash = createHash("sha256")
        .update(serializeSkillPackageForHash(canonical))
        .digest("hex");
      if (computedHash !== binding.contentHash) {
        const legacyHash = createHash("sha256")
          .update(serializeLegacySkillPackageForHash(canonical))
          .digest("hex");
        if (legacyHash !== binding.contentHash)
          throw new SkillPackageUnavailableError();
      }
      // Flue 2.0.3 serializes an empty metadata object as a bare YAML key,
      // which reloads as null and fails its own frontmatter validation.
      const definition = defineSkill({
        name: loaded.version.skill_name,
        description: loaded.version.description,
        instructions: loaded.version.instructions,
        ...(loaded.version.license ? { license: loaded.version.license } : {}),
        ...(loaded.version.compatibility
          ? { compatibility: loaded.version.compatibility }
          : {}),
        ...(Object.keys(metadata).length > 0
          ? { metadata: metadata as Record<string, string> }
          : {}),
        ...(loaded.version.allowed_tools
          ? { allowedTools: loaded.version.allowed_tools }
          : {}),
        files,
      });
      if (this.#cache.size >= this.maximumEntries) {
        const oldest = this.#cache.keys().next().value as string | undefined;
        if (oldest) this.#cache.delete(oldest);
      }
      this.#cache.set(key, { contentHash: binding.contentHash, definition });
    }
  }
}

export async function startManagedFlueRuntime(input: {
  readonly pool: PgPool;
  readonly providers: readonly Provider[];
  readonly presets: ModelPresetResolverPort;
  readonly broker: PostgresToolBroker;
  readonly skills?: SkillDefinitionResolverPort;
  readonly delegations?: AgentDelegationPort;
  readonly mcp?: McpToolExecutionPort;
  readonly oaoTools?: OaoToolExecutionPort;
  readonly runFileStorage?: ProjectArtifactStoreResolverPort;
  readonly platformTools?: ReadonlyMap<string, PlatformToolHandler>;
  readonly sandboxFactory?: (
    initial: ManagedAgentInstanceData,
    delivery: ManagedRunDelivery,
  ) => PersistableSandboxFactory;
}): Promise<Flue> {
  configureManagedAgentRuntime({
    pool: input.pool,
    presets: input.presets,
    broker: input.broker,
    platformTools: input.platformTools ?? new Map(),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.delegations ? { delegations: input.delegations } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
    ...(input.oaoTools ? { oaoTools: input.oaoTools } : {}),
    ...(input.runFileStorage ? { runFileStorage: input.runFileStorage } : {}),
    ...(input.sandboxFactory ? { sandboxFactory: input.sandboxFactory } : {}),
  });
  for (const provider of input.providers) recordRuntimeModels(provider);
  return start({
    agents: [ManagedAgent],
    db: createFluePostgresAdapter(input.pool),
    providers: input.providers.map((provider) =>
      withModelCallTimeout(provider),
    ),
  });
}

export const runtimeTesting = {
  rememberRunModelLimits,
  modelLimitsDetail,
  createModelTurnAdmission,
  rememberPromptCacheKey,
  managedPromptCacheScope,
  withManagedPromptCacheScope,
  agentVersionPromptCacheKey,
  createPendingAssistantText: () => new PendingAssistantText(),
  replyAfterCommittedText,
  withPendingAssistantText,
  withAssistantTextBeforeSandboxTools,
  publishAssistantTextBefore,
  shouldProjectObservation,
  observe,
  eventUuid,
  safeArguments,
  turnWindow,
  turnThinking,
  modelInvocationDiagnostics,
  threadInstanceId,
  compileObjectSchema,
  compileToolInputSchema,
  managedSystemPrompt,
  mcpToolName,
  oaoAgentTools,
  oaoToolLedgerArguments,
  loadManagedRunFiles,
  deliveryContext,
  recoveredAdmissionRequest,
};
