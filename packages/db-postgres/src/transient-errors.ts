/** Node socket codes that mean the database connection went away. */
const SOCKET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
]);

/** node-postgres messages for a lost connection or a pool checkout timeout. */
const TRANSIENT_MESSAGE =
  /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/u;

/**
 * True when an error says the database was briefly unreachable rather than
 * that the statement or the work itself failed: a lost connection (SQLSTATE
 * class 08), an administrator shutdown or restart (57P), exhausted resources
 * (53), a socket error or a pool checkout timeout. Wrapped errors are checked
 * through their `cause`. Callers retry these; they are never a run outcome.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  for (let current = error, depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error)) return false;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      if (/^(08|53|57P)/u.test(code) || SOCKET_CODES.has(code)) return true;
    }
    if (TRANSIENT_MESSAGE.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
