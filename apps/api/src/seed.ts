import { createPool, migrate } from "@oao/db-postgres";
import { seedDevelopment } from "./bootstrap.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = createPool(databaseUrl);
try {
  await migrate(pool);
  await seedDevelopment(pool);
  process.stdout.write(
    "Development organization, project, and principal are ready.\n",
  );
} finally {
  await pool.end();
}
