import type {
  EventId,
  OrganizationId,
  ProjectId,
  PublicValue,
} from "@oao/domain";

export type ProjectPosition = bigint;
export type AggregateSequence = bigint;
export type EventCursor = string & { readonly __brand: "EventCursor" };

export interface ProductEventInput {
  readonly id: EventId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly kind: string;
  readonly publicPayload: Readonly<Record<string, PublicValue>>;
  readonly occurredAt: Date;
}

export interface AppendedProductEvent extends ProductEventInput {
  readonly aggregateSequence: AggregateSequence;
  readonly projectPosition: ProjectPosition;
}

export interface AtomicEventAppender<TTransaction> {
  append(
    transaction: TTransaction,
    input: ProductEventInput,
  ): Promise<AppendedProductEvent>;
}

export interface EventPage {
  readonly events: readonly AppendedProductEvent[];
  readonly nextCursor?: EventCursor;
}

export interface ResumableEventStore {
  listAfter(input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly after: ProjectPosition;
    readonly limit: number;
  }): Promise<EventPage>;
}

export function encodeEventCursor(position: ProjectPosition): EventCursor {
  if (position < 0n)
    throw new RangeError("Event position must not be negative");
  return Buffer.from(`v1:${position.toString(10)}`, "utf8").toString(
    "base64url",
  ) as EventCursor;
}

export function decodeEventCursor(cursor: string): ProjectPosition {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new TypeError("Invalid event cursor");
  }
  const match = /^v1:(0|[1-9]\d*)$/u.exec(decoded);
  if (!match?.[1]) throw new TypeError("Invalid event cursor");
  return BigInt(match[1]);
}

export interface WakeSubscriptionScope {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
}

// Notifications never contain canonical event data. Consumers always resume from the store.
// A wake is only a latency hint: implementations may drop, merge, or over-deliver wakes, so
// every subscriber must also poll the store on its own schedule.
export interface WakeOnlyNotifier {
  notifyProject(
    organizationId: OrganizationId,
    projectId: ProjectId,
  ): Promise<void>;
  /**
   * Registers a wake callback. With a scope, only wakes for that project (or wakes whose
   * project is unknown) are delivered. Resolves without waiting for the listener to be
   * ready and never rejects because the notification channel is unavailable.
   */
  subscribe(
    onWake: () => void,
    scope?: WakeSubscriptionScope,
  ): Promise<() => Promise<void>>;
}
