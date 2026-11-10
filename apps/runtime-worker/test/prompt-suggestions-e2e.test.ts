import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createPool,
  withTenantTransaction,
  type PgPool,
} from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
  ThreadId,
} from "@oao/domain";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@oao/models-openrouter";
import {
  PROMPT_SUGGESTION_INSTRUCTION,
  type PlatformToolHandler,
} from "@oao/runtime-flue";
import { startRuntimeWorker, type RuntimeWorkerHandle } from "../src/main.js";

const databaseUrl = process.env.DATABASE_URL;
const testAdminDatabaseUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? databaseUrl;

// Every id is derived within this file's own namespace: the suites share one
// database, and other files derive ids from the same short labels.
function uuid(label: string): string {
  const bytes = createHash("sha256")
    .update(`prompt-suggestions-e2e/${label}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const tenant = {
  organizationId: uuid("prompt-suggestions-e2e-org") as OrganizationId,
  projectId: uuid("prompt-suggestions-e2e-project") as ProjectId,
};
const human = uuid("prompt-suggestions-e2e-human") as PrincipalId;
const service = uuid("prompt-suggestions-e2e-service") as PrincipalId;

const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const lookupTool = {
  schemaVersion: 1,
  name: "platform.lookup",
  description: "Look up an order.",
  owner: "platform",
  approval: "never",
  inputSchema: objectSchema({ order: { type: "string" } }),
  outputSchema: objectSchema({ found: { type: "boolean" } }),
};
const guardedTool = {
  ...lookupTool,
  name: "platform.release",
  description: "Release an order.",
  approval: "always",
};

/** The line the model is told to end its final reply with. */
const line = (message: string) =>
  `<next_user_message>${message}</next_user_message>`;

interface ModelCall {
  /** Whether the request's system prompt asks for the suggestion line. */
  readonly instructed: boolean;
  readonly transcript: string;
}

/** Every request the fake model received, in order. */
const calls: ModelCall[] = [];
/** Held open by the test that queues a newer run before the reply arrives. */
let releaseSlowReply: (() => void) | undefined;
let slowReplyStarted: (() => void) | undefined;

/**
 * The fake model. What it writes depends on a marker in the conversation; it
 * ends a final reply with the suggestion line only where a test says so, as a
 * model that follows the instruction would.
 */
const respond: FauxResponseStep = async (context) => {
  const transcript = JSON.stringify(context.messages);
  calls.push({
    instructed: transcript.includes(line("the message")),
    transcript,
  });
  const toolResults = context.messages.filter(
    (message) => message.role === "toolResult",
  ).length;
  if (transcript.includes("run-fails"))
    return fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "The model refused",
    });
  if (transcript.includes("run-gated"))
    return toolResults === 0
      ? fauxAssistantMessage(
          [
            {
              type: "text" as const,
              text: `I will release ORD-1592.\n${line("Approve it")}`,
            },
            fauxToolCall("platform.release", { order: "ORD-1592" }),
          ],
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage(
          `The release was not approved.\n\n${line("Release ORD-1592 anyway")}`,
        );
  if (transcript.includes("run-delegates"))
    return toolResults === 0
      ? fauxAssistantMessage(
          [
            fauxToolCall("delegate_agent", {
              agent: "helper",
              prompt: "child-work",
            }),
          ],
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage(
          `The helper checked ORD-1592.\n\n${line("Release ORD-1592 now")}`,
        );
  // A run that ends on a tool call: the tool is the whole response, and the
  // model was told to write no message after it.
  if (transcript.includes("run-ends-on-tool"))
    return toolResults === 0
      ? fauxAssistantMessage(
          [fauxToolCall("platform.lookup", { order: "ORD-1592" })],
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage(
          transcript.includes("carries-line") ? line("Pick Monday") : "",
        );
  if (transcript.includes("run-looks-up") && toolResults === 0)
    return fauxAssistantMessage(
      [
        // A line written before the final reply is never the suggestion.
        {
          type: "text" as const,
          text: `Checking ORD-1592.\n${line("Too early")}`,
        },
        fauxToolCall("platform.lookup", { order: "ORD-1592" }),
      ],
      { stopReason: "toolUse" },
    );
  // Only the first reply is held; the run queued behind it answers at once.
  if (
    transcript.includes("reply-slow") &&
    !transcript.includes("queued-behind")
  ) {
    slowReplyStarted?.();
    await new Promise<void>((resolve) => {
      releaseSlowReply = resolve;
    });
  }
  if (transcript.includes("reply-without-line"))
    return fauxAssistantMessage("You're welcome!");
  if (transcript.includes("reply-declines"))
    return fauxAssistantMessage(`You're welcome!\n${line("NONE")}`);
  if (transcript.includes("reply-line-before-choices"))
    return fauxAssistantMessage(
      `Apply the rule?\n${line("Accept")}\n[[choices: Accept | Deny]]`,
    );
  if (transcript.includes("reply-choices-before-line"))
    return fauxAssistantMessage(
      `Apply the rule?\n\n[[choices: Accept | Deny]]\n${line("Accept the rule")}`,
    );
  if (transcript.includes("reply-only-line"))
    return fauxAssistantMessage(line("Nothing came before"));
  // Wrapping quotes are not part of what the user would type.
  return fauxAssistantMessage(
    `ORD-1592 is ready to release.\n\n${line('"Release ORD-1592 to the carrier now"')}`,
  );
};

const disabledSandbox = {
  enabled: false,
  provider: "daytona-primary",
  network: "none",
  capabilities: [],
};

async function seedBase(pool: PgPool): Promise<void> {
  await pool.query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'prompt-suggestions-e2e','Prompt suggestions e2e')",
    [tenant.organizationId],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'prompt-suggestions-e2e','Prompt suggestions e2e')",
    [tenant.organizationId, tenant.projectId],
  );
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'human','prompt-suggestions-e2e-human',ARRAY['*']),
            ($1,$2,$4,'service','prompt-suggestions-e2e-service',ARRAY['*'])`,
    [tenant.organizationId, tenant.projectId, human, service],
  );
}

async function seedAgent(
  pool: PgPool,
  label: string,
  options: {
    readonly suggest: boolean;
    readonly publishText?: boolean;
    readonly delegateVersionId?: string;
  },
): Promise<string> {
  const agentId = uuid(`${label}:agent`);
  const versionId = uuid(`${label}:version`);
  const config = {
    systemPrompt: "Help with orders.",
    modelPreset: "local-default",
    tools: [lookupTool, guardedTool],
    delegates: options.delegateVersionId
      ? [
          {
            key: "helper",
            description: "Checks orders.",
            agentVersionId: options.delegateVersionId,
            maxParallel: 1,
          },
        ]
      : [],
    ...(options.suggest ? { promptSuggestions: true } : {}),
    ...(options.publishText ? { publishTextBeforeToolCalls: true } : {}),
    sandbox: disabledSandbox,
    limits: { maxTurns: 16, timeoutMs: 30_000 },
  };
  await pool.query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,$4,$4)`,
    [tenant.organizationId, tenant.projectId, agentId, label],
  );
  await pool.query(
    `INSERT INTO oao.agent_versions (
       organization_id,project_id,id,agent_definition_id,version,config,content_hash,
       created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
    [
      tenant.organizationId,
      tenant.projectId,
      versionId,
      agentId,
      config,
      createHash("sha256").update(JSON.stringify(config)).digest(),
      human,
    ],
  );
  return versionId;
}

interface SeededSession {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly versionId: string;
}

async function seedSession(
  pool: PgPool,
  label: string,
  versionId: string,
): Promise<SeededSession> {
  const threadId = uuid(`${label}:thread`) as ThreadId;
  const sessionId = uuid(`${label}:session`);
  await pool.query(
    "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,$4)",
    [tenant.organizationId, tenant.projectId, threadId, label],
  );
  await pool.query(
    `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenant.organizationId, tenant.projectId, sessionId, threadId, versionId],
  );
  return { threadId, sessionId, versionId };
}

