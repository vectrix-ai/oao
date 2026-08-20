import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthSession, AuthTenantAdapter } from "@oao/auth-core";
import { readCookie } from "@oao/auth-core";
import {
  parseCreateProjectSandboxProviderInput,
  parseCreateProjectStorageProviderInput,
  parseCreateProjectModelProviderInput,
  parseCreateModelPresetInput,
  parseManagedAgentSnapshotForPublication,
  parseRotateProjectModelProviderCredentialInput,
  parseRotateProjectSandboxProviderCredentialInput,
  parseRotateProjectStorageProviderCredentialInput,
  parseUpdateProjectSandboxProviderConfigurationInput,
  type CreateProjectSandboxProviderInput,
  type CreateProjectStorageProviderInput,
  type CreateModelPresetInput,
  type CreateProjectModelProviderInput,
  type ManagedAgentPublicationConfig,
  type ModelCatalogEntry,
  type ModelProviderType,
  type SandboxSnapshotEntry,
  type UpdateProjectSandboxProviderConfigurationInput,
} from "@oao/contracts";
import type { ArtifactPort, Principal, PublicValue } from "@oao/domain";
import { assertPublicPayload, AUTHORIZATION_ACTIONS } from "@oao/domain";
import { decodeEventCursor, encodeEventCursor } from "@oao/events";
import type { WakeOnlyNotifier } from "@oao/events";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { PgClient } from "@oao/db-postgres";
import type { ProviderCredentialCipher } from "@oao/provider-credentials";
import type { PostgresApiStore } from "./store.js";
import type { RuntimeCommandPort } from "./runtime-commands.js";
import { errorEnvelope, HttpApiError } from "./errors.js";
import {
  decodeListCursor,
  encodeListCursor,
  idempotencyKey,
  optionalString,
  parseLimit,
  publicValue,
  readJsonObject,
  requestHash,
  requiredString,
} from "./http.js";

export type RequestAuthenticator = AuthTenantAdapter;

export interface WebhookAuthenticationAdapter extends AuthTenantAdapter {
  handleWebhook(input: {
    readonly rawBody: Uint8Array;
    readonly signature: string;
  }): Promise<{ readonly status: string; readonly eventId: string }>;
}

/**
 * Adapter seam for the pinned provider catalogs. Provider credentials are
 * handled separately and are never returned through this port.
 */
export interface ModelCatalogPort {
  readonly deploymentPresets: readonly {
    readonly key: string;
    readonly model: string;
  }[];
  listCatalog(input?: {
    readonly providerType?: ModelProviderType;
    readonly apiKey?: string;
    readonly search?: string;
    readonly limit?: number;
  }): Promise<readonly ModelCatalogEntry[]> | readonly ModelCatalogEntry[];
  isApprovedModel(
    model: string,
    providerType?: ModelProviderType,
    input?: { readonly apiKey?: string },
  ): Promise<boolean> | boolean;
}

/** Provider adapter for credential-scoped sandbox snapshot discovery. */
export interface SandboxSnapshotCatalogPort {
  listSnapshots(input: {
    readonly apiKey: string;
    readonly target?: string;
  }): Promise<readonly SandboxSnapshotEntry[]>;
}

const EMPTY_MODEL_CATALOG: ModelCatalogPort = Object.freeze({
  deploymentPresets: Object.freeze([]),
  listCatalog: () => [],
  isApprovedModel: () => false,
});

export interface ApiDependencies {
  readonly store: PostgresApiStore;
  readonly auth: RequestAuthenticator;
  readonly webhookAuth?: WebhookAuthenticationAdapter;
  readonly artifacts?: ArtifactPort;
  readonly notifier?: WakeOnlyNotifier;
  readonly runtimeCommands: RuntimeCommandPort;
  readonly credentialCipher?: ProviderCredentialCipher;
  readonly activeModelPresetKeys?: ReadonlySet<string>;
  readonly modelCatalog?: ModelCatalogPort;
  readonly sandboxSnapshotCatalog?: SandboxSnapshotCatalogPort;
  readonly authConfiguration?: ApiAuthConfiguration;
  readonly onError?: (input: {
    readonly requestId: string;
    readonly error: unknown;
  }) => void;
}

export interface ApiAuthConfiguration {
  readonly provider: "development" | "workos";
  readonly appOrigins: readonly string[];
  readonly appOrigin: string;
  readonly callbackUri: string;
  readonly cookieSecure: boolean;
}

type Variables = { principal: Principal; requestId: string };
type ApiContext = Context<{ Variables: Variables }>;
const ALLOWED_SCOPES = new Set<string>(["*", ...AUTHORIZATION_ACTIONS]);
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_AUTH_CONFIGURATION: ApiAuthConfiguration = Object.freeze({
  provider: "development",
  appOrigins: ["http://localhost"],
  appOrigin: "http://localhost",
  callbackUri: "http://localhost/v1/auth/callback",
  cookieSecure: false,
});

function principal(c: ApiContext): Principal {
  return c.get("principal");
}

function assertProject(c: ApiContext): Principal {
  const value = principal(c);
  if (value.projectId !== c.req.param("projectId"))
    throw new HttpApiError(
      "forbidden",
      "Project is outside the principal scope",
    );
  return value;
}

function rows(result: { readonly rows: readonly unknown[] }): unknown[] {
  return result.rows.map(publicValue);
}

function pagination<T>(items: T[], limit: number, dateKey: string) {
  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, limit) : items;
  const last = data.at(-1) as Record<string, unknown> | undefined;
  const timestamp = last?.[dateKey];
  const id = last?.id;
  return {
    data,
    pageInfo: {
      hasMore,
      nextCursor:
        hasMore && typeof timestamp === "string" && typeof id === "string"
          ? encodeListCursor({ timestamp, id })
          : null,
    },
  };
}

function parseScopes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some(
      (scope) =>
        typeof scope !== "string" ||
        scope.length > 80 ||
        !ALLOWED_SCOPES.has(scope),
    )
  )
    throw new HttpApiError(
      "bad_request",
      "scopes must contain known authorization scopes",
    );
  return [...new Set(value as string[])];
}

function parseRole(value: unknown): "owner" | "admin" | "member" | "viewer" {
  if (
    value !== "owner" &&
    value !== "admin" &&
    value !== "member" &&
    value !== "viewer"
  )
    throw new HttpApiError(
      "bad_request",
      "role must be owner, admin, member, or viewer",
    );
  return value;
}

function parseFence(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value))
    throw new HttpApiError(
      "bad_request",
      "fence must be a positive integer string",
    );
  return BigInt(value);
}

function parseAgentConfig(value: unknown): ManagedAgentPublicationConfig {
  let config: ManagedAgentPublicationConfig;
  try {
    config = parseManagedAgentSnapshotForPublication(value);
  } catch {
    throw new HttpApiError(
      "bad_request",
      "config must match the managed-agent publication contract",
    );
  }
  assertPublicPayload(config as Readonly<Record<string, PublicValue>>);
  return config;
}

/** Publication may only name a durable preset scoped to the caller's project. */
async function assertModelPresetApproved(
  transaction: PgClient,
  actor: Principal,
  presetKey: string,
  activeModelPresetKeys: ReadonlySet<string>,
  projectModelsEnabled: boolean,
): Promise<void> {
  if (activeModelPresetKeys.has(presetKey)) return;
  const result = await transaction.query(
    `SELECT 1 FROM oao.project_model_presets p
     JOIN oao.project_model_providers c
       ON c.organization_id=p.organization_id
      AND c.project_id=p.project_id
      AND c.id=p.provider_id
     WHERE p.organization_id=$1 AND p.project_id=$2 AND p.preset_key=$3`,
    [actor.organizationId, actor.projectId, presetKey],
  );
  if (!result.rowCount)
    throw new HttpApiError(
      "bad_request",
      "config.modelPreset is not an approved model preset for this project",
    );
  if (!projectModelsEnabled)
    throw new HttpApiError(
      "bad_request",
      "config.modelPreset is not available until credential encryption is configured",
    );
}

async function listProjectModelPresetKeys(
  transaction: PgClient,
  actor: Principal,
): Promise<string[]> {
  const result = await transaction.query<{ preset_key: string }>(
    `SELECT p.preset_key FROM oao.project_model_presets p
     JOIN oao.project_model_providers c
       ON c.organization_id=p.organization_id
      AND c.project_id=p.project_id
      AND c.id=p.provider_id
     WHERE p.organization_id=$1 AND p.project_id=$2 ORDER BY p.preset_key`,
    [actor.organizationId, actor.projectId],
  );
  return result.rows.map((row) => row.preset_key);
}

async function assertSandboxProviderApproved(
  transaction: PgClient,
  actor: Principal,
  config: ManagedAgentPublicationConfig["sandbox"],
  projectProvidersEnabled: boolean,
): Promise<void> {
  if (!config.enabled) return;
  if (!projectProvidersEnabled)
    throw new HttpApiError(
      "bad_request",
      "config.sandbox.provider is not available until credential encryption is configured",
    );
  const result = await transaction.query<{
    restricted_egress: {
      allowedDomains?: readonly string[];
      allowedCidrs?: readonly string[];
    };
  }>(
    `SELECT restricted_egress FROM oao.project_sandbox_providers
     WHERE organization_id=$1 AND project_id=$2 AND provider_key=$3`,
    [actor.organizationId, actor.projectId, config.provider],
  );
  const provider = result.rows[0];
  if (!provider)
    throw new HttpApiError(
      "bad_request",
      "config.sandbox.provider is not configured for this project",
    );
  if (
    config.network === "restricted" &&
    !provider.restricted_egress.allowedDomains?.length &&
    !provider.restricted_egress.allowedCidrs?.length
  )
    throw new HttpApiError(
      "bad_request",
      "Restricted sandbox networking requires a provider allowlist",
    );
}

function defaultAgentKey(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 100);
  return `${base || "agent"}-${randomUUID().slice(0, 8)}`;
}

