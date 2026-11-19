import { createHash } from "node:crypto";
import type { PgPool, Queryable, TenantContext } from "@oao/db-postgres";
import type { PublicValue, RunId } from "@oao/domain";
import { assertPublicPayload } from "@oao/domain";

export type WakeKind =
  "admit" | "reconcile" | "cancel" | "deadline" | "tool_result" | "approval";

export interface RuntimeWakeJob extends TenantContext {
  readonly id: string;
  readonly runId: RunId;
  readonly dispatchKey: string;
  readonly kind: WakeKind;
  readonly payload: Readonly<Record<string, PublicValue>>;
  readonly attempts: number;
  readonly fence: bigint;
}

interface RuntimeWakeRow {
  organization_id: RuntimeWakeJob["organizationId"];
  project_id: RuntimeWakeJob["projectId"];
  id: string;
  run_id: RunId;
  dispatch_key: string;
  kind: WakeKind;
  payload_public: Readonly<Record<string, PublicValue>>;
  attempts: number;
  lease_fence: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function wakeRequestHash(input: {
  readonly runId: string;
  readonly kind: WakeKind;
  readonly payload: Readonly<Record<string, PublicValue>>;
}): Uint8Array {
  return createHash("sha256").update(canonical(input)).digest();
}

function mapWake(row: RuntimeWakeRow): RuntimeWakeJob {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    id: row.id,
    runId: row.run_id,
    dispatchKey: row.dispatch_key,
    kind: row.kind,
    payload: row.payload_public,
    attempts: row.attempts,
    fence: BigInt(row.lease_fence),
  };
}

/** The channel `oao.enqueue_runtime_wake` notifies when a wake is due. */
export const RUNTIME_WAKE_CHANNEL = "oao_runtime_wakes";

export class PostgresWakeQueue {
  constructor(private readonly pool: PgPool) {}

  async enqueue(
    transaction: Queryable,
    input: TenantContext & {
      readonly id: string;
      readonly runId: RunId;
      readonly dispatchKey: string;
      readonly kind: WakeKind;
      readonly payload: Readonly<Record<string, PublicValue>>;
      readonly availableAt?: Date;
    },
  ): Promise<void> {
    assertPublicPayload(input.payload);
    const hash = wakeRequestHash(input);
    await transaction.query(
      "SELECT oao.enqueue_runtime_wake($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        input.organizationId,
        input.projectId,
        input.id,
        input.runId,
        input.dispatchKey,
        hash,
        input.kind,
        input.payload,
        input.availableAt ?? new Date(),
      ],
    );
  }

  async claim(
    workerId: string,
    options: {
      readonly limit?: number;
      readonly leaseMilliseconds?: number;
    } = {},
  ): Promise<readonly RuntimeWakeJob[]> {
    const limit = options.limit ?? 10;
    const leaseMilliseconds = options.leaseMilliseconds ?? 15_000;
    const result = await this.pool.query(
      "SELECT * FROM oao.claim_runtime_wakes($1,$2,($3 || ' milliseconds')::interval)",
      [workerId, limit, leaseMilliseconds],
    );
    return (result.rows as RuntimeWakeRow[]).map(mapWake);
  }

  async complete(workerId: string, job: RuntimeWakeJob): Promise<void> {
    await this.pool.query("SELECT oao.complete_runtime_wake($1,$2,$3,$4,$5)", [
      job.organizationId,
      job.projectId,
      job.id,
      workerId,
      job.fence.toString(),
    ]);
  }

  /**
   * Extends a claimed job's lease. False means this worker no longer owns the
   * job: it was re-claimed after the lease expired, or already finished.
   */
  async renew(
    workerId: string,
    job: RuntimeWakeJob,
    leaseMilliseconds: number,
  ): Promise<boolean> {
    const result = await this.pool.query<{ renewed: boolean }>(
      "SELECT oao.renew_runtime_wake($1,$2,$3,$4,$5,($6 || ' milliseconds')::interval) AS renewed",
      [
        job.organizationId,
        job.projectId,
        job.id,
        workerId,
        job.fence.toString(),
        leaseMilliseconds,
      ],
    );
    return result.rows[0]?.renewed === true;
  }

  async retry(
    workerId: string,
    job: RuntimeWakeJob,
    input: {
      readonly delayMilliseconds: number;
      readonly safeError: Readonly<Record<string, PublicValue>>;
      readonly dead?: boolean;
    },
  ): Promise<void> {
    assertPublicPayload(input.safeError);
    await this.pool.query(
      "SELECT oao.retry_runtime_wake($1,$2,$3,$4,$5,($6 || ' milliseconds')::interval,$7,$8)",
      [
        job.organizationId,
        job.projectId,
        job.id,
        workerId,
        job.fence.toString(),
        input.delayMilliseconds,
        input.safeError,
        input.dead ?? false,
      ],
    );
  }
}

