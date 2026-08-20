// flue-blueprint: sandbox/daytona@1
/**
 * Daytona adapter for Flue.
 *
 * This file is the source emitted by `flue add sandbox daytona` in Flue 2.0.3.
 * OAO owns provisioning and lifecycle in `index.ts`; this adapter only maps an
 * already-initialized Daytona sandbox onto Flue's SandboxFactory contract.
 */
import {
  sandboxFromDriver,
  SandboxDiedError,
  SandboxOperationUnsupportedError,
} from "@flue/runtime";
import type {
  FileStat,
  Sandbox,
  SandboxDriver,
  SandboxFactory,
} from "@flue/runtime";
import { DaytonaNotFoundError } from "@daytona/sdk";
import type { Sandbox as DaytonaSandbox } from "@daytona/sdk";

const STATE_POLL_MS = 5_000;
const PROBE_SILENCE_MS = 10_000;
const DEFAULT_DAYTONA_WORKDIR = "/home/daytona";

const DEAD_STATES: ReadonlySet<string> = new Set([
  "destroyed",
  "stopped",
  "error",
  "build_failed",
]);

function raceSandboxDeath<T>(
  sandbox: DaytonaSandbox,
  operation: string,
  call: Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(pollTimer);
      clearTimeout(silenceTimer);
      complete();
    };

    const probe = (): void => {
      silenceTimer = setTimeout(() => {
        settle(() =>
          reject(new SandboxDiedError({ operation, reason: "probe_silent" })),
        );
      }, PROBE_SILENCE_MS);
      sandbox.refreshData().then(
        () => {
          if (settled) return;
          clearTimeout(silenceTimer);
          const state = sandbox.state;
          if (state !== undefined && DEAD_STATES.has(state)) {
            settle(() =>
              reject(new SandboxDiedError({ operation, reason: "stopped" })),
            );
          } else {
            pollTimer = setTimeout(probe, STATE_POLL_MS);
          }
        },
        (error: unknown) => {
          if (settled) return;
          clearTimeout(silenceTimer);
          if (error instanceof DaytonaNotFoundError) {
            settle(() =>
              reject(new SandboxDiedError({ operation, reason: "stopped" })),
            );
          } else {
            pollTimer = setTimeout(probe, STATE_POLL_MS);
          }
        },
      );
    };
    pollTimer = setTimeout(probe, STATE_POLL_MS);

    call.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

class DaytonaSandboxDriver implements SandboxDriver {
  constructor(private sandbox: DaytonaSandbox) {}

  private guarded<T>(operation: string, call: Promise<T>): Promise<T> {
    return raceSandboxDeath(this.sandbox, operation, call);
  }

  async readFile(path: string): Promise<string> {
    const buffer = await this.guarded(
      "readFile",
      this.sandbox.fs.downloadFile(path),
    );
    return buffer.toString("utf-8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const buffer = await this.guarded(
      "readFile",
      this.sandbox.fs.downloadFile(path),
    );
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const buffer =
      typeof content === "string"
        ? Buffer.from(content, "utf-8")
        : Buffer.from(content);
    await this.guarded("writeFile", this.sandbox.fs.uploadFile(buffer, path));
  }

  async stat(path: string): Promise<FileStat> {
    const info = await this.guarded(
      "stat",
      this.sandbox.fs.getFileDetails(path),
    );
    return {
      isFile: !info.isDir,
      isDirectory: info.isDir,
      size: info.size,
      mtime: new Date(info.modTime),
    };
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.guarded(
      "readdir",
      this.sandbox.fs.listFiles(path),
    );
    return entries
      .map((entry) => entry.name)
      .filter((name): name is string => !!name);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.guarded("exists", this.sandbox.fs.getFileDetails(path));
      return true;
    } catch (error) {
      if (error instanceof SandboxDiedError) throw error;
      return false;
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      await this.exec(`mkdir -p '${path.replace(/'/g, "'\\''")}'`);
      return;
    }
    await this.guarded("mkdir", this.sandbox.fs.createFolder(path, "755"));
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    if (options?.force) {
      throw new SandboxOperationUnsupportedError({
        operation: "rm",
        provider: "Daytona",
        options: ["force"],
      });
    }
    await this.guarded(
      "rm",
      this.sandbox.fs.deleteFile(path, options?.recursive),
    );
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const response = await this.guarded(
      "exec",
      this.sandbox.process.executeCommand(
        command,
        options?.cwd,
        options?.env,
        typeof options?.timeoutMs === "number"
          ? Math.ceil(options.timeoutMs / 1_000)
          : undefined,
      ),
    );
    return {
      stdout: response.result ?? "",
      stderr: "",
      exitCode: response.exitCode ?? 0,
    };
  }
}

export function daytona(sandbox: DaytonaSandbox): SandboxFactory {
  return {
    async createSandbox(): Promise<Sandbox> {
      const sandboxCwd = await resolveDaytonaWorkspaceDirectory(sandbox);
      const driver = new DaytonaSandboxDriver(sandbox);
      return sandboxFromDriver(driver, sandboxCwd);
    },
  };
}

export async function resolveDaytonaWorkspaceDirectory(
  sandbox: Pick<DaytonaSandbox, "getWorkDir">,
): Promise<string> {
  const workspaceDirectory =
    (await sandbox.getWorkDir()) ?? DEFAULT_DAYTONA_WORKDIR;
  if (
    !workspaceDirectory.startsWith("/") ||
    workspaceDirectory.includes("\0") ||
    workspaceDirectory.includes("\n") ||
    workspaceDirectory.includes("\r")
  )
    throw new Error("Daytona returned an invalid workspace directory");
  return workspaceDirectory;
}