export function createApiApp(dependencies: ApiDependencies): Hono<{
  Variables: Variables;
}> {
  const app = new Hono<{ Variables: Variables }>();
  const authConfiguration =
    dependencies.authConfiguration ?? DEFAULT_AUTH_CONFIGURATION;
  const activeModelPresetKeys =
    dependencies.activeModelPresetKeys ?? new Set<string>();

  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId =
      incoming && incoming.length <= 200 ? incoming : randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "no-store");
    await next();
  });

  app.use("*", async (c, next) => {
    const request = c.req.raw;
    const pathname = new URL(request.url).pathname;
    const apiKeyBearer = /^Bearer\s+oao_/iu.test(
      request.headers.get("authorization") ?? "",
    );
    const apiKeyProtectedRoute =
      pathname === "/v1/projects" ||
      pathname.startsWith("/v1/projects/") ||
      pathname.startsWith("/v1/organizations");
    const cookieAuthenticated =
      readCookie(request, "oao_session") !== undefined ||
      readCookie(request, "oao_refresh") !== undefined;
    if (
      UNSAFE_METHODS.has(request.method) &&
      cookieAuthenticated &&
      !(apiKeyBearer && apiKeyProtectedRoute) &&
      pathname !== "/v1/auth/workos/webhook"
    ) {
      const origin = request.headers.get("origin");
      if (!origin || !authConfiguration.appOrigins.includes(origin)) {
        throw new HttpApiError("forbidden", "Request origin is not allowed");
      }
    }
    await next();
  });

  const authenticate: MiddlewareHandler<{ Variables: Variables }> = async (
    c,
    next,
  ) => {
    const authorization = c.req.header("authorization");
    let authenticated: Principal | undefined;
    if (authorization?.startsWith("Bearer oao_"))
      authenticated = await dependencies.store.authenticateApiKey(
        authorization.slice("Bearer ".length),
      );
    else authenticated = await dependencies.auth.authenticate(c.req.raw);
    if (!authenticated)
      throw new HttpApiError("unauthenticated", "Authentication is required");
    c.set("principal", authenticated);
    await next();
  };

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    const ready = await dependencies.store.ready();
    return c.json({ status: ready ? "ready" : "not_ready" }, ready ? 200 : 503);
  });

  app.post("/v1/auth/login", async (c) => {
    const body = await readJsonObject(c.req.raw);
    if (
      body.redirectUri !== undefined ||
      body.returnTo !== undefined ||
      body.state !== undefined
    ) {
      throw new HttpApiError(
        "bad_request",
        "Authentication redirect parameters are server configured",
      );
    }
    const state = randomUUID();
    const result = await dependencies.auth.login({
      redirectUri: authConfiguration.callbackUri,
      state,
      ...(body.organizationHint === undefined
        ? {}
        : {
            organizationHint: requiredString(
              body.organizationHint,
              "organizationHint",
              500,
            ),
          }),
    });
    appendCookie(
      c,
      "oao_auth_state",
      state,
      "/v1/auth/callback",
      "Lax",
      600,
      authConfiguration.cookieSecure,
    );
    return c.json(result);
  });

  app.get("/v1/auth/callback", async (c) => {
    const expectedState = readCookie(c.req.raw, "oao_auth_state");
    const returnedState = c.req.query("state");
    clearCookie(
      c,
      "oao_auth_state",
      "/v1/auth/callback",
      "Lax",
      authConfiguration.cookieSecure,
    );
    if (
      expectedState === undefined ||
      returnedState === undefined ||
      !safeStringEqual(expectedState, returnedState)
    ) {
      throw new HttpApiError("bad_request", "Invalid authentication state");
    }
    const session = await dependencies.auth.callback({
      code: requiredString(c.req.query("code"), "code", 2_000),
      redirectUri: authConfiguration.callbackUri,
    });
    setSessionCookies(c, session, authConfiguration.cookieSecure);
    return c.redirect(authConfiguration.appOrigin, 303);
  });

  app.post("/v1/auth/refresh", async (c) => {
    const refreshToken = readCookie(c.req.raw, "oao_refresh");
    if (!refreshToken)
      throw new HttpApiError("unauthenticated", "Refresh session is required");
    const session = await dependencies.auth.refresh({ refreshToken });
    setSessionCookies(c, session, authConfiguration.cookieSecure);
    return c.json({
      expiresAt: session.expiresAt.toISOString(),
      principal: publicPrincipal(session.principal),
    });
  });

  app.post("/v1/auth/logout", async (c) => {
    const sessionToken =
      readCookie(c.req.raw, "oao_session") ??
      c.req.header("authorization")?.replace(/^Bearer\s+/iu, "");
    if (!sessionToken)
      throw new HttpApiError("unauthenticated", "Session is required");
    const result = await dependencies.auth.logout({
      sessionToken,
      returnTo: authConfiguration.appOrigin,
    });
    clearCookie(c, "oao_session", "/", "Lax", authConfiguration.cookieSecure);
    clearCookie(
      c,
      "oao_refresh",
      "/v1/auth",
      "Strict",
      authConfiguration.cookieSecure,
    );
    return c.json(result);
  });

  app.post("/v1/auth/workos/webhook", async (c) => {
    if (!dependencies.webhookAuth)
      throw new HttpApiError(
        "not_found",
        "Webhook authentication is not configured",
      );
    const signature = c.req.header("workos-signature");
    if (!signature)
      throw new HttpApiError(
        "unauthenticated",
        "Webhook signature is required",
      );
    const rawBody = new Uint8Array(await c.req.raw.arrayBuffer());
    const result = await dependencies.webhookAuth.handleWebhook({
      rawBody,
      signature,
    });
    return c.json(result, result.status === "duplicate" ? 200 : 202);
  });

  app.post("/v1/auth/development/login", async (c) => {
    if (authConfiguration.provider !== "development")
      throw new HttpApiError("not_found", "Route not found");
    const session = await dependencies.auth.callback({
      code: "development",
      redirectUri: authConfiguration.callbackUri,
    });
    setSessionCookies(c, session, authConfiguration.cookieSecure);
    return c.json({
      expiresAt: session.expiresAt.toISOString(),
      principal: publicPrincipal(session.principal),
    });
  });

  app.use("/v1/projects/*", authenticate);
  app.use("/v1/projects", authenticate);
  app.use("/v1/organizations", authenticate);
  app.use("/v1/organizations/*", authenticate);
  app.use("/v1/context", authenticate);

  app.get("/v1/context", async (c) => {
    const actor = principal(c);
    return dependencies.store.transaction(actor, undefined, async (tx) => {
      const [organizationResult, projectResult] = await Promise.all([
        tx.query(
          "SELECT id,slug,name,created_at FROM oao.organizations WHERE id=$1",
          [actor.organizationId],
        ),
        tx.query(
          `SELECT id,organization_id,slug,name,created_at FROM oao.projects
           WHERE organization_id=$1 AND id=$2`,
          [actor.organizationId, actor.projectId],
        ),
      ]);
      const organization = publicValue(organizationResult.rows[0]);
      const project = publicValue(projectResult.rows[0]);
      if (!organization || !project)
        throw new HttpApiError("not_found", "Authenticated project not found");
      return c.json({
        principal: publicPrincipal(actor),
        organization,
        project,
        organizations: [organization],
        projects: [project],
        activeModelPresets: [
          ...new Set([
            ...activeModelPresetKeys,
            ...(dependencies.credentialCipher
              ? await listProjectModelPresetKeys(tx, actor)
              : []),
          ]),
        ].sort(),
        authProvider: authConfiguration.provider,
      });
    });
  });

  app.get("/v1/organizations", async (c) => {
    const actor = principal(c);
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const result = await tx.query(
          "SELECT id,slug,name,created_at FROM oao.organizations WHERE id=$1",
          [actor.organizationId],
        );
        return c.json({
          data: rows(result),
          pageInfo: { hasMore: false, nextCursor: null },
        });
      },
    );
  });

  app.get("/v1/organizations/:organizationId", async (c) => {
    const actor = principal(c);
    if (actor.organizationId !== c.req.param("organizationId"))
      throw new HttpApiError(
        "forbidden",
        "Organization is outside the principal scope",
      );
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const result = await tx.query(
          "SELECT id,slug,name,created_at FROM oao.organizations WHERE id=$1",
          [actor.organizationId],
        );
        const organization = publicValue(result.rows[0]);
        if (!organization)
          throw new HttpApiError("not_found", "Organization not found");
        return c.json(organization);
      },
    );
  });

  app.get("/v1/projects", async (c) => {
    const actor = principal(c);
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const result = await tx.query(
          `SELECT id,organization_id,slug,name,created_at FROM oao.projects
         WHERE organization_id=$1 AND id=$2`,
          [actor.organizationId, actor.projectId],
        );
        return c.json({
          data: rows(result),
          pageInfo: { hasMore: false, nextCursor: null },
        });
      },
    );
  });

  app.get("/v1/projects/:projectId", async (c) => {
    const actor = assertProject(c);
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const result = await tx.query(
          `SELECT p.id,p.organization_id,p.slug,p.name,p.created_at,
                o.slug AS organization_slug,o.name AS organization_name
         FROM oao.projects p JOIN oao.organizations o ON o.id=p.organization_id
         WHERE p.organization_id=$1 AND p.id=$2`,
          [actor.organizationId, actor.projectId],
        );
        const project = publicValue(result.rows[0]);
        if (!project) throw new HttpApiError("not_found", "Project not found");
        return c.json(project);
      },
    );
  });

  app.get("/v1/projects/:projectId/members", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const condition = dependencies.store.cursorCondition(
          cursor,
          "pm.created_at",
          3,
          "p.id",
        );
        const result = await tx.query(
          `SELECT p.id,pm.organization_id,pm.project_id,pm.principal_id,p.kind,p.subject,p.scopes,pm.role,pm.created_at
         FROM oao.project_members pm JOIN oao.principals p
           ON p.organization_id=pm.organization_id AND p.project_id=pm.project_id AND p.id=pm.principal_id
         WHERE pm.organization_id=$1 AND pm.project_id=$2${condition.sql}
         ORDER BY pm.created_at DESC,pm.principal_id DESC LIMIT $${3 + condition.values.length}`,
          [
            actor.organizationId,
            actor.projectId,
            ...condition.values,
            limit + 1,
          ],
        );
        return c.json(pagination(rows(result), limit, "createdAt"));
      },
    );
  });

  app.post("/v1/projects/:projectId/members", async (c) => {
    const actor = assertProject(c);
    const body = await readJsonObject(c.req.raw);
    const key = idempotencyKey(c.req.raw);
    const subject = requiredString(body.subject, "subject", 500);
    const role = parseRole(body.role);
    const scopes = parseScopes(body.scopes);
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const response = await dependencies.store.idempotent(tx, actor, {
          scope: "POST:/members",
          key,
          hash: requestHash(body),
          status: 201,
          execute: async () => {
            const id = randomUUID();
            const result = await tx.query(
              `WITH created AS (
               INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
               VALUES ($1,$2,$3,'human',$4,$5)
               ON CONFLICT (organization_id,project_id,kind,subject)
               DO UPDATE SET scopes=EXCLUDED.scopes RETURNING id,kind,subject,scopes
             )
             INSERT INTO oao.project_members (organization_id,project_id,principal_id,role)
             SELECT $1,$2,id,$6 FROM created
             ON CONFLICT (organization_id,project_id,principal_id)
             DO UPDATE SET role=EXCLUDED.role
             RETURNING principal_id AS id,organization_id,project_id,principal_id,role,created_at`,
              [
                actor.organizationId,
                actor.projectId,
                id,
                subject,
                scopes,
                role,
              ],
            );
            const member = publicValue(result.rows[0]) as Readonly<
              Record<string, unknown>
            >;
            await dependencies.store.appendAudit(tx, actor, {
              action: "member.upserted",
              resourceType: "member",
              resourceId: String(member.id),
              detail: { role },
            });
            return member;
          },
        });
        c.header("idempotency-replayed", String(response.replayed));
        return c.json(response.body, 201);
      },
    );
  });

  app.patch("/v1/projects/:projectId/members/:memberId", async (c) => {
    const actor = assertProject(c);
    const body = await readJsonObject(c.req.raw);
    const idem = idempotencyKey(c.req.raw);
    const role = parseRole(body.role);
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const response = await dependencies.store.idempotent(tx, actor, {
          scope: `PATCH:/members/${c.req.param("memberId")}`,
          method: "PATCH",
          key: idem,
          hash: requestHash(body),
          status: 200,
          execute: async () => {
            const result = await tx.query(
              `UPDATE oao.project_members SET role=$4,updated_at=clock_timestamp()
             WHERE organization_id=$1 AND project_id=$2 AND principal_id=$3
             RETURNING principal_id AS id,organization_id,project_id,principal_id,role,created_at`,
              [
                actor.organizationId,
                actor.projectId,
                c.req.param("memberId"),
                role,
              ],
            );
            const member = publicValue(result.rows[0]);
            if (!member)
              throw new HttpApiError("not_found", "Member not found");
            await dependencies.store.appendAudit(tx, actor, {
              action: "member.role_changed",
              resourceType: "member",
              resourceId: c.req.param("memberId"),
              detail: { role },
            });
            return member as Readonly<Record<string, unknown>>;
          },
        });
        c.header("idempotency-replayed", String(response.replayed));
        return c.json(response.body);
      },
    );
  });

  app.delete("/v1/projects/:projectId/members/:memberId", async (c) => {
    const actor = assertProject(c);
    if (actor.id === c.req.param("memberId"))
      throw new HttpApiError(
        "conflict",
        "The active principal cannot remove itself",
      );
    const idem = idempotencyKey(c.req.raw);
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const response = await dependencies.store.idempotent(tx, actor, {
          scope: `DELETE:/members/${c.req.param("memberId")}`,
          method: "DELETE",
          key: idem,
          hash: requestHash({ memberId: c.req.param("memberId") }),
          status: 200,
          execute: async () => {
            const result = await tx.query(
              `DELETE FROM oao.project_members
             WHERE organization_id=$1 AND project_id=$2 AND principal_id=$3 RETURNING principal_id`,
              [actor.organizationId, actor.projectId, c.req.param("memberId")],
            );
            if (!result.rowCount)
              throw new HttpApiError("not_found", "Member not found");
            await dependencies.store.appendAudit(tx, actor, {
              action: "member.removed",
              resourceType: "member",
              resourceId: c.req.param("memberId"),
            });
            return { id: c.req.param("memberId"), removed: true };
          },
        });
        c.header("idempotency-replayed", String(response.replayed));
        return c.json(response.body);
      },
    );
  });

  app.get("/v1/projects/:projectId/api-keys", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const condition = dependencies.store.cursorCondition(
          cursor,
          "created_at",
          3,
        );
        const result = await tx.query(
          `SELECT id,organization_id,project_id,name,key_prefix AS prefix,scopes,expires_at,revoked_at,last_used_at,created_at
         FROM oao.api_keys WHERE organization_id=$1 AND project_id=$2${condition.sql}
         ORDER BY created_at DESC,id DESC LIMIT $${3 + condition.values.length}`,
          [
            actor.organizationId,
            actor.projectId,
            ...condition.values,
            limit + 1,
          ],
        );
        return c.json(pagination(rows(result), limit, "createdAt"));
      },
    );
  });

  app.post("/v1/projects/:projectId/api-keys", async (c) => {
    const actor = assertProject(c);
    const body = await readJsonObject(c.req.raw);
    const key = idempotencyKey(c.req.raw);
    const name = requiredString(body.name, "name", 200);
    const scopes = parseScopes(body.scopes);
    const expiresAt = body.expiresAt
      ? new Date(requiredString(body.expiresAt, "expiresAt", 50))
      : undefined;
    if (
      expiresAt &&
      (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())
    )
      throw new HttpApiError("bad_request", "expiresAt must be in the future");
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const hash = requestHash(body);
        const claim = await tx.query<{ outcome: "claimed" | "replayed" }>(
          "SELECT oao.claim_api_request_idempotency($1,$2,$3,'POST','POST:/api-keys',$4,$5,clock_timestamp() + interval '24 hours') AS outcome",
          [actor.organizationId, actor.projectId, actor.id, key, hash],
        );
        if (claim.rows[0]?.outcome === "replayed") {
          const replay = await tx.query<{
            response_public: Readonly<Record<string, unknown>>;
          }>(
            `SELECT response_public FROM oao.api_request_idempotency
           WHERE organization_id=$1 AND project_id=$2 AND principal_id=$3 AND http_method='POST'
             AND route_key='POST:/api-keys' AND idempotency_key=$4`,
            [actor.organizationId, actor.projectId, actor.id, key],
          );
          c.header("idempotency-replayed", "true");
          return c.json(replay.rows[0]?.response_public ?? null, 201);
        }
        const apiKey = await dependencies.store.createApiKey(tx, actor, {
          name,
          scopes,
          ...(expiresAt ? { expiresAt } : {}),
        });
        await dependencies.store.appendAudit(tx, actor, {
          action: "api_key.created",
          resourceType: "api_key",
          resourceId: apiKey.id,
          detail: { name, prefix: apiKey.prefix },
        });
        const storedResponse = {
          id: apiKey.id,
          organizationId: apiKey.organizationId,
          projectId: apiKey.projectId,
          name: apiKey.name,
          prefix: apiKey.prefix,
          scopes: apiKey.scopes,
          ...(apiKey.expiresAt ? { expiresAt: apiKey.expiresAt } : {}),
          createdAt: apiKey.createdAt,
          shown: false,
        };
        await tx.query(
          "SELECT oao.complete_api_request_idempotency($1,$2,$3,'POST','POST:/api-keys',$4,$5,201,$6::jsonb,$7)",
          [
            actor.organizationId,
            actor.projectId,
            actor.id,
            key,
            hash,
            storedResponse,
            apiKey.id,
          ],
        );
        c.header("idempotency-replayed", "false");
        return c.json(
          {
            ...storedResponse,
            secret: apiKey.secret,
            shown: true,
          },
          201,
        );
      },
    );
  });

  app.delete("/v1/projects/:projectId/api-keys/:apiKeyId", async (c) => {
    const actor = assertProject(c);
    const idem = idempotencyKey(c.req.raw);
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const response = await dependencies.store.idempotent(tx, actor, {
          scope: `DELETE:/api-keys/${c.req.param("apiKeyId")}`,
          method: "DELETE",
          key: idem,
          hash: requestHash({ apiKeyId: c.req.param("apiKeyId") }),
          status: 200,
          execute: async () => {
            const result = await tx.query(
              `UPDATE oao.api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp())
             WHERE organization_id=$1 AND project_id=$2 AND id=$3 RETURNING id`,
              [actor.organizationId, actor.projectId, c.req.param("apiKeyId")],
            );
            if (!result.rowCount)
              throw new HttpApiError("not_found", "API key not found");
            await dependencies.store.appendAudit(tx, actor, {
              action: "api_key.revoked",
              resourceType: "api_key",
              resourceId: c.req.param("apiKeyId"),
            });
            return { id: c.req.param("apiKeyId"), revoked: true };
          },
        });
        c.header("idempotency-replayed", String(response.replayed));
        return c.json(response.body);
      },
    );
  });

  registerModelPresetRoutes(app, dependencies);
  registerSandboxProviderRoutes(app, dependencies);
  registerStorageProviderRoutes(app, dependencies);
  registerAgentRoutes(app, dependencies);
  registerRunRoutes(app, dependencies);
  registerEventRoutes(app, dependencies);

  app.notFound((c) => {
    const requestId = c.get("requestId") ?? randomUUID();
    return c.json(
      {
        error: { code: "not_found", message: "Route not found", requestId },
      },
      404,
    );
  });
  app.onError((error, c) => {
    const requestId = c.get("requestId") ?? randomUUID();
    dependencies.onError?.({ requestId, error });
    const envelope = errorEnvelope(error, requestId);
    return new Response(JSON.stringify(envelope.body), {
      status: envelope.status,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      },
    });
  });
  return app;
}

