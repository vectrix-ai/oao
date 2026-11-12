import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What the model calls of one conversation share for prompt caching.
 *
 * Calls with the same key are routed to the same provider and cache, so a call
 * reads what an earlier call with the same key and the same start of its input
 * wrote, also when that call belonged to another conversation.
 */
export interface ModelPromptCacheScope {
  /**
   * Cache and routing key: 1 to 64 printable ASCII characters. Without one
   * the call keeps the session ID its caller gave.
   */
  readonly key?: string;
  /**
   * The length of the stable start of a user text block, or undefined when the
   * block has none. That start is the same for every conversation that shares
   * the key, so it ends in a cache breakpoint of its own.
   */
  readonly stablePrefixLength?: (text: string) => number | undefined;
}

const activeScope = new AsyncLocalStorage<ModelPromptCacheScope | undefined>();

/**
 * Runs `run` with `scope` as the prompt cache scope of every model call it
 * starts. A provider reads the scope when its stream starts.
 */
export function withModelPromptCacheScope<T>(
  scope: ModelPromptCacheScope | undefined,
  run: () => T,
): T {
  return activeScope.run(scope, run);
}

/** The prompt cache scope of the model call being started, if any. */
export function currentModelPromptCacheScope():
  ModelPromptCacheScope | undefined {
  return activeScope.getStore();
}

const BREAKPOINT = { mode: "explicit" } as const;
const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const MESSAGE_ROLES = new Set(["user", "system", "developer"]);
const MARKABLE_BLOCKS = new Set(["input_text", "input_image", "input_file"]);
const TOOL_OUTPUTS = new Set([
  "function_call_output",
  "custom_tool_call_output",
]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMessage(item: JsonRecord): boolean {
  return (
    (item.type === undefined || item.type === "message") &&
    typeof item.role === "string"
  );
}

function marked(block: JsonRecord): JsonRecord {
  return { ...block, prompt_cache_breakpoint: BREAKPOINT };
}

/**
 * Content with a breakpoint on its last block. A string becomes one text
 * block. Returns undefined when nothing in it can carry a breakpoint.
 */
function markLastBlock(content: unknown): JsonRecord[] | undefined {
  if (typeof content === "string")
    return content.length > 0
      ? [marked({ type: "input_text", text: content })]
      : undefined;
  if (!Array.isArray(content)) return undefined;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block: unknown = content[index];
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (!MARKABLE_BLOCKS.has(block.type)) continue;
    if (block.prompt_cache_breakpoint !== undefined)
      return content as JsonRecord[];
    const next = [...(content as JsonRecord[])];
    next[index] = marked(block);
    return next;
  }
  return undefined;
}

/**
 * The content of a user message with its first text block split at the
 * stable prefix the scope names, and a breakpoint after the prefix. Returns
 * undefined when no block starts with a stable prefix.
 */
function splitStablePrefix(
  content: unknown,
  stablePrefixLength: (text: string) => number | undefined,
): JsonRecord[] | undefined {
  if (!Array.isArray(content)) return undefined;
  for (let index = 0; index < content.length; index += 1) {
    const block: unknown = content[index];
    if (
      !isRecord(block) ||
      block.type !== "input_text" ||
      typeof block.text !== "string"
    )
      continue;
    const length = stablePrefixLength(block.text);
    if (
      length === undefined ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > block.text.length
    )
      continue;
    const next = [...(content as JsonRecord[])];
    next.splice(
      index,
      1,
      marked({ ...block, text: block.text.slice(0, length) }),
      ...(length < block.text.length
        ? [{ ...block, text: block.text.slice(length) }]
        : []),
    );
    return next;
  }
  return undefined;
}

/**
 * Adds prompt cache breakpoints to an OpenAI Responses request body.
 *
 * - After the leading instructions message: the instructions and the tool
 *   definitions before them are shared by every call of the same agent.
 * - After the stable start of the first user message that has one, when the
 *   scope can find it: it is shared by every conversation with the same key.
 * - At the end of the latest input item that can carry one: each call reads
 *   what the previous call of the conversation wrote.
 *
 * GPT-5.6 and later read cache only at breakpoints, and OpenRouter turns each
 * breakpoint into an Anthropic or Google `cache_control` marker. A request
 * writes at most four cache entries; this adds at most three breakpoints.
 */
export function withPromptCacheBreakpoints(
  payload: unknown,
  scope?: Pick<ModelPromptCacheScope, "stablePrefixLength">,
): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;
  const input: unknown[] = [...(payload.input as unknown[])];

  const first = input[0];
  if (
    isRecord(first) &&
    isMessage(first) &&
    INSTRUCTION_ROLES.has(first.role as string)
  ) {
    const content = markLastBlock(first.content);
    if (content) input[0] = { ...first, content };
  }

  if (scope?.stablePrefixLength) {
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      if (!isRecord(item) || !isMessage(item) || item.role !== "user") continue;
      const content = splitStablePrefix(item.content, scope.stablePrefixLength);
      if (!content) continue;
      input[index] = { ...item, content };
      break;
    }
  }

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item)) continue;
    if (isMessage(item) && MESSAGE_ROLES.has(item.role as string)) {
      const content = markLastBlock(item.content);
      if (!content) continue;
      input[index] = { ...item, content };
      break;
    }
    if (typeof item.type === "string" && TOOL_OUTPUTS.has(item.type)) {
      const output = markLastBlock(item.output);
      if (!output) continue;
      input[index] = { ...item, output };
      break;
    }
  }

  return { ...payload, input };
}
