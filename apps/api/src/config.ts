export type AuthProvider = "development" | "workos";

export interface WorkOsServerConfiguration {
  readonly apiKey: string;
  readonly clientId: string;
  readonly cookiePassword: string;
  readonly webhookSecret: string;
}

export interface ApiServerConfiguration {
  readonly authProvider: AuthProvider;
  readonly databaseUrl: string;
  readonly port: number;
  readonly appOrigins: readonly string[];
  readonly appOrigin: string;
  readonly callbackUri: string;
  readonly cookieSecure: boolean;
  readonly apiKeyPepper: string;
  readonly workos?: WorkOsServerConfiguration;
}

export function loadServerConfiguration(
  environment: NodeJS.ProcessEnv,
): ApiServerConfiguration {
  const authProvider = parseAuthProvider(environment.AUTH_PROVIDER);
  const databaseUrl = required(environment, "DATABASE_URL");
  const port = parsePort(environment.PORT);
  const nodeEnvironment = environment.NODE_ENV ?? "development";
  const appOrigins = parseAppOrigins(required(environment, "APP_ORIGIN"));
  const appOrigin = appOrigins[0];
  if (!appOrigin) throw new Error("APP_ORIGIN must contain an origin");
  const callbackUri =
    authProvider === "workos"
      ? validateCallbackUri(
          required(environment, "WORKOS_CALLBACK_URL"),
          appOrigins,
        )
      : `${appOrigin}/v1/auth/callback`;
  const callbackProtocol = new URL(callbackUri).protocol;
  const explicitLocalHttp =
    nodeEnvironment === "development" && callbackProtocol === "http:";
  if (callbackProtocol === "http:" && !explicitLocalHttp) {
    throw new Error(
      "HTTP cookies are allowed only with NODE_ENV=development; use HTTPS otherwise",
    );
  }

  const developmentPepper = "oao-development-api-key-pepper";
  const apiKeyPepper =
    environment.API_KEY_PEPPER ??
    (authProvider === "development" && nodeEnvironment === "development"
      ? developmentPepper
      : undefined);
  if (!apiKeyPepper)
    throw new Error("API_KEY_PEPPER is required outside local development");

  return {
    authProvider,
    databaseUrl,
    port,
    appOrigins,
    appOrigin,
    callbackUri,
    cookieSecure: !explicitLocalHttp,
    apiKeyPepper,
    ...(authProvider === "workos"
      ? {
          workos: {
            apiKey: required(environment, "WORKOS_API_KEY"),
            clientId: required(environment, "WORKOS_CLIENT_ID"),
            cookiePassword: minimumLength(
              required(environment, "WORKOS_COOKIE_PASSWORD"),
              "WORKOS_COOKIE_PASSWORD",
              32,
            ),
            webhookSecret: required(environment, "WORKOS_WEBHOOK_SECRET"),
          },
        }
      : {}),
  };
}

function parseAuthProvider(value: string | undefined): AuthProvider {
  const provider = value ?? "development";
  if (provider !== "development" && provider !== "workos")
    throw new Error("AUTH_PROVIDER must be development or workos");
  return provider;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("PORT must be a valid TCP port");
  return port;
}

function parseAppOrigins(value: string): readonly string[] {
  const origins = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      let url: URL;
      try {
        url = new URL(item);
      } catch {
        throw new Error("APP_ORIGIN entries must be absolute HTTP(S) origins");
      }
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error("APP_ORIGIN entries must be exact HTTP(S) origins");
      }
      return url.origin;
    });
  if (origins.length === 0)
    throw new Error("APP_ORIGIN must contain at least one origin");
  return [...new Set(origins)];
}

function validateCallbackUri(
  value: string,
  allowedOrigins: readonly string[],
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WORKOS_CALLBACK_URL must be an absolute URL");
  }
  if (
    !allowedOrigins.includes(url.origin) ||
    url.pathname !== "/v1/auth/callback" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "WORKOS_CALLBACK_URL must use an APP_ORIGIN and /v1/auth/callback",
    );
  }
  return url.toString();
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function minimumLength(value: string, name: string, length: number): string {
  if (value.length < length)
    throw new Error(`${name} must contain at least ${length} characters`);
  return value;
}
