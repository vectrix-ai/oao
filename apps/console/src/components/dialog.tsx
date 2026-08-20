import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button, IconButton } from "./button";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog.
 *
 * Short, blocking decisions or one-to-three-field forms; longer flows deserve
 * a page. Escape and the backdrop cancel, focus is trapped while open and
 * returned to the trigger on close.
 */
export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
  onSubmit,
  wide = false,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  /** When set, head/body/footer are wrapped in a form so a footer
   *  `type="submit"` button drives it — no `form` attribute plumbing. */
  readonly onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  readonly wide?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    if (node && !node.contains(document.activeElement))
      (node.querySelector<HTMLElement>(FOCUSABLE) ?? node).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const targets = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (targets.length === 0) return;
      const first = targets[0]!;
      const last = targets.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  const content = (
    <>
      <div className="dlg-head">
        <h2 id={titleId}>{title}</h2>
        <IconButton label="Close dialog" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="dlg-body">
        {description ? <p>{description}</p> : null}
        {children}
      </div>
      {footer ? <div className="dlg-foot">{footer}</div> : null}
    </>
  );

  return (
    <div
      className="dlg-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`dlg${wide ? " dlg--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panel}
        tabIndex={-1}
      >
        {onSubmit ? <form onSubmit={onSubmit}>{content}</form> : content}
      </div>
    </div>
  );
}

/**
 * Confirmation for an action that is hard to undo.
 *
 * The title names the object and the confirm button repeats the verb — never
 * "OK". Cancel is always a real button.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  pending = false,
  error,
  onConfirm,
  onClose,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly tone?: "danger" | "primary";
  readonly pending?: boolean;
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={tone} loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
