import { Check, ChevronsUpDown, Search } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useFieldControl } from "./field";

export interface ComboboxOption {
  readonly value: string;
  /** Primary line, and the text shown in the control once chosen. */
  readonly label: string;
  /** Secondary line — an identifier, key, or model string. */
  readonly description?: string;
  /** Short trailing fact such as a context window or availability note. */
  readonly hint?: string;
  readonly disabled?: boolean;
  /** Extra text matched by the built-in filter but never rendered. */
  readonly keywords?: string;
}

/** Popup height cap; the list scrolls beyond it. */
const MAX_POPUP_HEIGHT = 288;

function matches(option: ComboboxOption, term: string): boolean {
  return `${option.label} ${option.description ?? ""} ${option.value} ${option.keywords ?? ""}`
    .toLowerCase()
    .includes(term);
}

/**
 * Searchable single-select for lists too long to scan in a native `<select>`.
 *
 * Only the first `visibleCount` matches are rendered — the search box, not
 * scrolling, is how an operator reaches the rest — and the popup says how many
 * matches were withheld so a short list is never mistaken for the whole list.
 *
 * Filtering is local by default. Pass `onSearchChange` when the options come
 * from a server-side search: the component then renders `options` as given and
 * reports the debounced term instead of filtering it again.
 *
 * Place it inside a `Field`; the label, hint, and error wiring is picked up
 * from there, so the control keeps the label as its accessible name.
 */
export function Combobox({
  label,
  value,
  options,
  onChange,
  selectedOption,
  placeholder = "Search…",
  disabled = false,
  loading = false,
  errorMessage,
  emptyMessage = "No matches",
  visibleCount = 8,
  onSearchChange,
  searchDebounceMs = 200,
  name,
}: {
  /** Names the option list for assistive technology; matches the field label. */
  readonly label: string;
  readonly value: string;
  readonly options: readonly ComboboxOption[];
  readonly onChange: (value: string) => void;
  /** Display fallback for a value missing from a server-filtered `options`. */
  readonly selectedOption?: ComboboxOption | undefined;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly errorMessage?: string | undefined;
  readonly emptyMessage?: string;
  readonly visibleCount?: number;
  readonly onSearchChange?: (term: string) => void;
  readonly searchDebounceMs?: number;
  /** Emits a hidden input so `FormData`-driven dialogs keep working. */
  readonly name?: string;
}) {
  const control = useFieldControl();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const controlRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  const selected =
    options.find((option) => option.value === value) ??
    (selectedOption?.value === value ? selectedOption : undefined);

  const found = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (onSearchChange || term === "") return options;
    return options.filter((option) => matches(option, term));
  }, [onSearchChange, options, query]);
  const shown = found.slice(0, visibleCount);
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));
  const listVisible = !loading && !errorMessage && shown.length > 0;

  const search = (term: string) => {
    setQuery(term);
    setActive(0);
    if (!onSearchChange) return;
    clearTimeout(debounce.current);
    debounce.current = setTimeout(
      () => onSearchChange(term.trim()),
      searchDebounceMs,
    );
  };

  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(0);
    clearTimeout(debounce.current);
    if (onSearchChange) onSearchChange("");
  };

  useEffect(() => () => clearTimeout(debounce.current), []);

  // Anchor the popup to the control in viewport coordinates so a scrolling
  // dialog body or panel cannot clip it.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const anchor = controlRef.current;
    const popup = popupRef.current;
    if (!anchor || !popup) return undefined;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const flip = below < 180 && above > below;
      popup.style.left = `${rect.left}px`;
      popup.style.width = `${rect.width}px`;
      popup.style.maxHeight = `${Math.max(160, Math.min(MAX_POPUP_HEIGHT, flip ? above : below))}px`;
      popup.style.top = flip ? "auto" : `${rect.bottom + 4}px`;
      popup.style.bottom = flip
        ? `${window.innerHeight - rect.top + 4}px`
        : "auto";
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`${listId}option${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId, open, shown.length]);

  const commit = (option: ComboboxOption | undefined) => {
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
  };

  const step = (delta: number) => {
    if (shown.length === 0) return;
    let next = activeIndex;
    for (let hop = 0; hop < shown.length; hop += 1) {
      next = (next + delta + shown.length) % shown.length;
      if (!shown[next]?.disabled) break;
    }
    setActive(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      step(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      commit(shown[activeIndex]);
      return;
    }
    if (event.key === "Escape" && open) {
      // Keep an enclosing dialog open: the first Escape only closes the list.
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab" && open) close();
  };

  return (
    <div
      className="combo"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <div
        className={`combo-control${disabled ? " combo-control--disabled" : ""}`}
        ref={controlRef}
      >
        <Search size={14} aria-hidden="true" />
        <input
          {...control}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-expanded={open}
          aria-autocomplete="list"
          {...(listVisible && open
            ? {
                "aria-controls": listId,
                "aria-activedescendant": `${listId}option${activeIndex}`,
              }
            : {})}
          value={open ? query : (selected?.label ?? (value ? value : ""))}
          placeholder={open && selected ? selected.label : placeholder}
          onChange={(event) => {
            setOpen(true);
            search(event.target.value);
          }}
          onMouseDown={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <ChevronsUpDown size={14} aria-hidden="true" />
      </div>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      {open ? (
        <div className="combo-popup" ref={popupRef}>
          {loading ? (
            <p className="combo-msg">
              <span className="spin" aria-hidden="true" />
              Loading…
            </p>
          ) : errorMessage ? (
            <p className="combo-msg combo-msg--error">{errorMessage}</p>
          ) : shown.length === 0 ? (
            <p className="combo-msg">{emptyMessage}</p>
          ) : (
            <ul
              className="combo-list"
              role="listbox"
              id={listId}
              aria-label={`${label} options`}
            >
              {shown.map((option, index) => (
                <li
                  key={option.value}
                  id={`${listId}option${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  {...(option.disabled ? { "aria-disabled": true } : {})}
                  className={`combo-opt${index === activeIndex ? " combo-opt--active" : ""}${option.disabled ? " combo-opt--disabled" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(index)}
                  onClick={() => commit(option)}
                >
                  <span className="combo-opt-text">
                    <span className="combo-opt-label">{option.label}</span>
                    {option.description ? (
                      <span className="combo-opt-desc">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                  {option.hint ? (
                    <span className="combo-opt-hint">{option.hint}</span>
                  ) : null}
                  {option.value === value ? (
                    <Check size={14} aria-hidden="true" />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {listVisible && found.length > shown.length ? (
            <p className="combo-note">
              Showing {shown.length} of {found.length}. Search to narrow the
              list.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
