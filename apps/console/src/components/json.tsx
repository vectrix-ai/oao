import type { ReactNode } from "react";

/**
 * Pretty-printed, syntax-highlighted JSON.
 *
 * The console renders many small JSON payloads — tool arguments and results,
 * tool schemas, raw event payloads — and they should all read the same way.
 * Highlighting is a tiny tokenizer over the formatted text, not a library:
 * the payloads are small and the token classes map onto the existing signal
 * palette so light and dark stay coherent.
 */

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\bnull\b/gu;

/** Formats any value as stable two-space JSON; strings are re-parsed first. */
export function formatJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

function highlightJson(text: string): readonly ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index ?? cursor;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const [token = "", string, colon, number, boolean] = match;
    const className = string
      ? colon
        ? "jt-key"
        : "jt-str"
      : number
        ? "jt-num"
        : boolean
          ? "jt-bool"
          : "jt-null";
    nodes.push(
      <span key={index} className={className}>
        {colon ? string : token}
      </span>,
    );
    if (colon) nodes.push(colon);
    cursor = index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function JsonBlock({
  value,
  label,
}: {
  readonly value: unknown;
  readonly label?: string;
}) {
  return (
    <pre
      className="code-block code-block--json"
      {...(label ? { "aria-label": label } : {})}
    >
      <code>{highlightJson(formatJson(value))}</code>
    </pre>
  );
}
