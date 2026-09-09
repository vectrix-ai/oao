import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type Provider,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  createDeterministicModelProvider,
  fauxAssistantMessage,
  fauxToolCall,
  MODEL_CALL_TIMEOUT_MS,
  withModelCallTimeout,
} from "../src/index.js";

const context = { messages: [] };

function fixture(
  start: (options?: StreamOptions) => ReturnType<Provider["streamSimple"]>,
) {
  const base = createDeterministicModelProvider().provider;
  const provider: Provider = {
    ...base,
    stream: (_model, _context, options) => start(options),
    streamSimple: (_model, _context, options) => start(options),
  };
  const model = base.getModels()[0]!;
  return { provider, model };
}

test("a five-minute deadline bounds both stream entrypoints even if the provider ignores abort", async () => {
  assert.equal(MODEL_CALL_TIMEOUT_MS, 300_000);
  for (const method of ["stream", "streamSimple"] as const) {
    let signal: AbortSignal | undefined;
    const { provider, model } = fixture((options) => {
      signal = options?.signal;
      assert.equal(options?.maxRetries, 0);
      assert.equal(options?.timeoutMs, 15);
      return createAssistantMessageEventStream();
    });
    const bounded = withModelCallTimeout(provider, 15);
    const result = await bounded[method](model, context, {
      maxRetries: 99,
    }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, /timed out after 15ms/u);
    assert.deepEqual(result.content, []);
    assert.equal(signal?.aborted, true);
  }
});

test("streaming activity does not reset the total attempt deadline and late tool calls are discarded", async () => {
  const source = createAssistantMessageEventStream();
  const partial = fauxAssistantMessage("partial");
  const { provider, model } = fixture(() => source);
  const stream = withModelCallTimeout(provider, 30).streamSimple(
    model,
    context,
  );
  const heartbeat = setInterval(
    () =>
      source.push({ type: "text_delta", contentIndex: 0, delta: "x", partial }),
    5,
  );
  try {
    const result = await stream.result();
    assert.equal(result.stopReason, "error");
    source.push({
      type: "done",
      reason: "toolUse",
      message: fauxAssistantMessage([fauxToolCall("platform.late", {})], {
        stopReason: "toolUse",
      }),
    });
    const events = [];
    for await (const event of stream) events.push(event);
    assert.ok(events.some((event) => event.type === "text_delta"));
    assert.equal(events.filter((event) => event.type === "error").length, 1);
    assert.equal(
      events.some((event) => event.type === "done"),
      false,
    );
  } finally {
    clearInterval(heartbeat);
  }
});

test("cancellation is an aborted outcome, not a retryable timeout", async () => {
  for (const preAborted of [true, false]) {
    const abort = new AbortController();
    let calls = 0;
    const { provider, model } = fixture(() => {
      calls++;
      return createAssistantMessageEventStream();
    });
    if (preAborted) abort.abort();
    const stream = withModelCallTimeout(provider, 10_000).streamSimple(
      model,
      context,
      { signal: abort.signal },
    );
    abort.abort();
    assert.equal((await stream.result()).stopReason, "aborted");
    assert.equal(calls, preAborted ? 0 : 1);
  }
});

test("successful streams preserve output, options and usage without being retried", async () => {
  const response = fauxAssistantMessage("completed");
  let calls = 0;
  const { provider, model } = fixture((options) => {
    calls++;
    assert.equal(options?.sessionId, "cache-affinity");
    const source = createAssistantMessageEventStream();
    source.push({ type: "done", reason: "stop", message: response });
    return source;
  });
  const result = await withModelCallTimeout(provider, 20)
    .streamSimple(model, context, { sessionId: "cache-affinity" })
    .result();
  assert.deepEqual(result, response);
  assert.equal(calls, 1);
});

test("provider errors retain their classification for the durable retry layer", async () => {
  for (const error of [
    "503 Service unavailable",
    "401 Unauthorized",
    "Platform model turn limit exceeded (32)",
  ]) {
    const { provider, model } = fixture(() => {
      throw new Error(error);
    });
    const result = await withModelCallTimeout(provider, 100)
      .streamSimple(model, context)
      .result();
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, error);
  }
});
