import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  isContextOverflow,
  normalizeContext,
  type AssistantMessage,
  type Provider,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  createDeterministicModelProvider,
  EMPTY_LENGTH_OVERFLOW_MESSAGE,
  fauxAssistantMessage,
  fauxToolCall,
  MIN_MODEL_OUTPUT_TOKENS,
  OUTPUT_BUDGET_OVERFLOW_MESSAGE,
  withModelLimits,
  withModelOutputBudget,
} from "../src/index.js";

function fixture(
  start: (options?: StreamOptions) => ReturnType<Provider["streamSimple"]>,
  limits?: { readonly contextWindow: number; readonly maxOutputTokens: number },
) {
  const base = createDeterministicModelProvider().provider;
  const limited = limits
    ? withModelLimits(base, {
        id: "limits-test",
        contextWindow: limits.contextWindow,
        maxOutputTokens: limits.maxOutputTokens,
      })
    : base;
  const provider: Provider = {
    ...limited,
    stream: (_model, _context, options) => start(options),
    streamSimple: (_model, _context, options) => start(options),
  };
  const model = limited.getModels()[0]!;
  return { provider, model };
}

function streamOf(message: AssistantMessage) {
  const source = createAssistantMessageEventStream();
  source.push({
    type: "done",
    reason:
      message.stopReason === "toolUse"
        ? "toolUse"
        : message.stopReason === "length"
          ? "length"
          : "stop",
    message,
  });
  source.end();
  return source;
}

test("rejects calls whose remaining output room falls below the floor as a context overflow", async () => {
  assert.equal(MIN_MODEL_OUTPUT_TOKENS, 2_000);
  // Placeholder OpenRouter limits: 128,000 context window, 4,096 max output.
  // pi reserves at least 4,096 safety tokens, so 122,500 input tokens leaves
  // 1,404 output tokens (< 2,000 floor).
  const priorAssistant: AssistantMessage = {
    ...fauxAssistantMessage("a".repeat(36_000)),
    usage: {
      input: 120_000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120_500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 2,
  };
  const context = normalizeContext({
    messages: [
      { role: "user", content: "Look up records", timestamp: 1 },
      priorAssistant,
      // ~2,000 additional trailing tokens push input estimate to ~122,500.
      { role: "user", content: "x".repeat(7_000), timestamp: 3 },
    ],
  });
  for (const method of ["stream", "streamSimple"] as const) {
    let calls = 0;
    const { provider, model } = fixture(
      () => {
        calls++;
        return streamOf(fauxAssistantMessage("should not run"));
      },
      { contextWindow: 128_000, maxOutputTokens: 4_096 },
    );
    const guarded = withModelOutputBudget(provider);
    const result = await guarded[method](model, context).result();
    assert.equal(calls, 0);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, OUTPUT_BUDGET_OVERFLOW_MESSAGE);
    assert.deepEqual(result.content, []);
    assert.equal(isContextOverflow(result, model.contextWindow), true);
  }
});

