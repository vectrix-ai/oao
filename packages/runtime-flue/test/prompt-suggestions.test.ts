import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantMessage,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createDeterministicModelProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@oao/models-openrouter";
import {
  PROMPT_SUGGESTION_INSTRUCTION,
  PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS,
  PromptSuggestionCapture,
  isFinalReply,
  promptSuggestionText,
  requestPromptSuggestion,
} from "../src/prompt-suggestions.js";

const answer = (
  text: string,
  options?: Parameters<typeof fauxAssistantMessage>[1],
) => fauxAssistantMessage(text, options);

test("a suggestion is the model's text as a user would send it", () => {
  assert.equal(
    promptSuggestionText(answer("Release ORD-1592 to the carrier")),
    "Release ORD-1592 to the carrier",
  );
  // Wrapping quotes and layout are not part of the message.
  assert.equal(
    promptSuggestionText(answer('  "Release ORD-1592\n to the carrier"  ')),
    "Release ORD-1592 to the carrier",
  );
  assert.equal(
    promptSuggestionText(answer("“Bevestig order 1592”")),
    "Bevestig order 1592",
  );
  // Quotes inside the message stay.
  assert.equal(
    promptSuggestionText(answer('Rename "Acme" to "Acme BV"')),
    'Rename "Acme" to "Acme BV"',
  );
  // PostgreSQL text rejects NUL; it is replaced as in an assistant reply.
  assert.equal(promptSuggestionText(answer("Ship\u0000it")), "Ship\ufffdit");
});

test("an answer without a usable message is no suggestion", () => {
  for (const text of [
    "",
    "   ",
    "NONE",
    "none.",
    '"NONE"',
    "(no clear next step)",
    "No suggestion",
    "N/A",
  ])
    assert.equal(promptSuggestionText(answer(text)), undefined, text);
  // Longer than a message someone would send: dropped, not cut.
  assert.equal(promptSuggestionText(answer("x".repeat(501))), undefined);
  assert.equal(promptSuggestionText(answer("x".repeat(500)))?.length, 500);
  // Cut off by the output limit.
  assert.equal(
    promptSuggestionText(answer("Release ORD", { stopReason: "length" })),
    undefined,
  );
  // The model was told not to use tools; a tool call is not a message.
  assert.equal(
    promptSuggestionText(
      fauxAssistantMessage(
        [
          { type: "text", text: "Release ORD-1592" },
          fauxToolCall("lookup", { order: "ORD-1592" }),
        ],
        { stopReason: "toolUse" },
      ),
    ),
    undefined,
  );
  assert.equal(
    promptSuggestionText(
      answer("", { stopReason: "error", errorMessage: "boom" }),
    ),
    undefined,
  );
});

test("only a reply with text that ends the run is a final reply", () => {
  assert.equal(isFinalReply(answer("Done.")), true);
  assert.equal(isFinalReply(undefined), false);
  assert.equal(isFinalReply(answer("")), false);
  assert.equal(
    isFinalReply(answer("Partial", { stopReason: "length" })),
    false,
  );
  assert.equal(
    isFinalReply(
      fauxAssistantMessage(
        [{ type: "text", text: "Checking" }, fauxToolCall("lookup", {})],
        { stopReason: "toolUse" },
      ),
    ),
    false,
  );
});

interface SeenCall {
  readonly context: TranscriptContext;
  readonly options: SimpleStreamOptions | undefined;
}

function harness(scratch: () => boolean = () => false) {
  const seen: SeenCall[] = [];
  const respond: FauxResponseStep = (context, options) => {
    seen.push({ context, options });
    const last = context.messages.at(-1);
    return last?.role === "user" &&
      last.content === PROMPT_SUGGESTION_INSTRUCTION
      ? fauxAssistantMessage("Release ORD-1592 now")
      : fauxAssistantMessage(`reply ${seen.length}`);
  };
  const fake = createDeterministicModelProvider(
    Array.from({ length: 16 }, () => respond),
  );
  const capture = new PromptSuggestionCapture(scratch);
  const provider = capture.wrap(fake.provider);
  const model = fake.getModel();
  /** One model request as Flue makes it: observed, intercepted, then sent. */
  const call = async (input: {
    readonly instanceId: string | undefined;
    readonly turnId: string;
    readonly purpose?: string;
    readonly prompt: string;
    readonly options?: SimpleStreamOptions;
  }): Promise<AssistantMessage> => {
    capture.observe({
      type: "turn_request",
      turnId: input.turnId,
      purpose: input.purpose ?? "agent",
    });
    const context = {
      messages: [{ role: "user", content: input.prompt, timestamp: 1 }],
    } as unknown as TranscriptContext;
    const message = await capture.withModelCall(
      { instanceId: input.instanceId, turnId: input.turnId },
      async () => {
        // The interceptor awaits before the provider is called.
        await Promise.resolve();
        return provider.streamSimple(model, context, input.options).result();
      },
    );
    capture.observe({ type: "turn", turnId: input.turnId, purpose: "agent" });
    return message;
  };
  return { capture, call, seen };
}

