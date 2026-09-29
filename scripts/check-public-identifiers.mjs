#!/usr/bin/env node
// Keeps private deployment identifiers out of this public repository. Denied
// tokens are stored as SHA-256 digests so the check does not publish them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DENIED_TOKEN_DIGESTS = new Set([
  // Google Cloud project of a private deployment.
  "5bccce2206ac6594e65f2ebe7bd3d6a0cf9463cdd8b64d5b7f8f254647677b75",
  // Private downstream distribution repository.
  "cb39f83598e57e4ea9b4b685f9de4665a94b4cb288929a3f3f81f67a1642c5f7",
  // Private infrastructure repository.
  "1f7d9b322c5c2e231aae501d6ec89ced174f0f38f5d66b852049fd0b71c9d9e3",
]);

const PLACEHOLDER_PROJECTS = new Set([
  "example-project",
  "my-project",
  "project",
  "project-id",
]);

const CLOUD_IDENTIFIERS = [
  {
    label: "Google service account",
    pattern:
      /[a-z0-9-]+@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com/gi,
  },
  {
    label: "Artifact Registry repository",
    pattern: /[a-z0-9-]+-docker\.pkg\.dev\/([a-z][a-z0-9-]{4,28}[a-z0-9])\//gi,
  },
];

const digests = new Map();

function digest(token) {
  let value = digests.get(token);
  if (!value) {
    value = createHash("sha256").update(token).digest("hex");
    digests.set(token, value);
  }
  return value;
}

/** Returns the private identifiers found in `text`, one entry per match. */
export function findPrivateIdentifiers(
  text,
  deniedDigests = DENIED_TOKEN_DIGESTS,
) {
  const findings = [];
  text.split("\n").forEach((line, index) => {
    for (const token of line.toLowerCase().split(/[^a-z0-9_-]+/)) {
      if (token && deniedDigests.has(digest(token)))
        findings.push({ line: index + 1, reason: "private deployment name" });
    }
    for (const { label, pattern } of CLOUD_IDENTIFIERS) {
      for (const match of line.matchAll(pattern)) {
        if (!PLACEHOLDER_PROJECTS.has(match[1].toLowerCase()))
          findings.push({
            line: index + 1,
            reason: `${label} outside a placeholder project`,
          });
      }
    }
  });
  return findings;
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  let failed = false;
  for (const file of files) {
    const content = readFileSync(file);
    if (content.includes(0)) continue;
    for (const { line, reason } of findPrivateIdentifiers(content.toString())) {
      console.error(`${file}:${line}: ${reason}`);
      failed = true;
    }
  }
  if (failed) {
    console.error(
      "\nKeep deployment-specific identifiers in the downstream repository and use placeholders here. See CONTRIBUTING.md#keep-private-identifiers-out.",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
