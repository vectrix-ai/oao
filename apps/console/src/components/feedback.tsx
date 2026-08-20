import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconButton } from "./button";

export type Tone = "info" | "success" | "warning" | "danger";

const toneIcon = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
} as const;

/**
 * Persistent condition banner. Alerts stay until the condition is resolved —
 * use a toast for "this just happened".
 */
export function Alert({
  tone = "info",
  title,
  children,
  role,
}: {
  readonly tone?: Tone;
  readonly title?: string;
  readonly children: ReactNode;
  readonly role?: "alert" | "status" | "note";
}) {
  const Icon = toneIcon[tone];
  return (
    <div className={`alert alert--${tone}`} role={role}>
      <Icon size={16} aria-hidden="true" />
      <div>
        {title ? <strong>{title}</strong> : null}
        {children}
      </div>
    </div>
  );
}

interface Toast {
  readonly id: number;
  readonly tone: Tone;
  readonly message: string;
}

const ToastContext = createContext<
  ((message: string, tone?: Tone) => void) | null
>(null);

const MAX_TOASTS = 3;
const DISMISS_MS = 5000;

/**
 * Transient confirmation of something that already happened. One line, past
 * tense. Blocking errors belong inline with the task, not here.
 */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, tone: Tone = "success") => {
      const id = (nextId.current += 1);
      setToasts((current) =>
        [...current, { id, tone, message }].slice(-MAX_TOASTS),
      );
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        dismiss(id);
      }, DISMISS_MS);
      timers.current.add(timer);
    },
    [dismiss],
  );

  // Clear pending dismiss timers so unmounting mid-toast never updates state.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="toast-region"
        role="status"
        aria-live="polite"
        aria-label="Notifications"
      >
        {toasts.map((toast) => {
          const Icon = toneIcon[toast.tone];
          return (
            <div key={toast.id} className={`toast toast--${toast.tone}`}>
              <Icon size={16} aria-hidden="true" />
              <span className="t-msg">{toast.message}</span>
              <IconButton
                label="Dismiss notification"
                onClick={() => dismiss(toast.id)}
              >
                <X size={14} />
              </IconButton>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Returns a `notify(message, tone)` function. Safe to call outside a provider
 * (it becomes a no-op) so components stay testable in isolation.
 */
export function useToast(): (message: string, tone?: Tone) => void {
  const notify = useContext(ToastContext);
  return useMemo(() => notify ?? (() => undefined), [notify]);
}