test("the last main-loop request of a tracked run is kept until it is taken", async () => {
  const { capture, call } = harness();
  capture.track("instance-a", "run-1");
  await call({ instanceId: "instance-a", turnId: "t1", prompt: "first" });
  await call({ instanceId: "instance-a", turnId: "t2", prompt: "second" });
  // Another run's id does not get this run's request.
  assert.equal(capture.take("instance-a", "run-0"), undefined);
  const captured = capture.take("instance-a", "run-1");
  assert.ok(captured);
  assert.equal(captured.runId, "run-1");
  assert.equal(
    (captured.context.messages[0] as { content: string }).content,
    "second",
  );
  assert.equal(isFinalReply(await captured.reply), true);
  // Taken once.
  assert.equal(capture.take("instance-a", "run-1"), undefined);
});

test("requests that are not a tracked run's own turns are not kept", async () => {
  let scratch = false;
  const { capture, call } = harness(() => scratch);
  // The setting is off: the instance is not tracked.
  await call({ instanceId: "instance-off", turnId: "t1", prompt: "off" });
  assert.equal(capture.take("instance-off", "run-1"), undefined);

  capture.track("instance-a", "run-1");
  // A compaction call of the same run.
  await call({
    instanceId: "instance-a",
    turnId: "t2",
    purpose: "compaction",
    prompt: "summarize",
  });
  // A scratch turn inside a Harness Operation.
  scratch = true;
  await call({ instanceId: "instance-a", turnId: "t3", prompt: "scratch" });
  scratch = false;
  // A request Flue did not attribute to an agent instance.
  await call({ instanceId: undefined, turnId: "t4", prompt: "unattributed" });
  assert.equal(capture.take("instance-a", "run-1"), undefined);

  // Turning the setting off for the instance drops what was kept.
  capture.track("instance-a", "run-1");
  await call({ instanceId: "instance-a", turnId: "t5", prompt: "kept" });
  capture.track("instance-a", undefined);
  assert.equal(capture.take("instance-a", "run-1"), undefined);
});

test("a newer run of the same instance replaces the previous run's request", async () => {
  const { capture, call } = harness();
  capture.track("instance-a", "run-1");
  await call({ instanceId: "instance-a", turnId: "t1", prompt: "first run" });
  capture.track("instance-a", "run-2");
  assert.equal(capture.take("instance-a", "run-2"), undefined);
  await call({ instanceId: "instance-a", turnId: "t2", prompt: "second run" });
  assert.equal(capture.take("instance-a", "run-1"), undefined);
  assert.equal(capture.take("instance-a", "run-2")?.runId, "run-2");
});

test("the suggestion request replays the run's last request with only the tail added", async () => {
  const { capture, call, seen } = harness();
  capture.track("instance-a", "run-1");
  const onPayload = () => undefined;
  await call({
    instanceId: "instance-a",
    turnId: "t1",
    prompt: "Where is ORD-1592?",
    options: { sessionId: "aff_1", reasoning: "high", onPayload },
  });
  const captured = capture.take("instance-a", "run-1");
  assert.ok(captured);
  const controller = new AbortController();
  const call2 = await requestPromptSuggestion(captured, controller.signal);
  assert.ok(call2);
  assert.equal(call2.text, "Release ORD-1592 now");
  assert.ok(call2.completedAt.getTime() >= call2.startedAt.getTime());

  const [original, replay] = seen;
  assert.ok(original && replay);
  // The earlier messages are the same objects, in the same order.
  assert.equal(
    replay.context.messages.length,
    original.context.messages.length + 2,
  );
  original.context.messages.forEach((message, index) =>
    assert.equal(replay.context.messages[index], message),
  );
  assert.equal(replay.context.messages.at(-2), await captured.reply);
  assert.deepEqual(
    {
      role: replay.context.messages.at(-1)?.role,
      content: (replay.context.messages.at(-1) as { content: unknown }).content,
    },
    { role: "user", content: PROMPT_SUGGESTION_INSTRUCTION },
  );
  // Same options, apart from the output limit and the abort signal.
  assert.equal(replay.options?.sessionId, "aff_1");
  assert.equal(replay.options?.reasoning, "high");
  assert.equal(replay.options?.onPayload, onPayload);
  assert.equal(replay.options?.maxTokens, PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS);
  assert.notEqual(replay.options?.signal, original.options?.signal);
  // The replay itself is not captured: nothing loops.
  assert.equal(capture.take("instance-a", "run-1"), undefined);
});

test("a run that did not end with a reply asks for no suggestion", async () => {
  const seen: unknown[] = [];
  const fake = createDeterministicModelProvider([
    (context) => {
      seen.push(context);
      return fauxAssistantMessage([fauxToolCall("lookup", {})], {
        stopReason: "toolUse",
      });
    },
  ]);
  const capture = new PromptSuggestionCapture(() => false);
  capture.track("instance-a", "run-1");
  capture.observe({ type: "turn_request", turnId: "t1", purpose: "agent" });
  await capture.withModelCall({ instanceId: "instance-a", turnId: "t1" }, () =>
    capture
      .wrap(fake.provider)
      .streamSimple(fake.getModel(), {
        messages: [{ role: "user", content: "go", timestamp: 1 }],
      } as unknown as TranscriptContext)
      .result(),
  );
  const captured = capture.take("instance-a", "run-1");
  assert.ok(captured);
  assert.equal(
    await requestPromptSuggestion(captured, new AbortController().signal),
    undefined,
  );
  assert.equal(seen.length, 1);
});
