import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Provider,
  StreamOptions,
} from "@earendil-works/pi-ai";

export const MODEL_CALL_TIMEOUT_MS = 5 * 60 * 1_000;

/** Bound the entire response stream, including providers that ignore abort. */
export function withModelCallTimeout<T extends Provider>(
  provider: T,
  timeoutMs = MODEL_CALL_TIMEOUT_MS,
): T {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("Model call timeout must be a positive integer");

  function stream(
    model: Model<Api>,
    options: StreamOptions | undefined,
    start: (options: StreamOptions) => AssistantMessageEventStream,
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => controller.abort();
    const failure = (cancelled: boolean): AssistantMessage => ({
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: cancelled ? "aborted" : "error",
      errorMessage: cancelled
        ? "Model call cancelled"
        : `Model call timed out after ${timeoutMs}ms`,
      timestamp: Date.now(),
    });

    void (async () => {
      const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
      });
      // Install a rejection handler before invoking a possibly synchronous provider.
      void interrupted.catch(() => undefined);
      try {
        options?.signal?.addEventListener("abort", cancel, { once: true });
        if (options?.signal?.aborted) cancel();
        controller.signal.throwIfAborted();
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        const source = start({
          ...options,
          signal: controller.signal,
          timeoutMs,
          // Flue owns the durable three-retry budget. SDK retries must not multiply it.
          maxRetries: 0,
        });
        const iterator = source[Symbol.asyncIterator]();
        while (true) {
          const item = await Promise.race([iterator.next(), interrupted]);
          controller.signal.throwIfAborted();
          if (item.done)
            throw new Error("Model stream ended without an outcome");
          output.push(item.value);
          if (item.value.type === "done" || item.value.type === "error") return;
        }
      } catch (error) {
        const cancelled = options?.signal?.aborted === true;
        const message = failure(cancelled);
        if (!cancelled && !timedOut) {
          // Preserve provider errors for Flue's existing transient-error classifier.
          message.errorMessage =
            error instanceof Error ? error.message : "Model provider failed";
        }
        output.push({
          type: "error",
          reason: cancelled ? "aborted" : "error",
          error: message,
        });
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        controller.abort();
        output.end();
      }
    })();
    return output;
  }

  return {
    ...provider,
    stream(model, context, options) {
      return stream(model, options, (bounded) =>
        provider.stream(model, context, bounded as never),
      );
    },
    streamSimple(model, context, options) {
      return stream(model, options, (bounded) =>
        provider.streamSimple(model, context, { ...options, ...bounded }),
      );
    },
  } as T;
}