test("allows calls with enough output room or a deliberately small maxTokens option", async () => {
  const smallContext = normalizeContext({
    messages: [{ role: "user", content: "Hello", timestamp: 1 }],
  });
  let calls = 0;
  const response = fauxAssistantMessage("ok");
  const { provider, model } = fixture(
    () => {
      calls++;
      return streamOf(response);
    },
    { contextWindow: 128_000, maxOutputTokens: 4_096 },
  );
  const guarded = withModelOutputBudget(provider);
  const normal = await guarded.streamSimple(model, smallContext).result();
  assert.deepEqual(normal, response);
  // Explicit small maxTokens on a roomy context is not context pressure.
  const smallLimit = await guarded
    .streamSimple(model, smallContext, { maxTokens: 512 })
    .result();
  assert.deepEqual(smallLimit, response);
  // A single user message (first turn or compaction call) has no earlier cut
  // point to compact, so the pre-call estimate lets the provider decide.
  const singleLargeMessage = normalizeContext({
    messages: [{ role: "user", content: "x".repeat(450_000), timestamp: 1 }],
  });
  const firstTurn = await guarded
    .streamSimple(model, singleLargeMessage)
    .result();
  assert.deepEqual(firstTurn, response);
  // An oversized trailing toolResult alone exceeds Flue's 8,000-token retention
  // window, leaving no cut point after it. Let the provider attempt the call
  // instead of triggering a no-op compaction failure.
  const oversizedToolResult = normalizeContext({
    messages: [
      { role: "user", content: "Inspect the archive", timestamp: 1 },
      {
        ...fauxAssistantMessage([fauxToolCall("platform.lookup", {})], {
          stopReason: "toolUse",
        }),
        usage: {
          input: 110_000,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 110_050,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "platform.lookup",
        content: [{ type: "text", text: "r".repeat(48_000) }],
        isError: false,
        timestamp: 3,
      },
    ],
  });
  const withOversizedTool = await guarded
    .streamSimple(model, oversizedToolResult)
    .result();
  assert.deepEqual(withOversizedTool, response);
  assert.equal(calls, 4);
});

test("converts an empty length stop (including thinking-only) into a context overflow while preserving usage", async () => {
  const context = normalizeContext({
    messages: [{ role: "user", content: "Summarize", timestamp: 1 }],
  });
  const usage = {
    input: 120_000,
    output: 16,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120_016,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const cases: readonly (readonly [
    AssistantMessage["content"],
    AssistantMessage["content"],
  ])[] = [
    [[], []],
    [[{ type: "text", text: "   \n  " }], []],
    [
      [{ type: "thinking", thinking: "Let me think..." }],
      [{ type: "thinking", thinking: "Let me think..." }],
    ],
  ];
  for (const [content, expectedContent] of cases) {
    const emptyLength: AssistantMessage = {
      ...fauxAssistantMessage(content, {
        stopReason: "length",
        responseId: "resp_empty_length",
      }),
      usage,
    };
    const { provider, model } = fixture(() => streamOf(emptyLength));
    const result = await withModelOutputBudget(provider)
      .streamSimple(model, context)
      .result();
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, EMPTY_LENGTH_OVERFLOW_MESSAGE);
    assert.deepEqual(result.content, expectedContent);
    assert.deepEqual(result.usage, usage);
    assert.equal(result.responseId, "resp_empty_length");
    assert.equal(isContextOverflow(result, model.contextWindow), true);
  }
});

test("leaves length stops with text or tool calls unchanged", async () => {
  const context = normalizeContext({
    messages: [{ role: "user", content: "Write a long report", timestamp: 1 }],
  });
  for (const response of [
    fauxAssistantMessage("Long answer that hit the output limit.", {
      stopReason: "length",
    }),
    fauxAssistantMessage([fauxToolCall("platform.lookup", { id: "1" })], {
      stopReason: "length",
    }),
  ]) {
    const { provider, model } = fixture(() => streamOf(response));
    const result = await withModelOutputBudget(provider)
      .streamSimple(model, context)
      .result();
    assert.deepEqual(result, response);
  }
});

test("lets pre-aborted signals pass through instead of reporting context overflow", async () => {
  const abort = new AbortController();
  abort.abort();
  const hugeContext = normalizeContext({
    messages: [
      { role: "user", content: "earlier", timestamp: 1 },
      { ...fauxAssistantMessage("a".repeat(36_000)), timestamp: 2 },
      { role: "user", content: "x".repeat(500_000), timestamp: 3 },
    ],
  });
  let calls = 0;
  const { provider, model } = fixture(
    () => {
      calls++;
      const source = createAssistantMessageEventStream();
      source.push({
        type: "error",
        reason: "aborted",
        error: fauxAssistantMessage("", {
          stopReason: "aborted",
          errorMessage: "Model call cancelled",
        }),
      });
      source.end();
      return source;
    },
    { contextWindow: 128_000, maxOutputTokens: 4_096 },
  );
  const result = await withModelOutputBudget(provider)
    .streamSimple(model, hugeContext, { signal: abort.signal })
    .result();
  assert.equal(calls, 1);
  assert.equal(result.stopReason, "aborted");
});

test("rejects invalid minimum output token budgets", () => {
  const base = createDeterministicModelProvider().provider;
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => withModelOutputBudget(base, invalid), RangeError);
  }
});
