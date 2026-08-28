/* global AbortSignal, fetch, process */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseDotEnvContents } from "./preflight.mjs";

const DATABASE_VOLUME = "oao-postgres-data";
const DOCKER_CONTEXT_FILE = ".oao/docker-context";

function command(executable, args, options = {}) {
  try {
    return {
      ok: true,
      output: execFileSync(executable, args, {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      output:
        error && typeof error === "object" && "stderr" in error
          ? String(error.stderr).trim()
          : "",
    };
  }
}

async function jsonReady(url, expected) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return false;
    return expected(await response.json());
  } catch {
    return false;
  }
}

async function consoleReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    return (
      response.ok &&
      (await response.text()).includes("<title>OAO Console</title>")
    );
  } catch {
    return false;
  }
}

async function environment(repositoryRoot) {
  const path = resolve(repositoryRoot, ".env");
  if (!existsSync(path)) return {};
  return parseDotEnvContents(await readFile(path, "utf8"));
}

export async function inspectLocalServices(repositoryRoot) {
  const values = await environment(repositoryRoot);
  const apiPort = values.OAO_API_PORT ?? "3000";
  const runtimePort = values.OAO_RUNTIME_PORT ?? "8788";
  const consolePort = values.OAO_CONSOLE_PORT ?? "8080";
  return {
    api: await jsonReady(
      `http://127.0.0.1:${apiPort}/readyz`,
      (body) => body?.status === "ready",
    ),
    runtime: await jsonReady(
      `http://127.0.0.1:${runtimePort}/readyz`,
      (body) =>
        body?.status === "ready" && body?.profile === "project-providers",
    ),
    console: await consoleReady(`http://127.0.0.1:${consolePort}`),
  };
}

export async function recordDockerContext(
  repositoryRoot,
  runCommand = command,
) {
  const context = requireCommand(
    runCommand("docker", ["context", "show"], { cwd: repositoryRoot }),
    "Could not determine the active Docker context.",
  ).output;
  if (!context) throw new Error("Docker returned an empty active context name");
  const directory = resolve(repositoryRoot, ".oao");
  const path = resolve(repositoryRoot, DOCKER_CONTEXT_FILE);
  if (existsSync(path)) {
    const recorded = (await readFile(path, "utf8")).trim();
    if (recorded && recorded !== context) {
      throw new Error(
        `Active Docker context ${context} differs from setup context ${recorded}; switch back with docker context use ${recorded}.`,
      );
    }
    return recorded || context;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${context}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return context;
}

async function readConfirmation() {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Reset requires an interactive terminal. Pass --yes only when permanent deletion is intended.",
    );
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await readline.question("Type RESET to continue: ")).trim();
  } finally {
    readline.close();
  }
}

function requireCommand(result, failureMessage) {
  if (result.ok) return result;
  throw new Error(
    result.output ? `${failureMessage}\n${result.output}` : failureMessage,
  );
}

export async function resetLocalState({
  repositoryRoot,
  assumeYes = false,
  write = (message) => process.stdout.write(message),
  confirm = readConfirmation,
  inspectServices = inspectLocalServices,
  runCommand = command,
  removePath = (path) => rmSync(path, { recursive: true, force: true }),
} = {}) {
  const root = repositoryRoot ?? process.cwd();
  const services = await inspectServices(root);
  const running = Object.entries(services)
    .filter(([, ready]) => ready)
    .map(([name]) => name);
  if (running.length > 0) {
    throw new Error(
      `OAO ${running.join(", ")} ${running.length === 1 ? "is" : "are"} still running. Stop the setup/dev:local terminal with Ctrl-C, then run pnpm oao reset again.`,
    );
  }

  write(
    `This permanently deletes:\n- the ${DATABASE_VOLUME} Docker volume and all local OAO records\n- .env and its local settings\n- .oao setup state and logs\n\nDependencies and Docker images are kept.\n`,
  );
  if (!assumeYes && (await confirm()) !== "RESET") {
    write("Reset cancelled; nothing was deleted.\n");
    return { reset: false, removedVolume: false };
  }

  const activeContext = requireCommand(
    runCommand("docker", ["context", "show"], { cwd: root }),
    "Could not determine the active Docker context; no settings were deleted.",
  ).output;
  const contextPath = resolve(root, DOCKER_CONTEXT_FILE);
  if (existsSync(contextPath)) {
    const setupContext = (await readFile(contextPath, "utf8")).trim();
    if (setupContext && activeContext !== setupContext) {
      throw new Error(
        `Active Docker context ${activeContext} differs from setup context ${setupContext}; switch back with docker context use ${setupContext}. Nothing was deleted.`,
      );
    }
  }

  requireCommand(
    runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], {
      cwd: root,
    }),
    "Docker CLI cannot reach the active daemon/context; no settings were deleted.",
  );
  requireCommand(
    runCommand(resolve(root, "infra/compose/down.sh"), [], { cwd: root }),
    "Could not stop and remove the local PostgreSQL container; no settings were deleted.",
  );
  const volumes = requireCommand(
    runCommand(
      "docker",
      ["volume", "ls", "--quiet", "--filter", `name=^${DATABASE_VOLUME}$`],
      { cwd: root },
    ),
    "Could not inspect the local Docker volume; no settings were deleted.",
  );
  const volumeExists = volumes.output
    .split(/\r?\n/u)
    .some((name) => name === DATABASE_VOLUME);
  if (volumeExists) {
    requireCommand(
      runCommand("docker", ["volume", "rm", DATABASE_VOLUME], { cwd: root }),
      `Could not remove ${DATABASE_VOLUME}; no settings were deleted.`,
    );
  }

  removePath(resolve(root, ".env"));
  removePath(resolve(root, ".oao"));
  write(
    `Reset complete. Run pnpm oao doctor, then pnpm oao setup to create a fresh local environment.\n`,
  );
  return { reset: true, removedVolume: volumeExists };
}

export { DATABASE_VOLUME };
