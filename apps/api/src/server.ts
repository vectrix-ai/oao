import { serve } from "@hono/node-server";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import { InMemoryArtifactAdapter } from "@oao/artifact-s3";
import { createPool, migrate, PostgresWakeNotifier } from "@oao/db-postgres";
import { createApiApp } from "./app.js";
import { seedDevelopment } from "./bootstrap.js";
import { PostgresApiStore } from "./store.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error("PORT must be a valid TCP port");

const pool = createPool(databaseUrl);
await migrate(pool);
await seedDevelopment(pool);

const app = createApiApp({
  store: new PostgresApiStore(
    pool,
    process.env.API_KEY_PEPPER ?? "oao-development-api-key-pepper",
  ),
  auth: new DevelopmentAuthAdapter(),
  artifacts: new InMemoryArtifactAdapter(),
  notifier: new PostgresWakeNotifier(pool),
  onError: ({ requestId, error }) => {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        requestId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      })}\n`,
    );
  },
});

const server = serve({ fetch: app.fetch, port });
process.stdout.write(`OAO API listening on http://127.0.0.1:${port}\n`);

const close = (): void => {
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
