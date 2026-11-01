#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  postgresAddress,
  probePostgres,
  savedPostgresOverrides,
} from "../../apps/cli/bootstrap/postgres-probe.mjs";
import { parseDotEnvContents } from "../../apps/cli/bootstrap/preflight.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
// `node --env-file-if-exists` keeps exported values, so the database that
// `pnpm oao setup` saved in .env is applied over them here.
const environmentPath = resolve(repositoryRoot, ".env");
const savedPostgres = savedPostgresOverrides(
  existsSync(environmentPath)
    ? parseDotEnvContents(readFileSync(environmentPath, "utf8"))
    : {},
);
if (
  savedPostgres.DATABASE_URL &&
  process.env.DATABASE_URL &&
  process.env.DATABASE_URL !== savedPostgres.DATABASE_URL
)
  process.stdout.write(
    "Using the PostgreSQL database that pnpm oao setup saved in .env, not the exported DATABASE_URL.\n",
  );
Object.assign(process.env, savedPostgres);
const composeFile = fileURLToPath(
  new URL("./docker-compose.yml", import.meta.url),
);
const databaseDownScript = fileURLToPath(new URL("./down.sh", import.meta.url));
const apiPort = process.env.OAO_API_PORT ?? "3000";
const runtimePort = process.env.OAO_RUNTIME_PORT ?? "8788";
const consolePort = process.env.OAO_CONSOLE_PORT ?? "8080";
const postgresPort = process.env.OAO_POSTGRES_PORT ?? "5432";
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/oao`;
const appOrigin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${consolePort}`;
const apiOrigin = process.env.API_ORIGIN ?? `http://127.0.0.1:${apiPort}`;
const authProvider = process.env.AUTH_PROVIDER ?? "development";
const nodeEnvironment = process.env.NODE_ENV ?? "development";
// `pnpm oao setup` sets this after the user agrees to keep OAO's database on
// a PostgreSQL server that OAO did not start; the launcher never manages it.
const existingPostgres = process.env.OAO_POSTGRES_MODE === "existing";

if (authProvider !== "development" && authProvider !== "workos")
  throw new Error("AUTH_PROVIDER must be development or workos");

const children = new Set();
let databaseStartedHere = false;
let cleaningUp;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
}

function commandSucceeds(command, args) {
  return (
    spawnSync(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "ignore",
    }).status === 0
  );
}

function databaseIsRunning() {
  if (commandSucceeds("docker", ["compose", "version"])) {
    const result = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        composeFile,
        "ps",
        "--status",
        "running",
        "-q",
        "postgres",
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        encoding: "utf8",
      },
    );
    return result.status === 0 && result.stdout.trim().length > 0;
  }
  const result = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", "oao-postgres-local"],
    { cwd: repositoryRoot, env: process.env, encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() === "true";
}

function startChild(name, args, environment) {
  const child = spawn("pnpm", args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  child.oaoName = name;
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!cleaningUp) {
      process.stderr.write(
        `${name} stopped unexpectedly (${signal ?? code ?? "unknown"}).\n`,
      );
      void cleanup(1);
    }
  });
  child.once("error", (error) => {
    process.stderr.write(`${name} failed to start: ${error.message}\n`);
    void cleanup(1);
  });
  return child;
}

function signalChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForChildren(timeoutMs) {
  if (children.size === 0) return;
  await Promise.race([
    Promise.all(
      [...children].map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once("exit", resolve);
          }),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function cleanup(exitCode) {
  if (cleaningUp) return cleaningUp;
  cleaningUp = (async () => {
    for (const child of children) signalChild(child, "SIGTERM");
    await waitForChildren(12_000);
    for (const child of children) signalChild(child, "SIGKILL");
    await waitForChildren(2_000);
    if (databaseStartedHere) {
      const result = spawnSync(databaseDownScript, [], {
        cwd: repositoryRoot,
        env: process.env,
        stdio: "inherit",
      });
      if (result.status === 0) databaseStartedHere = false;
    }
    process.exitCode = exitCode;
  })();
  return cleaningUp;
}

// Package managers and terminal emulators do not all forward shutdown signals
// identically. Keep a synchronous last-resort hook so an interrupted launcher
// cannot strand a child process or a PostgreSQL container that it owns.
process.on("exit", () => {
  for (const child of children) {
    try {
      signalChild(child, "SIGKILL");
    } catch {
      // The process is already exiting; best-effort termination is sufficient.
    }
  }
  if (databaseStartedHere)
    spawnSync(databaseDownScript, [], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
});

async function waitForUrl(name, url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${name} did not become ready: ${lastError?.message ?? url}`);
}

async function preparePostgres() {
  if (existingPostgres) {
    const address = postgresAddress(databaseUrl);
    if (!address)
      throw new Error(
        "OAO_POSTGRES_MODE=existing needs a PostgreSQL DATABASE_URL in .env.",
      );
    if (!(await probePostgres(address.port, address.host)))
      throw new Error(
        `.env selects the existing PostgreSQL server at ${address.host}:${address.port}, but it does not answer. Start it, or remove OAO_POSTGRES_MODE and DATABASE_URL from .env so OAO runs its own PostgreSQL container.`,
      );
    process.stdout.write(
      `Using the existing PostgreSQL server at ${address.host}:${address.port}.\n`,
    );
    return;
  }
  const wasRunning = databaseIsRunning();
  if (!wasRunning && (await probePostgres(postgresPort)))
    throw new Error(
      `A PostgreSQL server that OAO did not start is already running on 127.0.0.1:${postgresPort}. Run pnpm oao setup to create the OAO database on it (setup asks first), or set OAO_POSTGRES_PORT to a free port.`,
    );
  databaseStartedHere = !wasRunning;
  run("pnpm", ["db:up"], {
    env: { ...process.env, OAO_POSTGRES_PORT: postgresPort },
  });
}

async function main() {
  await preparePostgres();

  // Workspace packages export built ESM, so a clean checkout needs this once
  // before the source watchers can resolve their internal dependencies.
  run("pnpm", ["build"]);
  run("pnpm", ["db:migrate"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (authProvider === "development") {
    run("pnpm", ["--filter", "@oao/api", "seed:dev"], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        AUTH_PROVIDER: authProvider,
        NODE_ENV: nodeEnvironment,
        APP_ORIGIN: appOrigin,
      },
    });
  }

  startChild("API", ["--filter", "@oao/api", "dev"], {
    DATABASE_URL: databaseUrl,
    AUTH_PROVIDER: authProvider,
    NODE_ENV: nodeEnvironment,
    APP_ORIGIN: appOrigin,
    PORT: apiPort,
  });
  startChild("runtime worker", ["--filter", "@oao/runtime-worker", "dev"], {
    DATABASE_URL: databaseUrl,
    NODE_ENV: nodeEnvironment,
    PORT: runtimePort,
    // Agents granted OAO tools call the local API.
    OAO_API_URL: process.env.OAO_API_URL ?? `http://127.0.0.1:${apiPort}`,
  });
  startChild(
    "console",
    [
      "--filter",
      "@oao/console",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      consolePort,
      "--strictPort",
    ],
    {
      AUTH_PROVIDER: authProvider,
      VITE_OAO_API_MODE: process.env.VITE_OAO_API_MODE ?? "http",
      VITE_OAO_API_PROXY_TARGET:
        process.env.VITE_OAO_API_PROXY_TARGET ?? apiOrigin,
    },
  );

  await Promise.all([
    waitForUrl("API", `${apiOrigin}/readyz`),
    waitForUrl("runtime worker", `http://127.0.0.1:${runtimePort}/readyz`),
    waitForUrl("console", appOrigin),
  ]);
  process.stdout.write(
    `\nOAO is ready at ${appOrigin}\nPress Ctrl-C to stop.\n`,
  );
}

process.once("SIGINT", () => void cleanup(130));
process.once("SIGTERM", () => void cleanup(143));
process.once("SIGHUP", () => void cleanup(129));

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  await cleanup(1);
}
