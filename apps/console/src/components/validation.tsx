import { ShieldCheck } from "lucide-react";

/**
 * Live validation summary for long forms.
 *
 * Lists every blocking problem in one place next to the action it blocks, so
 * a disabled submit button is never unexplained.
 */
export function ValidationPanel({
  errors,
  readyMessage,
  heading = "Validation",
}: {
  readonly errors: readonly string[];
  readonly readyMessage: string;
  readonly heading?: string;
}) {
  const invalid = errors.length > 0;
  return (
    <section
      className={`validation-panel${invalid ? " validation-panel--invalid" : ""}`}
      aria-live="polite"
    >
      <h2>
        <ShieldCheck size={15} aria-hidden="true" />
        {heading}
      </h2>
      {invalid ? (
        <ul>
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : (
        <p className="valid">{readyMessage}</p>
      )}
    </section>
  );
}