export interface WakeWorkerOptions {
  readonly workerId: string;
  /** Jobs handled at the same time. Defaults to 32. */
  readonly concurrency?: number;
  /** Lease per job, renewed every third of it while the handler runs. Defaults to 30 seconds. */
  readonly leaseMilliseconds?: number;
  /** Fallback poll when no wake notification arrives. Defaults to 1 second. */
  readonly pollMilliseconds?: number;
  readonly maxAttempts?: number;
  /** How long `stop` waits for running handlers. Defaults to 5 seconds. */
  readonly stopGraceMilliseconds?: number;
  /** Registers for enqueue notifications; polling continues regardless. */
  readonly subscribeToWakes?: (
    onWake: () => void,
  ) => Promise<() => Promise<void>>;
  /** Receives queue errors. The loop logs them and keeps going. */
  readonly onError?: (error: unknown, job?: RuntimeWakeJob) => void;
}

const MAX_CLAIM = 100;
const CLAIM_RETRY_MILLISECONDS = 1_000;

/**
 * Runs claimed runtime wakes concurrently. Each job keeps its own lease alive
 * while its handler runs, so a slow handler is never replayed by a second
 * claim, and a job whose lease was lost is neither completed nor retried here.
 */
export class WakeWorker {
  readonly #abort = new AbortController();
  readonly #active = new Set<Promise<void>>();
  #running: Promise<void> | undefined;
  /** A wake arrived since the last claim. */
  #pending = false;
  /** The last claim was capped by free slots, so more work may be due. */
  #backlog = false;
  #wake: (() => void) | undefined;

  constructor(
    private readonly queue: Pick<
      PostgresWakeQueue,
      "claim" | "complete" | "retry" | "renew"
    >,
    private readonly handler: (job: RuntimeWakeJob) => Promise<void>,
    private readonly options: WakeWorkerOptions,
  ) {}

  start(): void {
    if (this.#running) return;
    this.#running = this.loop();
  }

  /**
   * Stops claiming and waits for running handlers, by default for
   * `stopGraceMilliseconds`; leases cover the rest. Pass
   * `graceMilliseconds: Infinity` to wait for every handler. Resolves true
   * when no handler is still running, so a caller knows whether a handler
   * may still submit work after this returns.
   */
  async stop(options: { graceMilliseconds?: number } = {}): Promise<boolean> {
    this.#abort.abort();
    this.#signal();
    await this.#running;
    if (this.#active.size === 0) return true;
    const grace =
      options.graceMilliseconds ?? this.options.stopGraceMilliseconds ?? 5_000;
    const handlers = Promise.allSettled([...this.#active]);
    if (grace === Number.POSITIVE_INFINITY) {
      await handlers;
      return true;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      handlers,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, grace);
      }),
    ]);
    clearTimeout(timer);
    return this.#active.size === 0;
  }

