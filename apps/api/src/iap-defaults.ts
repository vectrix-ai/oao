import type { PgPool } from "@oao/db-postgres";

/** Resolve persisted installation defaults; initialize only a fresh database. */
export async function ensureIapDefaultTenant(
  pool: PgPool,
  expectedAudience: string,
): Promise<{ organizationId: string; projectId: string }> {
  const result = await pool.query<{
    organization_id: string;
    project_id: string;
  }>("SELECT * FROM oao.ensure_iap_default_tenant($1)", [expectedAudience]);
  const tenant = result.rows[0];
  if (result.rows.length !== 1 || !tenant)
    throw new Error("IAP default tenant initialization failed");
  return {
    organizationId: tenant.organization_id,
    projectId: tenant.project_id,
  };
}
