import assert from "node:assert/strict";
import test from "node:test";
import type { FlueObservation } from "@flue/runtime";
import * as v from "valibot";
import {
  createManagedHarnessOperationTool,
  runtimeTesting,
} from "../src/index.js";

function turn(
  submissionId: string | undefined,
  content: readonly Record<string, unknown>[],
  overrides: { readonly purpose?: string; readonly isError?: boolean } = {},
): FlueObservation {
  return {
    v: 3,
    eventIndex: 0,
    timestamp: "2026-10-11T12:00:00.000Z",
    type: "turn",
    turnId: `turn-${Math.random()}`,
    purpose: overrides.purpose ?? "agent",
    durationMs: 1,
    request: {},
    response: { output: { role: "assistant", content } },
    isError: overrides.isError ?? false,
    ...(submissionId ? { submissionId } : {}),
  } as unknown as FlueObservation;
}

const call = (id: string) => ({ type: "toolCall", id, name: "update_rule" });

const settled = (submissionId: string) =>
  ({
    v: 3,
    eventIndex: 1,
    timestamp: "2026-10-11T12:00:01.000Z",
    type: "submission_settled",
    submissionId,
    outcome: "completed",
  }) as unknown as FlueObservation;

// Gated calls of an agent that does not publish text before every tool call
// commit through the gate's own transaction, never separately.
const unexpectedCommit = (): Promise<boolean> => {
  throw new Error("an approval gate must not commit text separately");
};

test("a gated call claims the run's uncommitted text, joined like the reply", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  pending.observe(
    turn("submission-1", [
      { type: "text", text: "Let me read the rule." },
      { type: "toolCall", id: "call-read", name: "get_rules" },
    ]),
  );
  pending.observe(
    turn("submission-1", [
      { type: "thinking", thinking: "private scratch" },
      { type: "text", text: "Now: EUR → After: CHF for Example Corp." },
      call("call-update"),
    ]),
  );

  const claim = await pending.take("call-update");
  assert.equal(
    claim?.text,
    "Let me read the rule.\n\nNow: EUR → After: CHF for Example Corp.",
  );
  claim?.settle(true);
  assert.equal(await pending.take("call-update"), undefined);

  pending.observe(
    turn("submission-1", [
      { type: "text", text: "Second change." },
      call("call-second"),
    ]),
  );
  assert.equal((await pending.take("call-second"))?.text, "Second change.");
});

test("parallel gates from one turn never claim the same text twice", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  pending.observe(
    turn("submission-2", [
      { type: "text", text: "Two changes follow." },
      call("gate-a"),
      call("gate-b"),
    ]),
  );
  const claimed = await Promise.all([
    pending.take("gate-a"),
    pending.take("gate-b"),
  ]);
  assert.deepEqual(
    claimed.map((claim) => claim?.text),
    ["Two changes follow.", undefined],
  );
});

test("text from a publication that rolled back stays available", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  pending.observe(
    turn("submission-3", [{ type: "text", text: "First." }, call("failed")]),
  );
  const failed = await pending.take("failed");
  assert.equal(failed?.text, "First.");
  failed?.settle(false);

  pending.observe(
    turn("submission-3", [{ type: "text", text: "Second." }, call("next")]),
  );
  // The next gate commits the released explanation with its own.
  assert.equal((await pending.take("next"))?.text, "First.\n\nSecond.");
});

test("an unknown publication outcome keeps the text reserved", async () => {
  const { withPendingAssistantText } = runtimeTesting;
  const gate = (flueToolCallId: string) =>
    ({ approval: "always", flueToolCallId }) as Parameters<
      typeof withPendingAssistantText
    >[1];
  const pending = runtimeTesting.createPendingAssistantText();
  const published: (string | undefined)[] = [];
  const publish = async (obligation: ReturnType<typeof gate>) => {
    published.push(obligation.pendingAssistantText);
  };

  // The publication may have saved the text, but the check could not tell.
  pending.observe(
    turn("submission-6", [{ type: "text", text: "First." }, call("unknown")]),
  );
  await withPendingAssistantText(
    {
      hasPendingAssistantText: () => Promise.reject(new Error("lost")),
      commitAssistantText: unexpectedCommit,
    },
    gate("unknown"),
    undefined,
    publish,
    pending,
  );
  // A known rollback releases the text to the next gate.
  pending.observe(
    turn("submission-6", [{ type: "text", text: "Second." }, call("failed")]),
  );
  await assert.rejects(
    withPendingAssistantText(
      {
        hasPendingAssistantText: async () => false,
        commitAssistantText: unexpectedCommit,
      },
      gate("failed"),
      undefined,
      () => Promise.reject(new Error("rolled back")),
      pending,
    ),
    /rolled back/,
  );
  pending.observe(
    turn("submission-6", [{ type: "text", text: "Third." }, call("next")]),
  );
  await withPendingAssistantText(
    {
      hasPendingAssistantText: async () => true,
      commitAssistantText: unexpectedCommit,
    },
    gate("next"),
    undefined,
    publish,
    pending,
  );

  assert.deepEqual(published, ["First.", "Second.\n\nThird."]);
});

