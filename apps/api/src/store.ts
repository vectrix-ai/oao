import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  AuthorizationAction,
  AuthorizationScope,
  Principal,
  PrincipalId,
  PublicValue,
} from "@oao/domain";
import { assertPublicPayload, brandedId, isAuthorized } from "@oao/domain";
import type {
  PgClient,
  PgPool,
  TenantContext,
  TenantTransactionOptions,
} from "@oao/db-postgres";
import { withTenantTransaction } from "@oao/db-postgres";
import { HttpApiError, mapPostgresError } from "./errors.js";
import type { ListCursor } from "./http.js";

export interface ApiKeySecret {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly prefix: string;
  readonly secret: string;
  readonly scopes: readonly string[];
  /** Present when the key works only inside this project. */
  readonly projectId?: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
}

interface ApiKeyAuthRow {
  organization_id: string;
  project_id: string;
  principal_id: string;
  subject: string;
  scopes: string[];
  project_restricted: boolean;
}

export class PostgresApiStore {
  constructor(
    readonly pool: PgPool,
    private readonly apiKeyPepper: string,
  ) {
    if (apiKeyPepper.length < 16)
      throw new Error("API key pepper must be at least 16 characters");
  }

  async ready(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: number }>(
        "SELECT 1 AS ready FROM public.oao_schema_migrations WHERE name = '0003_api_auth.sql'",
      );
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }

  async authenticateApiKey(
    token: string,
    requestedProjectId?: string,
  ): Promise<Principal | undefined> {
    const match = /^oao_([a-zA-Z0-9]{10,32})_([a-zA-Z0-9_-]{32,128})$/u.exec(
      token,
    );
    if (!match?.[1] || !match[2]) return undefined;
    const hash = this.keyedHash(token);
    const result = await this.pool.query<ApiKeyAuthRow>(
      "SELECT * FROM oao.authenticate_api_key($1,$2,$3,clock_timestamp())",
      [match[1], hash, requestedProjectId ?? null],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: brandedId<PrincipalId>(row.principal_id),
      organizationId: row.organization_id as Principal["organizationId"],
      projectId: row.project_id as Principal["projectId"],
      kind: "api_key",
      subject: row.subject,
      scopes: new Set(row.scopes as AuthorizationScope[]),
      ...(row.project_restricted ? { projectRestricted: true } : {}),
    };
  }

  /**
   * Resolves a run token minted by the runtime worker for an agent's OAO
   * tool. The principal is the run's creator, limited to the run's project
   * and to the scopes both the agent version and the creator hold now.
   */
  async authenticateRunToken(token: string): Promise<Principal | undefined> {
    if (!/^oao_run_[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    const result = await this.pool.query<{
      organization_id: string;
      project_id: string;
      principal_id: string;
      principal_kind: Principal["kind"];
      subject: string;
      scopes: string[];
      run_id: string;
    }>("SELECT * FROM oao.authenticate_run_token($1,clock_timestamp())", [
      createHash("sha256").update(token).digest(),
    ]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: brandedId<PrincipalId>(row.principal_id),
      organizationId: row.organization_id as Principal["organizationId"],
      projectId: row.project_id as Principal["projectId"],
      kind: row.principal_kind,
      subject: row.subject,
      scopes: new Set(row.scopes as AuthorizationScope[]),
      projectRestricted: true,
      actingRunId: row.run_id,
    };
  }

  /**
   * Resolves the human principal provisioned for a subject inside another
   * project of the same organization, or undefined when the subject has no
   * membership there. Backs active-project switching.
   */
  async resolveProjectPrincipal(
    organizationId: Principal["organizationId"],
    projectId: string,
    subject: string,
    iapSource?: Principal,
  ): Promise<Principal | undefined> {
    if (iapSource) {
      const result = await withTenantTransaction(this.pool, iapSource, (tx) =>
        tx.query<{ id: string; subject: string; scopes: string[] }>(
          "SELECT * FROM oao.resolve_iap_project_member($1,$2,$3,$4)",
          [organizationId, iapSource.projectId, iapSource.id, projectId],
        ),
      );
      const row = result.rows[0];
      return row
        ? {
            id: brandedId<PrincipalId>(row.id),
            organizationId,
            projectId: projectId as Principal["projectId"],
            kind: "human",
            subject: row.subject,
            scopes: new Set(row.scopes as AuthorizationScope[]),
          }
        : undefined;
    }
    const result = await withTenantTransaction(
      this.pool,
      {
        organizationId,
        projectId: projectId as Principal["projectId"],
      },
      (transaction) =>
        transaction.query<{ id: string; scopes: string[] }>(
          `SELECT p.id,p.scopes FROM oao.principals p
           JOIN oao.project_members m
             ON m.organization_id=p.organization_id
            AND m.project_id=p.project_id AND m.principal_id=p.id
           WHERE p.organization_id=$1 AND p.project_id=$2
             AND p.kind='human' AND p.subject=$3`,
          [organizationId, projectId, subject],
        ),
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: brandedId<PrincipalId>(row.id),
      organizationId,
      projectId: projectId as Principal["projectId"],
      kind: "human",
      subject,
      scopes: new Set(row.scopes as AuthorizationScope[]),
    };
  }

  async transaction<T>(
    principal: Principal,
    action: AuthorizationAction | readonly AuthorizationAction[] | undefined,
    callback: (transaction: PgClient, tenant: TenantContext) => Promise<T>,
    options: TenantTransactionOptions = {},
  ): Promise<T> {
    const tenant = {
      organizationId: principal.organizationId,
      projectId: principal.projectId,
    };
    const actions =
      action === undefined ? [] : Array.isArray(action) ? action : [action];
    if (actions.some((required) => !isAuthorized(principal, required, tenant)))
      throw new HttpApiError("forbidden", "Principal lacks the required scope");
    try {
      return await withTenantTransaction(
        this.pool,
        tenant,
        async (transaction) => {
          if (principal.kind === "human") {
            const membership = await transaction.query(
              `SELECT 1 FROM oao.project_members
             WHERE organization_id=$1 AND project_id=$2 AND principal_id=$3`,
              [principal.organizationId, principal.projectId, principal.id],
            );
            if (!membership.rowCount)
              throw new HttpApiError(
                "forbidden",
                "Project membership is required",
              );
          }
          return callback(transaction, tenant);
        },
        options,
      );
    } catch (error) {
      mapPostgresError(error);
    }
  }

  async appendAudit(
    transaction: PgClient,
    principal: Principal,
    input: {
      readonly action: string;
      readonly resourceType: string;
      readonly resourceId: string;
      readonly detail?: Readonly<Record<string, PublicValue>>;
    },
  ): Promise<void> {
    // An agent acting through a run token is recorded beside the principal
    // it acts for.
    const detail = principal.actingRunId
      ? { ...input.detail, viaRunId: principal.actingRunId }
      : (input.detail ?? {});
    assertPublicPayload(detail);
    await transaction.query(
      "SELECT oao.append_audit_entry($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())",
      [
        principal.organizationId,
        principal.projectId,
        randomUUID(),
        principal.id,
        input.action,
        input.resourceType,
        input.resourceId,
        detail,
      ],
    );
  }

  async appendEvent(
    transaction: PgClient,
    principal: Principal,
    input: {
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly kind: string;
      readonly payload?: Readonly<Record<string, PublicValue>>;
    },
  ): Promise<void> {
    const payload = input.payload ?? {};
    assertPublicPayload(payload);
    await transaction.query(
      "SELECT oao.append_product_event($1,$2,$3,$4,$5,$6,$7,clock_timestamp())",
      [
        principal.organizationId,
        principal.projectId,
        randomUUID(),
        input.aggregateType,
        input.aggregateId,
        input.kind,
        payload,
      ],
    );
  }

  /**
   * The saved response of a request that already completed under this
   * idempotency key, without claiming it. Lets a route that needs network
   * work before its write transaction replay a completed request first.
   */
  async completedIdempotentResponse<T>(
    transaction: PgClient,
    principal: Principal,
    input: {
      readonly scope: string;
      readonly method?: "POST" | "PATCH" | "DELETE";
      readonly key: string;
      readonly hash: Uint8Array;
    },
  ): Promise<{ readonly status: number; readonly body: T } | undefined> {
    const result = await transaction.query<{
      request_hash: Buffer;
      status_code: number | null;
      response_public: T | null;
    }>(
      `SELECT request_hash,status_code,response_public
         FROM oao.api_request_idempotency
        WHERE organization_id=$1 AND project_id=$2 AND principal_id=$3
          AND http_method=$4 AND route_key=$5 AND idempotency_key=$6
          AND completed_at IS NOT NULL`,
      [
        principal.organizationId,
        principal.projectId,
        principal.id,
        input.method ?? "POST",
        input.scope,
        input.key,
      ],
    );
    const row = result.rows[0];
    if (!row || row.status_code === null || row.response_public === null)
      return undefined;
    if (!row.request_hash.equals(Buffer.from(input.hash)))
      throw new HttpApiError(
        "bad_request",
        "idempotency key reused with different request",
      );
    return { status: row.status_code, body: row.response_public };
  }

  async idempotent<T extends Readonly<Record<string, unknown>>>(
    transaction: PgClient,
    principal: Principal,
    input: {
      readonly scope: string;
      readonly method?: "POST" | "PATCH" | "DELETE";
      readonly key: string;
      readonly hash: Uint8Array;
      readonly status: number;
      readonly execute: () => Promise<T>;
    },
  ): Promise<{
    readonly status: number;
    readonly body: T;
    readonly replayed: boolean;
  }> {
    const claim = await transaction.query<{ outcome: "claimed" | "replayed" }>(
      "SELECT oao.claim_api_request_idempotency($1,$2,$3,$4,$5,$6,$7,clock_timestamp() + interval '24 hours') AS outcome",
      [
        principal.organizationId,
        principal.projectId,
        principal.id,
        input.method ?? "POST",
        input.scope,
        input.key,
        input.hash,
      ],
    );
    if (claim.rows[0]?.outcome === "replayed") {
      const replay = await transaction.query<{
        status_code: number;
        response_public: T;
      }>(
        `SELECT status_code,response_public FROM oao.api_request_idempotency
         WHERE organization_id=$1 AND project_id=$2 AND principal_id=$3
           AND http_method=$4 AND route_key=$5 AND idempotency_key=$6`,
        [
          principal.organizationId,
          principal.projectId,
          principal.id,
          input.method ?? "POST",
          input.scope,
          input.key,
        ],
      );
      const row = replay.rows[0];
      if (!row?.response_public)
        throw new HttpApiError("conflict", "Request is still being processed");
      return {
        status: row.status_code,
        body: row.response_public,
        replayed: true,
      };
    }
    const body = await input.execute();
    assertPublicPayload(body as Readonly<Record<string, PublicValue>>);
    await transaction.query(
      "SELECT oao.complete_api_request_idempotency($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NULL)",
      [
        principal.organizationId,
        principal.projectId,
        principal.id,
        input.method ?? "POST",
        input.scope,
        input.key,
        input.hash,
        input.status,
        body,
      ],
    );
    return { status: input.status, body, replayed: false };
  }

  async createApiKey(
    transaction: PgClient,
    principal: Principal,
    input: {
      readonly name: string;
      readonly scopes: readonly string[];
      readonly expiresAt?: Date;
      /** Restricts the key to the creating principal's project. */
      readonly projectRestricted?: boolean;
    },
  ): Promise<ApiKeySecret> {
    const id = randomUUID();
    const prefix = randomBytes(8).toString("hex");
    const token = `oao_${prefix}_${randomBytes(32).toString("base64url")}`;
    const created = await transaction.query<{ created_at: Date }>(
      `INSERT INTO oao.api_keys
         (organization_id,id,name,key_prefix,key_hash,scopes,created_by_principal_id,
          created_by_iap_subject,created_by_api_key_id,expires_at,project_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
         (SELECT identity.provider_subject FROM oao.auth_identities identity
          WHERE identity.organization_id=$1 AND identity.project_id=$9
            AND identity.principal_id=$7 AND identity.provider='iap'),
         (SELECT substring(creator.subject FROM 9)::uuid FROM oao.principals creator
          WHERE creator.organization_id=$1 AND creator.project_id=$9
            AND creator.id=$7 AND creator.kind='api_key'
            AND creator.subject ~ '^api-key:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
         $8,$10)
       RETURNING created_at`,
      [
        principal.organizationId,
        id,
        input.name,
        prefix,
        this.keyedHash(token),
        input.scopes,
        principal.id,
        input.expiresAt ?? null,
        principal.projectId,
        input.projectRestricted ? principal.projectId : null,
      ],
    );
    return {
      id,
      organizationId: principal.organizationId,
      name: input.name,
      prefix,
      secret: token,
      scopes: input.scopes,
      ...(input.projectRestricted ? { projectId: principal.projectId } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt.toISOString() } : {}),
      createdAt:
        created.rows[0]?.created_at.toISOString() ?? new Date().toISOString(),
    };
  }

  cursorCondition(
    cursor: ListCursor | undefined,
    timestampColumn: string,
    firstParameter: number,
    idColumn = "id",
  ): { readonly sql: string; readonly values: readonly unknown[] } {
    if (!cursor) return { sql: "", values: [] };
    return {
      sql: ` AND (${timestampColumn},${idColumn}) < ($${firstParameter}::timestamptz,$${firstParameter + 1}::uuid)`,
      values: [cursor.timestamp, cursor.id],
    };
  }

  private keyedHash(token: string): Uint8Array {
    return createHmac("sha256", this.apiKeyPepper).update(token).digest();
  }
}
