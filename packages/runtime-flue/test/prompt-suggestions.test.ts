import assert from "node:assert/strict";
import test from "node:test";
import type { FlueObservation } from "@flue/runtime";
import { runtimeTesting } from "../src/index.js";
import {
  PROMPT_SUGGESTION_INSTRUCTION,
  replySuggestion,
  withoutSuggestionLines,
} from "../src/prompt-suggestions.js";

const line = (message: string) =>
  `<next_user_message>${message}</next_user_message>`;

test("a reply's last line holds the suggestion, as a user would send it", () => {
  assert.equal(
    replySuggestion(
      `ORD-1592 is ready.\n\n${line("Release ORD-1592 to the carrier")}`,
    ),
    "Release ORD-1592 to the carrier",
  );
  // Layout around the line and inside it is not part of the message.
  assert.equal(
    replySuggestion(
      `Done.\n  ${line('  "Release   ORD-1592 to the carrier" ')}  \n\n`,
    ),
    "Release ORD-1592 to the carrier",
  );
  assert.equal(
    replySuggestion(`Klaar.\n${line("“Bevestig order 1592”")}`),
    "Bevestig order 1592",
  );
  // Quotes inside the message stay.
  assert.equal(
    replySuggestion(`Done.\n${line('Rename "Acme" to "Acme BV"')}`),
    'Rename "Acme" to "Acme BV"',
  );
  // PostgreSQL text rejects NUL; it is replaced as in an assistant reply.
  assert.equal(replySuggestion(`Done.\n${line("Ship\u0000it")}`), "Ship�it");
});

test("a reply without a usable last line has no suggestion", () => {
  for (const reply of [
    "",
    "ORD-1592 is ready.",
    // Not the last line: the model wrote it too early.
    `${line("Release ORD-1592")}\nORD-1592 is ready.`,
    `ORD-1592 is ready.\n${line("Release ORD-1592")}\n[[choices: Yes | No]]`,
    // Cut off before the closing tag.
    "ORD-1592 is ready.\n<next_user_message>Release ORD",
    // Nothing a user would send.
    `Done.\n${line("")}`,
    `Done.\n${line("NONE")}`,
    `Done.\n${line("(no clear next step)")}`,
    // Not one message.
    `Done.\n${line("One")}${line("Two")}`,
    // Longer than a message someone would send: dropped, not cut.
    `Done.\n${line("x".repeat(501))}`,
  ])
    assert.equal(replySuggestion(reply), undefined, reply.slice(0, 60));
  assert.equal(replySuggestion(`Done.\n${line("x".repeat(500))}`)?.length, 500);
});

test("suggestion lines are cut from text wherever the model wrote them", () => {
  assert.equal(
    withoutSuggestionLines(
      `ORD-1592 is ready.\n\n${line("Release ORD-1592")}`,
    ).trimEnd(),
    "ORD-1592 is ready.",
  );
  // A marker that must be the reply's last line is the last line again.
  assert.equal(
    withoutSuggestionLines(
      `Apply the rule?\n\n[[choices: Accept | Deny]]\n${line("Accept")}`,
    ).trimEnd(),
    "Apply the rule?\n\n[[choices: Accept | Deny]]",
  );
  assert.equal(
    withoutSuggestionLines(
      `Apply the rule?\n${line("Accept")}\n[[choices: Accept | Deny]]`,
    ),
    "Apply the rule?\n[[choices: Accept | Deny]]",
  );
  // Also a line the model did not finish, and more than one line.
  assert.equal(
    withoutSuggestionLines(
      `First.\n  <next_user_message>Cut off\nSecond.\n${line("Next")}`,
    ).trimEnd(),
    "First.\nSecond.",
  );
  // Text without a line is returned as it is, and a tag inside a sentence is
  // the model's own text.
  const plain = "Use <next_user_message> only as the last line.\n";
  assert.equal(withoutSuggestionLines(plain), plain);
});

test("the instruction asks for the line the runtime reads", () => {
  assert.match(
    PROMPT_SUGGESTION_INSTRUCTION,
    /<next_user_message>the message<\/next_user_message>/u,
  );
  const base = {
    systemPrompt: "Help with orders.",
    tools: [],
    delegates: [],
  };
  // Off unless the agent version turns it on: the prompt is unchanged.
  assert.equal(
    runtimeTesting.managedSystemPrompt(base as never),
    "Help with orders.",
  );
  assert.equal(
    runtimeTesting.managedSystemPrompt({
      ...base,
      promptSuggestions: true,
    } as never),
    `Help with orders.\n\n${PROMPT_SUGGESTION_INSTRUCTION}`,
  );
});