async function seedRun(
  pool: PgPool,
  session: SeededSession,
  label: string,
  message: string,
): Promise<RunId> {
  const runId = uuid(`${label}:run`) as RunId;
  await pool.query(
    `INSERT INTO oao.runs (
       organization_id,project_id,id,thread_id,session_id,agent_version_id,
       created_by_principal_id,idempotency_key,input_public
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tenant.organizationId,
      tenant.projectId,
      runId,
      session.threadId,
      session.sessionId,
      session.versionId,
      human,
      `prompt-suggestions-e2e:${label}`,
      { message },
    ],
  );
  await pool.query(
    `INSERT INTO oao.messages (
       organization_id,project_id,id,thread_id,run_id,role,redacted_content
     ) VALUES ($1,$2,$3,$4,$5,'user',$6)`,
    [
      tenant.organizationId,
      tenant.projectId,
      uuid(`${label}:message`),
      session.threadId,
      runId,
      message,
    ],
  );
  return runId;
}

async function waitFor<T>(
  description: string,
  read: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function admit(worker: RuntimeWorkerHandle, runId: RunId): Promise<void> {
  await worker.orchestrator.handleWake({
    ...tenant,
    id: uuid(`prompt-suggestions-e2e-wake:${runId}`),
    runId,
    dispatchKey: `admit:${runId}`,
    kind: "admit",
    payload: { reason: "integration_test" },
    attempts: 1,
    fence: 1n,
  });
}

async function settle(
  worker: RuntimeWorkerHandle,
  pool: PgPool,
  runId: RunId,
): Promise<string> {
  await admit(worker, runId);
  return waitFor(`run ${runId} to settle`, async () => {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM oao.runs WHERE id=$1",
      [runId],
    );
    const state = result.rows[0]?.state ?? "missing";
    return ["completed", "failed", "cancelled", "timed_out"].includes(state)
      ? state
      : undefined;
  });
}

interface RunFacts {
  readonly state: string;
  readonly suggestion: string | null;
  readonly current: string | null;
  readonly modelCalls: number;
  readonly reservedTurns: number;
  /** The run's assistant messages, as stored. */
  readonly messages: readonly string[];
  /** The run's reply, suggestion and settlement events, in project order. */
  readonly events: readonly string[];
}

async function runFacts(pool: PgPool, runId: string): Promise<RunFacts> {
  const result = await pool.query<{
    state: string;
    suggestion: string | null;
    current: string | null;
    model_calls: number;
    reserved_turns: number;
    messages: string[] | null;
    events: string[] | null;
  }>(
    `SELECT run.state::text,run.suggestion,oao.current_run_suggestion(run) AS current,
            (SELECT count(*)::int FROM oao.model_invocations call WHERE call.run_id=run.id) AS model_calls,
            (SELECT count(*)::int FROM oao.run_model_turns turn WHERE turn.run_id=run.id) AS reserved_turns,
            (SELECT array_agg(message.redacted_content ORDER BY message.created_at,message.id)
               FROM oao.messages message
              WHERE message.run_id=run.id AND message.role='assistant') AS messages,
            (SELECT array_agg(
                      CASE event.event_kind
                        WHEN 'run.state_changed' THEN 'state:' || (event.public_payload->>'state')
                        ELSE event.event_kind END
                      ORDER BY event.project_position)
               FROM oao.product_events event
              WHERE event.aggregate_id=run.id
                AND (event.event_kind IN ('message.created','run.suggestion_created')
                  OR (event.event_kind='run.state_changed'
                    AND event.public_payload->>'state' IN ('completed','failed')))
                AND event.public_payload->>'role' IS DISTINCT FROM 'user') AS events
       FROM oao.runs run WHERE run.id=$1`,
    [runId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    state: row.state,
    suggestion: row.suggestion,
    current: row.current,
    modelCalls: row.model_calls,
    reservedTurns: row.reserved_turns,
    messages: row.messages ?? [],
    events: row.events ?? [],
  };
}

/**
 * Runs to settlement and reads the run at once: whatever the run holds the
 * first time it reads as settled is what a reader sees with the reply.
 */
async function settled(
  worker: RuntimeWorkerHandle,
  pool: PgPool,
  runId: RunId,
): Promise<RunFacts> {
  await settle(worker, pool, runId);
  return runFacts(pool, runId);
}

function callsFor(marker: string): ModelCall[] {
  return calls.filter((call) => call.transcript.includes(marker));
}

const SUGGESTED = "Release ORD-1592 to the carrier now";

test(
  "prompt suggestions arrive with the reply of a completed run, off by default",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 240_000 },
  async (t) => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const pool = createPool(testAdminDatabaseUrl);
    const platformTools = new Map<string, PlatformToolHandler>([
      ["platform.lookup", async () => ({ found: true })],
      ["platform.release", async () => ({ found: true })],
    ]);
    let worker: RuntimeWorkerHandle | undefined;
    try {
      worker = await startRuntimeWorker({
        databaseUrl,
        listen: false,
        env: { ...process.env, OAO_RUNTIME_SERVICE_PRINCIPAL_ID: service },
        fakeResponses: Array.from({ length: 128 }, () => respond),
        platformTools,
      });
      const running = worker;
      await seedBase(pool);
      const silent = await seedAgent(pool, "silent", { suggest: false });
      const suggesting = await seedAgent(pool, "suggesting", { suggest: true });
      const narrating = await seedAgent(pool, "narrating", {
        suggest: true,
        publishText: true,
      });
      const helper = await seedAgent(pool, "helper", { suggest: true });
      const coordinator = await seedAgent(pool, "coordinator", {
        suggest: true,
        delegateVersionId: helper,
      });

      await t.test(
        "an agent without the setting is not instructed and keeps its reply as written",
        async () => {
          const session = await seedSession(pool, "off", silent);
          const run = await seedRun(pool, session, "off", "off-by-default");
          const facts = await settled(running, pool, run);
          assert.equal(facts.state, "completed");
          assert.deepEqual(
            callsFor("off-by-default").map((call) => call.instructed),
            [false],
          );
          // The line is the model's own text here: nothing reads or cuts it.
          assert.deepEqual(facts.messages, [
            `ORD-1592 is ready to release.\n\n${line(`"${SUGGESTED}"`)}`,
          ]);
          assert.equal(facts.suggestion, null);
          assert.deepEqual(facts.events, [
            "message.created",
            "state:completed",
          ]);
        },
      );

      await t.test(
        "a completed run holds its suggestion the moment it reads as completed",
        async () => {
          const session = await seedSession(pool, "on", suggesting);
          const first = await seedRun(
            pool,
            session,
            "on-1",
            "run-looks-up first-question",
          );
          const facts = await settled(running, pool, first);
          assert.equal(facts.state, "completed");
          assert.equal(facts.suggestion, SUGGESTED);
          assert.equal(facts.current, SUGGESTED);
          // The reply, then its suggestion, then the settlement: one
          // transaction, so no reader sees the reply without the suggestion.
          assert.deepEqual(facts.events, [
            "message.created",
            "run.suggestion_created",
            "state:completed",
          ]);
          // No line reaches the transcript, also not the one written early.
          assert.deepEqual(facts.messages, [
            "Checking ORD-1592.\n\nORD-1592 is ready to release.",
          ]);
          // The model was asked for the line, and there is no extra call.
          const forRun = callsFor("first-question");
          assert.deepEqual(
            forRun.map((call) => call.instructed),
            [true, true],
          );
          assert.ok(
            forRun[0]?.transcript.includes(
              JSON.stringify(PROMPT_SUGGESTION_INSTRUCTION).slice(1, -1),
            ),
          );
          assert.deepEqual([facts.modelCalls, facts.reservedTurns], [2, 2]);

          // The event names the run and carries no text.
          const event = await pool.query<{
            aggregate_type: string;
            public_payload: Record<string, unknown>;
          }>(
            `SELECT aggregate_type,public_payload FROM oao.product_events
              WHERE aggregate_id=$1 AND event_kind='run.suggestion_created'`,
            [first],
          );
          assert.equal(event.rows[0]?.aggregate_type, "run");
          assert.deepEqual(event.rows[0]?.public_payload, {
            sessionId: session.sessionId,
          });

          // The next message voids the first run's suggestion.
          const second = await seedRun(
            pool,
            session,
            "on-2",
            "second-question",
          );
          const next = await settled(running, pool, second);
          assert.equal(next.current, SUGGESTED);
          const voided = await runFacts(pool, first);
          assert.equal(voided.suggestion, SUGGESTED);
          assert.equal(voided.current, null);
        },
      );

      await t.test(
        "a reply without a usable last line has no suggestion and shows no line",
        async () => {
          const cases: readonly (readonly [string, string])[] = [
            ["reply-without-line", "You're welcome!"],
            ["reply-declines", "You're welcome!"],
            // A line the model did not put last is cut and not used, and the
            // marker the reply must end with is its last line again.
            [
              "reply-line-before-choices",
              "Apply the rule?\n[[choices: Accept | Deny]]",
            ],
          ];
          for (const [marker, message] of cases) {
            const session = await seedSession(pool, marker, suggesting);
            const run = await seedRun(pool, session, marker, marker);
            const facts = await settled(running, pool, run);
            assert.equal(facts.state, "completed", marker);
            assert.deepEqual(facts.messages, [message], marker);
            assert.equal(facts.suggestion, null, marker);
            assert.deepEqual(
              facts.events,
              ["message.created", "state:completed"],
              marker,
            );
          }
          // A run that ends on a tool call without a message stores no
          // assistant message, also when the model wrote the line anyway.
          for (const marker of [
            "run-ends-on-tool",
            "run-ends-on-tool carries-line",
          ]) {
            const session = await seedSession(pool, marker, suggesting);
            const run = await seedRun(pool, session, marker, marker);
            const facts = await settled(running, pool, run);
            assert.deepEqual(
              [facts.state, facts.messages, facts.suggestion, facts.events],
              ["completed", [], null, ["state:completed"]],
              marker,
            );
          }
          // A reply that is nothing but the line is no reply to follow.
          const session = await seedSession(pool, "only-line", suggesting);
          const run = await seedRun(
            pool,
            session,
            "only-line",
            "reply-only-line",
          );
          const facts = await settled(running, pool, run);
          assert.deepEqual(
            [facts.state, facts.messages, facts.suggestion, facts.events],
            ["completed", [], null, ["state:completed"]],
          );
        },
      );

      await t.test(
        "a line after a closing marker is cut, leaving the marker last",
        async () => {
          const session = await seedSession(pool, "choices", suggesting);
          const run = await seedRun(
            pool,
            session,
            "choices",
            "reply-choices-before-line",
          );
          const facts = await settled(running, pool, run);
          assert.deepEqual(facts.messages, [
            "Apply the rule?\n\n[[choices: Accept | Deny]]",
          ]);
          assert.equal(facts.suggestion, "Accept the rule");
        },
      );

      await t.test("a failed run gets no suggestion", async () => {
        const session = await seedSession(pool, "failed", suggesting);
        const run = await seedRun(pool, session, "failed", "run-fails");
        const facts = await settled(running, pool, run);
        assert.equal(facts.state, "failed");
        assert.equal(facts.suggestion, null);
        assert.ok(!facts.events.includes("run.suggestion_created"));
      });

      await t.test(
        "a run paused for approval shows no line and gets its suggestion when it completes",
        async () => {
          const session = await seedSession(pool, "gated", suggesting);
          const run = await seedRun(pool, session, "gated", "run-gated");
          await admit(running, run);
          const approvalId = await waitFor("the approval gate", async () => {
            const result = await pool.query<{ id: string }>(
              "SELECT id FROM oao.approvals WHERE run_id=$1 AND status='pending'",
              [run],
            );
            return result.rows[0]?.id;
          });
          // The explanation committed with the gate has no line.
          const paused = await runFacts(pool, run);
          assert.deepEqual(paused.messages, ["I will release ORD-1592."]);
          assert.equal(paused.suggestion, null);
          await withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              "SELECT oao.resolve_approval($1,$2,$3,'denied',$4,'not today')",
              [tenant.organizationId, tenant.projectId, approvalId, human],
            ),
          );
          const facts = await waitFor("the gated run to complete", async () => {
            const current = await runFacts(pool, run);
            return current.state === "completed" ? current : undefined;
          });
          assert.deepEqual(facts.messages, [
            "I will release ORD-1592.",
            "The release was not approved.",
          ]);
          assert.equal(facts.suggestion, "Release ORD-1592 anyway");
        },
      );

      await t.test(
        "text published before tool calls never shows or supplies the line",
        async () => {
          const session = await seedSession(pool, "narrated", narrating);
          const run = await seedRun(
            pool,
            session,
            "narrated",
            "run-looks-up narrated-question",
          );
          const facts = await settled(running, pool, run);
          assert.deepEqual(facts.messages, [
            "Checking ORD-1592.",
            "ORD-1592 is ready to release.",
          ]);
          assert.equal(facts.suggestion, SUGGESTED);
          assert.deepEqual(facts.events, [
            "message.created",
            "message.created",
            "run.suggestion_created",
            "state:completed",
          ]);
        },
      );

      await t.test(
        "a delegated child session is not instructed and gets no suggestion; its parent does",
        async () => {
          const session = await seedSession(pool, "delegating", coordinator);
          const run = await seedRun(
            pool,
            session,
            "delegating",
            "run-delegates",
          );
          const facts = await settled(running, pool, run);
          assert.equal(facts.suggestion, "Release ORD-1592 now");
          assert.deepEqual(facts.messages, ["The helper checked ORD-1592."]);
          const child = await pool.query<{ child_run_id: string }>(
            `SELECT child_run_id FROM oao.delegation_runs
              WHERE organization_id=$1 AND project_id=$2 AND requested_by_run_id=$3`,
            [tenant.organizationId, tenant.projectId, run],
          );
          const childRunId = child.rows[0]?.child_run_id;
          assert.ok(childRunId);
          const childFacts = await runFacts(pool, childRunId);
          assert.equal(childFacts.state, "completed");
          assert.equal(childFacts.suggestion, null);
          assert.ok(!childFacts.events.includes("run.suggestion_created"));
          // The child's version has the setting on too, yet nobody types there.
          const childCalls = calls.filter(
            (call) =>
              call.transcript.includes("child-work") &&
              !call.transcript.includes("run-delegates"),
          );
          assert.deepEqual(
            childCalls.map((call) => call.instructed),
            [false],
          );
        },
      );

      await t.test(
        "a reply that settles behind a newer run stores no suggestion",
        async () => {
          const session = await seedSession(pool, "slow", suggesting);
          const run = await seedRun(pool, session, "slow-1", "reply-slow");
          const started = new Promise<void>((resolve) => {
            slowReplyStarted = resolve;
          });
          await admit(running, run);
          await started;
          // Another message is queued while the model is still replying.
          const queued = await seedRun(
            pool,
            session,
            "slow-2",
            "queued-behind",
          );
          assert.ok(releaseSlowReply);
          releaseSlowReply();
          const facts = await waitFor("the slow run to complete", async () => {
            const current = await runFacts(pool, run);
            return current.state === "completed" ? current : undefined;
          });
          assert.deepEqual(facts.messages, ["ORD-1592 is ready to release."]);
          assert.equal(facts.suggestion, null);
          assert.deepEqual(facts.events, [
            "message.created",
            "state:completed",
          ]);
          // The queued run is admitted behind it and holds the suggestion.
          const latest = await waitFor(
            "the queued run to complete",
            async () => {
              const current = await runFacts(pool, queued);
              return current.state === "completed" ? current : undefined;
            },
          );
          assert.equal(latest.current, SUGGESTED);
        },
      );
    } finally {
      releaseSlowReply?.();
      await worker?.stop();
      await pool.end();
    }
  },
);