test("a call waits briefly for its turn observation", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  const claim = pending.take("late-call");
  pending.observe(
    turn("submission-4", [
      { type: "text", text: "Explained before the gate." },
      call("late-call"),
    ]),
  );
  assert.equal((await claim)?.text, "Explained before the gate.");

  const aborted = new AbortController();
  const unknown = pending.take("never-observed", aborted.signal);
  aborted.abort();
  assert.equal(await unknown, undefined);
});

test("scratch, failed, unscoped, and settled turns contribute nothing", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  pending.observe(
    turn("submission-5", [{ type: "text", text: "summary" }, call("c1")], {
      purpose: "compaction",
    }),
  );
  pending.observe(
    turn("submission-5", [{ type: "text", text: "partial" }, call("c2")], {
      isError: true,
    }),
  );
  pending.observe(turn(undefined, [{ type: "text", text: "x" }, call("c3")]));
  pending.observe(
    turn("submission-5", [{ type: "text", text: "kept" }, call("c4")]),
  );
  pending.observe(settled("submission-5"));
  // The runtime projection forgets a submission once it projected its
  // settlement.
  pending.forget("submission-5");

  const aborted = AbortSignal.abort();
  for (const id of ["c1", "c2", "c3", "c4"])
    assert.equal(await pending.take(id, aborted), undefined);
});

test("the settled reply drops text already committed ahead of gates", () => {
  const { replyAfterCommittedText } = runtimeTesting;
  const reply =
    "Let me read the rule.\n\nNow: EUR → After: CHF.\n\nThe change was not applied.";
  assert.equal(replyAfterCommittedText(reply, []), reply);
  assert.equal(
    replyAfterCommittedText(reply, [
      "Let me read the rule.\n\nNow: EUR → After: CHF.",
    ]),
    "The change was not applied.",
  );
  assert.equal(
    replyAfterCommittedText(reply, [
      "Let me read the rule.",
      "Now: EUR → After: CHF.",
    ]),
    "The change was not applied.",
  );
  assert.equal(
    replyAfterCommittedText("Only the gate text.", ["Only the gate text."]),
    "",
  );
  // An unexpected layout keeps every word instead of risking a loss.
  assert.equal(replyAfterCommittedText(reply, ["Something else."]), reply);
});

type Segments = readonly {
  readonly toolCallId: string;
  readonly text: string;
}[];

