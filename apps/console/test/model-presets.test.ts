import { describe, expect, it } from "vitest";
import {
  MODEL_PRESET_KEY_PATTERN,
  suggestPresetKey,
} from "../src/model-presets";

describe("suggestPresetKey", () => {
  it("derives a valid versioned key from a catalog model name", () => {
    const key = suggestPresetKey("Claude Sonnet 4.6", []);
    expect(key).toBe("claude-sonnet-4-6-v1");
    expect(MODEL_PRESET_KEY_PATTERN.test(key)).toBe(true);
  });

  it("walks forward past keys this project already published", () => {
    expect(suggestPresetKey("GPT-5.1", ["gpt-5-1-v1", "gpt-5-1-v2"])).toBe(
      "gpt-5-1-v3",
    );
  });

  it("keeps the key valid when the model name starts with a digit", () => {
    const key = suggestPresetKey("4o mini", []);
    expect(key).toBe("model-4o-mini-v1");
    expect(MODEL_PRESET_KEY_PATTERN.test(key)).toBe(true);
  });
});
