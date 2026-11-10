import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Api,
  AssistantMessage,
  Model,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { RUN_SUGGESTION_MAX_CHARACTERS } from "@oao/contracts";
import { jsonbSafeText } from "@oao/domain";
import { withOutputTokenLimit } from "@oao/models-openrouter";

/**
 * The user message appended to a run's last model request to ask for the
 * prompt suggestion. Everything before it is that request unchanged, so the
 * provider serves the conversation from its prompt cache.
 */
export const PROMPT_SUGGESTION_INSTRUCTION = [
  "[Automated request from the application, not a message from the user.]",
  "Predict the next message the user will send in this conversation.",
  "Reply with only that message, written in the first person exactly as the user would type it, in the language the user writes in, in under 30 words.",
  "Make it specific: continue the work in progress and name the items being discussed (their identifiers, names, or values) instead of referring to them vaguely.",
  "Never reply with a generic line such as a thank-you, a greeting, or a request to explain more.",
  "Do not use tools, and do not answer the conversation.",
  "If no specific next message is likely, reply with exactly: NONE",
].join(" ");

/**
 * Bounds what one suggestion can cost in output. It leaves room for a
 * reasoning model to think before it writes its short answer.
 */
export const PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS = 1_024;

/** A suggestion that arrives later than this is no longer worth showing. */
export const PROMPT_SUGGESTION_TIMEOUT_MS = 30_000;

// A request normally leaves when its run settles; the caps only bound memory
// when a settlement is never observed by this worker.
const MAX_TRACKED_INSTANCES = 256;
const MAX_TRACKED_TURNS = 1_000;

interface ModelCallScope {
  readonly instanceId: string;
  readonly turnId: string;
}

/** The last main-loop model request of a run and the reply it produced. */
export interface CapturedModelRequest {
  readonly runId: string;
  /** The provider the request went to, with OAO's call timeout. */
  readonly provider: Provider;
  readonly model: Model<Api>;
  readonly context: TranscriptContext;
  readonly options: SimpleStreamOptions | undefined;
  /** Undefined when the request failed. */
  readonly reply: Promise<AssistantMessage | undefined>;
}

/**
 * Keeps, in worker memory, the last model request of each run whose agent
 * version has prompt suggestions on, so the suggestion can replay it. Nothing
 * here is durable: after a worker restart, or when another worker settles the
 * run, the run simply gets no suggestion.
 *
 * Flue hands a provider the request but not the run it belongs to. The
 * execution interceptor knows the agent instance and turn, so it opens a scope
 * that the provider wrapper reads when the request reaches it.
 */
export class PromptSuggestionCapture {
  readonly #scope = new AsyncLocalStorage<ModelCallScope>();
  /** Agent instance to its current run, for runs with the setting on. */
  readonly #runs = new Map<string, string>();
  /** Turns of the main agent loop; compaction turns are not replayed. */
  readonly #agentTurns = new Set<string>();
  readonly #requests = new Map<string, CapturedModelRequest>();

  /**
   * @param isScratch Whether the current call belongs to a scratch
   *   conversation (a Harness Operation), which is not the run's reply.
   */
  constructor(private readonly isScratch: () => boolean) {}

  /** Records the run an agent instance is working on, or that it has none. */
  track(instanceId: string, runId: string | undefined): void {
    this.#runs.delete(instanceId);
    if (!runId) {
      this.#requests.delete(instanceId);
      return;
    }
    this.#runs.set(instanceId, runId);
    for (const oldest of this.#runs.keys()) {
      if (this.#runs.size <= MAX_TRACKED_INSTANCES) break;
      this.#runs.delete(oldest);
      this.#requests.delete(oldest);
    }
  }

  /** Follows Flue observations to tell main-loop turns from compaction. */
  observe(event: {
    readonly type: string;
    readonly turnId?: string;
    readonly purpose?: string;
  }): void {
    if (!event.turnId) return;
    if (event.type === "turn") {
      this.#agentTurns.delete(event.turnId);
      return;
    }
    if (event.type !== "turn_request" || event.purpose !== "agent") return;
    this.#agentTurns.add(event.turnId);
    for (const oldest of this.#agentTurns) {
      if (this.#agentTurns.size <= MAX_TRACKED_TURNS) break;
      this.#agentTurns.delete(oldest);
    }
  }

  /** Runs a Flue model operation so its provider request can be attributed. */
  withModelCall<T>(
    scope: {
      readonly instanceId: string | undefined;
      readonly turnId: string | undefined;
    },
    next: () => T,
  ): T {
    if (!scope.instanceId || !scope.turnId || !this.#runs.has(scope.instanceId))
      return next();
    return this.#scope.run(
      { instanceId: scope.instanceId, turnId: scope.turnId },
      next,
    );
  }

  /** Wraps a provider so the requests of tracked runs are kept. */
  wrap<T extends Provider>(provider: T): T {
    const record = this.#record.bind(this);
    return {
      ...provider,
      streamSimple(model, context, options) {
        const stream = provider.streamSimple(model, context, options);
        record(
          provider,
          model,
          context,
          options,
          stream.result().then(
            (message) => message,
            () => undefined,
          ),
        );
        return stream;
      },
    } as T;
  }

  #record(
    provider: Provider,
    model: Model<Api>,
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined,
    reply: Promise<AssistantMessage | undefined>,
  ): void {
    const scope = this.#scope.getStore();
    if (!scope || this.isScratch() || !this.#agentTurns.has(scope.turnId))
      return;
    const runId = this.#runs.get(scope.instanceId);
    if (!runId) return;
    this.#requests.set(scope.instanceId, {
      runId,
      provider,
      model,
      context,
      options,
      reply,
    });
  }

