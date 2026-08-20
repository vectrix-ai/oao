import { DEVELOPMENT_PRINCIPAL } from "@oao/auth-core";
import type { PgPool } from "@oao/db-postgres";

export async function seedDevelopment(pool: PgPool): Promise<void> {
  await pool.query(
    `SELECT oao.bootstrap_project(
      $1,'development','Development organization',
      $2,'default','Default project',
      $3,$4,'development'
    )`,
    [
      DEVELOPMENT_PRINCIPAL.organizationId,
      DEVELOPMENT_PRINCIPAL.projectId,
      DEVELOPMENT_PRINCIPAL.id,
      DEVELOPMENT_PRINCIPAL.subject,
    ],
  );
}
