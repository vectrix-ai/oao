import { DevelopmentAuthAdapter, type AuthTenantAdapter } from "@oao/auth-core";
import { GoogleIapAssertionVerifier, IapAuthAdapter } from "@oao/auth-iap";
import {
  WorkOsAuthKitAdapter,
  WorkOsNodeAuthTransport,
  WorkOsNodeWebhookVerifier,
} from "@oao/auth-workos";
import type { PgPool } from "@oao/db-postgres";
import type { WebhookAuthenticationAdapter } from "./app.js";
import { seedDevelopment } from "./bootstrap.js";
import type { ApiServerConfiguration } from "./config.js";
import { PostgresIapTenantResolver } from "./iap-postgres.js";
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

  if (configuration.authProvider === "iap") {
    const iap = configuration.iap;
    if (!iap) throw new Error("IAP configuration is required");
    return {
      auth: new IapAuthAdapter({
        verifier: new GoogleIapAssertionVerifier({
          expectedAudience: iap.expectedAudience,
        }),
        tenants: new PostgresIapTenantResolver({
          pool,
          expectedAudience: iap.expectedAudience,
          organizationId: iap.organizationId,
          projectId: iap.projectId,
        }),
      }),
    };
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
