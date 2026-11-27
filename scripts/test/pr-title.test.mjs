import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadReleasableCommitTypes,
  validatePrTitle,
} from "../check-pr-title.mjs";

const CONFIG_PATH = fileURLToPath(
  new URL("../../.release-please-config.json", import.meta.url),
);

test("release-please config exposes all Conventional Commit types for version increments", () => {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const sections = config.packages["."]["changelog-sections"];
  assert.ok(Array.isArray(sections), "changelog-sections must be an array");

  for (const entry of sections) {
    assert.equal(typeof entry.type, "string");
    assert.ok(entry.type.length > 0);
    assert.equal(typeof entry.section, "string");
    assert.ok(entry.section.length > 0);
    assert.equal(
      entry.hidden,
      false,
      `changelog section for ${entry.type} must have hidden: false`,
    );
  }

  const types = new Set(loadReleasableCommitTypes(CONFIG_PATH));
  for (const required of [
    "feat",
    "feature",
    "fix",
    "perf",
    "revert",
    "deps",
    "build",
    "ci",
    "docs",
    "refactor",
    "test",
    "style",
    "chore",
  ]) {
    assert.ok(types.has(required), `missing commit type: ${required}`);
  }
});

test("accepts valid Conventional Commit PR titles including package updates", () => {
  const validTitles = [
    "chore(deps): refresh weekly dependencies",
    "deps: upgrade runtime dependencies",
    "fix(deps): patch vite vulnerability",
    "feat(VEC-2406, VEC-2419): OpenRouter on Responses and editable preset limits",
    "feat!: replace the session event envelope",
    "fix(db-postgres)!: require explicit tenant context",
    "docs: update release workflow guide",
    "build: bump Node.js baseline",
    "ci: validate pull request titles",
    "refactor(api): simplify lease renewal",
    "test(console): cover SSE reconnects",
    "style: format configuration files",
    "perf(events): coalesce query invalidations",
    "revert: revert temporary workaround",
  ];
  for (const title of validTitles) {
    assert.deepEqual(validatePrTitle(title), { ok: true }, title);
  }
});

test("rejects non-conventional or malformed PR titles", () => {
  const invalidTitles = [
    "",
    "   ",
    "Update packages",
    "Bump lodash from 1.0 to 2.0",
    "update(deps): refresh packages",
    "Chore(deps): refresh weekly dependencies",
    "chore(): missing scope text",
    "chore(   ): whitespace scope",
    "chore(deps):missing space",
    "chore(deps): ",
    "chore(deps): line one\nline two",
  ];
  for (const title of invalidTitles) {
    const result = validatePrTitle(title);
    assert.equal(result.ok, false, `expected invalid title: ${title}`);
    assert.ok(result.reason.length > 0);
  }
});
