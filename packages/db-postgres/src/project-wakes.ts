import type { WakeOnlyNotifier, WakeSubscriptionScope } from "@oao/events";

/**
 * Waits between re-checks of durable state that changes together with a
 * product event of one project, such as a caller tool result, an approval
 * decision, or a delegated child run settling.
 */
export interface ProjectWakeWatch {
  /**
   * Resolves on the next project wake or after the fallback interval,
   * whichever comes first, but never sooner than the minimum interval after
   * the previous call resolved. A wake that arrived since then counts. Rejects
   * with the signal's reason on abort.
   */
  next(signal?: AbortSignal): Promise<void>;
  /** Wakes this watch now, for a change this process made without an event. */
  wake(): void;
  close(): Promise<void>;
}

export interface ProjectWakeWaiter {
  /**
   * Subscribes before the caller's first check, so a change committed between
   * that check and the first `next` still wakes it.
   */
  watch(scope: WakeSubscriptionScope): Promise<ProjectWakeWatch>;
}

export interface ProjectWakeWaiterOptions {
  /** Longest wait without a wake. Defaults to 5 seconds. */
  readonly fallbackMilliseconds?: number;
  /** Shortest time between two re-checks of one watch. Defaults to 250 ms. */
  readonly minimumIntervalMilliseconds?: number;
}

/** Project wakes from a LISTEN notifier, with a bounded fallback interval. */
export function createProjectWakeWaiter(
  notifier: Pick<WakeOnlyNotifier, "subscribe">,
  options: ProjectWakeWaiterOptions = {},
): ProjectWakeWaiter {
  const fallback = options.fallbackMilliseconds ?? 5_000;
  const minimum = options.minimumIntervalMilliseconds ?? 250;
  return {
    async watch(scope) {
      let pending = false;
      let onWake: (() => void) | undefined;
      let lastResolved = 0;
      const wake = () => {
        pending = true;
        onWake?.();
      };
      const unsubscribe = await notifier.subscribe(wake, scope);
      return {
        wake,
        close: unsubscribe,
        next(signal) {
          if (signal?.aborted) return Promise.reject(signal.reason);
          return new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + fallback;
            let timer: NodeJS.Timeout | undefined;
            const cleanup = () => {
              clearTimeout(timer);
              onWake = undefined;
              signal?.removeEventListener("abort", onAbort);
            };
            const finish = () => {
              cleanup();
              pending = false;
              lastResolved = Date.now();
              resolve();
            };
            const onAbort = () => {
              cleanup();
              reject(signal?.reason);
            };
            const schedule = () => {
              clearTimeout(timer);
              const at = pending
                ? Math.max(Date.now(), lastResolved + minimum)
                : deadline;
              timer = setTimeout(finish, Math.max(0, at - Date.now()));
            };
            onWake = schedule;
            signal?.addEventListener("abort", onAbort, { once: true });
            schedule();
          });
        },
      };
    },
  };
}

/** A watch that only sleeps, for callers without a notifier. */
export function sleepingProjectWakeWatch(
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  milliseconds: number,
): ProjectWakeWatch {
  return {
    next: (signal) =>
      signal?.aborted
        ? Promise.reject(signal.reason)
        : sleep(milliseconds, signal),
    wake: () => undefined,
    close: () => Promise.resolve(),
  };
}

/** Resolves after the delay; rejects with the signal's reason on abort. */
export function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
