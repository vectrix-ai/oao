import { serve } from "@hono/node-server";
import { InMemoryArtifactAdapter } from "@oao/artifact-s3";
import { createPool, migrate, PostgresWakeNotifier } from "@oao/db-postgres";
import { createApiApp } from "./app.js";
import { composeAuthentication } from "./composition.js";
import { loadServerConfiguration } from "./config.js";
import { PostgresApiStore } from "./store.js";
import { PostgresRuntimeCommandPort } from "./runtime-commands.js";

const configuration = loadServerConfiguration(process.env);

const pool = createPool(configuration.databaseUrl);
await migrate(pool);

const { auth, webhookAuth } = await composeAuthentication(configuration, pool);

const app = createApiApp({
  store: new PostgresApiStore(pool, configuration.apiKeyPepper),
  auth,
  ...(webhookAuth === undefined ? {} : { webhookAuth }),
  artifacts: new InMemoryArtifactAdapter(),
  notifier: new PostgresWakeNotifier(pool),
  runtimeCommands: new PostgresRuntimeCommandPort(),
  authConfiguration: {
    provider: configuration.authProvider,
    appOrigins: configuration.appOrigins,
    appOrigin: configuration.appOrigin,
    callbackUri: configuration.callbackUri,
    cookieSecure: configuration.cookieSecure,
  },
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

const server = serve({ fetch: app.fetch, port: configuration.port });
process.stdout.write(
  `OAO API listening on http://127.0.0.1:${configuration.port}\n`,
);

const close = (): void => {
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