  /** Removes and returns the last request of a run, when this worker has it. */
  take(instanceId: string, runId: string): CapturedModelRequest | undefined {
    const request = this.#requests.get(instanceId);
    if (request?.runId !== runId) return undefined;
    this.#requests.delete(instanceId);
    if (this.#runs.get(instanceId) === runId) this.#runs.delete(instanceId);
    return request;
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ");
}

function callsTools(message: AssistantMessage): boolean {
  return message.content.some((part) => part.type === "toolCall");
}

/** Whether a model reply ended a run with text for the user. */
export function isFinalReply(
  message: AssistantMessage | undefined,
): message is AssistantMessage {
  return (
    message !== undefined &&
    message.stopReason === "stop" &&
    !callsTools(message) &&
    assistantText(message).trim().length > 0
  );
}

const WRAPPING_QUOTES: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["«", "»"],
];

// What models write when asked to reply with nothing.
const NO_SUGGESTION =
  /^[([]?(?:none|null|n\/a|nothing|no (?:clear |specific |likely )?(?:next )?(?:step|message|suggestion))[)\].!]*$/iu;

/**
 * The suggestion in a model's answer, or undefined when there is none: the
 * answer called a tool, was cut off, was empty, declined, or is too long to be
 * a message someone would send.
 */
export function promptSuggestionText(
  message: AssistantMessage,
): string | undefined {
  if (message.stopReason !== "stop" || callsTools(message)) return undefined;
  // The same treatment as an assistant reply: PostgreSQL text rejects NUL and
  // lone surrogates, which a model answer can contain.
  let text = jsonbSafeText(assistantText(message)).replace(/\s+/gu, " ").trim();
  for (const [open, close] of WRAPPING_QUOTES) {
    if (
      text.length >= 2 &&
      text.startsWith(open) &&
      text.endsWith(close) &&
      !text.slice(1, -1).includes(open) &&
      !text.slice(1, -1).includes(close)
    ) {
      text = text.slice(1, -1).trim();
      break;
    }
  }
  if (!text || NO_SUGGESTION.test(text)) return undefined;
  if (text.length > RUN_SUGGESTION_MAX_CHARACTERS) return undefined;
  return text;
}

export interface PromptSuggestionCall {
  /** The provider's answer, whatever it holds; its usage is what the call cost. */
  readonly message: AssistantMessage;
  readonly startedAt: Date;
  readonly completedAt: Date;
  /** The suggestion, when the answer holds one. */
  readonly text: string | undefined;
}

/**
 * Sends a run's last model request again, with the reply it produced and the
 * suggestion instruction appended, straight to the provider. Flue never sees
 * the call, so it is not part of the conversation and wakes no sandbox.
 *
 * The model object, system prompt, tools, earlier messages, and options are
 * the ones the run used, so the provider can serve them from its prompt cache;
 * only the output limit and the abort signal differ. The tools stay in the
 * request for that reason, and an answer that calls one is not a suggestion.
 *
 * Returns undefined when the run did not end with a reply to the user.
 */
export async function requestPromptSuggestion(
  captured: CapturedModelRequest,
  signal: AbortSignal,
): Promise<PromptSuggestionCall | undefined> {
  const reply = await captured.reply;
  if (!isFinalReply(reply)) return undefined;
  signal.throwIfAborted();
  const startedAt = new Date();
  const message = await captured.provider
    .streamSimple(
      captured.model,
      {
        ...captured.context,
        messages: [
          ...captured.context.messages,
          reply,
          {
            role: "user",
            content: PROMPT_SUGGESTION_INSTRUCTION,
            timestamp: startedAt.getTime(),
          },
        ],
      },
      {
        // A preset with its own output limit would otherwise keep that limit.
        ...withOutputTokenLimit(
          captured.options,
          PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS,
        ),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(PROMPT_SUGGESTION_TIMEOUT_MS),
        ]),
      },
    )
    .result();
  return {
    message,
    startedAt,
    completedAt: new Date(),
    text: promptSuggestionText(message),
  };
}
