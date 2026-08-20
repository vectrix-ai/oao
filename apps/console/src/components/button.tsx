import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variantClass: Record<ButtonVariant, string> = {
  primary: "btn btn--primary",
  secondary: "btn",
  ghost: "btn btn--ghost",
  danger: "btn btn--danger",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: " btn--sm",
  md: "",
  lg: " btn--lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Renders a spinner and blocks interaction while an action is in flight. */
  readonly loading?: boolean;
  readonly icon?: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      className={`${variantClass[variant]}${sizeClass[size]}${className ? ` ${className}` : ""}`}
    >
      {loading ? <span className="spin" aria-hidden="true" /> : (icon ?? null)}
      {children}
    </button>
  );
}

/** Icon-only control. `label` is required because there is no visible text. */
export function IconButton({
  label,
  className,
  children,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  readonly label: string;
}) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      className={`icon-btn${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
}

export function ButtonGroup({ children }: { readonly children: ReactNode }) {
  return <div className="btn-group">{children}</div>;
}
