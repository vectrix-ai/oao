import { useRef, type ReactNode } from "react";

export interface TabItem<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Optional leading icon; segmented view switchers read faster with one. */
  readonly icon?: ReactNode;
  readonly panelId?: string;
}

/**
 * Underline tabs switching between views of the same object.
 *
 * Roving focus: only the selected tab is tabbable, arrows move between tabs,
 * Home/End jump to the ends, and selection follows focus.
 */
export function Tabs<T extends string>({
  label,
  value,
  onChange,
  tabs,
  variant = "underline",
}: {
  readonly label: string;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly tabs: readonly TabItem<T>[];
  readonly variant?: "underline" | "inline" | "segmented";
}) {
  const list = useRef<HTMLDivElement>(null);

  const move = (index: number) => {
    const target = (index + tabs.length) % tabs.length;
    const next = tabs[target];
    if (!next) return;
    onChange(next.value);
    const buttons =
      list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[target]?.focus();
  };

  return (
    <div
      className={`tabs${variant === "underline" ? "" : ` tabs--${variant}`}`}
      role="tablist"
      aria-label={label}
      ref={list}
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab.value === value}
          {...(tab.panelId ? { "aria-controls": tab.panelId } : {})}
          tabIndex={tab.value === value ? 0 : -1}
          onClick={() => onChange(tab.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") move(index + 1);
            else if (event.key === "ArrowLeft") move(index - 1);
            else if (event.key === "Home") move(0);
            else if (event.key === "End") move(tabs.length - 1);
            else return;
            event.preventDefault();
          }}
        >
          {tab.icon ? (
            <span className="tab-icon" aria-hidden="true">
              {tab.icon}
            </span>
          ) : null}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
