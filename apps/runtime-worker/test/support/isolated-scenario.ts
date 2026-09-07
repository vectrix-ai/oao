import { spawn } from "node:child_process";

/** Test-only process boundary: active runtime work must not outlive its test. */
export async function runIsolatedScenario(
  file: string,
  options: {
    readonly timeoutMs: number;
    readonly args?: readonly string[];
    readonly signal?: AbortSignal;
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", file, ...(options.args ?? [])],
      {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let failure: Error | undefined;
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65_536);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const killGroup = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const abort = () => {
      failure = new Error("Runtime scenario was aborted");
      killGroup();
    };
    const timer = setTimeout(() => {
      failure = new Error(`Runtime scenario exceeded ${options.timeoutMs}ms`);
      killGroup();
    }, options.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    // Kill descendants too, including those retaining inherited output pipes.
    child.once("exit", killGroup);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (failure || code !== 0) {
        reject(
          new Error(
            `${failure?.message ?? `Runtime scenario exited with ${code ?? signal}`}\n${output}`,
            { cause: failure },
          ),
        );
      } else resolve();
    });
  });
}

/** Run every cleanup and retain the original failure as the first cause. */
export async function withScenarioCleanup(
  scenario: () => Promise<void>,
  cleanups: readonly (() => Promise<void>)[],
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await scenario();
  } catch (error) {
    errors.push(error);
    // Emit before cleanup: even a stuck cleanup must not hide the cause.
    console.error("Runtime scenario failed:", error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
      console.error("Runtime scenario cleanup failed:", error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Runtime scenario or cleanup failed", {
      cause: errors[0],
    });
}
