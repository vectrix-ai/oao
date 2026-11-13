/* global AbortSignal, Buffer, fetch, process */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statfsSync,
} from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { postgresAddress, probePostgres } from "./postgres-probe.mjs";

const DEFAULT_PORTS = Object.freeze({
  postgres: 5432,
  api: 3000,
  runtime: 8788,
  console: 8080,
});

function command(commandName, args) {
  try {
    return {
      ok: true,
      output: execFileSync(commandName, args, {
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

function parseDotEnvContents(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
    values[key] = rawValue.replace(/^(['"])(.*)\1$/u, "$2").trim();
  }
  return values;
}

function parseDotEnv(path) {
  return existsSync(path)
    ? parseDotEnvContents(readFileSync(path, "utf8"))
    : {};
}

function atLeastVersion(actual, minimum) {
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function canonicalEncryptionKey(value) {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

async function addressAvailable(port, host) {
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen(host ? { host, port } : { port }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function portAvailable(port) {
  const ipv4 = await addressAvailable(port, "127.0.0.1");
  const wildcard = await addressAvailable(port);
  return ipv4 && wildcard;
}

async function jsonEndpointReady(url, expected) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return false;
    const body = await response.json();
    return expected(body);
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

function check(id, status, message, remediation, required = true) {
  return {
    id,
    status,
    required,
    message,
    ...(remediation ? { remediation } : {}),
  };
}

const USE_OAO_CONTAINER =
  "remove OAO_POSTGRES_MODE and DATABASE_URL from .env so OAO runs its own PostgreSQL container";

/**
 * The PostgreSQL port check. A server OAO did not start is not a failure:
 * setup offers to create the OAO database on it, after confirmation.
 */
export function postgresPortCheck({
  port,
  free,
  oaoContainer,
  answering,
  existingMode,
  address,
}) {
  if (existingMode) {
    if (!address)
      return check(
        "port_postgres",
        "fail",
        "OAO_POSTGRES_MODE=existing, but .env has no PostgreSQL DATABASE_URL.",
        `Set DATABASE_URL to the existing server, or ${USE_OAO_CONTAINER}.`,
      );
    const location = `${address.host}:${address.port}`;
    return answering
      ? check(
          "port_postgres",
          "pass",
          `Using the existing PostgreSQL server at ${location} configured in .env.`,
        )
      : check(
          "port_postgres",
          "fail",
          `.env selects the existing PostgreSQL server at ${location}, but it does not answer.`,
          `Start that server, or ${USE_OAO_CONTAINER}.`,
        );
  }
  if (oaoContainer)
    return check(
      "port_postgres",
      "pass",
      `Port ${port} is already serving the expected OAO postgres service.`,
    );
  if (free)
    return check(
      "port_postgres",
      "pass",
      `Port ${port} for postgres is available.`,
    );
  if (answering)
    return check(
      "port_postgres",
      "warn",
      `Port ${port} is served by a PostgreSQL server that OAO did not start; setup asks before creating the OAO database on it.`,
    );
  return check(
    "port_postgres",
    "fail",
    `Port ${port} for postgres is already in use by another process.`,
    "Stop the conflicting process or configure a different OAO postgres port before setup.",
  );
}

export async function collectPreflight({
  repositoryRoot,
  includeWorkspace = true,
} = {}) {
  const root =
    repositoryRoot ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const checks = [];
  const packagePath = resolve(root, "package.json");
  const lockfilePath = resolve(root, "pnpm-lock.yaml");
  const envPath = resolve(root, ".env");
  const packageJson = existsSync(packagePath)
    ? JSON.parse(readFileSync(packagePath, "utf8"))
    : undefined;
  const requiredNode = String(
    packageJson?.engines?.node ?? ">=22.22.0",
  ).replace(/^>=/u, "");
  const requiredPnpm =
    String(packageJson?.packageManager ?? "pnpm@10.27.0").split("@")[1] ??
    "10.27.0";

  checks.push(
    check(
      "repository",
      packageJson?.name === "oao" && existsSync(lockfilePath) ? "pass" : "fail",
      packageJson?.name === "oao" && existsSync(lockfilePath)
        ? "OAO repository and lockfile found."
        : "Run this command from the OAO repository root.",
      "Clone the OAO repository and change into that directory.",
    ),
  );

  const nodeVersion = process.versions.node;
  checks.push(
    check(
      "node",
      atLeastVersion(nodeVersion, requiredNode) ? "pass" : "fail",
      `Node.js ${nodeVersion} detected; OAO requires ${requiredNode} or newer.`,
      `Install Node.js ${requiredNode} or newer.`,
    ),
  );

  const pnpm = command("pnpm", ["--version"]);
  checks.push(
    check(
      "pnpm",
      pnpm.ok && pnpm.output === requiredPnpm ? "pass" : "fail",
      pnpm.ok
        ? `pnpm ${pnpm.output} detected; this checkout pins ${requiredPnpm}.`
        : "pnpm is not available.",
      `Run corepack enable and activate pnpm ${requiredPnpm}.`,
    ),
  );

  const env = parseDotEnv(envPath);
  const dockerCli = command("docker", ["--version"]);
  const dockerDaemon = dockerCli.ok
    ? command("docker", ["info", "--format", "{{.ServerVersion}}"])
    : { ok: false, output: "" };
  const compose = dockerCli.ok && command("docker", ["compose", "version"]).ok;
  const postgresContainer = dockerDaemon.ok
    ? command("docker", [
        "inspect",
        "--format",
        "{{.State.Running}}",
        "oao-postgres-local",
      ])
    : { ok: false, output: "" };
  const composePostgres =
    dockerDaemon.ok && compose
      ? command("docker", [
          "compose",
          "-f",
          resolve(root, "infra/compose/docker-compose.yml"),
          "ps",
          "--status",
          "running",
          "-q",
          "postgres",
        ])
      : { ok: false, output: "" };

  // OAO uses Docker only for its own PostgreSQL container. A server that is
  // already running, or one configured in .env, makes Docker unnecessary.
  const existingMode = env.OAO_POSTGRES_MODE === "existing";
  const postgresPort = Number(env.OAO_POSTGRES_PORT ?? DEFAULT_PORTS.postgres);
  const configuredAddress = existingMode
    ? postgresAddress(env.DATABASE_URL ?? "")
    : undefined;
  const oaoContainer =
    (postgresContainer.ok && postgresContainer.output === "true") ||
    (composePostgres.ok && composePostgres.output.length > 0);
  const postgresAnswering = existingMode
    ? configuredAddress !== undefined &&
      (await probePostgres(configuredAddress.port, configuredAddress.host))
    : !oaoContainer && (await probePostgres(postgresPort));
  const postgres = {
    port: configuredAddress?.port ?? postgresPort,
    existingMode,
    external: existingMode || postgresAnswering,
  };
  const dockerRequired = !postgres.external;
  const notNeeded =
    " Docker is not needed while OAO uses an existing PostgreSQL server.";

  checks.push(
    check(
      "docker_cli",
      dockerCli.ok ? "pass" : dockerRequired ? "fail" : "warn",
      dockerCli.ok
        ? dockerCli.output
        : `Docker CLI is not available.${dockerRequired ? "" : notNeeded}`,
      "Install Docker Desktop, Colima with the Docker CLI, or another Docker-compatible runtime.",
      dockerRequired,
    ),
  );
  checks.push(
    check(
      "docker_daemon",
      dockerDaemon.ok ? "pass" : dockerRequired ? "fail" : "warn",
      dockerDaemon.ok
        ? `Docker daemon ${dockerDaemon.output} is reachable.`
        : `Docker CLI cannot reach the active daemon/context.${dockerRequired ? "" : notNeeded}`,
      "Start Docker Desktop, Colima, or another Docker-compatible daemon, then rerun pnpm oao doctor.",
      dockerRequired,
    ),
  );
  checks.push(
    check(
      "docker_compose",
      compose || !dockerRequired ? "pass" : "warn",
      compose
        ? "Docker Compose is available."
        : dockerRequired
          ? "Docker Compose is unavailable; OAO will use its Docker CLI fallback."
          : "Docker Compose is not needed while OAO uses an existing PostgreSQL server.",
      undefined,
      false,
    ),
  );

  try {
    accessSync(root, constants.R_OK | constants.W_OK);
    checks.push(
      check(
        "workspace_writable",
        "pass",
        "Repository is readable and writable.",
      ),
    );
  } catch {
    checks.push(
      check(
        "workspace_writable",
        "fail",
        "Repository is not writable by the current user.",
        "Move the checkout to a writable directory or correct its ownership without running OAO as root.",
      ),
    );
  }

  try {
    const stats = statfsSync(root);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const availableGiB = availableBytes / 1024 ** 3;
    checks.push(
      check(
        "disk_space",
        availableGiB >= 2 ? "pass" : "warn",
        `${availableGiB.toFixed(1)} GiB is available in the repository filesystem.`,
        availableGiB >= 2
          ? undefined
          : "Free at least 2 GiB before installing dependencies and Docker images.",
        false,
      ),
    );
  } catch {
    checks.push(
      check(
        "disk_space",
        "warn",
        "Available disk space could not be determined.",
        "Confirm that the checkout and Docker runtime have enough free space.",
        false,
      ),
    );
  }

  if (includeWorkspace) {
    const installed = existsSync(resolve(root, "node_modules/.modules.yaml"));
    checks.push(
      check(
        "workspace_dependencies",
        installed ? "pass" : "fail",
        installed
          ? "Workspace dependencies are installed."
          : "Workspace dependencies are not installed.",
        "Run pnpm install --frozen-lockfile, or use pnpm oao setup to install them after system checks pass.",
        false,
      ),
    );
    const postgresImage =
      dockerRequired && dockerDaemon.ok
        ? command("docker", ["image", "inspect", "postgres:17-alpine"])
        : { ok: false, output: "" };
    checks.push(
      !dockerRequired
        ? check(
            "postgres_image",
            "pass",
            "The PostgreSQL container image is not needed while OAO uses an existing server.",
            undefined,
            false,
          )
        : check(
            "postgres_image",
            postgresImage.ok ? "pass" : "fail",
            postgresImage.ok
              ? "PostgreSQL 17 container image is available locally."
              : "PostgreSQL 17 container image is not available locally.",
            "Run pnpm oao setup to download the pinned image after system checks pass.",
            false,
          ),
    );
  }

  const encryptionKey = env.OAO_CREDENTIAL_ENCRYPTION_KEY;
  checks.push(
    check(
      "environment",
      !existsSync(envPath)
        ? "warn"
        : !encryptionKey
          ? "warn"
          : canonicalEncryptionKey(encryptionKey)
            ? "pass"
            : "fail",
      !existsSync(envPath)
        ? ".env does not exist; setup will create it safely."
        : !encryptionKey
          ? ".env exists without a credential-encryption key; setup will generate one."
          : canonicalEncryptionKey(encryptionKey)
            ? ".env contains a valid credential-encryption key."
            : ".env contains an invalid OAO_CREDENTIAL_ENCRYPTION_KEY.",
      "Use a canonical base64-encoded 32-byte key. Existing non-empty keys are never replaced automatically.",
    ),
  );

  const ports = {
    postgres: Number(env.OAO_POSTGRES_PORT ?? DEFAULT_PORTS.postgres),
    api: Number(env.OAO_API_PORT ?? DEFAULT_PORTS.api),
    runtime: Number(env.OAO_RUNTIME_PORT ?? DEFAULT_PORTS.runtime),
    console: Number(env.OAO_CONSOLE_PORT ?? DEFAULT_PORTS.console),
  };
  const ready = {
    api: await jsonEndpointReady(
      `http://127.0.0.1:${ports.api}/readyz`,
      (body) => body?.status === "ready",
    ),
    runtime: await jsonEndpointReady(
      `http://127.0.0.1:${ports.runtime}/readyz`,
      (body) =>
        body?.status === "ready" && body?.profile === "project-providers",
    ),
    console: await consoleReady(`http://127.0.0.1:${ports.console}/`),
  };
  const fullOaoStackReady = ready.api && ready.runtime && ready.console;
  for (const [name, port] of Object.entries(ports)) {
    if (name === "postgres") {
      checks.push(
        postgresPortCheck({
          port,
          free: !existingMode && (await portAvailable(port)),
          oaoContainer,
          answering: postgresAnswering,
          existingMode,
          address: configuredAddress,
        }),
      );
      continue;
    }
    const free = await portAvailable(port);
    const owned = fullOaoStackReady;
    checks.push(
      check(
        `port_${name}`,
        free || owned ? "pass" : "fail",
        owned
          ? `Port ${port} is already serving the expected OAO ${name} service.`
          : free
            ? `Port ${port} for ${name} is available.`
            : `Port ${port} for ${name} is already in use by another process.`,
        `Stop the conflicting process or configure a different OAO ${name} port before setup.`,
      ),
    );
  }

  return {
    schemaVersion: 1,
    ok: checks.every((item) => !item.required || item.status !== "fail"),
    repositoryRoot: root,
    postgres,
    checks,
  };
}

export function printPreflight(report, { json = false } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write("OAO preflight\n\n");
  for (const item of report.checks) {
    const marker =
      item.status === "pass" ? "✓" : item.status === "warn" ? "!" : "✗";
    process.stdout.write(`${marker} ${item.message}\n`);
    if (item.status === "fail" && item.remediation)
      process.stdout.write(`  ${item.remediation}\n`);
  }
  process.stdout.write(
    report.ok
      ? "\nAll required system checks passed.\n"
      : "\nSetup has not changed configuration or started services.\n",
  );
}

export { canonicalEncryptionKey, parseDotEnvContents };
