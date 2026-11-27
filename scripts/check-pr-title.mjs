#!/usr/bin/env node
// Verifies that pull request titles targeting main use a Conventional Commit
// type configured in .release-please-config.json so that squash-merged PRs
// land with a releasable commit subject.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL("../.release-please-config.json", import.meta.url),
);

/** Returns the visible commit types from `.release-please-config.json`. */
export function loadReleasableCommitTypes(configPath = DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const sections = config?.packages?.["."]?.["changelog-sections"];
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error(
      "Expected packages['.']['changelog-sections'] in .release-please-config.json",
    );
  }
  const types = sections
    .filter((entry) => entry && entry.hidden !== true)
    .map((entry) => entry.type);
  if (types.length === 0) {
    throw new Error(
      "Expected at least one visible commit type in changelog-sections",
    );
  }
  return types;
}

/** Validates a Conventional Commit pull request title against `allowedTypes`. */
export function validatePrTitle(
  title,
  allowedTypes = loadReleasableCommitTypes(),
) {
  if (typeof title !== "string" || title.trim().length === 0) {
    return { ok: false, reason: "Pull request title must not be empty." };
  }
  if (/[\r\n]/.test(title)) {
    return {
      ok: false,
      reason: "Pull request title must be a single line.",
    };
  }
  const escapedTypes = allowedTypes.map((type) =>
    type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(
    `^(?:${escapedTypes.join("|")})(?:\\([^()\\r\\n]*\\S[^()\\r\\n]*\\))?!?: \\S`,
  );
  if (!pattern.test(title)) {
    return {
      ok: false,
      reason: `Pull request title must start with a Conventional Commit prefix (${allowedTypes.join(", ")}), optional (scope), optional !, and ": <description>" (use "revert: ..." for revert PRs).`,
    };
  }
  return { ok: true };
}

function main() {
  const title = process.env.PR_TITLE ?? process.argv[2] ?? "";
  const result = validatePrTitle(title);
  if (!result.ok) {
    console.error(`Invalid pull request title: ${JSON.stringify(title)}`);
    console.error(result.reason);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
