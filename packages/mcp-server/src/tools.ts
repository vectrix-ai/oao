import {
  CreateMcpCredentialPolicyInputSchema,
  CreateMcpServerInputSchema,
  CreateMcpToolsetInputSchema,
  CreateModelPresetInputSchema,
  ProjectUsageGroupSchema,
  SetModelPresetPriceInputSchema,
  DiscoverMcpServerInputSchema,
  ManagedAgentPublicationConfigSchema,
  OAO_MCP_TOOL_CATALOG,
  availableOaoMcpTools,
  type OaoMcpToolDescriptor,
  type Run,
} from "@oao/contracts";
import {
  OaoApiError,
  type CreateAgentInput,
  type CreateModelPresetInput,
  type SetModelPresetPriceInput,
  type CreateSessionInput,
  type OaoClient,
  type PublishAgentVersionInput,
  type PublishSkillVersionInput,
} from "@oao/sdk-js";
import * as v from "valibot";

/** What a tool call needs to reach the OAO API for one project. */
export interface OaoToolContext {
  readonly client: OaoClient;
  readonly projectId: string;
  /**
   * The Idempotency-Key for one write this call makes. Retrying the same
   * call with the same key repeats the write safely instead of duplicating it.
   */
  readonly idempotencyKey: (purpose: string) => string;
  readonly signal?: AbortSignal;
}

/** A tool of the catalog in `@oao/contracts`, with its input and behaviour. */
export interface OaoTool extends OaoMcpToolDescriptor {
  readonly input: v.ObjectSchema<v.ObjectEntries, undefined>;
  readonly run: (
    input: Readonly<Record<string, unknown>>,
    context: OaoToolContext,
  ) => Promise<unknown>;
}

const SETTLED_RUN_STATES = new Set<Run["state"]>([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 600;

const Id = v.pipe(v.string(), v.uuid());
const Limit = v.optional(
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(100),
    v.description("Page size, 1 to 100."),
  ),
);
const Cursor = v.optional(
  v.pipe(
    v.string(),
    v.maxLength(2000),
    v.description("nextCursor from the previous page."),
  ),
);
const Message = v.pipe(v.string(), v.minLength(1), v.maxLength(100_000));
const WaitSeconds = v.optional(
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(MAX_WAIT_SECONDS),
    v.description(
      `Seconds to wait for the run to settle and return the agent's answer. 0 returns at once. Defaults to ${DEFAULT_WAIT_SECONDS}; when the run is still going, call wait_for_run.`,
    ),
  ),
);
const IdempotencyKey = v.optional(
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(120),
    v.description(
      "Reuse the same value to retry this exact call without repeating its effect.",
    ),
  ),
);
const SkillFile = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  content: v.pipe(
    v.string(),
    v.maxLength(1_000_000),
    v.description("UTF-8 text content of the file."),
  ),
  contentType: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
const SkillVersion = {
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  instructions: v.pipe(
    v.string(),
    v.minLength(1),
    v.description("Markdown body of SKILL.md."),
  ),
  license: v.optional(v.string()),
  compatibility: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.string())),
  files: v.optional(v.array(SkillFile)),
};
const AgentConfig = v.pipe(
  ManagedAgentPublicationConfigSchema,
  v.description(
    "The immutable agent version: system prompt, model preset key, tools, Skills, MCP bindings, delegates, sandbox, limits, whether to publish each turn's text before its tool calls (publishTextBeforeToolCalls), and whether to predict the user's next message after each completed run (promptSuggestions). A delegate pins agentVersionId or follows agentId; skillVersionIds pins Skill versions and skillIds follows Skills. Followed links resolve to the latest published version when a session starts.",
  ),
);

/** Implements the catalog entry `name`. */
function tool<Entries extends v.ObjectEntries>(
  name: string,
  definition: {
    readonly input: Entries;
    readonly run: (
      input: v.InferOutput<v.StrictObjectSchema<Entries, undefined>>,
      context: OaoToolContext,
    ) => Promise<unknown>;
  },
): OaoTool {
  const descriptor = OAO_MCP_TOOL_CATALOG.find((entry) => entry.name === name);
  if (!descriptor)
    throw new Error(`${name} is not in the OAO MCP tool catalog`);
  return {
    ...descriptor,
    input: v.strictObject(definition.input) as unknown as OaoTool["input"],
    run: definition.run as OaoTool["run"],
  };
}

