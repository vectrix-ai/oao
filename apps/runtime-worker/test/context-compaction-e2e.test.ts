import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPool, type PgPool } from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
  ThreadId,
} from "@oao/domain";
import {
  EMPTY_LENGTH_OVERFLOW_MESSAGE,
  fauxAssistantMessage,
  fauxToolCall,
  OUTPUT_BUDGET_OVERFLOW_MESSAGE,
  type FauxResponseStep,
} from "@oao/models-openrouter";
import type { PlatformToolHandler } from "@oao/runtime-flue";
import { startRuntimeWorker, type RuntimeWorkerHandle } from "../src/main.js";

const databaseUrl = process.env.DATABASE_URL;
const testAdminDatabaseUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? databaseUrl;

function uuid(label: string): string {
  const bytes = createHash("sha256")
    .update(`context-compaction-e2e/${label}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const tenant = {
  organizationId: uuid("org") as OrganizationId,
  projectId: uuid("project") as ProjectId,
};
const human = uuid("human") as PrincipalId;
const service = uuid("service") as PrincipalId;

const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const largeLookupTool = {
  schemaVersion: 1,
  name: "platform.large_lookup",
  description: "Fetch a detailed record payload.",
  owner: "platform",
  approval: "never",
  inputSchema: objectSchema({ query: { type: "string" } }),
  outputSchema: objectSchema({ payload: { type: "string" } }),
};

interface ObservedCall {
  readonly isCompaction: boolean;
  readonly transcript: string;
}

const observedCalls: ObservedCall[] = [];

const respond: FauxResponseStep = (context) => {
  const transcript = JSON.stringify(context.messages);
  const isCompaction = transcript.includes(
    "You are a context summarization assistant",
  );
  observedCalls.push({ isCompaction, transcript });

  if (isCompaction) {
    return fauxAssistantMessage(
      "## Goal\nContinue the conversation cleanly.\n\n## Progress\n- Earlier turns summarized.",
    );
  }

  const toolResults = context.messages.filter(
    (message) => message.role === "toolResult",
  ).length;
  const hasCompaction = transcript.includes("</compaction>");

  // Pre-call output-budget overflow scenario:
  // Run 1 fills context near the 32k fake window without crossing Flue's
  // post-turn compaction threshold (27,904 tokens).
  if (
    transcript.includes("compact-budget-setup") &&
    !transcript.includes("compact-budget-trigger")
  ) {
    return fauxAssistantMessage(`setup-ack ${"a".repeat(38_000)}`);
  }
  if (transcript.includes("compact-budget-trigger")) {
    if (toolResults === 0 && !hasCompaction) {
      return fauxAssistantMessage(
        [fauxToolCall("platform.large_lookup", { query: "full-record" })],
        { stopReason: "toolUse" },
      );
    }
    if (hasCompaction) {
      return fauxAssistantMessage("compacted-and-answered");
    }
    // Should never reach here: pre-call guard must compact before calling the model.
    return fauxAssistantMessage([], { stopReason: "length" });
  }

  // History builder for empty-length and double-overflow sessions so Flue's
  // compaction always has an earlier cut point to summarize.
  if (
    transcript.includes("history-turn-") &&
    !transcript.includes("empty-length-recover") &&
    !transcript.includes("double-overflow-fail")
  ) {
    return fauxAssistantMessage(`history-reply ${"h".repeat(16_000)}`);
  }

  if (transcript.includes("empty-length-recover")) {
    if (!hasCompaction) {
      return fauxAssistantMessage(
        [{ type: "thinking", thinking: "Ran out of room before writing text" }],
        { stopReason: "length" },
      );
    }
    return fauxAssistantMessage("recovered-after-empty-length");
  }

  if (transcript.includes("double-overflow-fail")) {
    return fauxAssistantMessage([], { stopReason: "length" });
  }

  if (transcript.includes("legitimate-length-text")) {
    return fauxAssistantMessage(
      "Long answer that legitimately ended on length.",
      { stopReason: "length" },
    );
  }

  if (transcript.includes("silent-empty-stop")) {
    return fauxAssistantMessage("");
  }

  if (transcript.includes("committed-before-empty")) {
    if (toolResults === 0) {
      return fauxAssistantMessage(
        [
          { type: "text", text: "Checking records now." },
          fauxToolCall("platform.large_lookup", { query: "small" }),
        ],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage("");
  }

  return fauxAssistantMessage("default-reply");
};

const disabledSandbox = {
  enabled: false,
  provider: "daytona-primary",
  network: "none",
  capabilities: [],
};

async function seedBase(pool: PgPool): Promise<void> {
  await pool.query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'context-compaction-e2e','Context compaction e2e')",
    [tenant.organizationId],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'context-compaction-e2e','Context compaction e2e')",
    [tenant.organizationId, tenant.projectId],
  );
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'human','context-compaction-e2e-human',ARRAY['*']),
            ($1,$2,$4,'service','context-compaction-e2e-service',ARRAY['*'])`,
    [tenant.organizationId, tenant.projectId, human, service],
  );
}

