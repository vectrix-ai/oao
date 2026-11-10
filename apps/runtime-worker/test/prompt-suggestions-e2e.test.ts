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
  PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS,
  type PlatformToolHandler,
} from "@oao/runtime-flue";
import { startRuntimeWorker, type RuntimeWorkerHandle } from "../src/main.js";

const databaseUrl = process.env.DATABASE_URL;
const testAdminDatabaseUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? databaseUrl;

function uuid(label: string): string {
  const bytes = createHash("sha256").update(label).digest().subarray(0, 16);
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

interface ModelCall {
  readonly suggestion: boolean;
  readonly messages: readonly unknown[];
  readonly maxTokens: number | undefined;
  readonly sessionId: string | undefined;
}

/** Every request the fake model received, in order. */
const calls: ModelCall[] = [];
/** Held open by the test that starts a newer run while a suggestion is in flight. */
let releaseSlowSuggestion: (() => void) | undefined;
let slowSuggestionStarted: (() => void) | undefined;

/** Lets the held suggestion call answer. */
function releaseSlow(): void {
  assert.ok(releaseSlowSuggestion);
  releaseSlowSuggestion();
  releaseSlowSuggestion = undefined;
}

function lastUserText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      readonly role?: string;
      readonly content?: unknown;
    };
    if (message.role !== "user") continue;
    return typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
  }
  return "";
}

/**
 * The fake model. A request that ends with the suggestion instruction is the
 * extra call; its answer depends on a marker in the conversation. Every other
 * request is a turn of the run.
 */
const respond: FauxResponseStep = async (context, options) => {
  const transcript = JSON.stringify(context.messages);
  const suggestion =
    lastUserText(context.messages) === PROMPT_SUGGESTION_INSTRUCTION;
  calls.push({
    suggestion,
    messages: structuredClone(context.messages),
    maxTokens: options?.maxTokens,
    sessionId: options?.sessionId,
  });
  const toolResults = context.messages.filter(
    (message) => message.role === "toolResult",
  ).length;
  if (suggestion) {
    if (transcript.includes("suggest-empty")) return fauxAssistantMessage("");
    if (transcript.includes("suggest-none"))
      return fauxAssistantMessage("NONE");
    if (transcript.includes("suggest-tool"))
      return fauxAssistantMessage(
        [fauxToolCall("platform.lookup", { order: "ORD-1" })],
        { stopReason: "toolUse" },
      );
    if (transcript.includes("suggest-broken"))
      throw new Error("The provider is unavailable");
    if (transcript.includes("suggest-slow")) {
      slowSuggestionStarted?.();
      await new Promise<void>((resolve) => {
        releaseSlowSuggestion = resolve;
      });
      return fauxAssistantMessage("Too late to matter");
    }
    return fauxAssistantMessage('"Release ORD-1592 to the carrier now"');
  }
  if (transcript.includes("run-fails"))
    return fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "The model refused",
    });
  if (transcript.includes("run-gated"))
    return toolResults === 0
      ? fauxAssistantMessage(
          [fauxToolCall("platform.release", { order: "ORD-1592" })],
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage("The release was not approved.");
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
      : fauxAssistantMessage("The helper checked ORD-1592.");
  if (transcript.includes("run-looks-up") && toolResults === 0)
    return fauxAssistantMessage(
      [fauxToolCall("platform.lookup", { order: "ORD-1592" })],
      { stopReason: "toolUse" },
    );
  return fauxAssistantMessage("ORD-1592 is ready to release.");
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
  readonly suggestion: string | null;
  readonly current: string | null;
  readonly suggestionCalls: number;
  readonly turns: number;
  readonly suggested: boolean | null;
  readonly events: number;
  /** `session.summary_changed` events that name the run. */
  readonly summaries: number;
  readonly reservedTurns: number;
}

