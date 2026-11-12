import assert from "node:assert/strict";
import test from "node:test";
import {
  currentModelPromptCacheScope,
  withModelPromptCacheScope,
  withPromptCacheBreakpoints,
} from "../src/index.js";

const BREAKPOINT = { mode: "explicit" };

function breakpoints(payload: unknown): number {
  return JSON.stringify(payload).split('"prompt_cache_breakpoint"').length - 1;
}

test("breakpoints follow the instructions and the latest tool output", () => {
  const payload = {
    model: "@preset/azure-sol-61",
    input: [
      { role: "system", content: "Instructions." },
      { role: "user", content: [{ type: "input_text", text: "Order." }] },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "opaque",
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "match_location",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "LOC-1" },
    ],
  };
  const marked = withPromptCacheBreakpoints(payload) as typeof payload;
  assert.deepEqual(marked.input[0], {
    role: "system",
    content: [
      {
        type: "input_text",
        text: "Instructions.",
        prompt_cache_breakpoint: BREAKPOINT,
      },
    ],
  });
  // The first message keeps no breakpoint: the latest item carries it.
  assert.deepEqual(marked.input[1], payload.input[1]);
  assert.deepEqual(marked.input[2], payload.input[2]);
  assert.deepEqual(marked.input[4], {
    type: "function_call_output",
    call_id: "call_1",
    output: [
      {
        type: "input_text",
        text: "LOC-1",
        prompt_cache_breakpoint: BREAKPOINT,
      },
    ],
  });
  assert.equal(breakpoints(marked), 2);
  // The request Pi built is left as it was.
  assert.equal(payload.input[0]?.content, "Instructions.");
});

test("the latest image block and tool output arrays carry the breakpoint", () => {
  const image = { type: "input_image", detail: "auto", image_url: "data:x" };
  const marked = withPromptCacheBreakpoints({
    input: [
      { role: "developer", content: [{ type: "input_text", text: "I." }] },
      {
        role: "user",
        content: [{ type: "input_text", text: "Look." }, image],
      },
    ],
  }) as { input: { content: unknown[] }[] };
  assert.deepEqual(marked.input[1]?.content, [
    { type: "input_text", text: "Look." },
    { ...image, prompt_cache_breakpoint: BREAKPOINT },
  ]);

  const output = withPromptCacheBreakpoints({
    input: [
      { role: "user", content: "Look." },
      {
        type: "function_call_output",
        call_id: "c",
        output: [{ type: "input_text", text: "a" }, image],
      },
    ],
  }) as { input: { output?: unknown[] }[] };
  assert.deepEqual(output.input[1]?.output, [
    { type: "input_text", text: "a" },
    { ...image, prompt_cache_breakpoint: BREAKPOINT },
  ]);
});

test("the stable prefix of the first user message ends in its own breakpoint", () => {
  const stable = "<oao-run>\nProject rules";
  const scope = {
    stablePrefixLength: (text: string) =>
      text.startsWith(stable) ? stable.length : undefined,
  };
  const first = {
    role: "user",
    content: [{ type: "input_text", text: `${stable} and the email.` }],
  };
  const firstCall = withPromptCacheBreakpoints(
    { input: [{ role: "system", content: "I." }, first] },
    scope,
  ) as { input: { content: unknown[] }[] };
  assert.deepEqual(firstCall.input[1]?.content, [
    { type: "input_text", text: stable, prompt_cache_breakpoint: BREAKPOINT },
    {
      type: "input_text",
      text: " and the email.",
      prompt_cache_breakpoint: BREAKPOINT,
    },
  ]);
  assert.equal(breakpoints(firstCall), 3);

  // A follow-up run replays the first message with the same split.
  const followUp = withPromptCacheBreakpoints(
    {
      input: [
        { role: "system", content: "I." },
        first,
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: `${stable} again?` }],
        },
      ],
    },
    scope,
  ) as { input: { content: unknown[] }[] };
  assert.deepEqual(followUp.input[1]?.content, [
    { type: "input_text", text: stable, prompt_cache_breakpoint: BREAKPOINT },
    { type: "input_text", text: " and the email." },
  ]);
  // Only the first stable prefix is split; the latest message gets the end marker.
  assert.deepEqual(followUp.input[3]?.content, [
    {
      type: "input_text",
      text: `${stable} again?`,
      prompt_cache_breakpoint: BREAKPOINT,
    },
  ]);
  assert.equal(breakpoints(followUp), 3);
});

test("a stable prefix outside the text is ignored", () => {
  const payload = {
    input: [{ role: "user", content: [{ type: "input_text", text: "Hi." }] }],
  };
  for (const length of [0, -1, 4, 1.5, Number.NaN])
    assert.deepEqual(
      withPromptCacheBreakpoints(payload, { stablePrefixLength: () => length }),
      {
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Hi.",
                prompt_cache_breakpoint: BREAKPOINT,
              },
            ],
          },
        ],
      },
    );
  // A prefix that is the whole block marks it once.
  assert.equal(
    breakpoints(
      withPromptCacheBreakpoints(payload, { stablePrefixLength: () => 3 }),
    ),
    1,
  );
});

test("requests without input are returned unchanged", () => {
  assert.equal(withPromptCacheBreakpoints("text"), "text");
  const payload = { model: "m", input: "Say OK." };
  assert.equal(withPromptCacheBreakpoints(payload), payload);
});

test("a prompt cache scope is visible only to the calls it runs", async () => {
  assert.equal(currentModelPromptCacheScope(), undefined);
  const seen = await withModelPromptCacheScope({ key: "k" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return currentModelPromptCacheScope()?.key;
  });
  assert.equal(seen, "k");
  assert.equal(currentModelPromptCacheScope(), undefined);
});
