import { ChevronLeft } from "lucide-react";
import { Link } from "react-router";
import type { ReactNode } from "react";

/** Page container. `wide` is for dense two-pane surfaces such as a session. */
export function Page({
  wide = false,
  fill = false,
  children,
}: {
  readonly wide?: boolean;
  /** Pins the page to the viewport so an inner region scrolls, not the document. */
  readonly fill?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={`page${wide ? " page--wide" : ""}${fill ? " page--fill" : ""}`}
    >
      {children}
    </div>
  );
}

export interface Crumb {
  readonly label: string;
  readonly to?: string;
}

/** Shows where you are inside one object; the sidebar handles object types. */
export function Breadcrumbs({ items }: { readonly items: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="crumbs">
        {items.map((crumb, index) => (
          <li key={crumb.label} style={{ display: "contents" }}>
            {index > 0 ? (
              <span className="sep" aria-hidden="true">
                /
              </span>
            ) : null}
            {crumb.to ? (
              <Link to={crumb.to}>
                {index === 0 ? (
                  <ChevronLeft size={13} aria-hidden="true" />
                ) : null}
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  breadcrumbs,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly breadcrumbs?: readonly Crumb[];
}) {
  return (
    <header>
      {breadcrumbs ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="page-header">
        <div>
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <h1>{title}</h1>
          {description ? (
            <p className="page-description">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

/** Bordered content panel with an optional header row and actions. */
export function Panel({
  title,
  description,
  actions,
  children,
  flush = false,
  labelledBy,
}: {
  readonly title?: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly flush?: boolean;
  readonly labelledBy?: string;
}) {
  return (
    <section
      className="panel"
      {...(labelledBy ? { "aria-labelledby": labelledBy } : {})}
    >
      {title ? (
        <div className="panel-head">
          <div>
            <h2 {...(labelledBy ? { id: labelledBy } : {})}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="panel-head-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className={`panel-body${flush ? " panel-body--flush" : ""}`}>
        {children}
      </div>
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
  id,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly id?: string;
}) {
  return (
    <div className="page-header section-heading">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h2 {...(id ? { id } : {})}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export interface MetaItem {
  readonly label: string;
  readonly value: ReactNode;
  readonly title?: string;
}

/** Bordered key/value strip for run and resource metadata. */
export function MetaGrid({
  items,
  columns = 4,
}: {
  readonly items: readonly MetaItem[];
  readonly columns?: number;
}) {
  return (
    <dl
      className="meta-grid"
      style={{ "--meta-cols": columns } as React.CSSProperties}
    >
      {items.map((item) => (
        <div className="meta-cell" key={item.label}>
          <dt>{item.label}</dt>
          <dd {...(item.title ? { title: item.title } : {})}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FilterBar({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="filter-bar" aria-label={label}>
      {children}
    </section>
  );
}

/** Accent-spined callout for rules, policy notes, and inline guidance. */
export function Note({ children }: { readonly children: ReactNode }) {
  return <div className="note">{children}</div>;
}
