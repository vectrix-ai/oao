import { serve } from "@hono/node-server";
import {
  InMemoryArtifactAdapter,
  ProjectArtifactStoreResolver,
} from "@oao/artifact-s3";
import { createPool, migrate, PostgresWakeNotifier } from "@oao/db-postgres";
import {
  isApprovedCatalogModel,
  listApprovedModelCatalog,
  listOpenRouterModelCatalog,
} from "@oao/models-openrouter";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import { listDaytonaSnapshots } from "@oao/sandbox-daytona";
import { createApiApp } from "./app.js";
import { composeAuthentication } from "./composition.js";
import { loadServerConfiguration } from "./config.js";
import { HttpApiError } from "./errors.js";
import { PostgresApiStore } from "./store.js";
import { PostgresRuntimeCommandPort } from "./runtime-commands.js";

const configuration = loadServerConfiguration(process.env);
const pool = createPool(configuration.databaseUrl);
await migrate(pool);

const { auth, webhookAuth } = await composeAuthentication(configuration, pool);
const credentialCipher = process.env.OAO_CREDENTIAL_ENCRYPTION_KEY
  ? ProviderCredentialCipher.fromBase64(
      process.env.OAO_CREDENTIAL_ENCRYPTION_KEY,
    )
  : undefined;

const app = createApiApp({
  store: new PostgresApiStore(pool, configuration.apiKeyPepper),
  auth,
  ...(webhookAuth === undefined ? {} : { webhookAuth }),
  artifacts: new InMemoryArtifactAdapter(),
  ...(credentialCipher
    ? {
        runFileStorage: new ProjectArtifactStoreResolver(
          pool,
          credentialCipher,
        ),
      }
    : {}),
  notifier: new PostgresWakeNotifier(pool),
  runtimeCommands: new PostgresRuntimeCommandPort(),
  activeModelPresetKeys: new Set(),
  ...(credentialCipher ? { credentialCipher } : {}),
  modelCatalog: {
    deploymentPresets: [],
    listCatalog: (input) => {
      const apiKey = input?.apiKey;
      return input?.providerType === "openrouter" && apiKey
        ? listOpenRouterModelCatalog({
            apiKey,
            ...(input.search ? { search: input.search } : {}),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          })
        : listApprovedModelCatalog(input?.providerType);
    },
    isApprovedModel: async (model, providerType, input) => {
      const apiKey = input?.apiKey;
      if (providerType === "openrouter" && apiKey) {
        const catalog = await listOpenRouterModelCatalog({
          apiKey,
          search: model,
        });
        return catalog.some((entry) => entry.model === model);
      }
      return isApprovedCatalogModel(model, providerType);
    },
  },
  sandboxSnapshotCatalog: {
    listSnapshots: listDaytonaSnapshots,
  },
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
        ...(error instanceof HttpApiError
          ? { errorCode: error.code, errorMessage: error.message }
          : {}),
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
