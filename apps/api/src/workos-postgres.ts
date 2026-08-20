import { createHash } from "node:crypto";
import type {
  WorkOsIdentity,
  WorkOsTenantResolver,
  WorkOsWebhookEvent,
  WorkOsWebhookLedger,
  WorkOsReconciler,
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

/**
 * Refreshes metadata only for identities that were explicitly provisioned in
 * PostgreSQL. It deliberately never bootstraps a tenant or first user.
 */
export class PostgresWorkOsReconciler implements WorkOsReconciler {
  constructor(private readonly pool: PgPool) {}

  async reconcile(event: WorkOsWebhookEvent): Promise<void> {
    const identity = workosIdentityMetadata(event);
    if (!identity) return;
    const resolved = await this.pool.query<PrincipalRow>(
      "SELECT * FROM oao.resolve_workos_principal($1,$2,NULL)",
      [identity.subject, identity.externalOrganizationId ?? null],
    );
    const principal = resolved.rows[0];
    if (!principal) return;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT oao.set_tenant_context($1,$2)", [
        principal.organization_id,
        principal.project_id,
      ]);
      await client.query(
        `UPDATE oao.auth_identities
         SET email=COALESCE($5,email), display_name=COALESCE($6,display_name),
             provider_updated_at=COALESCE($7,provider_updated_at),
             last_reconciled_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND principal_id=$3
           AND provider='workos' AND provider_subject=$4`,
        [
          principal.organization_id,
          principal.project_id,
          principal.principal_id,
          identity.subject,
          identity.email ?? null,
          identity.displayName ?? null,
          identity.updatedAt ?? null,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileAll(): Promise<void> {
    // A scheduled directory sync can call provider APIs and feed individual
    // events through reconcile(). The API process does not scan credentials.
  }
}

interface WorkOsIdentityMetadata {
  readonly subject: string;
  readonly externalOrganizationId?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly updatedAt?: string;
}

function workosIdentityMetadata(
  event: WorkOsWebhookEvent,
): WorkOsIdentityMetadata | undefined {
  if (
    !event.data ||
    typeof event.data !== "object" ||
    Array.isArray(event.data)
  )
    return undefined;
  const data = event.data as Record<string, unknown>;
  const nestedUser =
    data.user && typeof data.user === "object" && !Array.isArray(data.user)
      ? (data.user as Record<string, unknown>)
      : undefined;
  const subject =
    stringValue(data.userId) ??
    stringValue(data.id) ??
    stringValue(nestedUser?.id);
  if (!subject) return undefined;
  const externalOrganizationId = stringValue(data.organizationId);
  const email = stringValue(data.email) ?? stringValue(nestedUser?.email);
  const displayName = stringValue(data.name) ?? stringValue(nestedUser?.name);
  const updatedAt =
    stringValue(data.updatedAt) ?? stringValue(nestedUser?.updatedAt);
  return {
    subject,
    ...(externalOrganizationId === undefined ? {} : { externalOrganizationId }),
    ...(email === undefined ? {} : { email }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function payloadHash(rawBody: Uint8Array): Uint8Array {
  return createHash("sha256").update(rawBody).digest();
}