function publicPrincipal(value: Principal) {
  return {
    id: value.id,
    organizationId: value.organizationId,
    projectId: value.projectId,
    kind: value.kind,
    subject: value.subject,
    scopes: [...value.scopes],
  };
}

function setSessionCookies(
  c: ApiContext,
  session: AuthSession,
  secure: boolean,
): void {
  const maxAge = Math.max(
    0,
    Math.floor((session.expiresAt.getTime() - Date.now()) / 1_000),
  );
  appendCookie(
    c,
    "oao_session",
    session.sessionToken,
    "/",
    "Lax",
    maxAge,
    secure,
  );
  if (session.refreshToken) {
    appendCookie(
      c,
      "oao_refresh",
      session.refreshToken,
      "/v1/auth",
      "Strict",
      maxAge,
      secure,
    );
  }
}

function appendCookie(
  c: ApiContext,
  name: string,
  value: string,
  path: string,
  sameSite: "Lax" | "Strict",
  maxAge: number,
  secure: boolean,
): void {
  c.header(
    "set-cookie",
    `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly${secure ? "; Secure" : ""}; SameSite=${sameSite}; Max-Age=${maxAge}`,
    { append: true },
  );
}

function clearCookie(
  c: ApiContext,
  name: string,
  path: string,
  sameSite: "Lax" | "Strict",
  secure: boolean,
): void {
  appendCookie(c, name, "", path, sameSite, 0, secure);
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function registerSandboxProviderRoutes(
  app: Hono<{ Variables: Variables }>,
  dependencies: ApiDependencies,
): void {
  const providerViewSql = `id,organization_id,project_id,provider_key AS key,
    display_name,provider_type,true AS credential_configured,
    left(credential_fingerprint,12) AS credential_fingerprint,
    encryption_key_version AS credential_version,target,restricted_egress,
    created_by_principal_id,created_at,updated_at`;

  app.get(
    "/v1/projects/:projectId/sandbox-providers/:providerId/snapshots",
    async (c) => {
      const actor = assertProject(c);
      if (!dependencies.credentialCipher)
        throw new HttpApiError(
          "internal_error",
          "Provider credential encryption is not configured",
        );
      if (!dependencies.sandboxSnapshotCatalog)
        throw new HttpApiError(
          "internal_error",
          "Sandbox snapshot discovery is not configured",
        );
      return dependencies.store.transaction(actor, "agent:read", async (tx) => {
        const result = await tx.query<{
          readonly id: string;
          readonly provider_type: "daytona";
          readonly encrypted_api_key: Buffer;
          readonly encryption_nonce: Buffer;
          readonly encryption_tag: Buffer;
          readonly encryption_key_version: number;
          readonly target: string | null;
        }>(
          `SELECT id,provider_type,encrypted_api_key,encryption_nonce,
                  encryption_tag,encryption_key_version,target
             FROM oao.project_sandbox_providers
            WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
          [actor.organizationId, actor.projectId, c.req.param("providerId")],
        );
        const provider = result.rows[0];
        if (!provider)
          throw new HttpApiError("not_found", "Sandbox provider not found");
        const apiKey = dependencies.credentialCipher!.decrypt(
          {
            ciphertext: provider.encrypted_api_key,
            nonce: provider.encryption_nonce,
            tag: provider.encryption_tag,
            keyVersion: provider.encryption_key_version,
          },
          {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            providerId: provider.id,
            providerType: provider.provider_type,
          },
        );
        const snapshots =
          await dependencies.sandboxSnapshotCatalog!.listSnapshots({
            apiKey,
            ...(provider.target ? { target: provider.target } : {}),
          });
        return c.json({
          data: snapshots,
          providerId: provider.id,
          providerType: provider.provider_type,
        });
      });
    },
  );

  app.get("/v1/projects/:projectId/sandbox-providers", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(actor, "agent:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "p.created_at",
        4,
        "p.id",
      );
      const result = await tx.query(
        `SELECT ${providerViewSql}
         FROM oao.project_sandbox_providers p
         WHERE organization_id=$1 AND project_id=$2${condition.sql}
         ORDER BY created_at DESC,id DESC LIMIT $${3 + condition.values.length}`,
        [actor.organizationId, actor.projectId, ...condition.values, limit + 1],
      );
      return c.json({
        ...pagination(rows(result), limit, "createdAt"),
        credentialEncryptionConfigured:
          dependencies.credentialCipher !== undefined,
      });
    });
  });

  app.post("/v1/projects/:projectId/sandbox-providers", async (c) => {
    const actor = assertProject(c);
    if (!dependencies.credentialCipher)
      throw new HttpApiError(
        "internal_error",
        "Provider credential encryption is not configured",
      );
    const body = await readJsonObject(c.req.raw);
    const idem = idempotencyKey(c.req.raw);
    let input: CreateProjectSandboxProviderInput;
    try {
      input = parseCreateProjectSandboxProviderInput(body);
    } catch {
      throw new HttpApiError(
        "bad_request",
        "Request must contain a Daytona key, display name, API key, target, and restricted egress policy",
      );
    }
    if (input.key === "local-fake")
      throw new HttpApiError(
        "bad_request",
        "local-fake is a reserved provider key",
      );
    const providerId = randomUUID();
    const encrypted = dependencies.credentialCipher.encrypt(input.apiKey, {
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      providerId,
      providerType: "daytona",
      keyVersion: 1,
    });
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const response = await dependencies.store.idempotent(tx, actor, {
          scope: "POST:/sandbox-providers",
          key: idem,
          hash: requestHash(body),
          status: 201,
          execute: async () => {
            const result = await tx.query(
              `INSERT INTO oao.project_sandbox_providers
                 (organization_id,project_id,id,provider_key,display_name,provider_type,
                  encrypted_api_key,encryption_nonce,encryption_tag,encryption_key_version,
                  credential_fingerprint,target,restricted_egress,created_by_principal_id)
               VALUES ($1,$2,$3,$4,$5,'daytona',$6,$7,$8,$9,$10,$11,$12,$13)
               RETURNING ${providerViewSql}`,
              [
                actor.organizationId,
                actor.projectId,
                providerId,
                input.key,
                input.displayName,
                encrypted.ciphertext,
                encrypted.nonce,
                encrypted.tag,
                encrypted.keyVersion,
                encrypted.fingerprint,
                input.target,
                input.restrictedEgress,
                actor.id,
              ],
            );
            await dependencies.store.appendAudit(tx, actor, {
              action: "sandbox_provider.created",
              resourceType: "sandbox_provider",
              resourceId: providerId,
              detail: {
                key: input.key,
                providerType: "daytona",
                credentialFingerprint: encrypted.fingerprint.slice(0, 12),
              },
            });
            return publicValue(result.rows[0]) as Readonly<
              Record<string, unknown>
            >;
          },
        });
        c.header("idempotency-replayed", String(response.replayed));
        return c.json(response.body, 201);
      },
    );
  });

  app.put(
    "/v1/projects/:projectId/sandbox-providers/:providerId/credential",
    async (c) => {
      const actor = assertProject(c);
      if (!dependencies.credentialCipher)
        throw new HttpApiError(
          "internal_error",
          "Provider credential encryption is not configured",
        );
      const body = await readJsonObject(c.req.raw);
      const idem = idempotencyKey(c.req.raw);
      let apiKey: string;
      try {
        apiKey = parseRotateProjectSandboxProviderCredentialInput(body).apiKey;
      } catch {
        throw new HttpApiError(
          "bad_request",
          "Request must contain an API key",
        );
      }
      return dependencies.store.transaction(
        actor,
        "project:admin",
        async (tx) => {
          const response = await dependencies.store.idempotent(tx, actor, {
            scope: `PUT:/sandbox-providers/${c.req.param("providerId")}/credential`,
            key: idem,
            hash: requestHash(body),
            status: 200,
            execute: async () => {
              const current = await tx.query<{
                encryption_key_version: number;
              }>(
                `SELECT encryption_key_version FROM oao.project_sandbox_providers
                 WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
                [
                  actor.organizationId,
                  actor.projectId,
                  c.req.param("providerId"),
                ],
              );
              const provider = current.rows[0];
              if (!provider)
                throw new HttpApiError(
                  "not_found",
                  "Sandbox provider not found",
                );
              const encrypted = dependencies.credentialCipher!.encrypt(apiKey, {
                organizationId: actor.organizationId,
                projectId: actor.projectId,
                providerId: c.req.param("providerId"),
                providerType: "daytona",
                keyVersion: provider.encryption_key_version + 1,
              });
              const result = await tx.query(
                `UPDATE oao.project_sandbox_providers
                 SET encrypted_api_key=$4,encryption_nonce=$5,encryption_tag=$6,
                     encryption_key_version=$7,credential_fingerprint=$8
                 WHERE organization_id=$1 AND project_id=$2 AND id=$3
                 RETURNING ${providerViewSql}`,
                [
                  actor.organizationId,
                  actor.projectId,
                  c.req.param("providerId"),
                  encrypted.ciphertext,
                  encrypted.nonce,
                  encrypted.tag,
                  encrypted.keyVersion,
                  encrypted.fingerprint,
                ],
              );
              await dependencies.store.appendAudit(tx, actor, {
                action: "sandbox_provider.credential_rotated",
                resourceType: "sandbox_provider",
                resourceId: c.req.param("providerId"),
                detail: {
                  providerType: "daytona",
                  credentialVersion: encrypted.keyVersion,
                  credentialFingerprint: encrypted.fingerprint.slice(0, 12),
                },
              });
              return publicValue(result.rows[0]) as Readonly<
                Record<string, unknown>
              >;
            },
          });
          c.header("idempotency-replayed", String(response.replayed));
          return c.json(response.body);
        },
      );
    },
  );

  app.put(
    "/v1/projects/:projectId/sandbox-providers/:providerId/configuration",
    async (c) => {
      const actor = assertProject(c);
      const body = await readJsonObject(c.req.raw);
      const idem = idempotencyKey(c.req.raw);
      let input: UpdateProjectSandboxProviderConfigurationInput;
      try {
        input = parseUpdateProjectSandboxProviderConfigurationInput(body);
      } catch {
        throw new HttpApiError(
          "bad_request",
          "Request must contain a target and restricted egress policy",
        );
      }
      return dependencies.store.transaction(
        actor,
        "project:admin",
        async (tx) => {
          const response = await dependencies.store.idempotent(tx, actor, {
            scope: `PUT:/sandbox-providers/${c.req.param("providerId")}/configuration`,
            key: idem,
            hash: requestHash(body),
            status: 200,
            execute: async () => {
              const result = await tx.query(
                `UPDATE oao.project_sandbox_providers
                 SET target=$4,restricted_egress=$5
                 WHERE organization_id=$1 AND project_id=$2 AND id=$3
                 RETURNING ${providerViewSql}`,
                [
                  actor.organizationId,
                  actor.projectId,
                  c.req.param("providerId"),
                  input.target,
                  input.restrictedEgress,
                ],
              );
              if (!result.rowCount)
                throw new HttpApiError(
                  "not_found",
                  "Sandbox provider not found",
                );
              await dependencies.store.appendAudit(tx, actor, {
                action: "sandbox_provider.configuration_updated",
                resourceType: "sandbox_provider",
                resourceId: c.req.param("providerId"),
                detail: {
                  targetConfigured: input.target !== null,
                  allowedDomainCount:
                    input.restrictedEgress.allowedDomains.length,
                  allowedCidrCount: input.restrictedEgress.allowedCidrs.length,
                },
              });
              return publicValue(result.rows[0]) as Readonly<
                Record<string, unknown>
              >;
            },
          });
          c.header("idempotency-replayed", String(response.replayed));
          return c.json(response.body);
        },
      );
    },
  );
}