/** A copy of `value` without `keys`. */
function without<Value extends object, Key extends keyof Value>(
  value: Value,
  ...keys: readonly Key[]
): Omit<Value, Key> {
  const copy: Partial<Value> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Omit<Value, Key>;
}

function page(input: {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}) {
  return {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  };
}

function withSignal(context: OaoToolContext) {
  return context.signal ? { signal: context.signal } : {};
}

function write(context: OaoToolContext, purpose: string) {
  return {
    idempotencyKey: context.idempotencyKey(purpose),
    ...withSignal(context),
  };
}

/** The agent's last answer in a run, or null when it gave none. */
async function finalAnswer(
  context: OaoToolContext,
  runId: string,
): Promise<string | null> {
  const messages = await context.client.listRunMessages(
    context.projectId,
    runId,
    { limit: 100 },
    withSignal(context),
  );
  const answers = messages.data.filter(
    (message) => message.role === "assistant",
  );
  const latest = answers.reduce<(typeof answers)[number] | undefined>(
    (current, message) =>
      current === undefined || message.createdAt > current.createdAt
        ? message
        : current,
    undefined,
  );
  return latest?.redactedContent ?? null;
}

/** Waits up to `seconds` for a run to settle and reads the agent's answer. */
async function settle(
  context: OaoToolContext,
  run: Run,
  seconds: number | undefined,
): Promise<{
  readonly run: Run;
  readonly settled: boolean;
  readonly answer?: string | null;
}> {
  let current = run;
  const waitSeconds = seconds ?? DEFAULT_WAIT_SECONDS;
  if (!SETTLED_RUN_STATES.has(current.state) && waitSeconds > 0) {
    try {
      current = await context.client.waitForRunSettled(
        context.projectId,
        run.id,
        {
          timeoutMs: waitSeconds * 1000,
          pollIntervalMs: 1000,
          ...withSignal(context),
        },
      );
    } catch (error) {
      if (!(error instanceof OaoApiError && error.code === "run_wait_timeout"))
        throw error;
      current = await context.client.getRun(
        context.projectId,
        run.id,
        withSignal(context),
      );
    }
  }
  if (!SETTLED_RUN_STATES.has(current.state))
    return { run: current, settled: false };
  return {
    run: current,
    settled: true,
    answer: await finalAnswer(context, current.id),
  };
}

function skillVersion(input: {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly license?: string | undefined;
  readonly compatibility?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly files?:
    | readonly {
        readonly path: string;
        readonly content: string;
        readonly contentType?: string | undefined;
      }[]
    | undefined;
}): PublishSkillVersionInput {
  return {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    ...(input.license === undefined ? {} : { license: input.license }),
    ...(input.compatibility === undefined
      ? {}
      : { compatibility: input.compatibility }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.files === undefined
      ? {}
      : {
          files: input.files.map((file) => ({
            path: file.path,
            contentType:
              file.contentType ??
              (file.path.endsWith(".md") ? "text/markdown" : "text/plain"),
            dataBase64: Buffer.from(file.content, "utf8").toString("base64"),
          })),
        }),
  };
}

/**
 * The OAO MCP tools. Each wraps one public API operation of the project and
 * is offered only to a caller holding all of its scopes; the API checks
 * authorization again on every call.
 *
 * Operations that take a plaintext secret, such as provider credentials,
 * MCP credentials, and API keys, are deliberately absent so that no secret
 * passes through an agent's context.
 */
