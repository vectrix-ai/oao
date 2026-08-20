import { createPool } from "@oao/db-postgres";
import { provisionWorkOsIdentity } from "./workos-provisioning.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const pool = createPool(required("DATABASE_URL"));
try {
  await provisionWorkOsIdentity(pool, {
    organizationId: required("OAO_ORGANIZATION_ID"),
    projectId: required("OAO_PROJECT_ID"),
    principalId: required("OAO_PRINCIPAL_ID"),
    workosUserId: required("WORKOS_USER_ID"),
    workosOrganizationId: required("WORKOS_ORGANIZATION_ID"),
    ...(process.env.WORKOS_USER_EMAIL
      ? { email: process.env.WORKOS_USER_EMAIL }
      : {}),
    ...(process.env.WORKOS_USER_DISPLAY_NAME
      ? { displayName: process.env.WORKOS_USER_DISPLAY_NAME }
      : {}),
  });
  process.stdout.write("WorkOS identity link is provisioned.\n");
} catch (error) {
  process.stderr.write(
    `WorkOS identity provisioning failed (${error instanceof Error ? error.name : "UnknownError"}).\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