async function seedAgent(
  pool: PgPool,
  label: string,
  options: { readonly publishText?: boolean } = {},
): Promise<string> {
  const agentId = uuid(`${label}:agent`);
  const versionId = uuid(`${label}:version`);
  const config = {
    systemPrompt: "Answer concisely after running any needed lookup.",
    modelPreset: "local-default",
    tools: [largeLookupTool],
    delegates: [],
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
      `context-compaction-e2e:${label}`,
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

async function waitForSettled(
  worker: RuntimeWorkerHandle,
  pool: PgPool,
  runId: RunId,
): Promise<string> {
  await worker.orchestrator.handleWake({
    ...tenant,
    id: uuid(`wake:${runId}`),
    runId,
    dispatchKey: `admit:${runId}`,
    kind: "admit",
    payload: { reason: "integration_test" },
    attempts: 1,
    fence: 1n,
  });
  const deadline = Date.now() + 45_000;
  for (;;) {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM oao.runs WHERE id=$1",
      [runId],
    );
    const state = result.rows[0]?.state ?? "missing";
    if (["completed", "failed", "cancelled", "timed_out"].includes(state))
      return state;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for run ${runId} (state=${state})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runDetails(pool: PgPool, runId: RunId) {
  const [messages, invocations, stateEvents, timeline] = await Promise.all([
    pool.query<{ redacted_content: string }>(
      `SELECT redacted_content FROM oao.messages
        WHERE run_id=$1 AND role='assistant' ORDER BY created_at,id`,
      [runId],
    ),
    pool.query<{
      status: string;
      purpose: string | null;
      finish_reason: string | null;
      error_explanation: string | null;
    }>(
      `SELECT status,
              safe_request->>'purpose' AS purpose,
              safe_response->>'finishReason' AS finish_reason,
              safe_response->>'errorExplanation' AS error_explanation
         FROM oao.model_invocations
        WHERE run_id=$1 ORDER BY attempt`,
      [runId],
    ),
    pool.query<{ public_payload: Record<string, unknown> }>(
      `SELECT public_payload FROM oao.product_events
        WHERE aggregate_id=$1 AND event_kind='run.state_changed'
        ORDER BY project_position`,
      [runId],
    ),
    pool.query<{ safe_detail: Record<string, unknown> }>(
      `SELECT safe_detail FROM oao.timeline_entries
        WHERE run_id=$1 AND entry_sequence=1`,
      [runId],
    ),
  ]);
  return {
    messages: messages.rows.map((row) => row.redacted_content),
    invocations: invocations.rows,
    terminalEvent: stateEvents.rows.at(-1)?.public_payload,
    timelineDetail: timeline.rows[0]?.safe_detail,
  };
}

test(
  "long runs compact and retry instead of ending silently on length or empty reply",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 240_000 },
  async (t) => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const pool = createPool(testAdminDatabaseUrl);
    const platformTools = new Map<string, PlatformToolHandler>([
      [
        "platform.large_lookup",
        async (args) => ({
          payload:
            args.query === "full-record" ? "r".repeat(24_000) : "small-record",
        }),
      ],
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
      const standard = await seedAgent(pool, "standard");
      const narrating = await seedAgent(pool, "narrating", {
        publishText: true,
      });

      await t.test(
        "mid-run tool results that exhaust output room trigger compaction and retry to answer",
        async () => {
          const session = await seedSession(pool, "budget", standard);
          const setupRun = await seedRun(
            pool,
            session,
            "budget-setup",
            `compact-budget-setup ${"u".repeat(42_000)}`,
          );
          assert.equal(
            await waitForSettled(running, pool, setupRun),
            "completed",
          );
          // Verify Run 1 stayed below Flue's post-turn compaction threshold.
          const setupDetails = await runDetails(pool, setupRun);
          assert.equal(
            setupDetails.invocations.some((row) =>
              row.purpose?.startsWith("compaction"),
            ),
            false,
          );

          const beforeCalls = observedCalls.length;
          const triggerRun = await seedRun(
            pool,
            session,
            "budget-trigger",
            "compact-budget-trigger: inspect the full record and summarize",
          );
          assert.equal(
            await waitForSettled(running, pool, triggerRun),
            "completed",
          );
          const details = await runDetails(pool, triggerRun);
          assert.deepEqual(details.messages, ["compacted-and-answered"]);
          assert.ok(
            details.invocations.some((row) =>
              row.purpose?.startsWith("compaction"),
            ),
            "expected compaction invocation during overflow recovery",
          );
          assert.ok(
            details.invocations.some(
              (row) =>
                row.status === "failed" &&
                row.error_explanation?.includes("output token room"),
            ),
            "expected safe overflow explanation on the rejected attempt",
          );

          // Check the actual calls that reached the fake provider during Run 2:
          // 1st agent call requested the tool, compaction ran, and 2nd agent
          // call ran on compacted context without any synthetic error message.
          const runCalls = observedCalls.slice(beforeCalls);
          const agentCalls = runCalls.filter((call) => !call.isCompaction);
          const compactionCalls = runCalls.filter((call) => call.isCompaction);
          assert.equal(agentCalls.length, 2);
          assert.ok(compactionCalls.length >= 1);
          const retryCall = agentCalls[1]!;
          assert.ok(retryCall.transcript.includes("</compaction>"));
          assert.equal(
            retryCall.transcript.includes(OUTPUT_BUDGET_OVERFLOW_MESSAGE),
            false,
          );
          assert.equal(
            retryCall.transcript.includes("Context window exceeded"),
            false,
          );
        },
      );

      await t.test(
        "an empty length stop after model execution compacts and retries once",
        async () => {
          const session = await seedSession(pool, "empty-length", standard);
          for (const turn of [1, 2]) {
            const historyRun = await seedRun(
              pool,
              session,
              `empty-length-history-${turn}`,
              `history-turn-${turn} ${"p".repeat(16_000)}`,
            );
            assert.equal(
              await waitForSettled(running, pool, historyRun),
              "completed",
            );
          }

          const beforeCalls = observedCalls.length;
          const run = await seedRun(
            pool,
            session,
            "empty-length-recover",
            "empty-length-recover: answer now",
          );
          assert.equal(await waitForSettled(running, pool, run), "completed");
          const details = await runDetails(pool, run);
          assert.deepEqual(details.messages, ["recovered-after-empty-length"]);
          assert.ok(
            details.invocations.some((row) =>
              row.purpose?.startsWith("compaction"),
            ),
          );
          const agentCalls = observedCalls
            .slice(beforeCalls)
            .filter((call) => !call.isCompaction);
          assert.equal(agentCalls.length, 2);
          assert.ok(agentCalls[1]!.transcript.includes("</compaction>"));
          assert.equal(
            agentCalls[1]!.transcript.includes(EMPTY_LENGTH_OVERFLOW_MESSAGE),
            false,
          );
        },
      );

      await t.test(
        "a second overflow on the retry fails the run instead of looping",
        async () => {
          const session = await seedSession(pool, "double-overflow", standard);
          for (const turn of [1, 2]) {
            const historyRun = await seedRun(
              pool,
              session,
              `double-overflow-history-${turn}`,
              `history-turn-${turn} ${"d".repeat(16_000)}`,
            );
            assert.equal(
              await waitForSettled(running, pool, historyRun),
              "completed",
            );
          }

          const beforeCalls = observedCalls.length;
          const run = await seedRun(
            pool,
            session,
            "double-overflow-fail",
            "double-overflow-fail: still too large",
          );
          assert.equal(await waitForSettled(running, pool, run), "failed");
          const details = await runDetails(pool, run);
          assert.deepEqual(details.messages, []);
          assert.ok(
            details.invocations.some((row) =>
              row.purpose?.startsWith("compaction"),
            ),
          );
          const agentCalls = observedCalls
            .slice(beforeCalls)
            .filter((call) => !call.isCompaction);
          assert.equal(agentCalls.length, 2);
        },
      );

      await t.test(
        "a long answer that ends on length with text completes unchanged",
        async () => {
          const session = await seedSession(
            pool,
            "legitimate-length",
            standard,
          );
          const run = await seedRun(
            pool,
            session,
            "legitimate-length-text",
            "legitimate-length-text",
          );
          assert.equal(await waitForSettled(running, pool, run), "completed");
          const details = await runDetails(pool, run);
          assert.deepEqual(details.messages, [
            "Long answer that legitimately ended on length.",
          ]);
          assert.equal(details.invocations.length, 1);
          assert.equal(details.invocations[0]?.finish_reason, "length");
          assert.equal(details.invocations[0]?.error_explanation, null);
        },
      );

      await t.test(
        "settle fails an empty completed reply with empty_reply unless assistant text was already committed",
        async () => {
          const emptySession = await seedSession(pool, "empty-stop", standard);
          const emptyRun = await seedRun(
            pool,
            emptySession,
            "silent-empty-stop",
            "silent-empty-stop",
          );
          assert.equal(await waitForSettled(running, pool, emptyRun), "failed");
          const emptyDetails = await runDetails(pool, emptyRun);
          assert.deepEqual(emptyDetails.messages, []);
          assert.deepEqual(emptyDetails.terminalEvent, {
            state: "failed",
            code: "empty_reply",
          });
          assert.equal(emptyDetails.timelineDetail?.status, "failed");
          assert.equal(emptyDetails.timelineDetail?.code, "empty_reply");

          const committedSession = await seedSession(
            pool,
            "committed-before-empty",
            narrating,
          );
          const committedRun = await seedRun(
            pool,
            committedSession,
            "committed-before-empty",
            "committed-before-empty",
          );
          assert.equal(
            await waitForSettled(running, pool, committedRun),
            "completed",
          );
          const committedDetails = await runDetails(pool, committedRun);
          assert.deepEqual(committedDetails.messages, [
            "Checking records now.",
          ]);
          assert.deepEqual(committedDetails.terminalEvent, {
            state: "completed",
          });
        },
      );
    } finally {
      await worker?.stop();
      await pool.end();
    }
  },
);