export const OAO_TOOLS: readonly OaoTool[] = [
  tool("get_context", {
    input: {},
    run: (_input, context) => context.client.getContext(withSignal(context)),
  }),

  tool("list_agents", {
    input: { limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listAgents(
        context.projectId,
        page(input),
        withSignal(context),
      ),
  }),
  tool("get_agent", {
    input: { agentId: Id },
    run: async (input, context) => ({
      ...(await context.client.getAgent(
        context.projectId,
        input.agentId,
        withSignal(context),
      )),
      versions: (
        await context.client.listAgentVersions(
          context.projectId,
          input.agentId,
          { limit: 20 },
          withSignal(context),
        )
      ).data,
    }),
  }),
  tool("get_agent_version", {
    input: { agentId: Id, versionId: Id },
    run: (input, context) =>
      context.client.getAgentVersion(
        context.projectId,
        input.agentId,
        input.versionId,
        withSignal(context),
      ),
  }),
  tool("create_agent", {
    input: {
      key: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
      name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      description: v.optional(v.pipe(v.string(), v.maxLength(2000))),
      config: v.optional(AgentConfig),
      idempotencyKey: IdempotencyKey,
    },
    run: (input, context) =>
      context.client.createAgent(
        context.projectId,
        {
          ...(input.key === undefined ? {} : { key: input.key }),
          name: input.name,
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          ...(input.config === undefined
            ? {}
            : {
                initialConfig: input.config as unknown as NonNullable<
                  CreateAgentInput["initialConfig"]
                >,
              }),
        },
        write(context, "create_agent"),
      ),
  }),
  tool("publish_agent_version", {
    input: { agentId: Id, config: AgentConfig, idempotencyKey: IdempotencyKey },
    run: (input, context) =>
      context.client.publishAgentVersion(
        context.projectId,
        input.agentId,
        input.config as unknown as PublishAgentVersionInput,
        write(context, "publish_agent_version"),
      ),
  }),
  tool("delete_agent", {
    input: { agentId: Id, idempotencyKey: IdempotencyKey },
    run: (input, context) =>
      context.client.deleteAgent(
        context.projectId,
        input.agentId,
        write(context, "delete_agent"),
      ),
  }),

  tool("list_sessions", {
    input: { agentId: v.optional(Id), limit: Limit, cursor: Cursor },
    run: async (input, context) => {
      const sessions = await context.client.listSessions(
        context.projectId,
        page(input),
        withSignal(context),
      );
      return input.agentId === undefined
        ? sessions
        : {
            ...sessions,
            data: sessions.data.filter(
              (session) =>
                (session as { readonly agentId?: string }).agentId ===
                input.agentId,
            ),
          };
    },
  }),
  tool("get_session", {
    input: { sessionId: Id, includeDebug: v.optional(v.boolean()) },
    run: async (input, context) => {
      const session = (await context.client.getSession(
        context.projectId,
        input.sessionId,
        withSignal(context),
      )) as unknown as Readonly<Record<string, unknown>>;
      return input.includeDebug === true ? session : without(session, "debug");
    },
  }),
  tool("get_session_usage", {
    input: { sessionId: Id },
    run: (input, context) =>
      context.client.getSessionUsage(
        context.projectId,
        input.sessionId,
        withSignal(context),
      ),
  }),
  tool("get_project_usage", {
    input: {
      from: v.optional(v.pipe(v.string(), v.isoTimestamp())),
      to: v.optional(v.pipe(v.string(), v.isoTimestamp())),
      groupBy: v.optional(ProjectUsageGroupSchema),
    },
    run: (input, context) =>
      context.client.getProjectUsage(
        context.projectId,
        {
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.to === undefined ? {} : { to: input.to }),
          ...(input.groupBy === undefined ? {} : { groupBy: input.groupBy }),
        },
        withSignal(context),
      ),
  }),
  tool("start_session", {
    input: {
      agentId: v.optional(Id),
      agentVersionId: v.optional(
        v.pipe(
          Id,
          v.description("A specific version; defaults to the latest."),
        ),
      ),
      message: Message,
      title: v.optional(v.pipe(v.string(), v.maxLength(200))),
      waitSeconds: WaitSeconds,
      idempotencyKey: IdempotencyKey,
    },
    run: async (input, context) => {
      if (input.agentId === undefined && input.agentVersionId === undefined)
        throw new OaoToolInputError("Give agentId or agentVersionId.");
      const created = await context.client.createSession(
        context.projectId,
        {
          ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          ...(input.agentVersionId === undefined
            ? {}
            : { agentVersionId: input.agentVersionId }),
          ...(input.title === undefined ? {} : { title: input.title }),
          initialMessage: input.message,
        } as CreateSessionInput,
        write(context, "start_session"),
      );
      return {
        session: without(created, "run"),
        ...(await settle(context, created.run, input.waitSeconds)),
      };
    },
  }),
  tool("send_message", {
    input: {
      sessionId: Id,
      message: Message,
      waitSeconds: WaitSeconds,
      idempotencyKey: IdempotencyKey,
    },
    run: async (input, context) => {
      const run = await context.client.submitRun(
        context.projectId,
        input.sessionId,
        { message: input.message },
        write(context, "send_message"),
      );
      return settle(context, run, input.waitSeconds);
    },
  }),
  tool("list_runs", {
    input: { limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listRuns(
        context.projectId,
        page(input),
        withSignal(context),
      ),
  }),
  tool("get_run", {
    input: { runId: Id },
    run: (input, context) =>
      context.client.getRun(
        context.projectId,
        input.runId,
        withSignal(context),
      ),
  }),
  tool("get_run_messages", {
    input: { runId: Id, limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listRunMessages(
        context.projectId,
        input.runId,
        page(input),
        withSignal(context),
      ),
  }),
  tool("get_run_timeline", {
    input: { runId: Id, limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listRunTimeline(
        context.projectId,
        input.runId,
        page(input),
        withSignal(context),
      ),
  }),
  tool("wait_for_run", {
    input: { runId: Id, waitSeconds: WaitSeconds },
    run: async (input, context) =>
      settle(
        context,
        await context.client.getRun(
          context.projectId,
          input.runId,
          withSignal(context),
        ),
        input.waitSeconds,
      ),
  }),
  tool("cancel_run", {
    input: { runId: Id, idempotencyKey: IdempotencyKey },
    run: (input, context) =>
      context.client.cancelRun(
        context.projectId,
        input.runId,
        write(context, "cancel_run"),
      ),
  }),

  tool("list_approvals", {
    input: { runId: v.optional(Id), limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listApprovals(
        context.projectId,
        {
          ...page(input),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
        },
        withSignal(context),
      ),
  }),
  tool("decide_approval", {
    input: {
      approvalId: Id,
      decision: v.picklist(["approved", "denied"]),
      note: v.optional(v.pipe(v.string(), v.maxLength(2000))),
      idempotencyKey: IdempotencyKey,
    },
    run: (input, context) =>
      context.client.decideApproval(
        context.projectId,
        input.approvalId,
        {
          status: input.decision,
          ...(input.note === undefined ? {} : { note: input.note }),
        },
        write(context, "decide_approval"),
      ),
  }),

  tool("get_delegation", {
    input: { delegationId: Id },
    run: (input, context) =>
      context.client.getDelegation(
        context.projectId,
        input.delegationId,
        withSignal(context),
      ),
  }),
  tool("message_delegation", {
    input: {
      delegationId: Id,
      message: Message,
      waitSeconds: WaitSeconds,
      idempotencyKey: IdempotencyKey,
    },
    run: async (input, context) => {
      const queued = await context.client.messageDelegation(
        context.projectId,
        input.delegationId,
        input.message,
        write(context, "message_delegation"),
      );
      return {
        ...queued,
        ...(await settle(
          context,
          await context.client.getRun(
            context.projectId,
            queued.childRunId,
            withSignal(context),
          ),
          input.waitSeconds,
        )),
      };
    },
  }),

  tool("list_skills", {
    input: { limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listSkills(
        context.projectId,
        page(input),
        withSignal(context),
      ),
  }),
  tool("get_skill", {
    input: { skillId: Id },
    run: (input, context) =>
      context.client.getSkill(
        context.projectId,
        input.skillId,
        withSignal(context),
      ),
  }),
  tool("create_skill", {
    input: {
      key: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
      displayName: v.optional(v.pipe(v.string(), v.maxLength(200))),
      ...SkillVersion,
      idempotencyKey: IdempotencyKey,
    },
    run: (input, context) =>
      context.client.createSkill(
        context.projectId,
        {
          ...(input.key === undefined ? {} : { key: input.key }),
          ...(input.displayName === undefined
            ? {}
            : { displayName: input.displayName }),
          ...skillVersion(input),
        },
        write(context, "create_skill"),
      ),
  }),
  tool("publish_skill_version", {
    input: { skillId: Id, ...SkillVersion, idempotencyKey: IdempotencyKey },
    run: (input, context) =>
      context.client.publishSkillVersion(
        context.projectId,
        input.skillId,
        skillVersion(input),
        write(context, "publish_skill_version"),
      ),
  }),

  tool("list_model_presets", {
    input: { limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listModelPresets(
        context.projectId,
        page(input),
        withSignal(context),
      ),
  }),
  tool("create_model_preset", {
    input: {
      ...CreateModelPresetInputSchema.entries,
      idempotencyKey: IdempotencyKey,
    },
    run: (input, context) => {
      const preset = without(input, "idempotencyKey");
      return context.client.createModelPreset(
        context.projectId,
        preset as CreateModelPresetInput,
        write(context, "create_model_preset"),
      );
    },
  }),
  tool("list_model_preset_prices", {
    input: { presetId: Id, limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listModelPresetPrices(
        context.projectId,
        input.presetId,
        page(input),
        withSignal(context),
      ),
  }),
  tool("set_model_preset_price", {
    input: {
      presetId: Id,
      ...SetModelPresetPriceInputSchema.entries,
      idempotencyKey: IdempotencyKey,
    },
    run: (input, context) => {
      const price = without(without(input, "idempotencyKey"), "presetId");
      return context.client.setModelPresetPrice(
        context.projectId,
        input.presetId,
        price as SetModelPresetPriceInput,
        write(context, "set_model_preset_price"),
      );
    },
  }),

  tool("list_mcp_servers", {
    input: {},
    run: (_input, context) =>
      context.client.listMcpServers(context.projectId, withSignal(context)),
  }),
  tool("list_mcp_credentials", {
    input: {},
    run: (_input, context) =>
      context.client.listMcpCredentials(context.projectId, withSignal(context)),
  }),
  tool("list_mcp_credential_policies", {
    input: {},
    run: (_input, context) =>
      context.client.listMcpCredentialPolicies(
        context.projectId,
        withSignal(context),
      ),
  }),
  tool("list_mcp_toolsets", {
    input: {},
    run: (_input, context) =>
      context.client.listMcpToolsets(context.projectId, withSignal(context)),
  }),
  tool("create_mcp_server", {
    input: {
      ...CreateMcpServerInputSchema.entries,
      idempotencyKey: IdempotencyKey,
    },
    run: (input, context) => {
      const server = without(input, "idempotencyKey");
      return context.client.createMcpServer(
        context.projectId,
        server,
        write(context, "create_mcp_server"),
      );
    },
  }),
  tool("discover_mcp_server", {
    input: {
      serverId: Id,
      ...DiscoverMcpServerInputSchema.entries,
      idempotencyKey: IdempotencyKey,
    },
    run: (input, context) => {
      const { serverId } = input;
      const discovery = without(input, "idempotencyKey", "serverId");
      return context.client.discoverMcpServer(
        context.projectId,
        serverId,
        discovery,
        write(context, "discover_mcp_server"),
      );
    },
  }),
  tool("create_mcp_credential_policy", {
    input: {
      ...CreateMcpCredentialPolicyInputSchema.entries,
      idempotencyKey: IdempotencyKey,
    },
    run: (input, context) => {
      const policy = without(input, "idempotencyKey");
      return context.client.createMcpCredentialPolicy(
        context.projectId,
        policy,
        write(context, "create_mcp_credential_policy"),
      );
    },
  }),
  tool("create_mcp_toolset", {
    input: {
      ...CreateMcpToolsetInputSchema.entries,
      idempotencyKey: IdempotencyKey,
    },
    run: (input, context) => {
      const toolset = without(input, "idempotencyKey");
      return context.client.createMcpToolset(
        context.projectId,
        toolset,
        write(context, "create_mcp_toolset"),
      );
    },
  }),

  tool("list_audit_entries", {
    input: { limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listAuditEntries(
        context.projectId,
        page(input),
        withSignal(context),
      ),
  }),
];

/** An argument problem the tool reports back to the caller as is. */
export class OaoToolInputError extends Error {
  override readonly name = "OaoToolInputError";
}

/** The tools a caller with these scopes may use. */
export function availableOaoTools(
  scopes: ReadonlySet<string>,
  options: {
    readonly projectRestricted?: boolean;
    readonly tools?: readonly OaoTool[];
  } = {},
): readonly OaoTool[] {
  const offered = new Set(
    availableOaoMcpTools(scopes, {
      projectRestricted: options.projectRestricted === true,
    }).map((tool) => tool.name),
  );
  return (options.tools ?? OAO_TOOLS).filter((tool) => offered.has(tool.name));
}
