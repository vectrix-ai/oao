import { createHash } from "node:crypto";
import type { Queryable } from "@oao/db-postgres";
import type { PublicValue } from "@oao/domain";
import { assertPublicPayload } from "@oao/domain";

export type RuntimeCommandKind = "admit" | "cancel";

export interface RuntimeCommand {
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly kind: RuntimeCommandKind;
  readonly payload: Readonly<Record<string, PublicValue>>;
}

export interface RuntimeWakeInsert extends RuntimeCommand {
  readonly id: string;
  readonly dispatchKey: string;
  readonly requestHash: Uint8Array;
}

/** The transaction is supplied by the API; implementations must not commit it. */
export interface RuntimeCommandPort {
  enqueue(transaction: Queryable, command: RuntimeCommand): Promise<void>;
}

/**
 * Integration hook for runtime migration 0004. The runtime-owned function must
 * durably deduplicate by tenant, run, command kind, and idempotency key.
 */
export class PostgresRuntimeCommandPort implements RuntimeCommandPort {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async enqueue(
    transaction: Queryable,
    command: RuntimeCommand,
  ): Promise<void> {
    const wake = buildRuntimeWake(command);
    await transaction.query(
      "SELECT oao.enqueue_runtime_wake($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        wake.organizationId,
        wake.projectId,
        wake.id,
        wake.runId,
        wake.dispatchKey,
        wake.requestHash,
        wake.kind,
        wake.payload,
        this.now(),
      ],
    );
  }
}

/** Matches @oao/queue-postgres wakeRequestHash from runtime migration 0004. */
export function runtimeWakeRequestHash(input: {
  readonly runId: string;
  readonly kind: RuntimeCommandKind;
  readonly payload: Readonly<Record<string, PublicValue>>;
}): Uint8Array {
  return createHash("sha256").update(canonical(input)).digest();
}

export function buildRuntimeWake(command: RuntimeCommand): RuntimeWakeInsert {
  assertPublicPayload(command.payload);
  const dispatchKey = `${command.kind}:${command.runId}`;
  return {
    ...command,
    id: deterministicUuid(`wake:${dispatchKey}`),
    dispatchKey,
    requestHash: runtimeWakeRequestHash(command),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
