import type { ReactNode } from "react";
import { Button } from "./button";

/**
 * Skeleton placeholder. It mirrors the real layout so nothing jumps on load,
 * pulses opacity rather than shimmering, and is hidden from assistive tech —
 * `LoadingState` announces the load instead.
 */
export function Skeleton({ rows = 5 }: { readonly rows?: number }) {
  const widths = ["55%", "85%", "70%", "82%", "40%", "64%", "76%"];
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="sk-line"
          style={{ width: widths[index % widths.length] }}
        />
      ))}
    </div>
  );
}

export function LoadingState({
  label = "Loading",
  rows,
}: {
  readonly label?: string;
  readonly rows?: number;
}) {
  return (
    <div role="status">
      <span className="sr-only">{label}</span>
      <Skeleton {...(rows === undefined ? {} : { rows })} />
    </div>
  );
}

/**
 * Says what failed, what is still safe, and offers a retry — never a bare
 * "something went wrong".
 */
export function ErrorState({
  error,
  retry,
  title = "Couldn’t load this view",
}: {
  readonly error: Error;
  readonly retry: () => void;
  readonly title?: string;
}) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <div className="state-icon" aria-hidden="true">
        ✕
      </div>
      <h2>{title}</h2>
      <p>{error.message}</p>
      <p>Your agents are unaffected — this is a console read failure.</p>
      <Button size="sm" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * Teaches what the object is in one sentence, then offers the creation action.
 * The dashed border marks "nothing here yet" rather than "something broke".
 */
export function EmptyState({
  title,
  description,
  action,
  icon = "◇",
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
  readonly icon?: string;
}) {
  return (
    <div className="state-panel">
      <div className="state-icon" aria-hidden="true">
        {icon}
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