function registerStorageProviderRoutes(
  app: Hono<{ Variables: Variables }>,
  dependencies: ApiDependencies,
): void {
  const providerViewSql = `id,organization_id,project_id,provider_key AS key,
    display_name,provider_type,endpoint,region,bucket,object_prefix AS prefix,
    force_path_style,is_default AS "default",true AS credential_configured,
    left(credential_fingerprint,12) AS credential_fingerprint,
    encryption_key_version AS credential_version,created_by_principal_id,
    created_at,updated_at`;

  app.get("/v1/projects/:projectId/storage-providers", async (c) => {
    const actor = assertProject(c);
    return dependencies.store.transaction(actor, "agent:read", async (tx) => {
      const result = await tx.query(
        `SELECT ${providerViewSql} FROM oao.project_storage_providers
          WHERE organization_id=$1 AND project_id=$2
          ORDER BY is_default DESC,created_at DESC,id DESC`,
        [actor.organizationId, actor.projectId],
      );
      return c.json({
        data: rows(result),
        credentialEncryptionConfigured:
          dependencies.credentialCipher !== undefined,
      });
    });
  });

  app.post("/v1/projects/:projectId/storage-providers", async (c) => {
    const actor = assertProject(c);
    if (!dependencies.credentialCipher)
      throw new HttpApiError(
        "internal_error",
        "Provider credential encryption is not configured",
      );
    const body = await readJsonObject(c.req.raw);
    const idem = idempotencyKey(c.req.raw);
    let input: CreateProjectStorageProviderInput;
    try {
      input = parseCreateProjectStorageProviderInput(body);
    } catch {
      throw new HttpApiError(
        "bad_request",
        "Request must contain valid S3-compatible storage configuration and credentials",
      );
    }
    const providerId = randomUUID();
    const encrypted = dependencies.credentialCipher.encrypt(
      JSON.stringify({
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
      }),
      {
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        providerId,
        providerType: "s3",
        keyVersion: 1,
      },
    );
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const response = await dependencies.store.idempotent(tx, actor, {
          scope: "POST:/storage-providers",
          key: idem,
          hash: requestHash(body),
          status: 201,
          execute: async () => {
            const existingDefault = await tx.query(
              `SELECT 1 FROM oao.project_storage_providers
                WHERE organization_id=$1 AND project_id=$2 AND is_default`,
              [actor.organizationId, actor.projectId],
            );
            const makeDefault = input.setDefault || !existingDefault.rowCount;
            if (makeDefault)
              await tx.query(
                `UPDATE oao.project_storage_providers SET is_default=false
                  WHERE organization_id=$1 AND project_id=$2 AND is_default`,
                [actor.organizationId, actor.projectId],
              );
            const result = await tx.query(
              `INSERT INTO oao.project_storage_providers (
                 organization_id,project_id,id,provider_key,display_name,provider_type,
                 endpoint,region,bucket,object_prefix,force_path_style,is_default,
                 encrypted_credential,encryption_nonce,encryption_tag,
                 encryption_key_version,credential_fingerprint,created_by_principal_id
               ) VALUES ($1,$2,$3,$4,$5,'s3',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
               RETURNING ${providerViewSql}`,
              [
                actor.organizationId,
                actor.projectId,
                providerId,
                input.key,
                input.displayName,
                input.endpoint,
                input.region,
                input.bucket,
                input.prefix,
                input.forcePathStyle,
                makeDefault,
                encrypted.ciphertext,
                encrypted.nonce,
                encrypted.tag,
                encrypted.keyVersion,
                encrypted.fingerprint,
                actor.id,
              ],
            );
            await dependencies.store.appendAudit(tx, actor, {
              action: "storage_provider.created",
              resourceType: "storage_provider",
              resourceId: providerId,
              detail: {
                key: input.key,
                providerType: "s3",
                bucket: input.bucket,
                default: makeDefault,
                credentialFingerprint: encrypted.fingerprint.slice(0, 12),
              },
            });
            return publicValue(result.rows[0]) as Readonly<
              Record<string, unknown>
            >;
          },
        });
        c.header("idempotency-replayed", String(response.replayed));
        return c.json(response.body, 201);
      },
    );
  });

  app.put(
    "/v1/projects/:projectId/storage-providers/:providerId/credential",
    async (c) => {
      const actor = assertProject(c);
      if (!dependencies.credentialCipher)
        throw new HttpApiError(
          "internal_error",
          "Provider credential encryption is not configured",
        );
      const body = await readJsonObject(c.req.raw);
      const idem = idempotencyKey(c.req.raw);
      let credential: ReturnType<
        typeof parseRotateProjectStorageProviderCredentialInput
      >;
      try {
        credential = parseRotateProjectStorageProviderCredentialInput(body);
      } catch {
        throw new HttpApiError(
          "bad_request",
          "Request must contain valid S3-compatible credentials",
        );
      }
      return dependencies.store.transaction(
        actor,
        "project:admin",
        async (tx) => {
          const response = await dependencies.store.idempotent(tx, actor, {
            scope: `PUT:/storage-providers/${c.req.param("providerId")}/credential`,
            key: idem,
            hash: requestHash(body),
            status: 200,
            execute: async () => {
              const current = await tx.query<{
                encryption_key_version: number;
              }>(
                `SELECT encryption_key_version FROM oao.project_storage_providers
                  WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
                [
                  actor.organizationId,
                  actor.projectId,
                  c.req.param("providerId"),
                ],
              );
              const provider = current.rows[0];
              if (!provider)
                throw new HttpApiError(
                  "not_found",
                  "Storage provider not found",
                );
              const encrypted = dependencies.credentialCipher!.encrypt(
                JSON.stringify(credential),
                {
                  organizationId: actor.organizationId,
                  projectId: actor.projectId,
                  providerId: c.req.param("providerId"),
                  providerType: "s3",
                  keyVersion: provider.encryption_key_version + 1,
                },
              );
              const result = await tx.query(
                `UPDATE oao.project_storage_providers
                    SET encrypted_credential=$4,encryption_nonce=$5,encryption_tag=$6,
                        encryption_key_version=$7,credential_fingerprint=$8
                  WHERE organization_id=$1 AND project_id=$2 AND id=$3
                  RETURNING ${providerViewSql}`,
                [
                  actor.organizationId,
                  actor.projectId,
                  c.req.param("providerId"),
                  encrypted.ciphertext,
                  encrypted.nonce,
                  encrypted.tag,
                  encrypted.keyVersion,
                  encrypted.fingerprint,
                ],
              );
              await dependencies.store.appendAudit(tx, actor, {
                action: "storage_provider.credential_rotated",
                resourceType: "storage_provider",
                resourceId: c.req.param("providerId"),
                detail: {
                  credentialVersion: encrypted.keyVersion,
                  credentialFingerprint: encrypted.fingerprint.slice(0, 12),
                },
              });
              return publicValue(result.rows[0]) as Readonly<
                Record<string, unknown>
              >;
            },
          });
          c.header("idempotency-replayed", String(response.replayed));
          return c.json(response.body);
        },
      );
    },
  );

  app.put(
    "/v1/projects/:projectId/storage-providers/:providerId/default",
    async (c) => {
      const actor = assertProject(c);
      const body = await readJsonObject(c.req.raw);
      const idem = idempotencyKey(c.req.raw);
      if (Object.keys(body).length !== 0)
        throw new HttpApiError("bad_request", "Request body must be empty");
      return dependencies.store.transaction(
        actor,
        "project:admin",
        async (tx) => {
          const response = await dependencies.store.idempotent(tx, actor, {
            scope: `PUT:/storage-providers/${c.req.param("providerId")}/default`,
            key: idem,
            hash: requestHash(body),
            status: 200,
            execute: async () => {
              const exists = await tx.query(
                `SELECT 1 FROM oao.project_storage_providers
                  WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
                [
                  actor.organizationId,
                  actor.projectId,
                  c.req.param("providerId"),
                ],
              );
              if (!exists.rowCount)
                throw new HttpApiError(
                  "not_found",
                  "Storage provider not found",
                );
              await tx.query(
                `UPDATE oao.project_storage_providers SET is_default=false
                  WHERE organization_id=$1 AND project_id=$2 AND is_default`,
                [actor.organizationId, actor.projectId],
              );
              const result = await tx.query(
                `UPDATE oao.project_storage_providers SET is_default=true
                  WHERE organization_id=$1 AND project_id=$2 AND id=$3
                  RETURNING ${providerViewSql}`,
                [
                  actor.organizationId,
                  actor.projectId,
                  c.req.param("providerId"),
                ],
              );
              await dependencies.store.appendAudit(tx, actor, {
                action: "storage_provider.default_changed",
                resourceType: "storage_provider",
                resourceId: c.req.param("providerId"),
                detail: { default: true },
              });
              return publicValue(result.rows[0]) as Readonly<
                Record<string, unknown>
              >;
            },
          });
          c.header("idempotency-replayed", String(response.replayed));
          return c.json(response.body);
        },
      );
    },
  );
}

function registerModelPresetRoutes(
  app: Hono<{ Variables: Variables }>,
  dependencies: ApiDependencies,
): void {
  const catalog = dependencies.modelCatalog ?? EMPTY_MODEL_CATALOG;
  const deploymentPresets = new Map(
    catalog.deploymentPresets.map((preset) => [preset.key, preset.model]),
  );
  const activeModelPresetKeys =
    dependencies.activeModelPresetKeys ?? new Set(deploymentPresets.keys());

  const deploymentPresetViews = () =>
    [...activeModelPresetKeys].sort().map((key) => {
      const model = deploymentPresets.get(key);
      if (!model) throw new Error(`Deployment preset is unavailable: ${key}`);
      return {
        id: null,
        organizationId: null,
        projectId: null,
        key,
        displayName: key,
        origin: "deployment" as const,
        providerId: null,
        providerType: null,
        model,
        routing: {},
        hosted: true,
        available: true,
        createdByPrincipalId: null,
        createdAt: null,
      };
    });

  const providerViewSql = `id,organization_id,project_id,provider_key AS key,
    display_name,provider_type,true AS credential_configured,
    left(credential_fingerprint,12) AS credential_fingerprint,
    encryption_key_version AS credential_version,
    created_by_principal_id,created_at,updated_at`;
  type ProviderCredentialRow = {
    readonly id: string;
    readonly provider_type: ModelProviderType;
    readonly encrypted_api_key: Buffer;
    readonly encryption_nonce: Buffer;
    readonly encryption_tag: Buffer;
    readonly encryption_key_version: number;
  };
  const providerApiKey = (
    actor: Principal,
    provider: ProviderCredentialRow,
  ): string | undefined => {
    if (provider.provider_type !== "openrouter") return undefined;
    if (
      !Buffer.isBuffer(provider.encrypted_api_key) ||
      !Buffer.isBuffer(provider.encryption_nonce) ||
      !Buffer.isBuffer(provider.encryption_tag)
    )
      return undefined;
    if (!dependencies.credentialCipher)
      throw new HttpApiError(
        "internal_error",
        "Provider credential encryption is not configured",
      );
    return dependencies.credentialCipher.decrypt(
      {
        ciphertext: provider.encrypted_api_key,
        nonce: provider.encryption_nonce,
        tag: provider.encryption_tag,
        keyVersion: provider.encryption_key_version,
      },
      {
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        providerId: provider.id,
        providerType: provider.provider_type,
      },
    );
  };

  app.get("/v1/projects/:projectId/model-providers", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(actor, "agent:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "p.created_at",
        4,
        "p.id",
      );
      const result = await tx.query(
        `SELECT ${providerViewSql}
         FROM oao.project_model_providers
         WHERE organization_id=$1 AND project_id=$2${condition.sql}
         ORDER BY created_at DESC,id DESC LIMIT $${3 + condition.values.length}`,
        [actor.organizationId, actor.projectId, ...condition.values, limit + 1],
      );
      return c.json(pagination(rows(result), limit, "createdAt"));
    });
  });

  app.post("/v1/projects/:projectId/model-providers", async (c) => {
    const actor = assertProject(c);
    if (!dependencies.credentialCipher)
      throw new HttpApiError(
        "internal_error",
        "Provider credential encryption is not configured",
      );
    const body = await readJsonObject(c.req.raw);
    const idem = idempotencyKey(c.req.raw);
    let input: CreateProjectModelProviderInput;
    try {
      input = parseCreateProjectModelProviderInput(body);
    } catch {
      throw new HttpApiError(
        "bad_request",
        "Request must contain a key, display name, supported provider type, and API key",
      );
    }
    const providerId = randomUUID();
    const encrypted = dependencies.credentialCipher.encrypt(input.apiKey, {
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      providerId,
      providerType: input.providerType,
      keyVersion: 1,
    });
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const response = await dependencies.store.idempotent(tx, actor, {
          scope: "POST:/model-providers",
          key: idem,
          hash: requestHash(body),
          status: 201,
          execute: async () => {
            const result = await tx.query(
              `INSERT INTO oao.project_model_providers
                 (organization_id,project_id,id,provider_key,display_name,provider_type,
                  encrypted_api_key,encryption_nonce,encryption_tag,encryption_key_version,
                  credential_fingerprint,created_by_principal_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
               RETURNING ${providerViewSql}`,
              [
                actor.organizationId,
                actor.projectId,
                providerId,
                input.key,
                input.displayName,
                input.providerType,
                encrypted.ciphertext,
                encrypted.nonce,
                encrypted.tag,
                encrypted.keyVersion,
                encrypted.fingerprint,
                actor.id,
              ],
            );
            await dependencies.store.appendAudit(tx, actor, {
              action: "model_provider.created",
              resourceType: "model_provider",
              resourceId: providerId,
              detail: {
                key: input.key,
                providerType: input.providerType,
                credentialFingerprint: encrypted.fingerprint.slice(0, 12),
              },
            });
            return publicValue(result.rows[0]) as Readonly<
              Record<string, unknown>
            >;
          },
        });
        c.header("idempotency-replayed", String(response.replayed));
        return c.json(response.body, 201);
      },
    );
  });

  app.put(
    "/v1/projects/:projectId/model-providers/:providerId/credential",
    async (c) => {
      const actor = assertProject(c);
      if (!dependencies.credentialCipher)
        throw new HttpApiError(
          "internal_error",
          "Provider credential encryption is not configured",
        );
      const body = await readJsonObject(c.req.raw);
      const idem = idempotencyKey(c.req.raw);
      let apiKey: string;
      try {
        apiKey = parseRotateProjectModelProviderCredentialInput(body).apiKey;
      } catch {
        throw new HttpApiError(
          "bad_request",
          "Request must contain an API key",
        );
      }
      return dependencies.store.transaction(
        actor,
        "project:admin",
        async (tx) => {
          const response = await dependencies.store.idempotent(tx, actor, {
            scope: `PUT:/model-providers/${c.req.param("providerId")}/credential`,
            key: idem,
            hash: requestHash(body),
            status: 200,
            execute: async () => {
              const current = await tx.query<{
                provider_type: ModelProviderType;
                encryption_key_version: number;
              }>(
                `SELECT provider_type,encryption_key_version
                 FROM oao.project_model_providers
                 WHERE organization_id=$1 AND project_id=$2 AND id=$3
                 FOR UPDATE`,
                [
                  actor.organizationId,
                  actor.projectId,
                  c.req.param("providerId"),
                ],
              );
              const provider = current.rows[0];
              if (!provider)
                throw new HttpApiError("not_found", "Model provider not found");
              const encrypted = dependencies.credentialCipher!.encrypt(apiKey, {
                organizationId: actor.organizationId,
                projectId: actor.projectId,
                providerId: c.req.param("providerId"),
                providerType: provider.provider_type,
                keyVersion: provider.encryption_key_version + 1,
              });
              const result = await tx.query(
                `UPDATE oao.project_model_providers
                 SET encrypted_api_key=$4,encryption_nonce=$5,encryption_tag=$6,
                     encryption_key_version=$7,credential_fingerprint=$8
                 WHERE organization_id=$1 AND project_id=$2 AND id=$3
                 RETURNING ${providerViewSql}`,
                [
                  actor.organizationId,
                  actor.projectId,
                  c.req.param("providerId"),
                  encrypted.ciphertext,
                  encrypted.nonce,
                  encrypted.tag,
                  encrypted.keyVersion,
                  encrypted.fingerprint,
                ],
              );
              await dependencies.store.appendAudit(tx, actor, {
                action: "model_provider.credential_rotated",
                resourceType: "model_provider",
                resourceId: c.req.param("providerId"),
                detail: {
                  providerType: provider.provider_type,
                  credentialVersion: encrypted.keyVersion,
                  credentialFingerprint: encrypted.fingerprint.slice(0, 12),
                },
              });
              return publicValue(result.rows[0]) as Readonly<
                Record<string, unknown>
              >;
            },
          });
          c.header("idempotency-replayed", String(response.replayed));
          return c.json(response.body);
        },
      );
    },
  );

  app.get("/v1/projects/:projectId/model-catalog", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const search = (c.req.query("search") ?? "").trim().toLowerCase();
    const providerId = requiredString(c.req.query("providerId"), "providerId");
    return dependencies.store.transaction(actor, "agent:read", async (tx) => {
      const providerResult = await tx.query<ProviderCredentialRow>(
        `SELECT id,provider_type,encrypted_api_key,encryption_nonce,
                encryption_tag,encryption_key_version
         FROM oao.project_model_providers
         WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
        [actor.organizationId, actor.projectId, providerId],
      );
      const provider = providerResult.rows[0];
      if (!provider)
        throw new HttpApiError("not_found", "Model provider not found");
      const providerType = provider.provider_type;
      const apiKey = providerApiKey(actor, provider);
      const entries = (
        await catalog.listCatalog({
          providerType,
          ...(apiKey ? { apiKey } : {}),
          search,
          limit,
        })
      ).filter(
        (entry) =>
          !search ||
          entry.catalogId.toLowerCase().includes(search) ||
          entry.name.toLowerCase().includes(search),
      );
      return c.json({
        data: entries.slice(0, limit),
        pageInfo: { hasMore: entries.length > limit, nextCursor: null },
        providerId,
        providerType,
      });
    });
  });

  app.get("/v1/projects/:projectId/model-presets", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(actor, "agent:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "created_at",
        3,
      );
      const result = await tx.query(
        `SELECT p.id,p.organization_id,p.project_id,p.preset_key AS key,p.display_name,
                'project'::text AS origin,p.provider_id,c.provider_type,p.model,p.routing,
                true AS hosted,(c.id IS NOT NULL AND $3::boolean) AS available,
                p.created_by_principal_id,p.created_at
         FROM oao.project_model_presets p
         LEFT JOIN oao.project_model_providers c
           ON c.organization_id=p.organization_id
          AND c.project_id=p.project_id
          AND c.id=p.provider_id
         WHERE p.organization_id=$1 AND p.project_id=$2${condition.sql}
         ORDER BY p.created_at DESC,p.id DESC LIMIT $${4 + condition.values.length}`,
        [
          actor.organizationId,
          actor.projectId,
          dependencies.credentialCipher !== undefined,
          ...condition.values,
          limit + 1,
        ],
      );
      const project = rows(result) as Readonly<Record<string, unknown>>[];
      const page = pagination(project, limit, "createdAt");
      const projectKeys = new Set(await listProjectModelPresetKeys(tx, actor));
      return c.json({
        ...page,
        data: cursor
          ? page.data
          : [
              ...deploymentPresetViews().filter(
                (preset) => !projectKeys.has(preset.key),
              ),
              ...page.data,
            ],
        credentialEncryptionConfigured:
          dependencies.credentialCipher !== undefined,
      });
    });
  });

  app.post("/v1/projects/:projectId/model-presets", async (c) => {
    const actor = assertProject(c);
    const body = await readJsonObject(c.req.raw);
    const idem = idempotencyKey(c.req.raw);
    let input: CreateModelPresetInput;
    try {
      input = parseCreateModelPresetInput(body);
    } catch {
      throw new HttpApiError(
        "bad_request",
        "Request must contain a versioned key, display name, approved model, and supported routing policy",
      );
    }
    if (activeModelPresetKeys.has(input.key))
      throw new HttpApiError(
        "conflict",
        "Model preset key is already used by a deployment preset",
      );
    if (!dependencies.credentialCipher)
      throw new HttpApiError(
        "internal_error",
        "Provider credential encryption is not configured",
      );
    return dependencies.store.transaction(
      actor,
      "project:admin",
      async (tx) => {
        const response = await dependencies.store.idempotent(tx, actor, {
          scope: "POST:/model-presets",
          key: idem,
          hash: requestHash(body),
          status: 201,
          execute: async () => {
            const presetId = randomUUID();
            const providerResult = await tx.query<ProviderCredentialRow>(
              `SELECT id,provider_type,encrypted_api_key,encryption_nonce,
                      encryption_tag,encryption_key_version
               FROM oao.project_model_providers
               WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
              [actor.organizationId, actor.projectId, input.providerId],
            );
            const provider = providerResult.rows[0];
            if (!provider)
              throw new HttpApiError("not_found", "Model provider not found");
            const providerType = provider.provider_type;
            const apiKey = providerApiKey(actor, provider);
            if (
              !(await catalog.isApprovedModel(input.model, providerType, {
                ...(apiKey ? { apiKey } : {}),
              }))
            )
              throw new HttpApiError(
                "bad_request",
                "model is not present in the provider catalog",
              );
            if (
              providerType === "openai" &&
              Object.keys(input.routing).length > 0
            )
              throw new HttpApiError(
                "bad_request",
                "OpenAI model presets do not support OpenRouter routing policy",
              );
            assertPublicPayload({
              key: input.key,
              displayName: input.displayName,
              providerId: input.providerId,
              model: input.model,
              routing: input.routing,
            } as Readonly<Record<string, PublicValue>>);
            const existing = await tx.query(
              `SELECT 1 FROM oao.project_model_presets
               WHERE organization_id=$1 AND project_id=$2 AND preset_key=$3`,
              [actor.organizationId, actor.projectId, input.key],
            );
            if (existing.rowCount)
              throw new HttpApiError(
                "conflict",
                "Model preset key already exists in this project",
              );
            const result = await tx.query(
              `INSERT INTO oao.project_model_presets
                 (organization_id,project_id,id,preset_key,display_name,provider_id,model,routing,created_by_principal_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               RETURNING id,organization_id,project_id,preset_key AS key,display_name,
                         'project'::text AS origin,provider_id,$10::text AS provider_type,
                         model,routing,true AS hosted,true AS available,
                         created_by_principal_id,created_at`,
              [
                actor.organizationId,
                actor.projectId,
                presetId,
                input.key,
                input.displayName,
                input.providerId,
                input.model,
                input.routing,
                actor.id,
                providerType,
              ],
            );
            const preset = publicValue(result.rows[0]) as Readonly<
              Record<string, unknown>
            >;
            await dependencies.store.appendAudit(tx, actor, {
              action: "model_preset.created",
              resourceType: "model_preset",
              resourceId: presetId,
              detail: { key: input.key, model: input.model },
            });
            return preset;
          },
        });
        c.header("idempotency-replayed", String(response.replayed));
        return c.json(response.body, 201);
      },
    );
  });
}

