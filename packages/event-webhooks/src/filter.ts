/**
 * Event-kind filters are exact kinds (`run.state_changed`) or family wildcards
 * (`run.*`). A null filter delivers every event.
 */
const PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?$/u;

export function isEventKindPattern(value: string): boolean {
  return value.length <= 120 && PATTERN.test(value);
}

export function matchesEventKinds(
  kind: string,
  patterns: readonly string[] | null,
): boolean {
  if (patterns === null) return true;
  return patterns.some((pattern) =>
    pattern.endsWith(".*")
      ? kind.startsWith(pattern.slice(0, -1))
      : kind === pattern,
  );
}
