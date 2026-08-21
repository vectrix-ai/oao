import { createHash } from "node:crypto";
import type { Provider } from "@earendil-works/pi-ai";
import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry";
import { postgres } from "@flue/postgres";
import {
  AgentInstanceExistsError,
  AgentRunError,
  dispatch,
  defineSkill,
  getAgentInstance,
  init,
  instrument,
  observe,
  setProvider,
  useAgentFinish,
  useDelivery,
  useInitialData,
  useModel,
  useSandbox,
  useSkill,
  useTool,
} from "@flue/runtime";
import type {
  DispatchReceipt,
  DeliveredAttachment,
  DeliveredMessage,
  FlueObservation,
  Sandbox,
  SandboxFactory,
  SkillDefinition,
  ToolInputSchema,
  ToolOutputSchema,
} from "@flue/runtime";
import { start } from "@flue/runtime/node";
import type { Flue } from "@flue/runtime/node";
import {
  ManagedAgentInstanceDataSchema,
  parseManagedAgentSnapshotForPublication,
  ManagedRunDeliverySchema,
  ManagedRunInputV1Schema,
  ModelRoutingPolicySchema,
  ToolResultFailureCodeSchema,
  type ManagedAgentSnapshot,
  type ManagedSkillBindingSnapshot,
  type ManagedAgentInstanceData,
  type ManagedRunDelivery,
  type ManagedRunInputV1,
  type ModelProviderType,
  type ModelRoutingPolicy,
} from "@oao/contracts";
import type { PgPool, Queryable, TenantContext } from "@oao/db-postgres";
import { withTenantTransaction } from "@oao/db-postgres";
import type { ProviderCredentialCipher } from "@oao/provider-credentials";
import type {
  OrganizationId,
  ProjectId,
  PublicValue,
  RunId,
  ThreadId,
} from "@oao/domain";
import { redactForPublic } from "@oao/domain";
import type {
  ModelPresetTenant,
  ResolvedModelPreset,
} from "@oao/models-openrouter";
import type { PostgresWakeQueue, RuntimeWakeJob } from "@oao/queue-postgres";
import type { PostgresToolBroker, ToolObligationInput } from "@oao/tool-broker";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as v from "valibot";

export const FLUE_PACKAGE_VERSIONS = Object.freeze({
  runtime: "2.0.3",
  postgres: "2.0.3",
  opentelemetry: "2.0.3",
  piAi: "0.83.0",
});

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

/**
 * Registers a provider with the Flue runtime. Keeping the call behind this
 * package preserves the single Flue seam: the worker never imports Flue.
 */
export function registerRuntimeModelProvider(provider: Provider): void {
  setProvider(provider);
}

interface ManagedAgentRuntimeConfig {
  readonly presets: ModelPresetResolverPort;
  readonly broker: PostgresToolBroker;
  readonly platformTools: ReadonlyMap<string, PlatformToolHandler>;
  readonly skills?: SkillDefinitionResolverPort;
  readonly delegations?: AgentDelegationPort;
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
}

export function resetManagedAgentRuntime(): void {
  managedRuntime = undefined;
}

function runtimeConfig(): ManagedAgentRuntimeConfig {
  if (!managedRuntime)
    throw new Error("ManagedAgent runtime is not configured");
  return managedRuntime;
}

type PublishedObjectSchema =
  ManagedAgentSnapshot["tools"][number]["inputSchema"];

function compilePropertySchema(
  schema: Record<string, unknown>,
): v.GenericSchema {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum;
    return v.custom((value) => values.some((entry) => Object.is(entry, value)));
  }
  switch (schema.type) {
    case "string":
      return v.string();
    case "number":
      return v.number();
    case "integer":
      return v.pipe(v.number(), v.integer());
    case "boolean":
      return v.boolean();
    case "null":
      return v.null();
    case "array": {
      if (!schema.items || typeof schema.items !== "object")
        throw new TypeError("Published array schemas require items");
      return v.array(
        compilePropertySchema(schema.items as Record<string, unknown>),
      );
    }
    case "object":
      return compileObjectSchema(schema as PublishedObjectSchema);
    default:
      throw new TypeError("Unsupported published JSON schema type");
  }
}

