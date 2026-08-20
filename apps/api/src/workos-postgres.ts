import { createHash } from "node:crypto";
import type {
  WorkOsIdentity,
  WorkOsTenantResolver,
  WorkOsWebhookEvent,
  WorkOsWebhookLedger,
} from "@oao/auth-workos";
import type { AuthorizationScope, Principal, PrincipalId } from "@oao/domain";
import { brandedId } from "@oao/domain";
import type { PgPool } from "@oao/db-postgres";

interface PrincipalRow {
  organization_id: string;
  project_id: string;
  principal_id: string;
  subject: string;
  scopes: string[];
}

/** Resolves a verified WorkOS identity through PostgreSQL-authoritative mappings. */
export class PostgresWorkOsTenantResolver implements WorkOsTenantResolver {
  constructor(private readonly pool: PgPool) {}

  async resolvePrincipal(
    identity: WorkOsIdentity,
    request?: Request,
  ): Promise<Principal | undefined> {
    const requestedProjectId = request
      ? /^\/v1\/projects\/([0-9a-f-]{36})(?:\/|$)/iu.exec(
          new URL(request.url).pathname,
        )?.[1]
      : undefined;
    const result = await this.pool.query<PrincipalRow>(
      "SELECT * FROM oao.resolve_workos_principal($1,$2,$3)",
      [
        identity.subject,
        identity.externalOrganizationId ?? null,
        requestedProjectId ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: brandedId<PrincipalId>(row.principal_id),
      organizationId: row.organization_id as Principal["organizationId"],
      projectId: row.project_id as Principal["projectId"],
      kind: "human",
      subject: row.subject,
      scopes: new Set(row.scopes as AuthorizationScope[]),
    };
  }
}

/** Durable webhook deduplication; the keyed row stores only a SHA-256 body hash. */
export class PostgresWorkOsWebhookLedger implements WorkOsWebhookLedger {
  constructor(private readonly pool: PgPool) {}

  async claim(
    event: WorkOsWebhookEvent,
    rawBody: Uint8Array,
  ): Promise<"claimed" | "duplicate"> {
    const result = await this.pool.query<{ outcome: string }>(
      "SELECT oao.claim_workos_webhook_event($1,$2,$3) AS outcome",
      [event.id, event.type, payloadHash(rawBody)],
    );
    return result.rows[0]?.outcome === "claimed" ? "claimed" : "duplicate";
  }

  async complete(
    eventId: string,
    _event: WorkOsWebhookEvent,
    rawBody: Uint8Array,
  ): Promise<void> {
    await this.pool.query(
      "SELECT oao.complete_workos_webhook_event($1,$2,NULL)",
      [eventId, payloadHash(rawBody)],
    );
  }

  async release(
    eventId: string,
    _event: WorkOsWebhookEvent,
    rawBody: Uint8Array,
  ): Promise<void> {
    await this.pool.query("SELECT oao.release_workos_webhook_event($1,$2,$3)", [
      eventId,
      payloadHash(rawBody),
      { errorType: "reconciliation_failed" },
    ]);
  }
}

function payloadHash(rawBody: Uint8Array): Uint8Array {
  return createHash("sha256").update(rawBody).digest();
}
