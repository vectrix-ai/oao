import { DevelopmentAuthAdapter, type AuthTenantAdapter } from "@oao/auth-core";
import {
  WorkOsAuthKitAdapter,
  WorkOsNodeAuthTransport,
  WorkOsNodeWebhookVerifier,
} from "@oao/auth-workos";
import type { PgPool } from "@oao/db-postgres";
import type { WebhookAuthenticationAdapter } from "./app.js";
import { seedDevelopment } from "./bootstrap.js";
import type { ApiServerConfiguration } from "./config.js";
import {
  PostgresWorkOsReconciler,
  PostgresWorkOsTenantResolver,
  PostgresWorkOsWebhookLedger,
} from "./workos-postgres.js";

export interface AuthenticationComposition {
  readonly auth: AuthTenantAdapter;
  readonly webhookAuth?: WebhookAuthenticationAdapter;
}

export async function composeAuthentication(
  configuration: ApiServerConfiguration,
  pool: PgPool,
): Promise<AuthenticationComposition> {
  if (configuration.authProvider === "development") {
    await seedDevelopment(pool);
    return { auth: new DevelopmentAuthAdapter() };
  }

  const workos = configuration.workos;
  if (!workos) throw new Error("WorkOS configuration is required");
  const adapter = new WorkOsAuthKitAdapter({
    transport: new WorkOsNodeAuthTransport({
      apiKey: workos.apiKey,
      clientId: workos.clientId,
      cookiePassword: workos.cookiePassword,
    }),
    tenants: new PostgresWorkOsTenantResolver(pool),
    webhookVerifier: new WorkOsNodeWebhookVerifier({
      secret: workos.webhookSecret,
      clientId: workos.clientId,
    }),
    webhookLedger: new PostgresWorkOsWebhookLedger(pool),
    reconciler: new PostgresWorkOsReconciler(pool),
  });
  return { auth: adapter, webhookAuth: adapter };
}