function registerAgentRoutes(
  app: Hono<{ Variables: Variables }>,
  dependencies: ApiDependencies,
): void {
  const activeModelPresetKeys =
    dependencies.activeModelPresetKeys ?? new Set<string>();
  const projectModelsEnabled = dependencies.credentialCipher !== undefined;
  app.get("/v1/projects/:projectId/agents", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(actor, "agent:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "d.created_at",
        3,
        "d.id",
      );
      const result = await tx.query(
        `SELECT d.id,d.organization_id,d.project_id,d.agent_key AS key,d.name,COALESCE(d.description,'') AS description,
                d.latest_version_id,v.version,v.config->>'modelPreset' AS model,
                CASE WHEN v.id IS NULL THEN 'draft' ELSE 'published' END AS status,
                d.created_at,COALESCE(v.created_at,d.created_at) AS updated_at
         FROM oao.agent_definitions d
         LEFT JOIN oao.agent_versions v ON v.organization_id=d.organization_id
           AND v.project_id=d.project_id AND v.id=d.latest_version_id
         WHERE d.organization_id=$1 AND d.project_id=$2${condition.sql}
         ORDER BY d.created_at DESC,d.id DESC LIMIT $${3 + condition.values.length}`,
        [actor.organizationId, actor.projectId, ...condition.values, limit + 1],
      );
      return c.json(pagination(rows(result), limit, "createdAt"));
    });
  });

  app.post("/v1/projects/:projectId/agents", async (c) => {
    const actor = assertProject(c);
    const body = await readJsonObject(c.req.raw);
    const idem = idempotencyKey(c.req.raw);
    const name = requiredString(body.name, "name", 200);
    const agentKey =
      body.key === undefined
        ? defaultAgentKey(name)
        : requiredString(body.key, "key", 120);
    const description =
      body.description === ""
        ? undefined
        : optionalString(body.description, "description");
    const config = parseAgentConfig(body.initialConfig ?? body.config);
    return dependencies.store.transaction(actor, "agent:write", async (tx) => {
      await assertModelPresetApproved(
        tx,
        actor,
        config.modelPreset,
        activeModelPresetKeys,
        projectModelsEnabled,
      );
      await assertSandboxProviderApproved(
        tx,
        actor,
        config.sandbox,
        projectModelsEnabled,
      );
      const response = await dependencies.store.idempotent(tx, actor, {
        scope: "POST:/agents",
        key: idem,
        hash: requestHash(body),
        status: 201,
        execute: async () => {
          const agentId = randomUUID();
          const versionId = randomUUID();
          await tx.query(
            `INSERT INTO oao.agent_definitions
               (organization_id,project_id,id,agent_key,name,description)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING id`,
            [
              actor.organizationId,
              actor.projectId,
              agentId,
              agentKey,
              name,
              description ?? null,
            ],
          );
          await tx.query(
            "SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)",
            [
              actor.organizationId,
              actor.projectId,
              agentId,
              versionId,
              config,
              requestHash(config),
              actor.id,
            ],
          );
          const result = await tx.query(
            `SELECT d.id,d.organization_id,d.project_id,d.agent_key AS key,d.name,COALESCE(d.description,'') AS description,
                    d.latest_version_id,v.version,v.config->>'modelPreset' AS model,'published' AS status,
                    d.created_at,v.created_at AS updated_at
             FROM oao.agent_definitions d JOIN oao.agent_versions v
               ON v.organization_id=d.organization_id AND v.project_id=d.project_id
              AND v.id=d.latest_version_id
             WHERE d.organization_id=$1 AND d.project_id=$2 AND d.id=$3`,
            [actor.organizationId, actor.projectId, agentId],
          );
          const agent = publicValue(result.rows[0]) as Readonly<
            Record<string, unknown>
          >;
          await dependencies.store.appendAudit(tx, actor, {
            action: "agent.created",
            resourceType: "agent",
            resourceId: agentId,
            detail: { initialVersionId: versionId },
          });
          await dependencies.store.appendAudit(tx, actor, {
            action: "agent_version.published",
            resourceType: "agent_version",
            resourceId: versionId,
            detail: { agentId, version: 1 },
          });
          return agent;
        },
      });
      c.header("idempotency-replayed", String(response.replayed));
      return c.json(response.body, 201);
    });
  });

  app.get("/v1/projects/:projectId/agents/:agentId", async (c) => {
    const actor = assertProject(c);
    return dependencies.store.transaction(actor, "agent:read", async (tx) => {
      const result = await tx.query(
        `SELECT d.id,d.organization_id,d.project_id,d.agent_key AS key,d.name,COALESCE(d.description,'') AS description,
                d.latest_version_id,v.version,v.config->>'modelPreset' AS model,
                CASE WHEN v.id IS NULL THEN 'draft' ELSE 'published' END AS status,
                d.created_at,COALESCE(v.created_at,d.created_at) AS updated_at
         FROM oao.agent_definitions d
         LEFT JOIN oao.agent_versions v ON v.organization_id=d.organization_id
           AND v.project_id=d.project_id AND v.id=d.latest_version_id
         WHERE d.organization_id=$1 AND d.project_id=$2 AND d.id=$3`,
        [actor.organizationId, actor.projectId, c.req.param("agentId")],
      );
      const agent = publicValue(result.rows[0]) as
        Readonly<Record<string, unknown>> | undefined;
      if (!agent) throw new HttpApiError("not_found", "Agent not found");
      const versions = await tx.query(
        `SELECT id,organization_id,project_id,agent_definition_id,version,config,
                encode(content_hash,'hex') AS content_hash,created_by_principal_id,created_at
         FROM oao.agent_versions WHERE organization_id=$1 AND project_id=$2
           AND agent_definition_id=$3 ORDER BY version DESC`,
        [actor.organizationId, actor.projectId, c.req.param("agentId")],
      );
      return c.json({ ...agent, versions: rows(versions) });
    });
  });

  app.get("/v1/projects/:projectId/agents/:agentId/versions", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(actor, "agent:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "created_at",
        4,
      );
      const result = await tx.query(
        `SELECT id,organization_id,project_id,agent_definition_id,version,config,encode(content_hash,'hex') AS content_hash,
                created_by_principal_id,created_at
         FROM oao.agent_versions WHERE organization_id=$1 AND project_id=$2 AND agent_definition_id=$3${condition.sql}
         ORDER BY created_at DESC,id DESC LIMIT $${4 + condition.values.length}`,
        [
          actor.organizationId,
          actor.projectId,
          c.req.param("agentId"),
          ...condition.values,
          limit + 1,
        ],
      );
      return c.json(pagination(rows(result), limit, "createdAt"));
    });
  });

  app.get(
    "/v1/projects/:projectId/agents/:agentId/versions/:versionId",
    async (c) => {
      const actor = assertProject(c);
      return dependencies.store.transaction(actor, "agent:read", async (tx) => {
        const result = await tx.query(
          `SELECT id,organization_id,project_id,agent_definition_id,version,config,encode(content_hash,'hex') AS content_hash,
                  created_by_principal_id,created_at
           FROM oao.agent_versions
           WHERE organization_id=$1 AND project_id=$2 AND agent_definition_id=$3 AND id=$4`,
          [
            actor.organizationId,
            actor.projectId,
            c.req.param("agentId"),
            c.req.param("versionId"),
          ],
        );
        const version = publicValue(result.rows[0]);
        if (!version)
          throw new HttpApiError("not_found", "Agent version not found");
        return c.json(version);
      });
    },
  );

  app.post("/v1/projects/:projectId/agents/:agentId/versions", async (c) => {
    const actor = assertProject(c);
    const body = await readJsonObject(c.req.raw);
    const idem = idempotencyKey(c.req.raw);
    const config = parseAgentConfig(body.config ?? body);
    return dependencies.store.transaction(actor, "agent:write", async (tx) => {
      await assertModelPresetApproved(
        tx,
        actor,
        config.modelPreset,
        activeModelPresetKeys,
        projectModelsEnabled,
      );
      await assertSandboxProviderApproved(
        tx,
        actor,
        config.sandbox,
        projectModelsEnabled,
      );
      const response = await dependencies.store.idempotent(tx, actor, {
        scope: `POST:/agents/${c.req.param("agentId")}/versions`,
        key: idem,
        hash: requestHash(body),
        status: 201,
        execute: async () => {
          const result = await tx.query(
            `SELECT (published).*
             FROM (SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7) AS published) q`,
            [
              actor.organizationId,
              actor.projectId,
              c.req.param("agentId"),
              randomUUID(),
              config,
              requestHash(config),
              actor.id,
            ],
          );
          const version = publicValue(result.rows[0]) as Readonly<
            Record<string, unknown>
          >;
          await dependencies.store.appendAudit(tx, actor, {
            action: "agent_version.published",
            resourceType: "agent_version",
            resourceId: String(version.id),
            detail: {
              agentId: c.req.param("agentId"),
              version: Number(version.version),
            },
          });
          return version;
        },
      });
      c.header("idempotency-replayed", String(response.replayed));
      return c.json(response.body, 201);
    });
  });
}

