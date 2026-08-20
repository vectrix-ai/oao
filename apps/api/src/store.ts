import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  AuthorizationAction,
  AuthorizationScope,
  Principal,
  PrincipalId,
  PublicValue,
} from "@oao/domain";
import { assertPublicPayload, brandedId, isAuthorized } from "@oao/domain";
import type { PgClient, PgPool, TenantContext } from "@oao/db-postgres";
import { withTenantTransaction } from "@oao/db-postgres";
import { HttpApiError, mapPostgresError } from "./errors.js";
import type { ListCursor } from "./http.js";

export interface ApiKeySecret {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly name: string;
  readonly prefix: string;
  readonly secret: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: string;
  readonly createdAt: string;
}

interface ApiKeyAuthRow {
  organization_id: string;
  project_id: string;
  principal_id: string;
  scopes: string[];
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

  async authenticateApiKey(token: string): Promise<Principal | undefined> {
    const match = /^oao_([a-zA-Z0-9]{10,32})_([a-zA-Z0-9_-]{32,128})$/u.exec(
      token,
    );
    if (!match?.[1] || !match[2]) return undefined;
    const hash = this.keyedHash(token);
    const result = await this.pool.query<ApiKeyAuthRow>(
      "SELECT * FROM oao.authenticate_api_key($1,$2,clock_timestamp())",
      [match[1], hash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: brandedId<PrincipalId>(row.principal_id),
      organizationId: row.organization_id as Principal["organizationId"],
      projectId: row.project_id as Principal["projectId"],
      kind: "api_key",
      subject: `api-key:${match[1]}`,
      scopes: new Set(row.scopes as AuthorizationScope[]),
    };
  }

  async transaction<T>(
    principal: Principal,
    action: AuthorizationAction,
    callback: (transaction: PgClient, tenant: TenantContext) => Promise<T>,
  ): Promise<T> {
    const tenant = {
      organizationId: principal.organizationId,
      projectId: principal.projectId,
    };
    if (!isAuthorized(principal, action, tenant))
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
    const detail = input.detail ?? {};
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
    },
  ): Promise<ApiKeySecret> {
    const id = randomUUID();
    const principalId = randomUUID();
    const prefix = randomBytes(8).toString("hex");
    const token = `oao_${prefix}_${randomBytes(32).toString("base64url")}`;
    const created = await transaction.query<{ created_at: Date }>(
      `WITH principal AS (
         INSERT INTO oao.principals
           (organization_id,project_id,id,kind,subject,scopes)
         VALUES ($1,$2,$3,'api_key',$4,$5) RETURNING id
       )
       INSERT INTO oao.api_keys
         (organization_id,project_id,id,principal_id,name,key_prefix,key_hash,scopes,created_by_principal_id,expires_at)
       VALUES ($1,$2,$6,$3,$7,$8,$9,$5,$10,$11)
       RETURNING created_at`,
      [
        principal.organizationId,
        principal.projectId,
        principalId,
        `api-key:${id}`,
        input.scopes,
        id,
        input.name,
        prefix,
        this.keyedHash(token),
        principal.id,
        input.expiresAt ?? null,
      ],
    );
    return {
      id,
      organizationId: principal.organizationId,
      projectId: principal.projectId,
      name: input.name,
      prefix,
      secret: token,
      scopes: input.scopes,
      ...(input.expiresAt ? { expiresAt: input.expiresAt.toISOString() } : {}),
      createdAt:
        created.rows[0]?.created_at.toISOString() ?? new Date().toISOString(),
    };
  }

  cursorCondition(
    cursor: ListCursor | undefined,
    timestampColumn: string,
    firstParameter: number,
  ): { readonly sql: string; readonly values: readonly unknown[] } {
    if (!cursor) return { sql: "", values: [] };
    return {
      sql: ` AND (${timestampColumn},id) < ($${firstParameter}::timestamptz,$${firstParameter + 1}::uuid)`,
      values: [cursor.timestamp, cursor.id],
    };
  }

  private keyedHash(token: string): Uint8Array {
    return createHmac("sha256", this.apiKeyPepper).update(token).digest();
  }
}
