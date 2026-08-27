#!/usr/bin/env node
/* global process */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPreflight, printPreflight } from "./preflight.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const args = process.argv.slice(2);
const commandName = args[0] ?? "help";
const json = args.includes("--json");

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function succeeds(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "ignore",
  });
  return result.status === 0;
}

if (commandName === "doctor") {
  const report = await collectPreflight({
    repositoryRoot,
    includeWorkspace: true,
  });
  printPreflight(report, { json });
  process.exitCode = report.ok ? 0 : 1;
} else if (commandName === "setup") {
  const report = await collectPreflight({
    repositoryRoot,
    includeWorkspace: false,
  });
  printPreflight(report, { json: false });
  if (!report.ok) {
    process.exitCode = 1;
  } else {
    process.stdout.write("\nInstalling the locked workspace dependencies…\n");
    const installStatus = run("pnpm", ["install", "--frozen-lockfile"]);
    if (installStatus !== 0) process.exitCode = installStatus;
    else {
      if (!succeeds("docker", ["image", "inspect", "postgres:17-alpine"])) {
        process.stdout.write("\nDownloading the pinned PostgreSQL 17 image…\n");
        const imageStatus = run("docker", ["pull", "postgres:17-alpine"]);
        if (imageStatus !== 0) {
          process.exitCode = imageStatus;
          process.exit();
        }
      }
      process.stdout.write(
        "\nBuilding the onboarding CLI and its dependencies…\n",
      );
      const buildStatus = run("pnpm", ["--filter", "@oao/cli...", "build"]);
      if (buildStatus !== 0) process.exitCode = buildStatus;
      else {
        const fullReport = await collectPreflight({
          repositoryRoot,
          includeWorkspace: true,
        });
        if (!fullReport.ok) {
          printPreflight(fullReport, { json: false });
          process.exitCode = 1;
        } else {
          process.exitCode = run(process.execPath, [
            resolve(repositoryRoot, "apps/cli/dist/main.js"),
            ...args,
          ]);
        }
      }
    }
  }
} else {
  const cliPath = resolve(repositoryRoot, "apps/cli/dist/main.js");
  if (!existsSync(cliPath)) {
    process.stderr.write(
      "The OAO CLI has not been built. Run pnpm oao setup first, or pnpm --filter @oao/cli... build.\n",
    );
    process.exitCode = 1;
  } else {
    process.exitCode = run(process.execPath, [cliPath, ...args]);
  }
}
