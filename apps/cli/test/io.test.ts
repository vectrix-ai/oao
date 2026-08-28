import assert from "node:assert/strict";
import test from "node:test";

import {
  pickerMatches,
  transitionPicker,
  type PickerOption,
  type PickerState,
} from "../src/io.js";

const options: readonly PickerOption[] = [
  { label: "Claude Sonnet 4.6", value: "anthropic/claude-sonnet-4.6" },
  { label: "GPT-5.6 Pro", value: "openai/gpt-5.6-pro" },
  { label: "GPT-4o Mini", value: "openai/gpt-4o-mini" },
];

test("arrow selection wraps through provider-style choices", () => {
  const initial: PickerState = { query: "", selectedIndex: 0 };
  const up = transitionPicker(initial, "up", options, false);
  assert.equal(up.state.selectedIndex, 2);
  const selected = transitionPicker(up.state, "enter", options, false);
  assert.equal(selected.selected?.value, "openai/gpt-4o-mini");
});

test("search filters model labels and identifiers using every typed term", () => {
  assert.deepEqual(
    pickerMatches(options, "gpt pro").map((option) => option.value),
    ["openai/gpt-5.6-pro"],
  );
  assert.deepEqual(
    pickerMatches(options, "SONNET 4.6").map((option) => option.value),
    ["anthropic/claude-sonnet-4.6"],
  );
});

test("search typing, backspace, escape, arrows, and enter update predictably", () => {
  let state: PickerState = { query: "", selectedIndex: 0 };
  state = transitionPicker(state, { text: "g" }, options, true).state;
  state = transitionPicker(state, { text: "p" }, options, true).state;
  state = transitionPicker(state, { text: "t" }, options, true).state;
  state = transitionPicker(state, "down", options, true).state;
  assert.equal(
    transitionPicker(state, "enter", options, true).selected?.value,
    "openai/gpt-4o-mini",
  );
  state = transitionPicker(state, "backspace", options, true).state;
  assert.equal(state.query, "gp");
  state = transitionPicker(state, "escape", options, true).state;
  assert.deepEqual(state, { query: "", selectedIndex: 0 });
});