function compileObjectSchema(schema: PublishedObjectSchema): ToolInputSchema {
  if (schema.type !== "object" || schema.additionalProperties !== false)
    throw new TypeError("Tool schemas must be closed objects");
  const required = new Set(schema.required);
  const entries: Record<string, v.GenericSchema> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const compiled = compilePropertySchema(property);
    entries[key] = required.has(key) ? compiled : v.optional(compiled);
  }
  for (const key of required) {
    if (!(key in entries))
      throw new TypeError(`Required tool schema property is missing: ${key}`);
  }
  return v.strictObject(entries);
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

const IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const DELIVERY_FILENAME_PREFIX = "oao-run-v1.";

function deliveryContext(delivered: DeliveredMessage): ManagedRunDelivery {
  if (delivered.kind === "signal" && delivered.type === "oao.run.v1")
    return v.parse(ManagedRunDeliverySchema, delivered.attributes);
  if (delivered.kind === "user") {
    const encoded = delivered.attachments
      ?.map((attachment) => attachment.filename)
      .find((name) => name?.startsWith(DELIVERY_FILENAME_PREFIX))
      ?.slice(DELIVERY_FILENAME_PREFIX.length);
    if (encoded) {
      try {
        return v.parse(
          ManagedRunDeliverySchema,
          JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
        );
      } catch {
        // Fall through to the public-safe invalid-delivery error below.
      }
    }
  }
  throw new Error("ManagedAgent received an invalid delivery envelope");
}

function inputBody(
  message: string,
  files: readonly ManagedRunFileContent[],
): string {
  if (files.length === 0) return message;
  const sections = files.map((file) => {
    if (IMAGE_CONTENT_TYPES.has(file.contentType))
      return `[Attached image: ${file.name} (${file.contentType}, ${file.sizeBytes} bytes)]`;
    if (!file.modelText)
      throw new Error("Run file is missing its admitted model text");
    return [
      `[Attached file: ${file.name} (${file.contentType}, ${file.sizeBytes} bytes)]`,
      file.modelText,
      `[End attached file: ${file.name}]`,
    ].join("\n");
  });
  return [message, "", ...sections].join("\n\n");
}

export function createManagedRunDeliveredMessage(input: {
  readonly delivery: ManagedRunDelivery;
  readonly message: string;
  readonly files: readonly ManagedRunFileContent[];
}): DeliveredMessage {
  const images: DeliveredAttachment[] = input.files
    .filter((file) => IMAGE_CONTENT_TYPES.has(file.contentType))
    .map((file, index) => ({
      type: "image",
      data: file.bytes.toString("base64"),
      mimeType: file.contentType,
      filename:
        index === 0
          ? `${DELIVERY_FILENAME_PREFIX}${Buffer.from(JSON.stringify(input.delivery), "utf8").toString("base64url")}`
          : file.name,
    }));
  const body = inputBody(input.message, input.files);
  if (images.length > 0) return { kind: "user", body, attachments: images };
  return {
    kind: "signal",
    type: "oao.run.v1",
    tagName: "oao-run",
    body,
    attributes: input.delivery,
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
  const config = runtimeConfig();
  const preset = config.presets.resolve(initial.snapshot.modelPreset, {
    organizationId: initial.organizationId,
    projectId: initial.projectId,
  });
  useModel(preset.model);
  if (initial.snapshot.sandbox.enabled && config.sandboxFactory) {
    const sandbox = config.sandboxFactory(initial, delivery);
    useSandbox(sandbox);
    if (sandbox.persistWorkspace)
      useAgentFinish(async ({ harness }) =>
        sandbox.persistWorkspace?.(harness.sandbox),
      );
  }

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
          config.broker.executePlatform(
            obligation,
            async () => {
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
                ...(signal ? { signal } : {}),
              });
              return { ...result } as Readonly<Record<string, PublicValue>>;
            },
            signal,
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
          config.broker.executePlatform(
            obligation,
            async () => {
              const result = await config.delegations!.followUp({
                organizationId: initial.organizationId,
                projectId: initial.projectId,
                parentRunId: delivery.runId,
                parentSessionId: initial.sessionId,
                delegationId: data.delegationId,
                prompt: data.prompt,
                idempotencyKey: `delegate-follow-up:${delivery.runId}:${toolCallId}`,
                ...(signal ? { signal } : {}),
              });
              return { ...result } as Readonly<Record<string, PublicValue>>;
            },
            signal,
          ),
        );
        return { output: outcome };
      },
    });
  }

  for (const tool of initial.snapshot.tools) {
    useTool({
      name: tool.name,
      description: tool.description,
      input: compileObjectSchema(tool.inputSchema),
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
        if (tool.owner === "caller") {
          await step.do("publish-caller-obligation", () =>
            config.broker.publishCaller(obligation),
          );
          const outcome = await step.do("commit-caller-result", () =>
            config.broker.waitForCaller(obligation, signal),
          );
          return { output: outcome };
        }
        const handler = config.platformTools.get(tool.name);
        const outcome = await step.do("execute-platform-obligation", () =>
          config.broker.executePlatform(
            obligation,
            async () => {
              if (!handler)
                throw new Error("Platform tool handler unavailable");
              const result = await handler(obligation.safeArguments, {
                runId: obligation.runId,
                toolCallId,
                idempotencyKey: `platform:${obligation.runId}:${toolCallId}`,
                ...(signal ? { signal } : {}),
              });
              return v.parse(
                compileObjectSchema(tool.outputSchema),
                result,
              ) as PublicValue;
            },
            signal,
          ),
        );
        return { output: outcome };
      },
    });
  }
  if (initial.snapshot.delegates.length === 0)
    return initial.snapshot.systemPrompt;
  return `${initial.snapshot.systemPrompt}\n\nYou may delegate work with delegate_agent. Keep the returned delegationId and use message_agent for later questions to that same isolated child thread.`;
}

