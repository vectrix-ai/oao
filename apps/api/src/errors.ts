import type { ApiError } from "@oao/contracts";
import { AuthenticationError } from "@oao/auth-core";

export type ApiErrorCode = ApiError["error"]["code"];

const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};

export class HttpApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = "HttpApiError";
    this.status = STATUS_BY_CODE[code];
  }
}

export function errorEnvelope(
  error: unknown,
  requestId: string,
): { readonly status: number; readonly body: ApiError } {
  if (error instanceof HttpApiError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  if (error instanceof AuthenticationError) {
    const code: ApiErrorCode =
      error.code === "invalid_callback"
        ? "bad_request"
        : error.code === "invalid_session"
          ? "unauthenticated"
          : error.code === "principal_not_found"
            ? "forbidden"
            : "internal_error";
    return {
      status: STATUS_BY_CODE[code],
      body: {
        error: {
          code,
          message:
            code === "internal_error"
              ? "Authentication provider is unavailable"
              : "Authentication request was rejected",
          requestId,
        },
      },
    };
  }
  if (
    error instanceof Error &&
    error.name === "WorkOsWebhookVerificationError"
  ) {
    return {
      status: 401,
      body: {
        error: {
          code: "unauthenticated",
          message: "Webhook signature is invalid",
          requestId,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "The request could not be completed",
        requestId,
      },
    },
  };
}

export function mapPostgresError(error: unknown): never {
  const pgError = error as {
    readonly code?: string;
    readonly message?: string;
  };
  if (pgError.code === "P0002")
    throw new HttpApiError("not_found", "Resource not found");
  if (pgError.code === "23505")
    throw new HttpApiError("conflict", "Resource already exists");
  if (pgError.code === "22023")
    throw new HttpApiError(
      pgError.message?.includes("idempotency")
        ? "idempotency_conflict"
        : "bad_request",
      pgError.message?.includes("idempotency")
        ? "Idempotency key conflicts with an earlier request"
        : "Invalid request",
    );
  if (
    pgError.code === "23503" ||
    pgError.code === "23514" ||
    pgError.code === "22P02"
  )
    throw new HttpApiError("bad_request", "Request violates a resource rule");
  if (pgError.code === "55000")
    throw new HttpApiError("conflict", "Resource is not in the required state");
  throw error;
}
