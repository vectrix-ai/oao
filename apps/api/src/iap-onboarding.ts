import { randomUUID } from "node:crypto";
import type { IapIdentity } from "@oao/auth-iap";
import type { PgPool } from "@oao/db-postgres";
import type { AuthorizationScope } from "@oao/domain";

// Explicit developer permissions: no wildcard, tenant administration, or
// organization-wide provider/credential configuration. Do not expand implicitly
// when a new authorization action is introduced.
export const IAP_MEMBER_SCOPES: readonly AuthorizationScope[] = [
  "agent:read",
  "agent:write",
  "skill:read",
  "skill:write",
  "skill:bind",
  "skill:revoke",
  "mcp:read",
  "mcp:execute",
  "credential:read_metadata",
  "session:read",
  "session:write",
  "run:create",
  "run:read",
  "run:cancel",
  "tool_call:claim",
  "tool_call:submit",
  "approval:resolve",
  "delegation:read",
  "delegation:message",
  "delegation:cancel",
];

export function isHumanIapIdentity(identity: IapIdentity): boolean {
  const email = identity.email.trim().toLowerCase();
  return (
    /^accounts\.google\.com:\d{1,100}$/u.test(identity.subject) &&
    /^[^@\s]+@[^@\s]+$/u.test(email) &&
    email.length <= 320 &&
    !email.endsWith("gserviceaccount.com")
  );
}

/** Called only after cryptographic IAP verification, never with unsigned headers. */
export async function onboardIapHuman(
  pool: PgPool,
  input: {
    readonly identity: IapIdentity;
    readonly expectedAudience: string;
    readonly organizationId: string;
    readonly projectId: string;
  },
): Promise<void> {
  const { identity, organizationId, projectId, expectedAudience } = input;
  const email = identity.email.trim().toLowerCase();
  if (!isHumanIapIdentity(identity)) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE oao_app");
    await client.query("SELECT oao.set_tenant_context($1,$2)", [
      organizationId,
      projectId,
    ]);
    // Serialize both subject and email: duplicate first requests and competing
    // subjects claiming the same email must not create duplicate memberships.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `iap-onboarding/${organizationId}/${projectId}/${identity.subject}`,
    ]);
    // Same email lock as resolve_iap_principal's pending-identity claim.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${organizationId}/${projectId}/${email}`,
    ]);
    const tenant = await client.query(
      `SELECT 1 FROM oao.auth_tenant_links
       WHERE organization_id=$1 AND project_id=$2
         AND provider='iap' AND provider_tenant_id=$3
         FOR SHARE`,
      [organizationId, projectId, expectedAudience],
    );
    if (tenant.rowCount !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    const existing = await client.query(
      `SELECT 1 FROM oao.auth_identities
       WHERE organization_id=$1 AND project_id=$2 AND provider='iap'
         AND (provider_subject=$3 OR lower(email)=$4)
       UNION ALL
       SELECT 1 FROM oao.principals
       WHERE organization_id=$1 AND project_id=$2 AND kind='human' AND subject=$5`,
      [
        organizationId,
        projectId,
        identity.subject,
        email,
        `iap:${identity.subject}`,
      ],
    );
    // Never relink an email, overwrite an owner, or restore removed membership.
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return;
    }
    const claim = await client.query<{ initial_owner: boolean }>(
      "SELECT oao.claim_iap_initial_owner($1,$2,$3) AS initial_owner",
      [organizationId, projectId, expectedAudience],
    );
    const initialOwner = claim.rows[0]?.initial_owner;
    if (typeof initialOwner !== "boolean")
      throw new Error("IAP ownership claim failed");
    const role = initialOwner ? "owner" : "member";
    const principalId = randomUUID();
    await client.query(
      `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
       VALUES ($1,$2,$3,'human',$4,$5)`,
      [
        organizationId,
        projectId,
        principalId,
        `iap:${identity.subject}`,
        initialOwner ? ["*"] : IAP_MEMBER_SCOPES,
      ],
    );
    await client.query(
      `INSERT INTO oao.organization_members (organization_id,principal_id,role)
       VALUES ($1,$2,$3)`,
      [organizationId, principalId, role],
    );
    await client.query(
      `INSERT INTO oao.project_members (organization_id,project_id,principal_id,role)
       VALUES ($1,$2,$3,$4)`,
      [organizationId, projectId, principalId, role],
    );
    await client.query(
      `INSERT INTO oao.auth_identities
       (organization_id,project_id,principal_id,provider,provider_subject,email,display_name,last_reconciled_at)
       VALUES ($1,$2,$3,'iap',$4,$5,$5,clock_timestamp())`,
      [organizationId, projectId, principalId, identity.subject, email],
    );
    await client.query(
      `SELECT oao.append_audit_entry($1,$2,$3,$4::uuid,$6,'member',$4::uuid::text,$5::jsonb,clock_timestamp())`,
      [
        organizationId,
        projectId,
        randomUUID(),
        principalId,
        JSON.stringify({
          provider: "iap",
          organizationRole: role,
          projectRole: role,
        }),
        initialOwner
          ? "installation.initial_owner_created"
          : "member.auto_provisioned",
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