function registerRunRoutes(
  app: Hono<{ Variables: Variables }>,
  dependencies: ApiDependencies,
): void {
  app.get("/v1/projects/:projectId/sessions", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(actor, "session:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "s.last_activity_at",
        3,
        "s.id",
      );
      const result = await tx.query(
        `SELECT s.id,s.organization_id,s.project_id,s.thread_id,s.agent_version_id,t.title,
                d.id AS agent_id,d.name AS agent_name,v.version AS agent_version,
                v.config->>'modelPreset' AS model,lr.id AS latest_run_id,
                COALESCE(lr.state::text,'queued') AS status,
                lr.created_at AS started_at,lr.settled_at AS completed_at,
                COALESCE(ss.input_tokens,0)::float8 AS input_tokens,
                COALESCE(ss.output_tokens,0)::float8 AS output_tokens,
                COALESCE(ss.cost_microunits,0)::float8 AS cost_microunits,
                CASE WHEN COALESCE(mi.invocations,0)=0 THEN 'unavailable'
                     WHEN mi.unavailable=mi.invocations THEN 'unavailable'
                     WHEN mi.provider_observed=mi.invocations THEN 'provider_observed'
                     ELSE 'estimated' END AS cost_provenance,
                s.created_at,s.last_activity_at
         FROM oao.sessions s
         JOIN oao.threads t ON t.organization_id=s.organization_id AND t.project_id=s.project_id AND t.id=s.thread_id
         JOIN oao.agent_versions v ON v.organization_id=s.organization_id AND v.project_id=s.project_id AND v.id=s.agent_version_id
         JOIN oao.agent_definitions d ON d.organization_id=v.organization_id AND d.project_id=v.project_id AND d.id=v.agent_definition_id
         LEFT JOIN oao.session_summaries ss ON ss.organization_id=s.organization_id AND ss.project_id=s.project_id AND ss.session_id=s.id
         LEFT JOIN LATERAL (
           SELECT r.id,r.state,r.created_at,r.settled_at FROM oao.runs r
           WHERE r.organization_id=s.organization_id AND r.project_id=s.project_id AND r.session_id=s.id
           ORDER BY r.created_at DESC,r.id DESC LIMIT 1
         ) lr ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS invocations,
                  count(*) FILTER (WHERE m.usage_source='unavailable')::int AS unavailable,
                  count(*) FILTER (WHERE m.usage_source='provider_reported')::int AS provider_observed
           FROM oao.model_invocations m JOIN oao.runs r
             ON r.organization_id=m.organization_id AND r.project_id=m.project_id AND r.id=m.run_id
           WHERE r.organization_id=s.organization_id AND r.project_id=s.project_id AND r.session_id=s.id
         ) mi ON true
         WHERE s.organization_id=$1 AND s.project_id=$2${condition.sql}
         ORDER BY s.last_activity_at DESC,s.id DESC LIMIT $${3 + condition.values.length}`,
        [actor.organizationId, actor.projectId, ...condition.values, limit + 1],
      );
      return c.json(pagination(rows(result), limit, "lastActivityAt"));
    });
  });

  app.post("/v1/projects/:projectId/sessions", async (c) => {
    const actor = assertProject(c);
    const body = await readJsonObject(c.req.raw);
    const idem = idempotencyKey(c.req.raw);
    const submittedAgentVersionId =
      body.agentVersionId === undefined
        ? undefined
        : requiredString(body.agentVersionId, "agentVersionId", 50);
    const submittedAgentId =
      body.agentId === undefined
        ? undefined
        : requiredString(body.agentId, "agentId", 50);
    if (!submittedAgentVersionId && !submittedAgentId)
      throw new HttpApiError(
        "bad_request",
        "agentVersionId or agentId is required",
      );
    const initialMessage = requiredString(
      body.initialMessage,
      "initialMessage",
      100_000,
    );
    const title = optionalString(body.title, "title", 500);
    return dependencies.store.transaction(
      actor,
      ["session:write", "run:create"],
      async (tx) => {
        const response = await dependencies.store.idempotent(tx, actor, {
          scope: "POST:/sessions",
          key: idem,
          hash: requestHash(body),
          status: 201,
          execute: async () => {
            const threadId = randomUUID();
            const sessionId = randomUUID();
            const runId = randomUUID();
            const messageId = randomUUID();
            let agentVersionId = submittedAgentVersionId;
            if (submittedAgentId) {
              const definition = await tx.query<{
                latest_version_id: string | null;
              }>(
                `SELECT latest_version_id FROM oao.agent_definitions
                 WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
                [actor.organizationId, actor.projectId, submittedAgentId],
              );
              const latestVersionId = definition.rows[0]?.latest_version_id;
              if (!latestVersionId)
                throw new HttpApiError(
                  "conflict",
                  "Agent does not have a published version",
                );
              if (agentVersionId && agentVersionId !== latestVersionId)
                throw new HttpApiError(
                  "bad_request",
                  "agentVersionId is not the agent's latest published version",
                );
              agentVersionId = latestVersionId;
            }
            const result = await tx.query(
              `WITH thread AS (
                 INSERT INTO oao.threads (organization_id,project_id,id,title)
                 VALUES ($1,$2,$3,$4) RETURNING id
               ), session AS (
                 INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
                 VALUES ($1,$2,$5,$3,$6) RETURNING *
               ), run AS (
                 INSERT INTO oao.runs
                   (organization_id,project_id,id,thread_id,session_id,agent_version_id,created_by_principal_id,idempotency_key,input_public)
                 VALUES ($1,$2,$7,$3,$5,$6,$8,$9,$10) RETURNING *
               ), message AS (
                 INSERT INTO oao.messages
                   (organization_id,project_id,id,thread_id,run_id,role,redacted_content)
                 VALUES ($1,$2,$11,$3,$7,'user',$12)
               )
               SELECT row_to_json(session) AS session,row_to_json(run) AS run FROM session,run`,
              [
                actor.organizationId,
                actor.projectId,
                threadId,
                title ?? null,
                sessionId,
                agentVersionId,
                runId,
                actor.id,
                idem,
                { message: initialMessage },
                messageId,
                initialMessage,
              ],
            );
            const session = publicValue(result.rows[0]?.session) as Readonly<
              Record<string, unknown>
            >;
            const run = publicValue(result.rows[0]?.run) as Readonly<
              Record<string, unknown>
            >;
            await dependencies.store.appendEvent(tx, actor, {
              aggregateType: "run",
              aggregateId: runId,
              kind: "run.created",
              payload: { state: "queued", sessionId },
            });
            await dependencies.store.appendEvent(tx, actor, {
              aggregateType: "thread",
              aggregateId: threadId,
              kind: "message.created",
              payload: { messageId, runId, role: "user" },
            });
            await dependencies.store.appendAudit(tx, actor, {
              action: "session.created",
              resourceType: "session",
              resourceId: sessionId,
              detail: { initialRunId: runId },
            });
            await dependencies.runtimeCommands.enqueue(tx, {
              organizationId: actor.organizationId,
              projectId: actor.projectId,
              runId,
              kind: "admit",
              payload: { reason: "api_session_created" },
            });
            return { ...session, run, latestRunId: runId, status: "queued" };
          },
        });
        c.header("idempotency-replayed", String(response.replayed));
        return c.json(response.body, 201);
      },
    );
  });

  app.get("/v1/projects/:projectId/sessions/:sessionId", async (c) => {
    const actor = assertProject(c);
    return dependencies.store.transaction(actor, "session:read", async (tx) => {
      const result = await tx.query(
        `SELECT s.id,s.organization_id,s.project_id,s.thread_id,s.agent_version_id,t.title,
                d.id AS agent_id,d.name AS agent_name,v.version AS agent_version,
                v.config->>'modelPreset' AS model,lr.id AS latest_run_id,
                COALESCE(lr.state::text,'queued') AS status,
                lr.created_at AS started_at,lr.settled_at AS completed_at,
                COALESCE(ss.input_tokens,0)::float8 AS input_tokens,
                COALESCE(ss.output_tokens,0)::float8 AS output_tokens,
                COALESCE(ss.cost_microunits,0)::float8 AS cost_microunits,
                CASE WHEN COALESCE(mi.invocations,0)=0 THEN 'unavailable'
                     WHEN mi.unavailable=mi.invocations THEN 'unavailable'
                     WHEN mi.provider_observed=mi.invocations THEN 'provider_observed'
                     ELSE 'estimated' END AS cost_provenance,
                s.created_at,s.last_activity_at
         FROM oao.sessions s
         JOIN oao.threads t ON t.organization_id=s.organization_id AND t.project_id=s.project_id AND t.id=s.thread_id
         JOIN oao.agent_versions v ON v.organization_id=s.organization_id AND v.project_id=s.project_id AND v.id=s.agent_version_id
         JOIN oao.agent_definitions d ON d.organization_id=v.organization_id AND d.project_id=v.project_id AND d.id=v.agent_definition_id
         LEFT JOIN oao.session_summaries ss ON ss.organization_id=s.organization_id AND ss.project_id=s.project_id AND ss.session_id=s.id
         LEFT JOIN LATERAL (
           SELECT r.id,r.state,r.created_at,r.settled_at FROM oao.runs r
           WHERE r.organization_id=s.organization_id AND r.project_id=s.project_id AND r.session_id=s.id
           ORDER BY r.created_at DESC,r.id DESC LIMIT 1
         ) lr ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS invocations,
                  count(*) FILTER (WHERE m.usage_source='unavailable')::int AS unavailable,
                  count(*) FILTER (WHERE m.usage_source='provider_reported')::int AS provider_observed
           FROM oao.model_invocations m JOIN oao.runs r
             ON r.organization_id=m.organization_id AND r.project_id=m.project_id AND r.id=m.run_id
           WHERE r.organization_id=s.organization_id AND r.project_id=s.project_id AND r.session_id=s.id
         ) mi ON true
         WHERE s.organization_id=$1 AND s.project_id=$2 AND s.id=$3`,
        [actor.organizationId, actor.projectId, c.req.param("sessionId")],
      );
      const session = publicValue(result.rows[0]) as
        Readonly<Record<string, unknown>> | undefined;
      if (!session) throw new HttpApiError("not_found", "Session not found");
      const values: unknown[] = [
        actor.organizationId,
        actor.projectId,
        c.req.param("sessionId"),
      ];
      const [
        runs,
        transcript,
        timeline,
        invocations,
        events,
        toolCalls,
        approvals,
        sandboxCommands,
        sandboxes,
        workspaceBackups,
      ] = await Promise.all([
        tx.query(
          `SELECT id,thread_id,session_id,agent_version_id,state,cancellation_requested_at,
                    admitted_at,settled_at,created_at,updated_at
             FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND session_id=$3
             ORDER BY created_at,id`,
          values,
        ),
        tx.query(
          `SELECT m.id,m.thread_id,m.run_id,m.role,m.redacted_content,m.created_at
             FROM oao.messages m JOIN oao.runs r
               ON r.organization_id=m.organization_id AND r.project_id=m.project_id AND r.id=m.run_id
             WHERE r.organization_id=$1 AND r.project_id=$2 AND r.session_id=$3
             ORDER BY m.created_at,m.id`,
          values,
        ),
        tx.query(
          `SELECT e.run_id,e.entry_sequence,e.entry_type,e.started_at,e.completed_at,e.safe_detail
             FROM oao.timeline_entries e JOIN oao.runs r
               ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.id=e.run_id
             WHERE r.organization_id=$1 AND r.project_id=$2 AND r.session_id=$3
             ORDER BY r.created_at,e.entry_sequence`,
          values,
        ),
        tx.query(
          `SELECT m.id,m.run_id,m.attempt,m.provider_key,m.model_key,m.provider_request_id,
                    m.status,m.input_tokens,m.output_tokens,m.cost_microunits,m.usage_source,
                    m.pricing_snapshot,m.provider_route,m.safe_request,m.safe_response,
                    m.started_at,m.completed_at
             FROM oao.model_invocations m JOIN oao.runs r
               ON r.organization_id=m.organization_id AND r.project_id=m.project_id AND r.id=m.run_id
             WHERE r.organization_id=$1 AND r.project_id=$2 AND r.session_id=$3
             ORDER BY m.started_at,m.attempt`,
          values,
        ),
        tx.query(
          `SELECT e.project_position,e.id,e.aggregate_type,e.aggregate_id,e.aggregate_sequence,
                    e.event_kind,e.public_payload,e.occurred_at
             FROM oao.product_events e WHERE e.organization_id=$1 AND e.project_id=$2
               AND (e.aggregate_id=$3 OR e.aggregate_id IN (
                 SELECT r.id FROM oao.runs r WHERE r.organization_id=$1 AND r.project_id=$2 AND r.session_id=$3
               )) ORDER BY e.project_position`,
          values,
        ),
        tx.query(
          `SELECT c.id,c.run_id,c.tool_name,c.owner,c.stage,c.safe_arguments,c.claim_fence,
                    c.lease_expires_at,c.flue_tool_call_ref,c.created_at,c.updated_at
             FROM oao.tool_calls c JOIN oao.runs r
               ON r.organization_id=c.organization_id AND r.project_id=c.project_id AND r.id=c.run_id
             WHERE r.organization_id=$1 AND r.project_id=$2 AND r.session_id=$3
             ORDER BY c.created_at,c.id`,
          values,
        ),
        tx.query(
          `SELECT a.id,a.run_id,a.tool_call_id,a.status,a.summary,a.expires_at,
                    a.resolved_by_principal_id,a.resolved_at,a.created_at
             FROM oao.approvals a JOIN oao.runs r
               ON r.organization_id=a.organization_id AND r.project_id=a.project_id AND r.id=a.run_id
             WHERE r.organization_id=$1 AND r.project_id=$2 AND r.session_id=$3
             ORDER BY a.created_at,a.id`,
          values,
        ),
        tx.query(
          `SELECT c.id,c.run_id,c.state,
                    c.safe_command->>'toolName' AS tool_name,
                    NULLIF(c.safe_command->>'path','') AS path,
                    NULLIF(c.safe_command->>'commandName','') AS command_name,
                    NULLIF(c.safe_command->>'origin','') AS origin,
                    NULLIF(c.safe_command->>'action','') AS action,
                    c.safe_command,c.safe_result,
                    c.created_at,c.started_at,c.completed_at
             FROM oao.sandbox_commands c JOIN oao.runs r
               ON r.organization_id=c.organization_id AND r.project_id=c.project_id AND r.id=c.run_id
             WHERE r.organization_id=$1 AND r.project_id=$2 AND r.session_id=$3
             ORDER BY c.created_at,c.id`,
          values,
        ),
        tx.query(
          `SELECT id,run_id,thread_id,session_id,provider,provider_ref,target_preference,provider_target,
                    state,egress_policy,safe_error,created_at,updated_at,stopped_at
             FROM oao.sandbox_instances WHERE organization_id=$1 AND project_id=$2 AND session_id=$3
             ORDER BY created_at,id`,
          values,
        ),
        tx.query(
          `SELECT b.thread_id,b.session_id,b.last_run_id,p.provider_key,p.display_name,
                  p.provider_type,p.bucket,b.object_key,b.content_length,b.generation,
                  b.backed_up_at,b.last_restored_at
             FROM oao.thread_workspace_backups b
             JOIN oao.project_storage_providers p
               ON p.organization_id=b.organization_id AND p.project_id=b.project_id
              AND p.id=b.storage_provider_id
            WHERE b.organization_id=$1 AND b.project_id=$2 AND b.session_id=$3`,
          values,
        ),
      ]);
      return c.json({
        ...session,
        runs: rows(runs),
        transcript: rows(transcript),
        timeline: rows(timeline),
        pendingWork: [
          ...rows(toolCalls).filter((item) =>
            [
              "caller_pending",
              "caller_claimed",
              "platform_ready",
              "platform_executing",
            ].includes(String((item as Record<string, unknown>).stage)),
          ),
          ...rows(approvals).filter(
            (item) => (item as Record<string, unknown>).status === "pending",
          ),
        ],
        debug: {
          productEvents: rows(events),
          modelInvocations: rows(invocations),
          toolCalls: rows(toolCalls),
          approvals: rows(approvals),
          sandboxCommands: rows(sandboxCommands),
          sandboxes: rows(sandboxes),
          workspaceBackups: rows(workspaceBackups),
        },
      });
    });
  });

  app.get("/v1/projects/:projectId/pending-work", async (c) => {
    const actor = assertProject(c);
    return dependencies.store.transaction(actor, "run:read", async (tx) => {
      const values: unknown[] = [actor.organizationId, actor.projectId];
      const [tools, approvals] = await Promise.all([
        tx.query(
          `SELECT 'tool' AS kind,c.id,c.run_id,r.session_id,t.title,c.tool_name,c.owner,c.stage,
                  c.safe_arguments,c.claim_fence,c.lease_holder_principal_id AS claimed_by,
                  c.lease_expires_at AS expires_at,c.created_at
           FROM oao.tool_calls c JOIN oao.runs r
             ON r.organization_id=c.organization_id AND r.project_id=c.project_id AND r.id=c.run_id
           JOIN oao.threads t ON t.organization_id=r.organization_id AND t.project_id=r.project_id AND t.id=r.thread_id
           WHERE c.organization_id=$1 AND c.project_id=$2
             AND c.stage IN ('caller_pending','caller_claimed','platform_ready','platform_executing')
           ORDER BY c.created_at,c.id`,
          values,
        ),
        tx.query(
          `SELECT 'approval' AS kind,a.id,a.run_id,r.session_id,t.title,a.tool_call_id,
                  a.summary,a.status,a.created_at,a.expires_at
           FROM oao.approvals a JOIN oao.runs r
             ON r.organization_id=a.organization_id AND r.project_id=a.project_id AND r.id=a.run_id
           JOIN oao.threads t ON t.organization_id=r.organization_id AND t.project_id=r.project_id AND t.id=r.thread_id
           WHERE a.organization_id=$1 AND a.project_id=$2 AND a.status='pending'
           ORDER BY a.created_at,a.id`,
          values,
        ),
      ]);
      return c.json({ data: [...rows(tools), ...rows(approvals)] });
    });
  });

  app.get("/v1/projects/:projectId/threads", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(actor, "session:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "created_at",
        3,
      );
      const result = await tx.query(
        `SELECT id,organization_id,project_id,title,created_at FROM oao.threads
         WHERE organization_id=$1 AND project_id=$2${condition.sql}
         ORDER BY created_at DESC,id DESC LIMIT $${3 + condition.values.length}`,
        [actor.organizationId, actor.projectId, ...condition.values, limit + 1],
      );
      return c.json(pagination(rows(result), limit, "createdAt"));
    });
  });

  app.get("/v1/projects/:projectId/threads/:threadId", async (c) => {
    const actor = assertProject(c);
    return dependencies.store.transaction(actor, "session:read", async (tx) => {
      const result = await tx.query(
        `SELECT id,organization_id,project_id,title,created_at FROM oao.threads
         WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
        [actor.organizationId, actor.projectId, c.req.param("threadId")],
      );
      const thread = publicValue(result.rows[0]);
      if (!thread) throw new HttpApiError("not_found", "Thread not found");
      return c.json(thread);
    });
  });

  const createRun = async (c: ApiContext, resumeRunId?: string) => {
    const actor = assertProject(c);
    const body = await readJsonObject(c.req.raw);
    const idem = idempotencyKey(c.req.raw);
    const redactedInput = requiredString(
      body.message ?? body.redactedInput,
      body.message === undefined ? "redactedInput" : "message",
      100_000,
    );
    const submittedSessionId = resumeRunId
      ? undefined
      : requiredString(c.req.param("sessionId"), "sessionId", 50);
    return dependencies.store.transaction(actor, "run:create", async (tx) => {
      const response = await dependencies.store.idempotent(tx, actor, {
        scope: resumeRunId
          ? `POST:/runs/${resumeRunId}/resume`
          : `POST:/sessions/${submittedSessionId}/runs`,
        key: idem,
        hash: requestHash(body),
        status: 202,
        execute: async () => {
          let sessionId = submittedSessionId;
          let parent:
            | {
                readonly thread_id: string;
                readonly agent_version_id: string;
                readonly latest_run_state?: string | null;
              }
            | undefined;
          if (resumeRunId) {
            const previous = await tx.query<{
              state: string;
              session_id: string;
              thread_id: string;
              agent_version_id: string;
            }>(
              `SELECT state,session_id,thread_id,agent_version_id FROM oao.runs
               WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
              [actor.organizationId, actor.projectId, resumeRunId],
            );
            const prior = previous.rows[0];
            if (!prior) throw new HttpApiError("not_found", "Run not found");
            if (
              !["completed", "failed", "cancelled", "timed_out"].includes(
                prior.state,
              )
            )
              throw new HttpApiError(
                "conflict",
                "Only a settled run can be resumed",
              );
            sessionId = prior.session_id;
            parent = prior;
          } else {
            const session = await tx.query<{
              thread_id: string;
              agent_version_id: string;
              latest_run_state: string | null;
            }>(
              `SELECT s.thread_id,s.agent_version_id,
                      (SELECT r.state::text FROM oao.runs r
                       WHERE r.organization_id=s.organization_id AND r.project_id=s.project_id
                         AND r.session_id=s.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS latest_run_state
               FROM oao.sessions s WHERE s.organization_id=$1 AND s.project_id=$2 AND s.id=$3 FOR UPDATE`,
              [actor.organizationId, actor.projectId, sessionId],
            );
            parent = session.rows[0];
            if (
              parent?.latest_run_state &&
              !["completed", "failed", "cancelled", "timed_out"].includes(
                parent.latest_run_state,
              )
            )
              throw new HttpApiError(
                "conflict",
                "The session's latest run must settle before another message",
              );
          }
          if (!parent || !sessionId)
            throw new HttpApiError("not_found", "Session not found");
          const runId = randomUUID();
          const messageId = randomUUID();
          const result = await tx.query(
            `WITH run AS (
               INSERT INTO oao.runs
                 (organization_id,project_id,id,thread_id,session_id,agent_version_id,created_by_principal_id,idempotency_key,input_public)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
             ), message AS (
               INSERT INTO oao.messages
                 (organization_id,project_id,id,thread_id,run_id,role,redacted_content)
               VALUES ($1,$2,$10,$4,$3,'user',$11)
             )
             UPDATE oao.sessions SET last_activity_at=clock_timestamp()
             WHERE organization_id=$1 AND project_id=$2 AND id=$5
             RETURNING (SELECT row_to_json(run) FROM run) AS run`,
            [
              actor.organizationId,
              actor.projectId,
              runId,
              parent.thread_id,
              sessionId,
              parent.agent_version_id,
              actor.id,
              idem,
              { message: redactedInput },
              messageId,
              redactedInput,
            ],
          );
          await dependencies.store.appendEvent(tx, actor, {
            aggregateType: "run",
            aggregateId: runId,
            kind: "run.created",
            payload: { state: "queued", sessionId },
          });
          await dependencies.store.appendEvent(tx, actor, {
            aggregateType: "thread",
            aggregateId: parent.thread_id,
            kind: "message.created",
            payload: { messageId, runId, role: "user" },
          });
          await dependencies.store.appendAudit(tx, actor, {
            action: resumeRunId ? "run.resumed" : "run.created",
            resourceType: "run",
            resourceId: runId,
            detail: resumeRunId ? { previousRunId: resumeRunId } : {},
          });
          await dependencies.runtimeCommands.enqueue(tx, {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            runId,
            kind: "admit",
            payload: { reason: resumeRunId ? "api_resume" : "api_submit" },
          });
          return publicValue(result.rows[0]?.run) as Readonly<
            Record<string, unknown>
          >;
        },
      });
      c.header("idempotency-replayed", String(response.replayed));
      return c.json(response.body, 202);
    });
  };

  app.post("/v1/projects/:projectId/sessions/:sessionId/runs", (c) =>
    createRun(c),
  );
  app.post("/v1/projects/:projectId/runs/:runId/resume", (c) =>
    createRun(c, c.req.param("runId")),
  );

  app.get("/v1/projects/:projectId/runs", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(actor, "run:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "created_at",
        3,
      );
      const result = await tx.query(
        `SELECT id,organization_id,project_id,thread_id,session_id,agent_version_id,created_by_principal_id,state,cancellation_requested_at,admitted_at,settled_at,created_at,updated_at
         FROM oao.runs WHERE organization_id=$1 AND project_id=$2${condition.sql}
         ORDER BY created_at DESC,id DESC LIMIT $${3 + condition.values.length}`,
        [actor.organizationId, actor.projectId, ...condition.values, limit + 1],
      );
      return c.json(pagination(rows(result), limit, "createdAt"));
    });
  });

  app.get("/v1/projects/:projectId/runs/:runId", async (c) => {
    const actor = assertProject(c);
    return dependencies.store.transaction(actor, "run:read", async (tx) => {
      const result = await tx.query(
        `SELECT id,organization_id,project_id,thread_id,session_id,agent_version_id,created_by_principal_id,state,cancellation_requested_at,admitted_at,settled_at,created_at,updated_at
         FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
        [actor.organizationId, actor.projectId, c.req.param("runId")],
      );
      const run = publicValue(result.rows[0]);
      if (!run) throw new HttpApiError("not_found", "Run not found");
      return c.json(run);
    });
  });

  app.post("/v1/projects/:projectId/runs/:runId/cancel", async (c) => {
    const actor = assertProject(c);
    const idem = idempotencyKey(c.req.raw);
    return dependencies.store.transaction(actor, "run:cancel", async (tx) => {
      const response = await dependencies.store.idempotent(tx, actor, {
        scope: `POST:/runs/${c.req.param("runId")}/cancel`,
        key: idem,
        hash: requestHash({ runId: c.req.param("runId") }),
        status: 202,
        execute: async () => {
          const result = await tx.query<{ outcome: string }>(
            "SELECT oao.request_run_cancellation($1,$2,$3) AS outcome",
            [actor.organizationId, actor.projectId, c.req.param("runId")],
          );
          const outcome = result.rows[0]?.outcome ?? "already_settled";
          await dependencies.store.appendEvent(tx, actor, {
            aggregateType: "run",
            aggregateId: c.req.param("runId"),
            kind: "run.cancellation_requested",
            payload: { outcome },
          });
          await dependencies.store.appendAudit(tx, actor, {
            action: "run.cancellation_requested",
            resourceType: "run",
            resourceId: c.req.param("runId"),
            detail: { outcome },
          });
          await dependencies.runtimeCommands.enqueue(tx, {
            organizationId: actor.organizationId,
            projectId: actor.projectId,
            runId: c.req.param("runId"),
            kind: "cancel",
            payload: { reason: "api_cancel" },
          });
          const current = await tx.query(
            `SELECT id,organization_id,project_id,thread_id,session_id,agent_version_id,created_by_principal_id,state,cancellation_requested_at,
                    admitted_at,created_at,updated_at
             FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
            [actor.organizationId, actor.projectId, c.req.param("runId")],
          );
          return publicValue(current.rows[0]) as Readonly<
            Record<string, unknown>
          >;
        },
      });
      c.header("idempotency-replayed", String(response.replayed));
      return c.json(response.body, 202);
    });
  });

  app.get("/v1/projects/:projectId/runs/:runId/messages", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    return dependencies.store.transaction(actor, "run:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "created_at",
        4,
      );
      const result = await tx.query(
        `SELECT id,organization_id,project_id,thread_id,run_id,role,redacted_content,created_at FROM oao.messages
         WHERE organization_id=$1 AND project_id=$2 AND run_id=$3${condition.sql}
         ORDER BY created_at DESC,id DESC LIMIT $${4 + condition.values.length}`,
        [
          actor.organizationId,
          actor.projectId,
          c.req.param("runId"),
          ...condition.values,
          limit + 1,
        ],
      );
      return c.json(pagination(rows(result), limit, "createdAt"));
    });
  });

  app.get("/v1/projects/:projectId/runs/:runId/timeline", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const after = c.req.query("cursor") ?? "0";
    if (!/^\d+$/u.test(after))
      throw new HttpApiError(
        "bad_request",
        "timeline cursor must be a sequence",
      );
    return dependencies.store.transaction(actor, "run:read", async (tx) => {
      const result = await tx.query(
        `SELECT entry_sequence,entry_type,started_at,completed_at,safe_detail
         FROM oao.timeline_entries WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
           AND entry_sequence>$4 ORDER BY entry_sequence LIMIT $5`,
        [
          actor.organizationId,
          actor.projectId,
          c.req.param("runId"),
          after,
          limit + 1,
        ],
      );
      const data = rows(result);
      const hasMore = data.length > limit;
      const page = hasMore ? data.slice(0, limit) : data;
      return c.json({
        data: page,
        pageInfo: {
          hasMore,
          nextCursor: hasMore
            ? String((page.at(-1) as Record<string, unknown>).entrySequence)
            : null,
        },
      });
    });
  });

  app.get("/v1/projects/:projectId/tool-calls", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    const runId = c.req.query("runId") ?? null;
    return dependencies.store.transaction(actor, "run:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "created_at",
        4,
      );
      const result = await tx.query(
        `SELECT id,organization_id,project_id,run_id,tool_name,owner,stage,safe_arguments,claim_fence,lease_expires_at,created_at,updated_at
         FROM oao.tool_calls WHERE organization_id=$1 AND project_id=$2
           AND ($3::uuid IS NULL OR run_id=$3)${condition.sql}
         ORDER BY created_at DESC,id DESC LIMIT $${4 + condition.values.length}`,
        [
          actor.organizationId,
          actor.projectId,
          runId,
          ...condition.values,
          limit + 1,
        ],
      );
      return c.json(pagination(rows(result), limit, "createdAt"));
    });
  });

  app.post("/v1/projects/:projectId/tool-calls/:toolCallId/claim", (c) =>
    leaseAction(c, dependencies, "claim"),
  );
  app.post("/v1/projects/:projectId/tool-calls/:toolCallId/renew", (c) =>
    leaseAction(c, dependencies, "renew"),
  );
  app.post("/v1/projects/:projectId/tool-calls/:toolCallId/release", (c) =>
    leaseAction(c, dependencies, "release"),
  );

  app.post(
    "/v1/projects/:projectId/tool-calls/:toolCallId/result",
    async (c) => {
      const actor = assertProject(c);
      const body = await readJsonObject(c.req.raw);
      const idem = idempotencyKey(c.req.raw);
      const fence = parseFence(body.fence);
      const safeResult = body.safeResult;
      if (
        !safeResult ||
        Array.isArray(safeResult) ||
        typeof safeResult !== "object"
      )
        throw new HttpApiError("bad_request", "safeResult must be an object");
      assertPublicPayload(safeResult as Readonly<Record<string, PublicValue>>);
      return dependencies.store.transaction(
        actor,
        "tool_call:submit",
        async (tx) => {
          const result = await tx.query<{ outcome: string }>(
            "SELECT oao.submit_tool_result($1,$2,$3,$4,$5,$6,$7,$8) AS outcome",
            [
              actor.organizationId,
              actor.projectId,
              c.req.param("toolCallId"),
              actor.id,
              fence.toString(),
              idem,
              requestHash(safeResult),
              safeResult,
            ],
          );
          const outcome = result.rows[0]?.outcome ?? "submitted";
          if (outcome === "submitted") {
            await dependencies.store.appendEvent(tx, actor, {
              aggregateType: "tool_call",
              aggregateId: c.req.param("toolCallId"),
              kind: "tool_call.result_submitted",
              payload: { outcome, fence: fence.toString() },
            });
            await dependencies.store.appendAudit(tx, actor, {
              action: "tool_call.result_submitted",
              resourceType: "tool_call",
              resourceId: c.req.param("toolCallId"),
              detail: { outcome, fence: fence.toString() },
            });
          }
          return c.json({ outcome }, 202);
        },
      );
    },
  );

  app.get("/v1/projects/:projectId/approvals", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeListCursor(c.req.query("cursor"));
    const runId = c.req.query("runId") ?? null;
    return dependencies.store.transaction(actor, "run:read", async (tx) => {
      const condition = dependencies.store.cursorCondition(
        cursor,
        "created_at",
        4,
      );
      const result = await tx.query(
        `SELECT id,organization_id,project_id,run_id,tool_call_id,status,summary,expires_at,resolved_by_principal_id,resolved_at,created_at
         FROM oao.approvals WHERE organization_id=$1 AND project_id=$2
           AND ($3::uuid IS NULL OR run_id=$3)${condition.sql}
         ORDER BY created_at DESC,id DESC LIMIT $${4 + condition.values.length}`,
        [
          actor.organizationId,
          actor.projectId,
          runId,
          ...condition.values,
          limit + 1,
        ],
      );
      return c.json(pagination(rows(result), limit, "createdAt"));
    });
  });

  app.post(
    "/v1/projects/:projectId/approvals/:approvalId/decision",
    async (c) => {
      const actor = assertProject(c);
      const body = await readJsonObject(c.req.raw);
      const idem = idempotencyKey(c.req.raw);
      const status = requiredString(body.status, "status", 20);
      if (status !== "approved" && status !== "denied")
        throw new HttpApiError(
          "bad_request",
          "status must be approved or denied",
        );
      const note = optionalString(body.note, "note", 2_000) ?? "";
      return dependencies.store.transaction(
        actor,
        "approval:resolve",
        async (tx) => {
          const response = await dependencies.store.idempotent(tx, actor, {
            scope: `POST:/approvals/${c.req.param("approvalId")}/decision`,
            key: idem,
            hash: requestHash(body),
            status: 200,
            execute: async () => {
              const result = await tx.query(
                `SELECT (resolved).*
             FROM (SELECT oao.resolve_approval($1,$2,$3,$4,$5,$6) AS resolved) q`,
                [
                  actor.organizationId,
                  actor.projectId,
                  c.req.param("approvalId"),
                  status,
                  actor.id,
                  note,
                ],
              );
              await dependencies.store.appendEvent(tx, actor, {
                aggregateType: "approval",
                aggregateId: c.req.param("approvalId"),
                kind: "approval.resolved",
                payload: { status },
              });
              await dependencies.store.appendAudit(tx, actor, {
                action: "approval.resolved",
                resourceType: "approval",
                resourceId: c.req.param("approvalId"),
                detail: { status },
              });
              return publicValue(result.rows[0]) as Readonly<
                Record<string, unknown>
              >;
            },
          });
          c.header("idempotency-replayed", String(response.replayed));
          return c.json(response.body);
        },
      );
    },
  );

  app.get("/v1/projects/:projectId/audit", async (c) => {
    const actor = assertProject(c);
    const limit = parseLimit(c.req.query("limit"));
    const after = c.req.query("after") ?? c.req.query("cursor") ?? "0";
    if (!/^\d+$/u.test(after))
      throw new HttpApiError("bad_request", "after must be a sequence");
    return dependencies.store.transaction(actor, "audit:read", async (tx) => {
      const result = await tx.query(
        `SELECT sequence,id,principal_id,action,resource_type,resource_id,safe_detail,occurred_at,
                encode(previous_hash,'hex') AS previous_hash,encode(entry_hash,'hex') AS entry_hash
         FROM oao.audit_entries WHERE organization_id=$1 AND project_id=$2 AND sequence>$3
         ORDER BY sequence LIMIT $4`,
        [actor.organizationId, actor.projectId, after, limit + 1],
      );
      const data = rows(result);
      const hasMore = data.length > limit;
      const page = hasMore ? data.slice(0, limit) : data;
      return c.json({
        data: page,
        pageInfo: {
          hasMore,
          nextCursor: hasMore
            ? String((page.at(-1) as Record<string, unknown>).sequence)
            : null,
        },
      });
    });
  });

  app.post("/v1/projects/:projectId/audit/export", async (c) => {
    const actor = assertProject(c);
    if (!dependencies.artifacts)
      throw new HttpApiError("conflict", "Artifact storage is not configured");
    const body = await readJsonObject(c.req.raw);
    const idem = idempotencyKey(c.req.raw);
    return dependencies.store.transaction(actor, "audit:read", async (tx) => {
      const response = await dependencies.store.idempotent(tx, actor, {
        scope: "POST:/audit/export",
        key: idem,
        hash: requestHash(body),
        status: 201,
        execute: async () => {
          const result = await tx.query(
            `SELECT sequence,id,principal_id,action,resource_type,resource_id,safe_detail,occurred_at,
                    encode(previous_hash,'hex') AS previous_hash,encode(entry_hash,'hex') AS entry_hash
             FROM oao.audit_entries WHERE organization_id=$1 AND project_id=$2 ORDER BY sequence`,
            [actor.organizationId, actor.projectId],
          );
          const bytes = new TextEncoder().encode(
            `${rows(result)
              .map((entry) => JSON.stringify(entry))
              .join("\n")}\n`,
          );
          const artifact = await dependencies.artifacts!.put({
            tenant: {
              organizationId: actor.organizationId,
              projectId: actor.projectId,
            },
            key: `audit/${actor.id}/${encodeURIComponent(idem)}.ndjson`,
            bytes,
            contentType: "application/x-ndjson",
          });
          await dependencies.store.appendAudit(tx, actor, {
            action: "audit.exported",
            resourceType: "audit_export",
            resourceId: artifact.ref,
            detail: {
              contentType: "application/x-ndjson",
              entryCount: result.rowCount ?? 0,
            },
          });
          return {
            artifactRef: artifact.ref,
            contentType: "application/x-ndjson",
          };
        },
      });
      c.header("idempotency-replayed", String(response.replayed));
      return c.json(response.body, 201);
    });
  });
}

async function leaseAction(
  c: ApiContext,
  dependencies: ApiDependencies,
  action: "claim" | "renew" | "release",
) {
  const actor = assertProject(c);
  const body = await readJsonObject(c.req.raw);
  const idem = idempotencyKey(c.req.raw);
  const toolCallId = requiredString(
    c.req.param("toolCallId"),
    "toolCallId",
    50,
  );
  const leaseMs = body.leaseMs === undefined ? 30_000 : Number(body.leaseMs);
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000)
    throw new HttpApiError(
      "bad_request",
      "leaseMs must be from 1000 to 300000",
    );
  const fence = action === "claim" ? undefined : parseFence(body.fence);
  return dependencies.store.transaction(
    actor,
    "tool_call:claim",
    async (tx) => {
      const response = await dependencies.store.idempotent(tx, actor, {
        scope: `POST:/tool-calls/${toolCallId}/${action}`,
        key: idem,
        hash: requestHash(body),
        status: 200,
        execute: async () => {
          const sql =
            action === "claim"
              ? "SELECT oao.claim_tool_call($1,$2,$3,$4,($5 || ' milliseconds')::interval) AS fence"
              : action === "renew"
                ? "SELECT oao.renew_tool_call_claim($1,$2,$3,$4,$5,($6 || ' milliseconds')::interval) AS fence"
                : "SELECT oao.release_tool_call_claim($1,$2,$3,$4,$5) AS fence";
          const values =
            action === "claim"
              ? [
                  actor.organizationId,
                  actor.projectId,
                  toolCallId,
                  actor.id,
                  leaseMs,
                ]
              : action === "renew"
                ? [
                    actor.organizationId,
                    actor.projectId,
                    toolCallId,
                    actor.id,
                    fence?.toString(),
                    leaseMs,
                  ]
                : [
                    actor.organizationId,
                    actor.projectId,
                    toolCallId,
                    actor.id,
                    fence?.toString(),
                  ];
          const result = await tx.query<{ fence: string }>(sql, values);
          const returnedFence =
            result.rows[0]?.fence ?? fence?.toString() ?? "0";
          await dependencies.store.appendEvent(tx, actor, {
            aggregateType: "tool_call",
            aggregateId: toolCallId,
            kind: "tool_call.claimed",
            payload: { action, fence: returnedFence },
          });
          await dependencies.store.appendAudit(tx, actor, {
            action: `tool_call.${action}`,
            resourceType: "tool_call",
            resourceId: toolCallId,
            detail: { fence: returnedFence },
          });
          return { fence: returnedFence };
        },
      });
      c.header("idempotency-replayed", String(response.replayed));
      return c.json(response.body);
    },
  );
}

function registerEventRoutes(
  app: Hono<{ Variables: Variables }>,
  dependencies: ApiDependencies,
): void {
  app.get("/v1/projects/:projectId/events", async (c) => {
    const actor = assertProject(c);
    const header = c.req.header("last-event-id");
    const query = c.req.query("cursor");
    let after = 0n;
    if (header || query) {
      try {
        after = decodeEventCursor(header ?? query ?? "");
      } catch {
        throw new HttpApiError("bad_request", "Invalid event cursor");
      }
    }
    const once = c.req.query("once") === "true";
    return streamSSE(c, async (stream) => {
      const deadline = Date.now() + (once ? 0 : 25_000);
      let position = after;
      let wake: (() => void) | undefined;
      let wakePromise = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const unsubscribe = dependencies.notifier
        ? await dependencies.notifier.subscribe(() => wake?.())
        : undefined;
      try {
        do {
          const result = await dependencies.store.transaction(
            actor,
            "run:read",
            (tx) =>
              tx.query(
                `SELECT organization_id,project_id,project_position,id,aggregate_type,aggregate_id,
                      aggregate_sequence,event_kind,public_payload,occurred_at
               FROM oao.product_events WHERE organization_id=$1 AND project_id=$2 AND project_position>$3
               ORDER BY project_position LIMIT 200`,
                [actor.organizationId, actor.projectId, position.toString()],
              ),
          );
          for (const event of result.rows) {
            position = BigInt(event.project_position as string);
            await stream.writeSSE({
              id: encodeEventCursor(position),
              event: String(event.event_kind),
              data: JSON.stringify({
                id: event.id,
                organizationId: event.organization_id,
                projectId: event.project_id,
                aggregateType: event.aggregate_type,
                aggregateId: event.aggregate_id,
                aggregateSequence: Number(event.aggregate_sequence),
                projectPosition: String(event.project_position),
                kind: event.event_kind,
                publicPayload: publicValue(event.public_payload),
                occurredAt: publicValue(event.occurred_at),
              }),
            });
          }
          if (once || Date.now() >= deadline) break;
          await Promise.race([wakePromise, stream.sleep(1_000)]);
          wakePromise = new Promise<void>((resolve) => {
            wake = resolve;
          });
        } while (!stream.aborted);
      } finally {
        await unsubscribe?.();
      }
    });
  });
}