function turn(
  submissionId: string,
  content: readonly Record<string, unknown>[],
): FlueObservation {
  return {
    v: 3,
    eventIndex: 0,
    timestamp: "2026-10-11T12:00:00.000Z",
    type: "turn",
    turnId: `turn-${Math.random()}`,
    purpose: "agent",
    durationMs: 1,
    request: {},
    response: { output: { role: "assistant", content } },
    isError: false,
    submissionId,
  } as unknown as FlueObservation;
}

test("text published before a run settles never shows a suggestion line", async () => {
  const pending = runtimeTesting.createPendingAssistantText();
  pending.cutSuggestionLines("run-1");
  pending.observe(
    turn("submission-1", [
      { type: "text", text: `Reading the order.\n${line("Too early")}` },
      { type: "toolCall", id: "call-read", name: "get_order" },
    ]),
  );
  pending.observe(
    turn("submission-1", [
      // A turn whose only text is the line publishes nothing.
      { type: "text", text: line("Still too early") },
      { type: "toolCall", id: "call-check", name: "check_order" },
    ]),
  );
  pending.observe(
    turn("submission-1", [
      { type: "text", text: `Now: EUR, after: CHF.\n${line("Approve")}` },
      { type: "toolCall", id: "call-update", name: "update_rule" },
    ]),
  );

  // Each tool-calling turn's own message.
  const committed: string[] = [];
  await pending.publishThrough(
    "call-check",
    async (segments) => {
      committed.push(...segments.map((segment) => segment.text));
      return true;
    },
    { runId: "run-1" },
  );
  assert.deepEqual(committed, ["Reading the order."]);

  // The explanation a gated call commits with its approval.
  const claim = await pending.take("call-update", undefined, "run-1");
  assert.equal(claim?.text, "Now: EUR, after: CHF.");

  // A run without the setting keeps its text exactly as written.
  const other = runtimeTesting.createPendingAssistantText();
  other.observe(
    turn("submission-2", [
      { type: "text", text: `Reading.\n${line("Kept")}` },
      { type: "toolCall", id: "call-other", name: "get_order" },
    ]),
  );
  assert.equal(
    (await other.take("call-other", undefined, "run-2"))?.text,
    `Reading.\n${line("Kept")}`,
  );
});

test("the settled reply still drops committed text after its lines were cut", () => {
  // What Flue returns: every turn's text, with the lines the model wrote.
  const reply = [
    `Reading the order.\n${line("Too early")}`,
    `Now: EUR, after: CHF.\n${line("Approve")}`,
    `The rule was updated.\n\n${line("Show me rule fca-pickup")}`,
  ].join("\n\n");
  assert.equal(replySuggestion(reply), "Show me rule fca-pickup");
  assert.equal(
    runtimeTesting.replyAfterCommittedText(
      withoutSuggestionLines(reply).trimEnd(),
      ["Reading the order.", "Now: EUR, after: CHF."],
    ),
    "The rule was updated.",
  );
});

test("only a final turn that wrote text can end the reply with a suggestion", () => {
  const pending = runtimeTesting.createPendingAssistantText();
  // A submission this worker did not observe is not judged.
  assert.equal(pending.endsWithReply("submission-1"), undefined);
  pending.observe(
    turn("submission-1", [
      { type: "text", text: `Asking.\n${line("Too early")}` },
      { type: "toolCall", id: "call-ask", name: "ask_user" },
    ]),
  );
  // The run ends on the tool call: its last words predate the tool's result.
  assert.equal(pending.endsWithReply("submission-1"), false);
  pending.observe(turn("submission-1", [{ type: "text", text: "  " }]));
  assert.equal(pending.endsWithReply("submission-1"), false);
  // A final turn that writes only the line has not replied either.
  pending.observe(
    turn("submission-1", [{ type: "text", text: line("Pick Monday") }]),
  );
  assert.equal(pending.endsWithReply("submission-1"), false);
  pending.observe(
    turn("submission-1", [{ type: "text", text: `Done.\n${line("Next")}` }]),
  );
  assert.equal(pending.endsWithReply("submission-1"), true);
  // A run without any tool call ends with its only turn's text.
  pending.observe(turn("submission-2", [{ type: "text", text: "Hello." }]));
  assert.equal(pending.endsWithReply("submission-2"), true);
});
