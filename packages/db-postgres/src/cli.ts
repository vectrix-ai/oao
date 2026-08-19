import { createPool, migrate } from "./index.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = createPool(connectionString);
try {
  const result = await migrate(pool);
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