async function runFacts(pool: PgPool, runId: string): Promise<RunFacts> {
  const result = await pool.query<{
    suggestion: string | null;
    current: string | null;
    suggestion_calls: number;
    turns: number;
    suggested: boolean | null;
    events: number;
    summaries: number;
    reserved_turns: number;
  }>(
    `SELECT run.suggestion,oao.current_run_suggestion(run) AS current,
            (SELECT count(*)::int FROM oao.model_invocations call
              WHERE call.run_id=run.id AND call.safe_request->>'purpose'='suggestion') AS suggestion_calls,
            (SELECT count(*)::int FROM oao.model_invocations call
              WHERE call.run_id=run.id AND call.safe_request->>'purpose'<>'suggestion') AS turns,
            (SELECT (call.safe_response->>'suggested')::boolean FROM oao.model_invocations call
              WHERE call.run_id=run.id AND call.safe_request->>'purpose'='suggestion') AS suggested,
            (SELECT count(*)::int FROM oao.product_events event
              WHERE event.aggregate_id=run.id AND event.event_kind='run.suggestion_created') AS events,
            (SELECT count(*)::int FROM oao.product_events event
              WHERE event.aggregate_id=run.session_id AND event.event_kind='session.summary_changed'
                AND event.public_payload->>'runId'=run.id::text) AS summaries,
            (SELECT count(*)::int FROM oao.run_model_turns turn WHERE turn.run_id=run.id) AS reserved_turns
       FROM oao.runs run WHERE run.id=$1`,
    [runId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    suggestion: row.suggestion,
    current: row.current,
    suggestionCalls: row.suggestion_calls,
    turns: row.turns,
    suggested: row.suggested,
    events: row.events,
    summaries: row.summaries,
    reservedTurns: row.reserved_turns,
  };
}

/** Waits until the extra call of a run has been recorded. */
function suggestionRecorded(pool: PgPool, runId: string): Promise<RunFacts> {
  return waitFor(`the suggestion call of run ${runId}`, async () => {
    const facts = await runFacts(pool, runId);
    return facts.suggestionCalls > 0 ? facts : undefined;
  });
}

/** Lets a suggestion that should not happen have its chance to happen. */
async function quiet(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

function suggestionCallsFor(marker: string): ModelCall[] {
  return calls.filter(
    (call) => call.suggestion && JSON.stringify(call.messages).includes(marker),
  );
}

test(
  "prompt suggestions predict the next message after a completed run, off by default",
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
      const helper = await seedAgent(pool, "helper", { suggest: true });
      const coordinator = await seedAgent(pool, "coordinator", {
        suggest: true,
        delegateVersionId: helper,
      });

      await t.test(
        "an agent without the setting makes no extra call",
        async () => {
          const session = await seedSession(pool, "off", silent);
          const run = await seedRun(pool, session, "off", "off-by-default");
          assert.equal(await settle(running, pool, run), "completed");
          await quiet();
          const facts = await runFacts(pool, run);
          assert.deepEqual(
            [
              facts.suggestionCalls,
              facts.suggestion,
              facts.events,
              facts.turns,
            ],
            [0, null, 0, 1],
          );
          assert.equal(suggestionCallsFor("off-by-default").length, 0);
        },
      );

      await t.test(
        "a completed run gets one priced call, a stored suggestion, and an event",
        async () => {
          const session = await seedSession(pool, "on", suggesting);
          const first = await seedRun(
            pool,
            session,
            "on-1",
            "run-looks-up first-question",
          );
          assert.equal(await settle(running, pool, first), "completed");
          const facts = await suggestionRecorded(pool, first);
          // Wrapping quotes are not part of what the user would type.
          assert.equal(facts.suggestion, "Release ORD-1592 to the carrier now");
          assert.equal(facts.current, facts.suggestion);
          assert.deepEqual(
            [facts.suggestionCalls, facts.suggested, facts.events],
            [1, true, 1],
          );
          // One summary event when the run settled, one for the extra call.
          assert.equal(facts.summaries, 2);
          // Two turns of the run, and the suggestion is not a third one.
          assert.deepEqual([facts.turns, facts.reservedTurns], [2, 2]);

          // The extra request is the run's last request, then its reply, then
          // the instruction: an exact prefix, so the provider cache applies.
          const forRun = calls.filter((call) =>
            JSON.stringify(call.messages).includes("first-question"),
          );
          assert.deepEqual(
            forRun.map((call) => call.suggestion),
            [false, false, true],
          );
          const [, lastTurn, extra] = forRun;
          assert.ok(lastTurn && extra);
          assert.deepEqual(
            extra.messages.slice(0, lastTurn.messages.length),
            lastTurn.messages,
          );
          assert.equal(extra.messages.length, lastTurn.messages.length + 2);
          assert.equal(
            (extra.messages.at(-2) as { role: string }).role,
            "assistant",
          );
          assert.equal(extra.maxTokens, PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS);
          assert.ok(extra.sessionId);
          assert.equal(extra.sessionId, lastTurn.sessionId);

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

          // The call is priced and counted with the session's other calls.
          const usage = await pool.query<{
            attempt: number;
            status: string;
            model_key: string;
            pricing_snapshot: Record<string, unknown>;
          }>(
            `SELECT attempt,status,model_key,pricing_snapshot FROM oao.model_invocations
              WHERE run_id=$1 ORDER BY attempt`,
            [first],
          );
          assert.deepEqual(
            usage.rows.map((row) => row.attempt),
            [1, 2, 3],
          );
          assert.equal(usage.rows[2]?.status, "completed");
          assert.equal(usage.rows[2]?.model_key, "deterministic");
          assert.ok(usage.rows[2]?.pricing_snapshot.source);

          // Nothing of the extra call is in the transcript.
          const transcript = await pool.query<{
            role: string;
            content: string;
          }>(
            `SELECT role,redacted_content AS content FROM oao.messages
              WHERE run_id=$1 ORDER BY created_at,id`,
            [first],
          );
          assert.deepEqual(
            transcript.rows.map((row) => [row.role, row.content]),
            [
              ["user", "run-looks-up first-question"],
              ["assistant", "ORD-1592 is ready to release."],
            ],
          );

          // The next real turn sees the conversation without the instruction
          // or the suggestion, and voids the first run's suggestion.
          const second = await seedRun(
            pool,
            session,
            "on-2",
            "second-question",
          );
          assert.equal(await settle(running, pool, second), "completed");
          const nextTurn = calls.find(
            (call) =>
              !call.suggestion &&
              JSON.stringify(call.messages).includes("second-question"),
          );
          assert.ok(nextTurn);
          const seen = JSON.stringify(nextTurn.messages);
          assert.ok(seen.includes("first-question"));
          assert.ok(!seen.includes(PROMPT_SUGGESTION_INSTRUCTION));
          assert.ok(!seen.includes("Release ORD-1592 to the carrier now"));
          const voided = await runFacts(pool, first);
          assert.equal(
            voided.suggestion,
            "Release ORD-1592 to the carrier now",
          );
          assert.equal(voided.current, null);
          const latest = await suggestionRecorded(pool, second);
          assert.equal(latest.current, "Release ORD-1592 to the carrier now");
        },
      );

      await t.test(
        "an empty, declined, or tool-calling answer is no suggestion",
        async () => {
          for (const marker of [
            "suggest-empty",
            "suggest-none",
            "suggest-tool",
          ]) {
            const session = await seedSession(pool, marker, suggesting);
            const run = await seedRun(pool, session, marker, marker);
            assert.equal(await settle(running, pool, run), "completed");
            const facts = await suggestionRecorded(pool, run);
            // The call happened and is accounted for; nothing is published.
            assert.deepEqual(
              [facts.suggestion, facts.suggested, facts.events],
              [null, false, 0],
              marker,
            );
            // Its usage still changed the session's totals.
            assert.equal(facts.summaries, 2, marker);
          }
        },
      );

      await t.test(
        "a failing extra call leaves the run untouched",
        async () => {
          const session = await seedSession(pool, "broken", suggesting);
          const run = await seedRun(pool, session, "broken", "suggest-broken");
          assert.equal(await settle(running, pool, run), "completed");
          await waitFor("the failing suggestion call", async () =>
            suggestionCallsFor("suggest-broken").length > 0 ? true : undefined,
          );
          await quiet();
          const facts = await runFacts(pool, run);
          assert.deepEqual(
            [facts.suggestionCalls, facts.suggestion, facts.events],
            [0, null, 0],
          );
          const state = await pool.query<{ state: string }>(
            "SELECT state FROM oao.runs WHERE id=$1",
            [run],
          );
          assert.equal(state.rows[0]?.state, "completed");
        },
      );

      await t.test("a failed run gets no suggestion", async () => {
        const session = await seedSession(pool, "failed", suggesting);
        const run = await seedRun(pool, session, "failed", "run-fails");
        assert.equal(await settle(running, pool, run), "failed");
        await quiet();
        assert.equal((await runFacts(pool, run)).suggestionCalls, 0);
        assert.equal(suggestionCallsFor("run-fails").length, 0);
      });

      await t.test(
        "a run paused for approval gets no suggestion until it completes",
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
          await quiet();
          assert.equal(suggestionCallsFor("run-gated").length, 0);
          await withTenantTransaction(pool, tenant, (transaction) =>
            transaction.query(
              "SELECT oao.resolve_approval($1,$2,$3,'denied',$4,'not today')",
              [tenant.organizationId, tenant.projectId, approvalId, human],
            ),
          );
          const facts = await suggestionRecorded(pool, run);
          assert.equal(facts.suggestion, "Release ORD-1592 to the carrier now");
        },
      );

      await t.test(
        "a delegated child session gets no suggestion; its parent does",
        async () => {
          const session = await seedSession(pool, "delegating", coordinator);
          const run = await seedRun(
            pool,
            session,
            "delegating",
            "run-delegates",
          );
          assert.equal(await settle(running, pool, run), "completed");
          const facts = await suggestionRecorded(pool, run);
          assert.equal(facts.events, 1);
          const child = await pool.query<{ child_run_id: string }>(
            `SELECT child_run_id FROM oao.delegation_runs
              WHERE organization_id=$1 AND project_id=$2 AND requested_by_run_id=$3`,
            [tenant.organizationId, tenant.projectId, run],
          );
          const childRunId = child.rows[0]?.child_run_id;
          assert.ok(childRunId);
          await quiet();
          const childFacts = await runFacts(pool, childRunId);
          assert.deepEqual(
            [childFacts.suggestionCalls, childFacts.suggestion],
            [0, null],
          );
          // The child's own last request ends with its prompt, not the parent's.
          assert.equal(
            calls.filter(
              (call) =>
                call.suggestion &&
                JSON.stringify(call.messages).includes("child-work") &&
                !JSON.stringify(call.messages).includes("run-delegates"),
            ).length,
            0,
          );
        },
      );

      await t.test(
        "a suggestion that arrives after a newer run started is not published",
        async () => {
          const session = await seedSession(pool, "slow", suggesting);
          const run = await seedRun(pool, session, "slow-1", "suggest-slow");
          const started = new Promise<void>((resolve) => {
            slowSuggestionStarted = resolve;
          });
          assert.equal(await settle(running, pool, run), "completed");
          await started;
          // The user sends the next message while the model is still predicting.
          await seedRun(pool, session, "slow-2", "second-message");
          releaseSlow();
          const facts = await suggestionRecorded(pool, run);
          // The call is paid for; the stale suggestion is dropped.
          assert.deepEqual(
            [facts.suggestionCalls, facts.suggestion, facts.events],
            [1, null, 0],
          );
        },
      );

      await t.test(
        "a run resumed while its suggestion is being saved neither deadlocks nor publishes",
        async () => {
          const session = await seedSession(pool, "resumed", suggesting);
          const run = await seedRun(pool, session, "resumed-1", "suggest-slow");
          const started = new Promise<void>((resolve) => {
            slowSuggestionStarted = resolve;
          });
          assert.equal(await settle(running, pool, run), "completed");
          await started;
          // What the resume route does: lock the settled run, add a run to its
          // session, then touch the session.
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query(
              "SELECT 1 FROM oao.runs WHERE id=$1 FOR UPDATE",
              [run],
            );
            releaseSlow();
            // The save now waits for the run.
            await quiet();
            await client.query(
              `INSERT INTO oao.runs (
                 organization_id,project_id,id,thread_id,session_id,agent_version_id,
                 created_by_principal_id,idempotency_key,input_public
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,'prompt-suggestions-e2e:resumed-2','{}')`,
              [
                tenant.organizationId,
                tenant.projectId,
                uuid("resumed-2:run"),
                session.threadId,
                session.sessionId,
                session.versionId,
                human,
              ],
            );
            await client.query(
              "UPDATE oao.sessions SET last_activity_at=clock_timestamp() WHERE id=$1",
              [session.sessionId],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
          const facts = await suggestionRecorded(pool, run);
          assert.deepEqual(
            [facts.suggestionCalls, facts.suggestion, facts.events],
            [1, null, 0],
          );
        },
      );
    } finally {
      releaseSlowSuggestion?.();
      await worker?.stop();
      await pool.end();
    }
  },
);
