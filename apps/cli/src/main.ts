#!/usr/bin/env node

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parseDotEnv } from "./environment.js";
import { TerminalIo } from "./io.js";
import { runSetup } from "./setup.js";
import { stackAddresses, stackIsReady } from "./stack.js";

function help(): void {
  process.stdout.write(`OAO onboarding CLI

Usage:
  pnpm oao setup              Run the guided local setup
  pnpm oao doctor [--json]    Check system prerequisites without changing them
  pnpm oao status             Check local service readiness
  pnpm oao open               Open the local console
  pnpm oao reset [--yes]      Permanently delete local settings and database

The setup command keeps services attached to this terminal. Press Ctrl-C to stop
services started by this invocation.
`);
}

async function environment(
  repositoryRoot: string,
): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await readFile(resolve(repositoryRoot, ".env"), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw error;
  }
}

async function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "cmd.exe", args: ["/c", "start", "", url] }
        : { executable: "xdg-open", args: [url] };
  await new Promise<void>((resolvePromise, reject) => {
    execFile(command.executable, command.args, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "help";
  const repositoryRoot = process.cwd();
  if (command === "help" || command === "--help" || command === "-h") {
    help();
    return 0;
  }
  if (command === "doctor") {
    process.stderr.write(
      "Run doctor through the dependency-free entry point: pnpm oao doctor\n",
    );
    return 1;
  }
  if (command === "setup") {
    const result = await runSetup({ repositoryRoot, io: new TerminalIo() });
    if (argv.includes("--exit-after-setup")) {
      await result.stack.stop();
      return 0;
    }
    if (!result.stack.owned) return 0;
    process.stdout.write("\nOAO is running. Press Ctrl-C to stop it.\n");
    await new Promise<void>((resolvePromise) => {
      const stop = () => resolvePromise();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await result.stack.stop();
    return 0;
  }
  const values = await environment(repositoryRoot);
  const addresses = stackAddresses(values);
  if (command === "status") {
    const ready = await stackIsReady(addresses);
    process.stdout.write(
      ready
        ? `OAO is ready at ${addresses.consoleOrigin}.\n`
        : "OAO is not fully ready. Run pnpm oao doctor, then pnpm oao setup.\n",
    );
    return ready ? 0 : 1;
  }
  if (command === "open") {
    if (!(await stackIsReady(addresses))) {
      process.stderr.write("OAO is not ready. Run pnpm oao setup first.\n");
      return 1;
    }
    await openUrl(addresses.consoleOrigin);
    return 0;
  }
  help();
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
