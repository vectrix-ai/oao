import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface StackAddresses {
  readonly apiOrigin: string;
  readonly runtimeOrigin: string;
  readonly consoleOrigin: string;
}

export interface LocalStackHandle {
  readonly owned: boolean;
  readonly addresses: StackAddresses;
  stop(): Promise<void>;
}

function addresses(values: Readonly<Record<string, string>>): StackAddresses {
  const apiPort = values.OAO_API_PORT ?? "3000";
  const runtimePort = values.OAO_RUNTIME_PORT ?? "8788";
  const consolePort = values.OAO_CONSOLE_PORT ?? "8080";
  return {
    apiOrigin: values.API_ORIGIN ?? `http://127.0.0.1:${apiPort}`,
    runtimeOrigin: `http://127.0.0.1:${runtimePort}`,
    consoleOrigin: values.APP_ORIGIN ?? `http://127.0.0.1:${consolePort}`,
  };
}

async function jsonReady(
  url: string,
  expected: (body: Record<string, unknown>) => boolean,
): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    return expected((await response.json()) as Record<string, unknown>);
  } catch {
    return false;
  }
}

async function consoleReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return (
      response.ok &&
      (await response.text()).includes("<title>OAO Console</title>")
    );
  } catch {
    return false;
  }
}

export async function stackIsReady(input: StackAddresses): Promise<boolean> {
  const results = await Promise.all([
    jsonReady(`${input.apiOrigin}/readyz`, (body) => body.status === "ready"),
    jsonReady(
      `${input.runtimeOrigin}/readyz`,
      (body) => body.status === "ready" && body.profile === "project-providers",
    ),
    consoleReady(input.consoleOrigin),
  ]);
  return results.every(Boolean);
}

export async function startLocalStack(
  repositoryRoot: string,
  values: Readonly<Record<string, string>>,
  onProgress: (message: string) => void,
): Promise<LocalStackHandle> {
  const stackAddresses = addresses(values);
  if (await stackIsReady(stackAddresses)) {
    onProgress("✓ Existing OAO stack is ready; reusing it.\n");
    return {
      owned: false,
      addresses: stackAddresses,
      stop: async () => {},
    };
  }

  const logDirectory = resolve(repositoryRoot, ".oao/logs");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const logPath = resolve(logDirectory, "setup-stack.log");
  const log = await open(logPath, "w", 0o600);
  const child = spawn("pnpm", ["dev:local"], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer) => void log.write(chunk);
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  let exited:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  onProgress("Starting PostgreSQL, migrations, API, runtime, and console…\n");
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (exited) {
      await log.close();
      const contents = await readFile(logPath, "utf8");
      const tail = contents.split(/\r?\n/u).slice(-25).join("\n");
      throw new Error(
        `Local stack exited before becoming ready (${exited.signal ?? exited.code ?? "unknown"}).\n${tail}`,
      );
    }
    if (await stackIsReady(stackAddresses)) {
      onProgress(`✓ OAO is ready at ${stackAddresses.consoleOrigin}.\n`);
      return {
        owned: true,
        addresses: stackAddresses,
        stop: async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGINT");
            await Promise.race([
              new Promise<void>((resolvePromise) =>
                child.once("exit", () => resolvePromise()),
              ),
              new Promise<void>((resolvePromise) =>
                setTimeout(resolvePromise, 15_000),
              ),
            ]);
            if (child.exitCode === null && child.signalCode === null)
              child.kill("SIGKILL");
          }
          await log.close();
        },
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  child.kill("SIGINT");
  await log.close();
  throw new Error(
    `OAO did not become ready within five minutes; inspect ${logPath}`,
  );
}

export function stackAddresses(
  values: Readonly<Record<string, string>>,
): StackAddresses {
  return addresses(values);
}
