import { createHash } from "node:crypto";
import { HttpApiError } from "./errors.js";

export interface ListCursor {
  readonly timestamp: string;
  readonly id: string;
}

export function decodeListCursor(
  value: string | undefined,
): ListCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ListCursor>;
    if (
      typeof parsed.timestamp !== "string" ||
      !Number.isFinite(Date.parse(parsed.timestamp)) ||
      typeof parsed.id !== "string"
    )
      throw new Error("invalid");
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch {
    throw new HttpApiError("bad_request", "Invalid cursor");
  }
}

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function parseLimit(value: string | undefined): number {
  if (!value) return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new HttpApiError(
      "bad_request",
      "limit must be an integer from 1 to 200",
    );
  return limit;
}

export async function readJsonObject(
  request: Request,
): Promise<Readonly<Record<string, unknown>>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json"))
    throw new HttpApiError(
      "bad_request",
      "Content-Type must be application/json",
    );
  try {
    const value: unknown = await request.json();
    if (value === null || Array.isArray(value) || typeof value !== "object")
      throw new Error("not object");
    return value as Readonly<Record<string, unknown>>;
  } catch {
    throw new HttpApiError("bad_request", "Request body must be a JSON object");
  }
}

export function requiredString(
  value: unknown,
  name: string,
  maximum = 2_000,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new HttpApiError(
      "bad_request",
      `${name} must be a non-empty string of at most ${maximum} characters`,
    );
  return value;
}

export function optionalString(
  value: unknown,
  name: string,
  maximum = 2_000,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, maximum);
}

export function idempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || key.length > 200)
    throw new HttpApiError(
      "bad_request",
      "Idempotency-Key header is required and must be at most 200 characters",
    );
  return key;
}

export function requestHash(value: unknown): Uint8Array {
  return createHash("sha256").update(stableJson(value)).digest();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function publicValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key.replace(/_([a-z])/gu, (_match, letter: string) =>
          letter.toUpperCase(),
        ),
        publicValue(nested),
      ]),
    );
  }
  return value;
}
