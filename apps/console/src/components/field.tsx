import { Search } from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

interface FieldControl {
  readonly id: string;
  readonly describedBy?: string;
  readonly invalid: boolean;
}

const FieldContext = createContext<FieldControl | null>(null);

/**
 * Labelled form control wrapper.
 *
 * The label is explicitly associated with the control, and hint/error text is
 * wired through `aria-describedby`, so the accessible name stays exactly the
 * label. `Input`, `Select`, and `Textarea` pick this up automatically.
 */
export function Field({
  label,
  labelHidden = false,
  hint,
  error,
  className,
  children,
}: {
  readonly label: string;
  /** Hides the label visually where a placeholder already carries it. */
  readonly labelHidden?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const base = useId();
  const id = `${base}control`;
  const hintId = hint ? `${base}hint` : undefined;
  const errorId = error ? `${base}error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider
      value={{
        id,
        ...(describedBy ? { describedBy } : {}),
        invalid: Boolean(error),
      }}
    >
      <div className={`field${className ? ` ${className}` : ""}`}>
        <label htmlFor={id} className={labelHidden ? "sr-only" : undefined}>
          {label}
        </label>
        {children}
        {hint ? (
          <span className="hint" id={hintId}>
            {hint}
          </span>
        ) : null}
        {error ? (
          <span className="error-msg" id={errorId}>
            {error}
          </span>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/** Wiring a custom control needs to inherit its `Field` label and hints. */
export function useFieldControl(): Partial<{
  id: string;
  "aria-describedby": string;
  "aria-invalid": true;
}> {
  const field = useContext(FieldContext);
  if (!field) return {};
  return {
    id: field.id,
    ...(field.describedBy ? { "aria-describedby": field.describedBy } : {}),
    ...(field.invalid ? { "aria-invalid": true as const } : {}),
  };
}

export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...useFieldControl()}
      {...rest}
      className={`input${className ? ` ${className}` : ""}`}
    />
  );
}

export function Select({
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...useFieldControl()}
      {...rest}
      className={`select${className ? ` ${className}` : ""}`}
    />
  );
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...useFieldControl()}
      {...rest}
      className={`textarea${className ? ` ${className}` : ""}`}
    />
  );
}

/** Row of related fields that wraps instead of squeezing on narrow screens. */
export function FieldRow({ children }: { readonly children: ReactNode }) {
  return <div className="field-row">{children}</div>;
}

export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function CheckboxRow({
  label,
  description,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  readonly label: string;
  readonly description?: string;
}) {
  return (
    <label className="check-row">
      <input type="checkbox" {...rest} />
      <span>
        <strong>{label}</strong>
        {description ? <span className="sub">{description}</span> : null}
      </span>
    </label>
  );
}

export function SearchField({
  value,
  onChange,
  label = "Search",
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label?: string;
}) {
  return (
    <label className="search-field">
      <span className="sr-only">{label}</span>
      <Search size={15} aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
      />
    </label>
  );
}

/** Inline, blocking error shown where the failing task lives — never a toast. */
export function FormError({ children }: { readonly children: ReactNode }) {
  return (
    <p className="form-error" role="alert">
      {children}
    </p>
  );
}

export function FormActions({ children }: { readonly children: ReactNode }) {
  return <div className="form-actions">{children}</div>;
}
