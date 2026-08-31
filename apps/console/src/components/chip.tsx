import type { ReactNode } from "react";
import { humanize } from "./format";

export type ChipTone = "neutral" | "success" | "warning" | "danger" | "info";

/**
 * Status vocabulary shared by runs, agents, tools, approvals, roles, and
 * service health. Green = healthy/approved, amber = waiting on a human,
 * red = failed, blue = system-neutral in flight, gray = inert.
 */
const toneByStatus: Record<string, ChipTone> = {
  active: "success",
  approved: "success",
  completed: "success",
  operational: "success",
  owner: "success",
  published: "success",
  running: "success",
  success: "success",

  admin: "info",
  caller_claimed: "info",
  deployment: "info",
  openai: "info",
  anthropic: "info",
  openrouter: "info",
  xai: "info",
  project: "info",
  queued: "info",
  retry_scheduled: "info",
  info: "info",

  caller_pending: "warning",
  degraded: "warning",
  disabled: "warning",
  draft: "warning",
  operator: "warning",
  pending: "warning",
  waiting_for_approval: "warning",
  waiting_for_tool: "warning",

  denied: "danger",
  error: "danger",
  failed: "danger",
  offline: "danger",
  timed_out: "danger",
};

export function statusTone(value: string): ChipTone {
  return toneByStatus[value] ?? "neutral";
}

export function Chip({
  tone = "neutral",
  live = false,
  children,
}: {
  readonly tone?: ChipTone;
  readonly live?: boolean;
  readonly children: ReactNode;
}) {
  const classes = ["chip"];
  if (tone !== "neutral") classes.push(`chip--${tone}`);
  if (live) classes.push("chip--live");
  return (
    <span className={classes.join(" ")}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * Renders a machine status as a chip. Colour never carries meaning alone —
 * the humanised label is always present.
 */
export function StatusChip({ value }: { readonly value: string }) {
  return (
    <Chip tone={statusTone(value)} live={value === "running"}>
      {humanize(value)}
    </Chip>
  );
}

/** Queue counter for navigation items; only shown when work is waiting. */
export function BadgeCount({ value }: { readonly value: number }) {
  return <span className="badge-count">{value}</span>;
}
