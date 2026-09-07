import type { PgPool } from "@oao/db-postgres";

export interface IapIdentityProvisioningInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly expectedAudience: string;
  readonly iapSubject?: string;
  readonly email: string;
  readonly displayName?: string;
}

/** Links a verified IAP subject to an existing tenant principal and membership. */
export async function provisionIapIdentity(
  pool: PgPool,
  input: IapIdentityProvisioningInput,
): Promise<void> {
  if (
    !/^\/projects\/\d+\/locations\/[a-z0-9-]+\/services\/[a-z0-9-]+$/u.test(
      input.expectedAudience,
    )
  )
    throw new TypeError("expectedAudience must be a Cloud Run IAP audience");
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/u.test(email) || email.length > 320)
    throw new TypeError("email must be an email address");
  const iapSubject = input.iapSubject?.trim();
  if (iapSubject !== undefined && (!iapSubject || iapSubject.length > 500))
    throw new TypeError("iapSubject must be a non-empty IAP subject");
  const providerSubject = iapSubject ?? `pending-email:${email}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT oao.set_tenant_context($1,$2)", [
      input.organizationId,
      input.projectId,
    ]);
    const existing = await client.query(
      `SELECT 1
       FROM oao.projects project
       JOIN oao.principals principal
         ON principal.organization_id=project.organization_id
        AND principal.project_id=project.id AND principal.id=$3
       JOIN oao.project_members membership
         ON membership.organization_id=principal.organization_id
        AND membership.project_id=principal.project_id
        AND membership.principal_id=principal.id
       WHERE project.organization_id=$1 AND project.id=$2
       FOR SHARE`,
      [input.organizationId, input.projectId, input.principalId],
    );
    if (existing.rowCount !== 1)
      throw new Error("Existing tenant principal membership is required");

    await client.query(
      `INSERT INTO oao.auth_tenant_links
         (organization_id,project_id,provider,provider_tenant_id)
       VALUES ($1,$2,'iap',$3)
       ON CONFLICT (organization_id,project_id,provider) DO NOTHING`,
      [input.organizationId, input.projectId, input.expectedAudience],
    );
    const tenant = await client.query<{ provider_tenant_id: string }>(
      `SELECT provider_tenant_id FROM oao.auth_tenant_links
       WHERE organization_id=$1 AND project_id=$2 AND provider='iap'`,
      [input.organizationId, input.projectId],
    );
    if (tenant.rows[0]?.provider_tenant_id !== input.expectedAudience)
      throw new Error("IAP audience is already linked to a different tenant");

    const identity = await client.query(
      `INSERT INTO oao.auth_identities (
         organization_id,project_id,principal_id,provider,provider_subject,
         email,display_name,last_reconciled_at
       ) VALUES ($1,$2,$3,'iap',$4,$5,$6,clock_timestamp())
       ON CONFLICT (organization_id,project_id,provider,provider_subject)
       DO UPDATE SET email=COALESCE(EXCLUDED.email,oao.auth_identities.email),
         display_name=COALESCE(EXCLUDED.display_name,oao.auth_identities.display_name),
         last_reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE oao.auth_identities.principal_id=EXCLUDED.principal_id
       RETURNING principal_id`,
      [
        input.organizationId,
        input.projectId,
        input.principalId,
        providerSubject,
        email,
        input.displayName ?? email,
      ],
    );
    if (identity.rowCount !== 1)
      throw new Error("IAP identity is already linked to another principal");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
