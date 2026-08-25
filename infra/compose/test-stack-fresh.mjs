#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const containerName = `oao-stack-test-${process.pid}-${randomUUID().slice(0, 8)}`;
const children = new Set();
let containerStarted = false;
let cleanupPromise;

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

function startChild(name, entrypoint, environment) {
  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  child.oaoName = name;
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", (error) => {
    process.stderr.write(`${name} failed to start: ${error.message}\n`);
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

async function stopChildren() {
  const active = [...children];
  for (const child of active) signalChild(child, "SIGTERM");
  await Promise.race([
    Promise.all(
      active.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once("exit", resolve);
          }),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, 12_000)),
  ]);
  for (const child of children) signalChild(child, "SIGKILL");
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await stopChildren();
    if (containerStarted) {
      spawnSync("docker", ["rm", "-f", containerName], {
        cwd: repositoryRoot,
        env: process.env,
        stdio: "ignore",
      });
      containerStarted = false;
    }
  })();
  return cleanupPromise;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a test port");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForUrl(name, url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`${name} exited before becoming ready`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${name} did not become ready: ${lastError?.message ?? url}`);
}

async function waitForPostgres() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "docker",
      ["inspect", "--format", "{{.State.Health.Status}}", containerName],
      { cwd: repositoryRoot, env: process.env, encoding: "utf8" },
    );
    if (result.status === 0 && result.stdout.trim() === "healthy") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  run("docker", ["logs", containerName]);
  throw new Error("Fresh PostgreSQL did not become healthy");
}

function mappedPostgresPort() {
  const result = spawnSync("docker", ["port", containerName, "5432/tcp"], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error("Could not read PostgreSQL test port");
  const match = /:(\d+)\s*$/u.exec(result.stdout.split("\n")[0] ?? "");
  if (!match?.[1]) throw new Error("PostgreSQL test port was not mapped");
  return match[1];
}

async function main() {
  run("pnpm", ["build"]);
  run("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "-e",
    "POSTGRES_DB=oao",
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-P",
    "--health-cmd=pg_isready -U postgres -d oao",
    "--health-interval=1s",
    "--health-timeout=3s",
    "--health-retries=60",
    "postgres:17-alpine",
  ]);
  containerStarted = true;
  await waitForPostgres();

  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${mappedPostgresPort()}/oao`;
  const [apiPort, runtimePort] = await Promise.all([freePort(), freePort()]);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
  const commonEnvironment = {
    DATABASE_URL: databaseUrl,
  };

  run("pnpm", ["--filter", "@oao/db-postgres", "migrate"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  const runtime = startChild(
    "runtime worker",
    "apps/runtime-worker/src/main.ts",
    { ...commonEnvironment, PORT: String(runtimePort) },
  );
  const api = startChild("API", "apps/api/src/server.ts", {
    ...commonEnvironment,
    AUTH_PROVIDER: "development",
    NODE_ENV: "development",
    APP_ORIGIN: "http://127.0.0.1:8080",
    PORT: String(apiPort),
  });

  await Promise.all([
    waitForUrl("runtime worker", `${runtimeOrigin}/readyz`, runtime),
    waitForUrl("API", `${apiOrigin}/readyz`, api),
  ]);
  run(
    process.execPath,
    ["--import", "tsx", "--test", "infra/compose/real-stack.test.ts"],
    {
      env: {
        ...process.env,
        OAO_TEST_API_URL: apiOrigin,
      },
    },
  );
}

const interrupted = async (exitCode) => {
  await cleanup();
  process.exit(exitCode);
};
process.once("SIGINT", () => void interrupted(130));
process.once("SIGTERM", () => void interrupted(143));

try {
  await main();
} finally {
  await cleanup();
}
