import { RUN_SUGGESTION_MAX_CHARACTERS } from "@oao/contracts";
import { jsonbSafeText } from "@oao/domain";

const OPEN_TAG = "<next_user_message>";
const CLOSE_TAG = "</next_user_message>";

/**
 * Added to the system prompt of an agent version with prompt suggestions. The
 * model writes its prediction of the user's next message as the last line of
 * its final reply, so the suggestion exists the moment the reply does. OAO
 * cuts the line out before the reply is stored or published.
 */
export const PROMPT_SUGGESTION_INSTRUCTION = [
  "Suggested next message: every final reply you write to the user (text in a turn in which you call no tool) must end with one last line in exactly this form:",
  `${OPEN_TAG}the message${CLOSE_TAG}`,
  "The message is your prediction of what the user will most likely send next, written in the first person exactly as the user would type it, in the language the user writes in, in under 30 words.",
  "Make it specific: continue the work in progress and name the items being discussed (their identifiers, names, or values) instead of referring to them vaguely. Use only identifiers, names, and values that appear in the conversation; never invent one.",
  "Never predict a generic line such as a thank-you, a greeting, or a request to explain more.",
  `Whenever you write a final reply, always write the line, also after a short or complete answer: there is nearly always a useful next step about what was just discussed. Only when the user is clearly ending the conversation, write ${OPEN_TAG}NONE${CLOSE_TAG} instead.`,
  "The line only ever follows a reply of your own. When you end your turn without writing anything to the user, for example because a tool has just put a question to the user or you were told to add no further message, write nothing at all: never write text, or this line on its own, just to carry a suggestion.",
  "The application removes this line before the user sees your reply and offers the message as a suggestion. Never mention it, never write the tag anywhere else, and write nothing after it.",
].join("\n");

function isSuggestionLine(line: string): boolean {
  return line.trimStart().startsWith(OPEN_TAG);
}

/**
 * Text without any suggestion line. Applied to every assistant text of a run
 * with prompt suggestions before it is stored, so a consumer never sees the
 * line, wherever the model wrote it.
 */
export function withoutSuggestionLines(text: string): string {
  if (!text.includes(OPEN_TAG)) return text;
  return text
    .split("\n")
    .filter((line) => !isSuggestionLine(line))
    .join("\n");
}

const WRAPPING_QUOTES: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["«", "»"],
];

// What models write when they have nothing to suggest.
const NO_SUGGESTION =
  /^[([]?(?:none|null|n\/a|nothing|no (?:clear |specific |likely )?(?:next )?(?:step|message|suggestion))[)\].!]*$/iu;

/**
 * The suggestion a reply ends with, or undefined when there is none: the reply
 * does not end with a complete suggestion line, or the line holds nothing a
 * user would send. Only the last line counts, so a line the model wrote
 * earlier in its reply is never taken for the suggestion.
 */
export function replySuggestion(reply: string): string | undefined {
  const last = reply.trimEnd().split("\n").at(-1)?.trim() ?? "";
  if (!last.startsWith(OPEN_TAG) || !last.endsWith(CLOSE_TAG)) return undefined;
  // The same treatment as an assistant reply: PostgreSQL text rejects NUL and
  // lone surrogates, which a model answer can contain.
  let text = jsonbSafeText(last.slice(OPEN_TAG.length, -CLOSE_TAG.length))
    .replace(/\s+/gu, " ")
    .trim();
  // A tag inside the message means the line is not what was asked for.
  if (text.includes(OPEN_TAG) || text.includes(CLOSE_TAG)) return undefined;
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
