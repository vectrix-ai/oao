import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "./button";

/**
 * Bordered table shell with its own horizontal scroll container, so wide data
 * never forces the page to scroll sideways.
 */
export function TableCard({
  label,
  caption,
  children,
  footer,
}: {
  readonly label: string;
  readonly caption?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <section className="table-card">
      <div
        className="table-scroll"
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        <table>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          {children}
        </table>
      </div>
      {footer}
    </section>
  );
}

/** Two-line identity cell: icon, name, and a mono secondary identifier. */
export function EntityCell({
  icon,
  name,
  meta,
}: {
  readonly icon: ReactNode;
  readonly name: ReactNode;
  readonly meta?: ReactNode;
}) {
  return (
    <span className="entity-link">
      <span className="entity-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="entity-text">
        <strong>{name}</strong>
        {meta ? <small>{meta}</small> : null}
      </span>
    </span>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label="Pagination">
      <span>
        {total === 0
          ? "0"
          : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}`}{" "}
        of {total}
      </span>
      <span className="page-count">
        Page {page} of {pages}
      </span>
      <IconButton
        label="Previous page"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        <ChevronLeft size={16} />
      </IconButton>
      <IconButton
        label="Next page"
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      >
        <ChevronRight size={16} />
      </IconButton>
    </nav>
  );
}
