import {
  CreateMcpCredentialPolicyInputSchema,
  CreateMcpServerInputSchema,
  CreateMcpToolsetInputSchema,
  CreateModelPresetInputSchema,
  DiscoverMcpServerInputSchema,
  ManagedAgentPublicationConfigSchema,
  type Run,
} from "@oao/contracts";
import {
  OaoApiError,
  type CreateAgentInput,
  type CreateModelPresetInput,
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

export interface OaoTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Every scope a caller must hold for the tool to be offered. */
  readonly scopes: readonly string[];
  /** Read-only tools change nothing in OAO. */
  readonly readOnly: boolean;
  /** Changes a resource the whole organization shares. */
  readonly organizationShared?: boolean;
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
    "The immutable agent version: system prompt, model preset key, tools, Skills, MCP bindings, delegates, sandbox, and limits.",
  ),
);

function tool<Entries extends v.ObjectEntries>(definition: {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly scopes: readonly string[];
  readonly readOnly: boolean;
  readonly organizationShared?: boolean;
  readonly input: Entries;
  readonly run: (
    input: v.InferOutput<v.StrictObjectSchema<Entries, undefined>>,
    context: OaoToolContext,
  ) => Promise<unknown>;
}): OaoTool {
  return {
    ...definition,
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
  tool({
    name: "get_context",
    title: "Get context",
    description:
      "Shows who is calling, the project these tools act in, and the scopes the caller holds.",
    scopes: [],
    readOnly: true,
    input: {},
    run: (_input, context) => context.client.getContext(withSignal(context)),
  }),

  tool({
    name: "list_agents",
    title: "List agents",
    description: "Lists the project's agents, newest first.",
    scopes: ["agent:read"],
    readOnly: true,
    input: { limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listAgents(
        context.projectId,
        page(input),
        withSignal(context),
      ),
  }),
  tool({
    name: "get_agent",
    title: "Get agent",
    description: "Reads an agent and its most recent versions.",
    scopes: ["agent:read"],
    readOnly: true,
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
  tool({
    name: "get_agent_version",
    title: "Get agent version",
    description:
      "Reads one immutable agent version with its full configuration.",
    scopes: ["agent:read"],
    readOnly: true,
    input: { agentId: Id, versionId: Id },
    run: (input, context) =>
      context.client.getAgentVersion(
        context.projectId,
        input.agentId,
        input.versionId,
        withSignal(context),
      ),
  }),
  tool({
    name: "create_agent",
    title: "Create agent",
    description:
      "Creates an agent, optionally publishing its first version from config. Binding Skills or MCP toolsets also needs skill:bind or mcp:bind.",
    scopes: ["agent:write"],
    readOnly: false,
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
  tool({
    name: "publish_agent_version",
    title: "Publish agent version",
    description:
      "Publishes a new immutable version of an agent. New sessions use it; existing sessions keep their version.",
    scopes: ["agent:write"],
    readOnly: false,
    input: { agentId: Id, config: AgentConfig, idempotencyKey: IdempotencyKey },
    run: (input, context) =>
      context.client.publishAgentVersion(
        context.projectId,
        input.agentId,
        input.config as unknown as PublishAgentVersionInput,
        write(context, "publish_agent_version"),
      ),
  }),
  tool({
    name: "delete_agent",
    title: "Delete agent",
    description:
      "Archives an agent so no new session can start on it. History stays.",
    scopes: ["agent:write"],
    readOnly: false,
    input: { agentId: Id, idempotencyKey: IdempotencyKey },
    run: (input, context) =>
      context.client.deleteAgent(
        context.projectId,
        input.agentId,
        write(context, "delete_agent"),
      ),
  }),

  tool({
    name: "list_sessions",
    title: "List sessions",
    description:
      "Lists sessions newest first, with each session's agent, title, and latest run state. agentId keeps only that agent's sessions from the page.",
    scopes: ["session:read"],
    readOnly: true,
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
  tool({
    name: "get_session",
    title: "Get session",
    description:
      "Reads a session: its agent, runs, full transcript, timeline, delegations, and pending work. includeDebug adds model invocations, tool calls, and sandbox detail.",
    scopes: ["session:read"],
    readOnly: true,
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
  tool({
    name: "start_session",
    title: "Start session",
    description:
      "Starts a new session on an agent with a first message and, by default, waits for the agent's answer.",
    scopes: ["session:write", "run:create"],
    readOnly: false,
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
  tool({
    name: "send_message",
    title: "Send message",
    description:
      "Sends a message to an existing session as a new run, for example a question about an earlier run. The agent answers with the whole session in context. The session's latest run must have settled. By default waits for the answer.",
    scopes: ["run:create"],
    readOnly: false,
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
  tool({
    name: "list_runs",
    title: "List runs",
    description: "Lists the project's runs, newest first.",
    scopes: ["run:read"],
    readOnly: true,
    input: { limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listRuns(
        context.projectId,
        page(input),
        withSignal(context),
      ),
  }),
  tool({
    name: "get_run",
    title: "Get run",
    description: "Reads a run's state.",
    scopes: ["run:read"],
    readOnly: true,
    input: { runId: Id },
    run: (input, context) =>
      context.client.getRun(
        context.projectId,
        input.runId,
        withSignal(context),
      ),
  }),
  tool({
    name: "get_run_messages",
    title: "Get run messages",
    description:
      "Reads the messages of a run: the input, the agent's answers, and tool messages.",
    scopes: ["run:read"],
    readOnly: true,
    input: { runId: Id, limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listRunMessages(
        context.projectId,
        input.runId,
        page(input),
        withSignal(context),
      ),
  }),
  tool({
    name: "get_run_timeline",
    title: "Get run timeline",
    description:
      "Reads what happened during a run: model turns, tool calls, approvals, and errors.",
    scopes: ["run:read"],
    readOnly: true,
    input: { runId: Id, limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listRunTimeline(
        context.projectId,
        input.runId,
        page(input),
        withSignal(context),
      ),
  }),
  tool({
    name: "wait_for_run",
    title: "Wait for run",
    description:
      "Waits for a run to settle and returns its state and the agent's answer.",
    scopes: ["run:read"],
    readOnly: true,
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
  tool({
    name: "cancel_run",
    title: "Cancel run",
    description: "Requests cancellation of an unsettled run.",
    scopes: ["run:cancel"],
    readOnly: false,
    input: { runId: Id, idempotencyKey: IdempotencyKey },
    run: (input, context) =>
      context.client.cancelRun(
        context.projectId,
        input.runId,
        write(context, "cancel_run"),
      ),
  }),

  tool({
    name: "list_approvals",
    title: "List approvals",
    description:
      "Lists tool approvals, newest first, optionally only those of one run.",
    scopes: ["run:read"],
    readOnly: true,
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
  tool({
    name: "decide_approval",
    title: "Decide approval",
    description: "Approves or denies a pending tool approval.",
    scopes: ["approval:resolve"],
    readOnly: false,
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

  tool({
    name: "get_delegation",
    title: "Get delegation",
    description:
      "Reads a delegation between a coordinator and a child agent, with its child runs.",
    scopes: ["delegation:read"],
    readOnly: true,
    input: { delegationId: Id },
    run: (input, context) =>
      context.client.getDelegation(
        context.projectId,
        input.delegationId,
        withSignal(context),
      ),
  }),
  tool({
    name: "message_delegation",
    title: "Message delegation",
    description:
      "Sends a follow-up to a delegated child agent's session and, by default, waits for its answer.",
    scopes: ["delegation:message", "run:create"],
    readOnly: false,
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

  tool({
    name: "list_skills",
    title: "List Skills",
    description: "Lists the project's Skills.",
    scopes: ["skill:read"],
    readOnly: true,
    input: { limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listSkills(
        context.projectId,
        page(input),
        withSignal(context),
      ),
  }),
  tool({
    name: "get_skill",
    title: "Get Skill",
    description: "Reads a Skill and its versions.",
    scopes: ["skill:read"],
    readOnly: true,
    input: { skillId: Id },
    run: (input, context) =>
      context.client.getSkill(
        context.projectId,
        input.skillId,
        withSignal(context),
      ),
  }),
  tool({
    name: "create_skill",
    title: "Create Skill",
    description:
      "Creates a Skill and publishes its first version from SKILL.md fields and text files.",
    scopes: ["skill:write"],
    readOnly: false,
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
  tool({
    name: "publish_skill_version",
    title: "Publish Skill version",
    description:
      "Publishes a new immutable version of a Skill. Agents keep the version they pin until republished.",
    scopes: ["skill:write"],
    readOnly: false,
    input: { skillId: Id, ...SkillVersion, idempotencyKey: IdempotencyKey },
    run: (input, context) =>
      context.client.publishSkillVersion(
        context.projectId,
        input.skillId,
        skillVersion(input),
        write(context, "publish_skill_version"),
      ),
  }),

  tool({
    name: "list_model_presets",
    title: "List model presets",
    description: "Lists the model presets an agent version may name.",
    scopes: ["agent:read"],
    readOnly: true,
    input: { limit: Limit, cursor: Cursor },
    run: (input, context) =>
      context.client.listModelPresets(
        context.projectId,
        page(input),
        withSignal(context),
      ),
  }),
  tool({
    name: "create_model_preset",
    title: "Create model preset",
    description:
      "Creates a project model preset on an existing model provider connection.",
    scopes: ["project:admin"],
    readOnly: false,
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

  tool({
    name: "list_mcp_servers",
    title: "List MCP servers",
    description:
      "Lists the organization's remote MCP servers and their discovered tools.",
    scopes: ["mcp:read"],
    readOnly: true,
    input: {},
    run: (_input, context) =>
      context.client.listMcpServers(context.projectId, withSignal(context)),
  }),
  tool({
    name: "list_mcp_credentials",
    title: "List MCP credentials",
    description: "Lists MCP credential metadata. Secrets are never returned.",
    scopes: ["credential:read_metadata"],
    readOnly: true,
    input: {},
    run: (_input, context) =>
      context.client.listMcpCredentials(context.projectId, withSignal(context)),
  }),
  tool({
    name: "list_mcp_credential_policies",
    title: "List MCP credential policies",
    description: "Lists the policies that let an MCP server use a credential.",
    scopes: ["mcp:read"],
    readOnly: true,
    input: {},
    run: (_input, context) =>
      context.client.listMcpCredentialPolicies(
        context.projectId,
        withSignal(context),
      ),
  }),
  tool({
    name: "list_mcp_toolsets",
    title: "List MCP toolsets",
    description:
      "Lists the project's MCP toolsets, the tool selections agents bind.",
    scopes: ["mcp:read"],
    readOnly: true,
    input: {},
    run: (_input, context) =>
      context.client.listMcpToolsets(context.projectId, withSignal(context)),
  }),
  tool({
    name: "create_mcp_server",
    title: "Create MCP server",
    description:
      "Adds a remote MCP server to the organization. Credentials are added in the console or API, never through this tool.",
    scopes: ["mcp:write"],
    readOnly: false,
    organizationShared: true,
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
  tool({
    name: "discover_mcp_server",
    title: "Discover MCP server tools",
    description:
      "Connects to an MCP server through a credential policy and records the tools it offers.",
    scopes: ["mcp:discover"],
    readOnly: false,
    organizationShared: true,
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
  tool({
    name: "create_mcp_credential_policy",
    title: "Create MCP credential policy",
    description:
      "Lets an MCP server use an existing credential, within the credential's destination.",
    scopes: ["mcp:write"],
    readOnly: false,
    organizationShared: true,
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
  tool({
    name: "create_mcp_toolset",
    title: "Create MCP toolset",
    description:
      "Selects discovered tools of an MCP server, with their approvals, for agents of this project to bind.",
    scopes: ["mcp:write"],
    readOnly: false,
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

  tool({
    name: "list_audit_entries",
    title: "List audit entries",
    description: "Lists the project's audit trail, newest first.",
    scopes: ["audit:read"],
    readOnly: true,
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
  return (options.tools ?? OAO_TOOLS).filter(
    (tool) =>
      (scopes.has("*") || tool.scopes.every((scope) => scopes.has(scope))) &&
      !(options.projectRestricted === true && tool.organizationShared === true),
  );
}