function recordingCommit(result: boolean | Error = true) {
  const commits: Segments[] = [];
  return {
    commits,
    commit: async (segments: Segments) => {
      commits.push(segments);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("each tool-calling turn's text is committed as its own message", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  const { commits, commit } = recordingCommit();
  pending.observe(
    turn("turn-text-1", [
      { type: "text", text: "Reading the email." },
      call("read-email"),
    ]),
  );
  await pending.publishThrough("read-email", commit);
  // A text-only turn has no tool call of its own: its text joins the next
  // tool-calling turn, so the messages stay a prefix of the reply.
  pending.observe(turn("turn-text-1", [{ type: "text", text: "Hmm." }]));
  pending.observe(
    turn("turn-text-1", [
      { type: "thinking", thinking: "private scratch" },
      { type: "text", text: "Two lookups follow." },
      call("lookup-a"),
      call("lookup-b"),
    ]),
  );
  await pending.publishThrough("lookup-b", commit);
  await pending.publishThrough("lookup-a", commit);
  // A turn without text commits nothing.
  pending.observe(turn("turn-text-1", [call("silent")]));
  await pending.publishThrough("silent", commit);

  assert.deepEqual(commits, [
    [{ toolCallId: "read-email", text: "Reading the email." }],
    [{ toolCallId: "lookup-a", text: "Hmm.\n\nTwo lookups follow." }],
  ]);
  const { replyAfterCommittedText } = runtimeTesting;
  assert.equal(
    replyAfterCommittedText(
      "Reading the email.\n\nHmm.\n\nTwo lookups follow.\n\nDone.",
      commits.flat().map((segment) => segment.text),
    ),
    "Done.",
  );
});

test("parallel calls of one turn wait for one shared commit", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  pending.observe(
    turn("turn-text-2", [
      { type: "text", text: "Checking both." },
      call("parallel-a"),
      call("parallel-b"),
    ]),
  );
  let release!: (persisted: boolean) => void;
  const commits: Segments[] = [];
  const commit = (segments: Segments) => {
    commits.push(segments);
    return new Promise<boolean>((resolve) => {
      release = resolve;
    });
  };
  const finished: string[] = [];
  const first = pending
    .publishThrough("parallel-a", commit)
    .then(() => finished.push("parallel-a"));
  const second = pending
    .publishThrough("parallel-b", commit)
    .then(() => finished.push("parallel-b"));
  await new Promise((resolve) => setImmediate(resolve));
  // Neither call may run its tool before the turn's message is saved.
  assert.deepEqual(finished, []);
  assert.equal(commits.length, 1);
  release(true);
  await Promise.all([first, second]);
  assert.deepEqual(finished.sort(), ["parallel-a", "parallel-b"]);
  assert.equal(commits.length, 1);
});

test("a failed commit leaves its text for the next turn's commit", async () => {
  for (const failure of [false, new Error("database unavailable")]) {
    const pending = runtimeTesting.createPendingAssistantText();
    const failed = recordingCommit(failure);
    pending.observe(
      turn("turn-text-3", [{ type: "text", text: "First." }, call("first")]),
    );
    await pending.publishThrough("first", failed.commit);
    pending.observe(
      turn("turn-text-3", [{ type: "text", text: "Second." }, call("second")]),
    );
    const next = recordingCommit();
    await pending.publishThrough("second", next.commit);
    // Each turn keeps its own message; the retry names the same one.
    assert.deepEqual(next.commits, [
      [
        { toolCallId: "first", text: "First." },
        { toolCallId: "second", text: "Second." },
      ],
    ]);
  }
});

test("a call that is never observed commits nothing", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  const { commits, commit } = recordingCommit();
  const startedAt = Date.now();
  await pending.publishThrough("unknown-call", commit, { wait: false });
  await pending.publishThrough("aborted-call", commit, {
    signal: AbortSignal.abort(),
  });
  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual(commits, []);
});

test("with publishing on, every call commits its turn's text before it publishes", async () => {
  const { withPendingAssistantText } = runtimeTesting;
  const pending = runtimeTesting.createPendingAssistantText();
  const order: string[] = [];
  const broker = {
    hasPendingAssistantText: async () => {
      throw new Error("per-turn publication needs no check");
    },
    commitAssistantText: async (input: { readonly segments: Segments }) => {
      order.push(`commit:${input.segments.map((s) => s.text).join("|")}`);
      return true;
    },
  };
  pending.observe(
    turn("turn-text-4", [
      { type: "text", text: "Looking it up." },
      call("ungated"),
    ]),
  );
  pending.observe(
    turn("turn-text-4", [
      { type: "text", text: "Changing the rule." },
      call("gated"),
    ]),
  );
  for (const [flueToolCallId, approval] of [
    ["ungated", "never"],
    ["gated", "always"],
  ] as const)
    await withPendingAssistantText(
      broker,
      { flueToolCallId, approval, runId: "run-4" } as Parameters<
        typeof withPendingAssistantText
      >[1],
      undefined,
      async (obligation) => {
        // The gate never carries the text: it was committed on its own.
        assert.equal(obligation.pendingAssistantText, undefined);
        order.push(`publish:${obligation.flueToolCallId}`);
      },
      pending,
      true,
    );
  assert.deepEqual(order, [
    "commit:Looking it up.",
    "publish:ungated",
    "commit:Changing the rule.",
    "publish:gated",
  ]);
});

