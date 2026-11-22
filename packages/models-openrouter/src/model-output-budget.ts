import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Provider,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";

/**
 * Smallest clamped output budget OAO will send to a model before triggering
 * context compaction and retry. Prevents near-zero-output `length` stops when
 * mid-run tool results push a conversation close to the context window.
 */
export const MIN_MODEL_OUTPUT_TOKENS = 2_000;

/**
 * Matches pi-ai's context-overflow error patterns (`/context window exceeded/i`)
 * so Flue's `runModelTurnWithRecovery` compacts and retries the turn once.
 */
export const OUTPUT_BUDGET_OVERFLOW_MESSAGE =
  "Context window exceeded: remaining output token budget is too small";

export const EMPTY_LENGTH_OVERFLOW_MESSAGE =
  "Context window exceeded: model stopped on length with no output";

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function hasActionableOutput(message: AssistantMessage): boolean {
  return message.content.some(
    (block) =>
      block.type === "toolCall" ||
      (block.type === "text" && block.text.trim().length > 0),
  );
}

/** Flue's `DEFAULT_COMPACTION_SETTINGS.keepRecentTokens`. */
const FLUE_KEEP_RECENT_TOKENS = 8_000;

function estimateFlueMessageTokens(
  message: TranscriptContext["messages"][number],
): number {
  let chars = 0;
  if (message.role === "user") {
    if (typeof message.content === "string") {
      chars = message.content.length;
    } else {
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
      }
    }
    return Math.ceil(chars / 4);
  }
  if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "thinking") chars += block.thinking.length;
      else chars += block.name.length + JSON.stringify(block.arguments).length;
    }
    return Math.ceil(chars / 4);
  }
  if (message.role === "toolResult") {
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else chars += 4_800;
    }
    return Math.ceil(chars / 4);
  }
  return 0;
}

function isCompactionSummaryMessage(
  message: TranscriptContext["messages"][number] | undefined,
): boolean {
  if (message?.role !== "user") return false;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
  return text.startsWith("<compaction ") && text.endsWith("</compaction>");
}

/**
 * Mirror Flue's `prepareCompaction` cut-point selection so the pre-call guard
 * only synthesizes an overflow when Flue can actually compact earlier history.
 */
function hasCompactableCutPoint(context: TranscriptContext): boolean {
  const messages = context.messages.filter(
    (message) => message.role !== "system",
  );
  if (messages.length === 0) return false;
  const boundaryStart = isCompactionSummaryMessage(messages[0]) ? 1 : 0;
  const cutPoints: number[] = [];
  for (let i = boundaryStart; i < messages.length; i += 1) {
    const role = messages[i]?.role;
    if (role === "user" || role === "assistant") cutPoints.push(i);
  }
  if (cutPoints.length === 0) return false;
  let accumulated = 0;
  let cutIndex = cutPoints[0] ?? boundaryStart;
  for (let i = messages.length - 1; i >= boundaryStart; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    accumulated += estimateFlueMessageTokens(message);
    if (accumulated >= FLUE_KEEP_RECENT_TOKENS) {
      for (const cutPoint of cutPoints) {
        if (cutPoint >= i) {
          cutIndex = cutPoint;
          break;
        }
      }
      break;
    }
  }
  return cutIndex > boundaryStart;
}

function hasInsufficientOutputBudget(
  model: Model<Api>,
  context: TranscriptContext,
  options: StreamOptions | undefined,
  minOutputTokens: number,
): boolean {
  if (model.contextWindow <= 0) return false;
  if (!hasCompactableCutPoint(context)) return false;
  const requested = options?.maxTokens ?? model.maxTokens;
  if (requested <= 0) return false;
  const floor = Math.min(minOutputTokens, requested);
  return clampMaxTokensToContext(model, context, requested) < floor;
}

/**
 * Convert near-zero output room or an empty `length` stop into a context
 * overflow error so Flue compacts the conversation and retries the turn once.
 */
export function withModelOutputBudget<T extends Provider>(
  provider: T,
  minOutputTokens = MIN_MODEL_OUTPUT_TOKENS,
): T {
  if (!Number.isSafeInteger(minOutputTokens) || minOutputTokens <= 0)
    throw new RangeError(
      "Minimum output token budget must be a positive integer",
    );

  function guard(
    model: Model<Api>,
    context: TranscriptContext,
    options: StreamOptions | undefined,
    start: () => AssistantMessageEventStream,
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    if (
      options?.signal?.aborted !== true &&
      hasInsufficientOutputBudget(model, context, options, minOutputTokens)
    ) {
      const error: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: OUTPUT_BUDGET_OVERFLOW_MESSAGE,
        timestamp: Date.now(),
      };
      output.push({ type: "error", reason: "error", error });
      output.end();
      return output;
    }

    void (async () => {
      try {
        const source = start();
        for await (const event of source) {
          if (
            event.type === "done" &&
            event.message.stopReason === "length" &&
            !hasActionableOutput(event.message)
          ) {
            const error: AssistantMessage = {
              ...event.message,
              // Keep thinking blocks for invocation diagnostics while dropping
              // whitespace-only text; Flue excludes error turns from context.
              content: event.message.content.filter(
                (block) => block.type === "thinking",
              ),
              stopReason: "error",
              errorMessage: EMPTY_LENGTH_OVERFLOW_MESSAGE,
            };
            output.push({ type: "error", reason: "error", error });
            return;
          }
          output.push(event);
          if (event.type === "done" || event.type === "error") return;
        }
        throw new Error("Model stream ended without an outcome");
      } catch (error) {
        const cancelled = options?.signal?.aborted === true;
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          usage: emptyUsage(),
          stopReason: cancelled ? "aborted" : "error",
          errorMessage: cancelled
            ? "Model call cancelled"
            : error instanceof Error
              ? error.message
              : "Model provider failed",
          timestamp: Date.now(),
        };
        output.push({
          type: "error",
          reason: cancelled ? "aborted" : "error",
          error: message,
        });
      } finally {
        output.end();
      }
    })();

    return output;
  }

  return {
    ...provider,
    stream(model, context, options) {
      return guard(model, context, options, () =>
        provider.stream(model, context, options),
      );
    },
    streamSimple(model, context, options) {
      return guard(model, context, options, () =>
        provider.streamSimple(model, context, options),
      );
    },
  } as T;
}
