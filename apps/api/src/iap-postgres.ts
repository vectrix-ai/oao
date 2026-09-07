import type { IapIdentity, IapTenantResolver } from "@oao/auth-iap";
import {
  brandedId,
  type AuthorizationScope,
  type Principal,
  type PrincipalId,
} from "@oao/domain";
import type { PgPool } from "@oao/db-postgres";

interface PrincipalRow {
  organization_id: string;
  project_id: string;
  principal_id: string;
  kind: Principal["kind"];
  subject: string;
  scopes: string[];
}

export class PostgresIapTenantResolver implements IapTenantResolver {
  readonly #pool: PgPool;
  readonly #expectedAudience: string;
  readonly #organizationId: string;
  readonly #projectId: string;

  constructor(input: {
    readonly pool: PgPool;
    readonly expectedAudience: string;
    readonly organizationId: string;
    readonly projectId: string;
  }) {
    this.#pool = input.pool;
    this.#expectedAudience = input.expectedAudience;
    this.#organizationId = input.organizationId;
    this.#projectId = input.projectId;
  }

  async resolvePrincipal(
    identity: IapIdentity,
    request?: Request,
  ): Promise<Principal | undefined> {
    const requestedProjectId = request
      ? /^\/v1\/projects\/([0-9a-f-]{36})(?:\/|$)/iu.exec(
          new URL(request.url).pathname,
        )?.[1]
      : undefined;
    const result = await this.#pool.query<PrincipalRow>(
      "SELECT * FROM oao.resolve_iap_principal($1,$2,$3,$4,$5)",
      [
        identity.subject,
        identity.email,
        this.#expectedAudience,
        this.#organizationId,
        requestedProjectId ?? this.#projectId,
      ],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: brandedId<PrincipalId>(row.principal_id),
      organizationId: row.organization_id as Principal["organizationId"],
      projectId: row.project_id as Principal["projectId"],
      kind: row.kind,
      subject: row.subject,
      displayName: identity.email,
      scopes: new Set(row.scopes as AuthorizationScope[]),
    };
  }
}
