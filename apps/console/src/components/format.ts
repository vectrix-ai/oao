/** Shared display formatters so every surface renders values identically. */

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-BE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatCost(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

export function formatDuration(value: number | null): string {
  return value === null ? "—" : `${formatNumber(value)} ms`;
}

export function shortId(value: string): string {
  return value.length > 22 ? `${value.slice(0, 15)}…${value.slice(-4)}` : value;
}

export function initials(displayName: string): string {
  return displayName
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Turns a machine status such as `waiting_for_tool` into readable copy. */
export function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

/** Full stamp with seconds, for exports where ordering has to be readable. */
export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-BE", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

/** Clock-only stamp for transcript rows, where the date is already implied. */
export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-BE", { timeStyle: "medium" }).format(
    new Date(value),
  );
}

/**
 * Short duration for dense rows: `725ms`, `11.4s`, `2m 44s`.
 *
 * The verbose `formatDuration` stays for detail views where the exact
 * millisecond count is the point.
 */
export function formatCompactDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Binary file sizes for attachment rows: `812 B`, `3.4 KiB`, `1.2 MiB`. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Compact token counts for meta strips: `507k`, `7.1k`, `24`. */
export function formatCompactNumber(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`;
}
