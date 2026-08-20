import { createHash } from "node:crypto";
import type { PgPool, Queryable, TenantContext } from "@oao/db-postgres";
import type { PublicValue, RunId } from "@oao/domain";
import { assertPublicPayload } from "@oao/domain";

export type WakeKind =
  "admit" | "reconcile" | "cancel" | "tool_result" | "approval";

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
  readonly pollMilliseconds?: number;
  readonly leaseMilliseconds?: number;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
}

export class WakeWorker {
  readonly #abort = new AbortController();
  #running: Promise<void> | undefined;

  constructor(
    private readonly queue: PostgresWakeQueue,
    private readonly handler: (job: RuntimeWakeJob) => Promise<void>,
    private readonly options: WakeWorkerOptions,
  ) {}

  start(): void {
    if (this.#running) return;
    this.#running = this.loop();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#running;
  }

  private async loop(): Promise<void> {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      const jobs = await this.queue.claim(this.options.workerId, {
        limit: this.options.batchSize ?? 10,
        leaseMilliseconds: this.options.leaseMilliseconds ?? 15_000,
      });
      for (const job of jobs) {
        if (signal.aborted) return;
        try {
          await this.handler(job);
          await this.queue.complete(this.options.workerId, job);
        } catch {
          const dead = job.attempts >= (this.options.maxAttempts ?? 10);
          await this.queue.retry(this.options.workerId, job, {
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
        }
      }
      if (jobs.length === 0) {
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, this.options.pollMilliseconds ?? 250);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  }
}