ManagedAgent.agentName = "ManagedAgent";
ManagedAgent.initialData = ManagedAgentInstanceDataSchema;
ManagedAgent.durability = { maxAttempts: 10, timeoutMs: 3_600_000 };

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
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly agentVersionId: string;
  readonly state: string;
  readonly cancellationRequested: boolean;
  readonly inputPublic: ManagedRunInputV1;
  readonly files: readonly ManagedRunFileContent[];
  readonly snapshot: ManagedAgentSnapshot;
  readonly workspace: NonNullable<ManagedAgentInstanceData["workspace"]>;
}

export interface ManagedRunFileContent {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly bytes: Buffer;
  readonly modelText?: string;
}

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
  return thinking || undefined;
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
          child_agent_version_id: string;
          max_parallel: number;
          workspace_id: string;
        }>(
          `SELECT parent.created_by_principal_id,delegate.child_agent_version_id,
                  delegate.max_parallel,binding.workspace_id
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
            parent.child_agent_version_id,
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
          `INSERT INTO oao.runs
             (organization_id,project_id,id,thread_id,session_id,agent_version_id,
              created_by_principal_id,idempotency_key,input_public)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.organizationId,
            input.projectId,
            childRunId,
            childThreadId,
            childSessionId,
            parent.child_agent_version_id,
            parent.created_by_principal_id,
            input.idempotencyKey,
            { message: prompt },
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
            parent.child_agent_version_id,
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
            parent.child_agent_version_id,
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
            childAgentVersionId: parent.child_agent_version_id,
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
              created_by_principal_id,idempotency_key,input_public)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
            `SELECT run.state::text AS state,
                    (SELECT message.redacted_content FROM oao.messages message
                      WHERE message.organization_id=run.organization_id
                        AND message.project_id=run.project_id
                        AND message.run_id=run.id AND message.role='assistant'
                      ORDER BY message.created_at DESC,message.id DESC LIMIT 1) AS response
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
    // Flue resolves `useModel` synchronously during the agent render, so a
    // durable project preset must be loaded and registered before dispatch.
    await this.modelPresets?.activate(run, run.snapshot.modelPreset);
    await this.skills?.activate(run, run.snapshot.skills);
    const admissionKey = `run:${run.runId}`;
    const snapshotHash = digestJson(run.snapshot);
    const deliveredMessage = this.deliveredMessage(run);
    const requestHash = digestJson({
      runId: run.runId,
      snapshotHash: Buffer.from(snapshotHash).toString("hex"),
      deliveredMessage,
    });
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
        const receipt = await this.dispatchFenced(run, runtimeDispatch);
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
  ): Promise<DispatchReceipt> {
    let instance = await this.loadThreadInstance(run);
    const message = this.deliveredMessage(run);
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
    await this.cascadeDelegations(job);
    const run = await this.loadRun(job);
    const dispatchResult = await withTenantTransaction(
      this.pool,
      run,
      async (transaction) => {
        const result = await transaction.query<DispatchRow>(
          `UPDATE oao.runtime_dispatches SET timeout_requested_at=COALESCE(timeout_requested_at,clock_timestamp()),
             state=CASE WHEN state='settled' THEN state ELSE 'aborting'::oao.runtime_dispatch_state END,
             updated_at=clock_timestamp()
           WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
             AND state <> 'settled' AND deadline_at <= clock_timestamp()
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
    const runtimeDispatch = dispatchResult.rows[0];
    if (!runtimeDispatch) return;
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
          v.id AS agent_version_id,v.config,encode(v.content_hash,'hex') AS content_hash,
          workspace.id AS workspace_id,workspace.owner_thread_id,
          COALESCE(workspace.owner_session_id,r.session_id) AS owner_session_id,
          COALESCE(workspace.owner_run_id,r.id) AS owner_run_id
         FROM oao.runs r JOIN oao.agent_versions v
           ON v.organization_id=r.organization_id AND v.project_id=r.project_id AND v.id=r.agent_version_id
         JOIN oao.thread_workspace_bindings binding
           ON binding.organization_id=r.organization_id AND binding.project_id=r.project_id
          AND binding.thread_id=r.thread_id
         JOIN oao.agent_workspaces workspace
           ON workspace.organization_id=binding.organization_id AND workspace.project_id=binding.project_id
          AND workspace.id=binding.workspace_id
         WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=$3`,
        [tenant.organizationId, tenant.projectId, tenant.runId],
      );
      if (!result.rowCount) throw new Error("Run not found");
      const row = result.rows[0] as Record<string, unknown>;
      const publication = parseManagedAgentSnapshotForPublication(row.config);
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
      const expectedSkillIds = [...publication.skillVersionIds].sort();
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
      if (skillResult.rows.some((binding) => binding.status === "revoked"))
        throw new Error("A bound Skill version has been revoked");
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
      const runInput = v.parse(ManagedRunInputV1Schema, row.input_public);
      const fileResult = await transaction.query<{
        id: string;
        file_name: string;
        content_type: string;
        size_bytes: number;
        content_sha256: Buffer;
        content_bytes: Buffer;
        extracted_text: string | null;
      }>(
        `SELECT id,file_name,content_type,size_bytes,content_sha256,content_bytes,extracted_text
         FROM oao.run_files
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
         ORDER BY created_at,id`,
        [tenant.organizationId, tenant.projectId, tenant.runId],
      );
      const expectedFiles = runInput.files ?? [];
      if (fileResult.rows.length !== expectedFiles.length)
        throw new Error("Run file records do not match the admitted input");
      const files = expectedFiles.map((expected) => {
        const stored = fileResult.rows.find((file) => file.id === expected.id);
        if (!stored) throw new Error("Run file record is missing");
        const actualDigest = createHash("sha256")
          .update(stored.content_bytes)
          .digest("hex");
        const expectsModelText = !IMAGE_CONTENT_TYPES.has(expected.contentType);
        if (
          stored.file_name !== expected.name ||
          stored.content_type !== expected.contentType ||
          stored.size_bytes !== expected.sizeBytes ||
          stored.content_bytes.byteLength !== expected.sizeBytes ||
          Buffer.from(stored.content_sha256).toString("hex") !==
            expected.sha256 ||
          actualDigest !== expected.sha256 ||
          (expectsModelText
            ? !stored.extracted_text
            : stored.extracted_text !== null)
        )
          throw new Error("Run file integrity validation failed");
        return {
          id: expected.id,
          name: expected.name,
          contentType: expected.contentType,
          sizeBytes: expected.sizeBytes,
          sha256: expected.sha256,
          bytes: Buffer.from(stored.content_bytes),
          ...(stored.extracted_text === null
            ? {}
            : { modelText: stored.extracted_text }),
        } satisfies ManagedRunFileContent;
      });
      const runtimeConfig = {
        systemPrompt: publication.systemPrompt,
        modelPreset: publication.modelPreset,
        tools: publication.tools,
        delegates: publication.delegates,
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
        threadId: row.thread_id as ThreadId,
        sessionId: row.session_id as string,
        agentVersionId: row.agent_version_id as string,
        state: row.state as string,
        cancellationRequested: row.cancellation_requested_at !== null,
        inputPublic: runInput,
        files,
        snapshot: parsed,
        workspace: {
          id: row.workspace_id as string,
          ownerThreadId: row.owner_thread_id as string,
          ownerSessionId: row.owner_session_id as string,
          ownerRunId: row.owner_run_id as string,
        },
      };
    });
  }

  private inputText(input: ManagedRunInputV1): string {
    return input.message;
  }

  private deliveredMessage(run: RunContext): DeliveredMessage {
    const delivery: ManagedRunDelivery = {
      version: "1",
      runId: run.runId,
      sessionId: run.sessionId,
      snapshotHash: digestHex(run.snapshot),
    };
    return createManagedRunDeliveredMessage({
      delivery,
      message: run.inputPublic.message,
      files: run.files,
    });
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
      if (!event.conversationId) return;
      this.#pending = this.#pending
        .then(() => this.project(event))
        .catch(() => undefined);
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

  private async project(event: FlueObservation): Promise<void> {
    const dispatchResult = await this.pool.query<DispatchRow>(
      `SELECT * FROM oao.runtime_dispatches
       WHERE flue_submission_id=$1 OR
         ($1='' AND flue_conversation_id=$2 AND state <> 'settled')
       ORDER BY CASE WHEN flue_submission_id=$1 THEN 0 ELSE 1 END,created_at DESC
       LIMIT 1`,
      [event.submissionId ?? "", event.conversationId ?? ""],
    );
    const runtimeDispatch = dispatchResult.rows[0];
    if (!runtimeDispatch) return;
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
      await this.projectTurn(runtimeDispatch, event);
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

  private async projectTurn(
    runtimeDispatch: DispatchRow,
    event: Extract<FlueObservation, { type: "turn" }>,
  ): Promise<void> {
    const usage = event.response.usage;
    const timing = turnWindow(event);
    const thinking = turnThinking(event.response.output);
    const invocationId = eventUuid(
      `turn:${runtimeDispatch.run_id}:${event.turnId}`,
    );
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
        const inserted = await transaction.query<{ attempt: string }>(
          `INSERT INTO oao.model_invocations (
          organization_id,project_id,id,run_id,attempt,provider_key,model_key,status,
          input_tokens,output_tokens,cost_microunits,safe_request,safe_response,
          started_at,completed_at,usage_source,pricing_snapshot,provider_route
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
            Math.round((usage?.cost.total ?? 0) * 1_000_000),
            { purpose: event.purpose },
            {
              finishReason: event.response.finishReason ?? "unknown",
              ...(thinking ? { thinking } : {}),
            },
            timing.startedAt,
            timing.completedAt,
            usage ? "estimated" : "unavailable",
            { model: event.request.requestedModel },
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
            },
          ],
        );
        await transaction.query(
          `INSERT INTO oao.session_summaries (
          organization_id,project_id,session_id,input_tokens,output_tokens,cost_microunits
        ) SELECT organization_id,project_id,session_id,$4,$5,$6 FROM oao.runs
          WHERE organization_id=$1 AND project_id=$2 AND id=$3
        ON CONFLICT (organization_id,project_id,session_id) DO UPDATE SET
          summary_version=oao.session_summaries.summary_version+1,
          input_tokens=oao.session_summaries.input_tokens+EXCLUDED.input_tokens,
          output_tokens=oao.session_summaries.output_tokens+EXCLUDED.output_tokens,
          cost_microunits=oao.session_summaries.cost_microunits+EXCLUDED.cost_microunits,
          updated_at=clock_timestamp()`,
          [
            runtimeDispatch.organization_id,
            runtimeDispatch.project_id,
            runtimeDispatch.run_id,
            usage?.input ?? 0,
            usage?.output ?? 0,
            Math.round((usage?.cost.total ?? 0) * 1_000_000),
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
        costMicrounits: Math.round((usage?.cost.total ?? 0) * 1_000_000),
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
        }>(
          `SELECT r.cancellation_requested_at,r.session_id,r.thread_id,d.timeout_requested_at,
             i.state AS thread_instance_state
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
      if (redactedReply) {
        await transaction.query(
          `INSERT INTO oao.messages (
            organization_id,project_id,id,thread_id,run_id,role,redacted_content,flue_message_ref
          ) VALUES ($1,$2,$3,$4,$5,'assistant',$6,$7) ON CONFLICT DO NOTHING`,
          [
            tenant.organizationId,
            tenant.projectId,
            eventUuid(`message:${runtimeDispatch.run_id}:assistant`),
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
          payload: { role: "assistant" },
        });
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

  private async appendPublicEvent(
    runtimeDispatch: DispatchRow,
    event: FlueObservation,
    kind: string,
    payload: Readonly<Record<string, PublicValue>>,
  ): Promise<void> {
    const eventId = eventUuid(
      `flue:${runtimeDispatch.run_id}:${event.eventIndex}:${kind}`,
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
            payload,
            new Date(event.timestamp),
          ],
        );
      },
    );
  }
}

export async function configureVendorNeutralTelemetry(
  input: {
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
  const disposeInstrumentation = instrument(
    createOpenTelemetryInstrumentation({ content: false }),
  );
  return async () => {
    await disposeInstrumentation();
    await sdk?.shutdown();
  };
}

interface ProjectModelPresetRow {
  preset_key: string;
  model: string;
  routing: unknown;
  provider_id: string;
  provider_type: ModelProviderType;
  encrypted_api_key: Buffer;
  encryption_nonce: Buffer;
  encryption_tag: Buffer;
  encryption_key_version: number;
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
            `SELECT p.preset_key,p.model,p.routing,p.provider_id,
                    c.provider_type,c.encrypted_api_key,c.encryption_nonce,
                    c.encryption_tag,c.encryption_key_version
             FROM oao.project_model_presets p
             JOIN oao.project_model_providers c
               ON c.organization_id=p.organization_id
              AND c.project_id=p.project_id
              AND c.id=p.provider_id
             WHERE p.organization_id=$1 AND p.project_id=$2 AND p.preset_key=$3`,
            [tenant.organizationId, tenant.projectId, presetKey],
          ),
      );
      const row = result.rows[0];
      if (!row && input.deploymentPresetKeys.has(presetKey)) return undefined;
      if (!row) throw new Error(`Model preset is not approved: ${presetKey}`);
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
          projectId: tenant.projectId,
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
          if (!version) throw new Error("Bound Skill version is missing");
          if (version.status === "revoked")
            throw new Error(`Bound Skill version is revoked: ${binding.name}`);
          const storedHash = Buffer.from(version.content_hash).toString("hex");
          if (
            version.skill_id !== binding.skillId ||
            version.version !== binding.version ||
            version.skill_name !== binding.name ||
            version.description !== binding.description ||
            storedHash !== binding.contentHash
          )
            throw new Error("Bound Skill metadata failed integrity validation");
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
        throw new Error("Stored Skill metadata is invalid");
      const files: Record<string, Uint8Array> = {};
      let totalBytes = Buffer.byteLength(loaded.version.instructions, "utf8");
      const manifest = loaded.files.map((file) => {
        const bytes = Buffer.from(file.content_bytes);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (
          bytes.byteLength !== file.size_bytes ||
          Buffer.from(file.content_sha256).toString("hex") !== digest
        )
          throw new Error("Stored Skill file failed integrity validation");
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
        throw new Error(
          "Stored Skill package size failed integrity validation",
        );
      const canonical = {
        schemaVersion: 1,
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
        .update(stableJson(canonical))
        .digest("hex");
      if (computedHash !== binding.contentHash)
        throw new Error(
          "Stored Skill package hash failed integrity validation",
        );
      const definition = defineSkill({
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
  readonly platformTools?: ReadonlyMap<string, PlatformToolHandler>;
  readonly sandboxFactory?: (
    initial: ManagedAgentInstanceData,
    delivery: ManagedRunDelivery,
  ) => PersistableSandboxFactory;
}): Promise<Flue> {
  configureManagedAgentRuntime({
    presets: input.presets,
    broker: input.broker,
    platformTools: input.platformTools ?? new Map(),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.delegations ? { delegations: input.delegations } : {}),
    ...(input.sandboxFactory ? { sandboxFactory: input.sandboxFactory } : {}),
  });
  return start({
    agents: [ManagedAgent],
    db: createFluePostgresAdapter(input.pool),
    providers: input.providers,
  });
}

export const runtimeTesting = {
  eventUuid,
  safeArguments,
  turnWindow,
  turnThinking,
  threadInstanceId,
  compileObjectSchema,
};