  #signal(): void {
    this.#pending = true;
    this.#wake?.();
  }

  #report(error: unknown, job?: RuntimeWakeJob): void {
    try {
      this.options.onError?.(error, job);
    } catch {
      // Reporting must never end the loop.
    }
  }

  private async loop(): Promise<void> {
    const signal = this.#abort.signal;
    const unsubscribe = await Promise.resolve()
      .then(() => this.options.subscribeToWakes?.(() => this.#signal()))
      .catch((error: unknown) => {
        this.#report(error);
        return undefined;
      });
    const concurrency = Math.max(1, this.options.concurrency ?? 32);
    const leaseMilliseconds = this.options.leaseMilliseconds ?? 30_000;
    try {
      while (!signal.aborted) {
        const free = concurrency - this.#active.size;
        let failed = false;
        if (free === 0) {
          // Due work may be waiting; claim again as soon as a slot frees up.
          if (this.#pending) this.#backlog = true;
        } else {
          this.#pending = false;
          const limit = Math.min(MAX_CLAIM, free);
          try {
            const jobs = await this.queue.claim(this.options.workerId, {
              limit,
              leaseMilliseconds,
            });
            this.#backlog = jobs.length === limit;
            for (const job of jobs) this.#launch(job, leaseMilliseconds);
          } catch (error) {
            this.#report(error);
            failed = true;
          }
        }
        if (signal.aborted) break;
        const idleSlots = concurrency - this.#active.size;
        if (!failed && idleSlots > 0 && (this.#backlog || this.#pending))
          continue;
        await this.#idle(
          failed
            ? CLAIM_RETRY_MILLISECONDS
            : (this.options.pollMilliseconds ?? 1_000),
          failed,
        );
      }
    } finally {
      await Promise.resolve(unsubscribe?.()).catch(() => undefined);
    }
  }

  /** Waits for a wake, a finished job, the timeout or stop. */
  async #idle(milliseconds: number, ignoreWakes: boolean): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      // After a claim error only stop ends the backoff early.
      this.#wake = ignoreWakes
        ? () => {
            if (this.#abort.signal.aborted) done();
          }
        : done;
      if (this.#abort.signal.aborted) done();
    });
  }

  #launch(job: RuntimeWakeJob, leaseMilliseconds: number): void {
    const running = this.#run(job, leaseMilliseconds).finally(() => {
      this.#active.delete(running);
      // A freed slot only matters when due work was left unclaimed.
      if (this.#backlog || this.#pending) this.#wake?.();
    });
    this.#active.add(running);
  }

  async #run(job: RuntimeWakeJob, leaseMilliseconds: number): Promise<void> {
    const workerId = this.options.workerId;
    let lost = false;
    let renewing: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(
      () => {
        renewing = renewing.then(async () => {
          if (lost) return;
          try {
            if (!(await this.queue.renew(workerId, job, leaseMilliseconds)))
              lost = true;
          } catch (error) {
            // A transient error keeps the current lease until the next beat.
            this.#report(error, job);
          }
        });
      },
      Math.max(1, Math.floor(leaseMilliseconds / 3)),
    );
    // A handler still running after stop must not keep the process alive.
    heartbeat.unref();
    let failure: unknown;
    let failed = false;
    try {
      await this.handler(job);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      clearInterval(heartbeat);
      await renewing;
    }
    if (lost) {
      this.#report(
        new Error("Runtime wake lease was lost while its handler ran"),
        job,
      );
      return;
    }
    if (!failed) {
      try {
        await this.queue.complete(workerId, job);
      } catch (error) {
        // Never turn a finished job into a retry: running it again would
        // repeat work that already succeeded.
        this.#report(error, job);
      }
      return;
    }
    this.#report(failure, job);
    const dead = job.attempts >= (this.options.maxAttempts ?? 10);
    try {
      await this.queue.retry(workerId, job, {
        delayMilliseconds: Math.min(
          30_000,
          250 * 2 ** Math.min(job.attempts, 7),
        ),
        safeError: {
          code: dead ? "wake_attempts_exhausted" : "wake_retry_scheduled",
          message: dead
            ? "Runtime wake attempts exhausted"
            : "Runtime wake will be retried",
        },
        dead,
      });
    } catch (error) {
      this.#report(error, job);
    }
  }
}
