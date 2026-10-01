import { randomUUID } from "node:crypto";
import { matchesEventKinds } from "./filter.js";
import { buildWebhookRequest } from "./payload.js";
import {
  classifyResponse,
  DEFAULT_RETRY_POLICY,
  retryDelayMs,
  type RetryPolicy,
} from "./policy.js";
import {
  WebhookTransportError,
  type ClaimedEventWebhook,
  type DeliveryOutcome,
  type EncryptedSigningKey,
  type EventWebhookStore,
  type WebhookProductEvent,
  type WebhookTransport,
} from "./types.js";

export interface SigningKeyContext {
  readonly organizationId: string;
  readonly webhookId: string;
}

export interface EventWebhookDispatcherOptions {
  readonly store: EventWebhookStore;
  readonly transport: WebhookTransport;
  /** Decrypts one stored signing key to its `whsec_` form. */
  readonly decryptSigningKey: (
    key: EncryptedSigningKey,
    context: SigningKeyContext,
  ) => string;
  readonly workerId: string;
  /** Endpoints delivered in parallel; each endpoint is always sequential. */
  readonly concurrency?: number;
  readonly leaseMs?: number;
  /** Fallback poll interval when no wake arrives. */
  readonly pollIntervalMs?: number;
  readonly maxEvents?: number;
  /** Soft byte budget per batch; a single larger event is still sent alone. */
  readonly maxBatchBytes?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly now?: () => Date;
  /** Registers for commit wake hints; polling continues regardless. */
  readonly subscribeToWakes?: (
    onWake: () => void,
  ) => Promise<() => Promise<void>>;
  readonly onError?: (error: unknown, claim?: ClaimedEventWebhook) => void;
}

const DEFAULTS = {
  concurrency: 8,
  leaseMs: 60_000,
  pollIntervalMs: 1_000,
  maxEvents: 100,
  maxBatchBytes: 256 * 1024,
} as const;

export class EventWebhookDispatcher {
  readonly #options: EventWebhookDispatcherOptions;
  readonly #concurrency: number;
  readonly #leaseMs: number;
  readonly #pollIntervalMs: number;
  readonly #maxEvents: number;
  readonly #maxBatchBytes: number;
  readonly #retryPolicy: RetryPolicy;
  readonly #now: () => Date;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(options: EventWebhookDispatcherOptions) {
    this.#options = options;
    this.#concurrency = options.concurrency ?? DEFAULTS.concurrency;
    this.#leaseMs = options.leaseMs ?? DEFAULTS.leaseMs;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.#maxEvents = options.maxEvents ?? DEFAULTS.maxEvents;
    this.#maxBatchBytes = options.maxBatchBytes ?? DEFAULTS.maxBatchBytes;
    this.#retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.#now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.#loop) return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#loop = this.#run(abort.signal);
  }

  async stop(): Promise<void> {
    this.#abort?.abort();
    this.#wake?.();
    await this.#loop;
    this.#loop = undefined;
    this.#abort = undefined;
  }

  /** Claims and processes one round of due endpoints. Returns the number claimed. */
  async runOnce(): Promise<number> {
    const claims = await this.#options.store.claim({
      workerId: this.#options.workerId,
      limit: this.#concurrency,
      leaseMs: this.#leaseMs,
    });
    await Promise.all(
      claims.map((claim) =>
        this.#deliver(claim).catch((error: unknown) =>
          this.#options.onError?.(error, claim),
        ),
      ),
    );
    return claims.length;
  }

  async #run(signal: AbortSignal): Promise<void> {
    const unsubscribe = await this.#options
      .subscribeToWakes?.(() => this.#wake?.())
      .catch((error: unknown) => {
        this.#options.onError?.(error);
        return undefined;
      });
    let failures = 0;
    try {
      while (!signal.aborted) {
        let claimed = 0;
        try {
          claimed = await this.runOnce();
          failures = 0;
        } catch (error) {
          // A database blip must not end the loop or the process.
          this.#options.onError?.(error);
          failures += 1;
        }
        if (claimed > 0 || signal.aborted) continue;
        const idleMs = failures
          ? Math.min(30_000, this.#pollIntervalMs * 2 ** Math.min(failures, 5))
          : this.#pollIntervalMs;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, idleMs);
          function done() {
            clearTimeout(timer);
            resolve();
          }
          this.#wake = done;
        });
        this.#wake = undefined;
      }
    } finally {
      await unsubscribe?.().catch(() => undefined);
    }
  }

  async #deliver(claim: ClaimedEventWebhook): Promise<void> {
    const { store, workerId } = this.#options;
    const work = await store.load(claim, workerId, this.#maxEvents);
    if (!work) return;
    const matches = (event: WebhookProductEvent) =>
      matchesEventKinds(event.kind, work.eventKinds);

    let batch = work.batch;
    let events: WebhookProductEvent[];
    if (batch) {
      events = work.events.filter(matches);
    } else {
      const selected: WebhookProductEvent[] = [];
      let bytes = 0;
      let through = work.deliveredPosition;
      for (const event of work.events) {
        if (matches(event)) {
          const size = Buffer.byteLength(JSON.stringify(event));
          if (selected.length > 0 && bytes + size > this.#maxBatchBytes) break;
          selected.push(event);
          bytes += size;
        }
        through = BigInt(event.projectPosition);
      }
      if (selected.length === 0) {
        // Nothing this endpoint wants: move the cursor without a request.
        await store.skip(claim, workerId, through, work.deliveredPosition);
        return;
      }
      batch = { id: randomUUID(), throughPosition: through };
      if (
        !(await store.startBatch(
          claim,
          workerId,
          batch,
          work.deliveredPosition,
        ))
      )
        return;
      events = selected;
    }

    let outcome: DeliveryOutcome;
    try {
      const signingSecrets = work.signingKeys.map((key) =>
        this.#options.decryptSigningKey(key, {
          organizationId: claim.organizationId,
          webhookId: claim.webhookId,
        }),
      );
      const request = buildWebhookRequest({
        endpointUrl: work.endpointUrl,
        webhookId: claim.webhookId,
        organizationId: claim.organizationId,
        projectId: claim.projectId,
        fromPosition: work.deliveredPosition,
        batch,
        events,
        signingSecrets,
        now: this.#now(),
      });
      outcome = classifyResponse(
        await this.#options.transport(request),
        batch.id,
        work.consecutiveFailures,
        this.#retryPolicy,
      );
    } catch (error) {
      outcome = {
        kind: "failed",
        errorCode:
          error instanceof WebhookTransportError
            ? error.code
            : "signing_key_unavailable",
        retryAfterMs: retryDelayMs(work.consecutiveFailures, this.#retryPolicy),
        disable: false,
      };
      if (!(error instanceof WebhookTransportError))
        this.#options.onError?.(error, claim);
    }
    await store.finish(claim, workerId, outcome);
  }
}