test("sandbox tools commit their turn's text before they run", async () => {
  const { withAssistantTextBeforeSandboxTools } = runtimeTesting;
  const order: string[] = [];
  const read = {
    name: "read",
    label: "Read",
    description: "Read a file",
    parameters: {},
    async execute(toolCallId: string, params: unknown) {
      order.push(`execute:${toolCallId}:${JSON.stringify(params)}`);
      return { content: [], details: {} };
    },
  };
  const factory = {
    createSandbox: async () => ({}) as never,
    tools: () => [read],
    persistWorkspace: async () => undefined,
  };
  const wrapped = withAssistantTextBeforeSandboxTools(
    factory as unknown as Parameters<
      typeof withAssistantTextBeforeSandboxTools
    >[0],
    async (toolCallId) => {
      order.push(`publish:${toolCallId}`);
    },
  );
  // Everything else about the factory is unchanged.
  assert.equal(wrapped.createSandbox, factory.createSandbox);
  assert.equal(wrapped.persistWorkspace, factory.persistWorkspace);
  const [tool] = wrapped.tools!({} as never, { subagents: {} });
  assert.equal(tool?.name, "read");
  await tool?.execute("sandbox-call", { path: "a.txt" });
  assert.deepEqual(order, [
    "publish:sandbox-call",
    'execute:sandbox-call:{"path":"a.txt"}',
  ]);
  const withoutTools = { createSandbox: factory.createSandbox };
  assert.equal(
    withAssistantTextBeforeSandboxTools(
      withoutTools as unknown as Parameters<
        typeof withAssistantTextBeforeSandboxTools
      >[0],
      async () => undefined,
    ),
    withoutTools,
  );
});

test("a turn still queued for projection commits after its submission settles", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  const { commits, commit } = recordingCommit();
  pending.observe(
    turn("turn-text-5", [
      { type: "text", text: "Loading the order Skill." },
      { type: "toolCall", id: "skill-call", name: "activate_skill" },
    ]),
  );
  // The run finished while the projection still had this turn queued.
  pending.observe(settled("turn-text-5"));
  await pending.publishThrough("skill-call", commit, { wait: false });
  assert.deepEqual(commits, [
    [{ toolCallId: "skill-call", text: "Loading the order Skill." }],
  ]);
});

test("a Harness Operation commits its turn's text before its scratch conversation, which publishes none", async () => {
  const { publishAssistantTextBefore } = runtimeTesting;
  const pending = runtimeTesting.createPendingAssistantText();
  const order: string[] = [];
  const broker = {
    commitAssistantText: async (input: { readonly segments: Segments }) => {
      order.push(`commit:${input.segments.map((s) => s.text).join("|")}`);
      return true;
    },
  };
  const run = { organizationId: "org", projectId: "project", runId: "run" };
  const publish = (toolCallId: string, signal?: AbortSignal) =>
    publishAssistantTextBefore(
      broker,
      run as Parameters<typeof publishAssistantTextBefore>[1],
      toolCallId,
      signal,
      pending,
    );
  pending.observe(
    turn("turn-text-6", [
      { type: "text", text: "Extracting the shipment." },
      { type: "toolCall", id: "outer-call", name: "extract_shipment" },
    ]),
  );
  const tool = createManagedHarnessOperationTool(
    {
      key: "extract_shipment",
      description: "Extract a shipment.",
      instructions: "Read the shipment file and return its reference.",
      resultSchema: {
        type: "object",
        properties: { shipmentReference: { type: "string" } },
        required: ["shipmentReference"],
        additionalProperties: false,
      },
      timeoutMs: 10_000,
    },
    publish,
  );
  const output = await (
    tool.run as unknown as (context: unknown) => Promise<unknown>
  )({
    data: { task: "Extract the shipment." },
    toolCallId: "outer-call",
    step: { do: (_name: string, callback: () => unknown) => callback() },
    log: { info() {}, warn() {} },
    harness: {
      async prompt(_prompt: string, options: { result: v.GenericSchema }) {
        order.push("scratch");
        // A scratch tool call never publishes, and never waits for a scratch
        // turn observation that never comes.
        const startedAt = Date.now();
        await publish("scratch-call");
        assert.ok(Date.now() - startedAt < 500);
        return { data: v.parse(options.result, { shipmentReference: "S-1" }) };
      },
    },
  });
  assert.deepEqual(output, { output: { shipmentReference: "S-1" } });
  assert.deepEqual(order, ["commit:Extracting the shipment.", "scratch"]);
});
