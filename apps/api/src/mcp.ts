import { createHash, randomUUID } from "node:crypto";
import {
  canonicalMcpOrigin,
  mcpResourceDestination,
  type CreateMcpCredentialInput,
  type CreateMcpCredentialPolicyInput,
  type CreateMcpServerInput,
  type CreateMcpToolsetInput,
  type McpCredential,
  type McpCredentialDestination,
  type McpCredentialPolicy,
  type McpOAuthClientCredentialsConfig,
  type McpServer,
  type McpToolset,
  type RotateMcpCredentialInput,
} from "@oao/contracts";
import type { Principal } from "@oao/domain";
import type { PgClient } from "@oao/db-postgres";
import {
  McpRemoteError,
  matchesPinnedAuthorization,
  type McpAuthorizationDiscovery,
  type McpConnectionDefinition,
  type McpCredentialMaterial,
  type McpCredentialTestResult,
  type McpDiscoveredTool as RemoteMcpDiscoveredTool,
  type McpOAuthClientCredentialsMaterial,
  type McpRemotePort,
} from "@oao/mcp-remote";
import type { ProviderCredentialCipher } from "@oao/provider-credentials";
import { HttpApiError } from "./errors.js";

// MCP servers, credentials, and credential policies are organization-shared:
// their tables carry no project column and their encrypted secrets bind the
// organization (projectId "" in the credential AAD) so any project of the
// organization can use them.

interface ServerRow {
  id: string;
  organization_id: string;
  server_key: string;
  display_name: string;
  latest_version_id: string;
  version: number;
  endpoint_url: string;
  transport: "streamable_http" | "legacy_sse";
  status: "active" | "deprecated" | "revoked";
  tools: unknown;
  last_discovered_at: Date | null;
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

type CredentialKind =
  "static_bearer" | "api_key_header" | "oauth_client_credentials";

/** The pinned OAuth columns of a credential version; all null for other kinds. */
interface OAuthColumns {
  oauth_issuer: string | null;
  oauth_token_endpoint: string | null;
  oauth_client_id: string | null;
  oauth_token_endpoint_auth_method:
    "client_secret_post" | "client_secret_basic" | null;
  oauth_scope: string | null;
  oauth_resource: string | null;
  oauth_resource_metadata_url: string | null;
  oauth_send_resource: boolean | null;
}

interface CredentialRow extends OAuthColumns {
  id: string;
  organization_id: string;
  credential_key: string;
  display_name: string;
  credential_kind: CredentialKind;
  header_name: string | null;
  destination_origin: string | null;
  destination_path_prefix: string | null;
  credential_fingerprint: string;
  credential_version: number;
  status: "active" | "deprecated" | "revoked";
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface PolicyRow {
  id: string;
  organization_id: string;
  policy_key: string;
  display_name: string;
  latest_version_id: string;
  version: number;
  credential_id: string;
  exact_origin: string;
  path_prefix: string;
  timeout_ms: number;
  maximum_response_bytes: number;
  status: "active" | "deprecated" | "revoked";
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface ToolsetRow {
  id: string;
  organization_id: string;
  project_id: string;
  toolset_key: string;
  display_name: string;
  latest_version_id: string;
  version: number;
  server_version_id: string;
  status: "active" | "deprecated" | "revoked";
  tools: unknown;
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface ConnectionRow extends OAuthColumns {
  endpoint_url: string;
  exact_origin: string;
  path_prefix: string;
  transport: "streamable_http" | "legacy_sse";
  timeout_ms: number;
  maximum_response_bytes: number;
  credential_id: string;
  credential_version_id: string;
  credential_kind: CredentialKind;
  header_name: string | null;
  destination_origin: string | null;
  destination_path_prefix: string | null;
  encrypted_secret: Buffer;
  encryption_nonce: Buffer;
  encryption_tag: Buffer;
  encryption_key_version: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(value)).digest();
}

function timestamp(value: Date): string {
  return value.toISOString();
}

/**
 * The destination a rotated version keeps. A pinned destination never moves:
 * the secret of every later version goes to the same place. A credential
 * stored before destinations existed is pinned by the first rotation that
 * names one.
 */
function rotatedDestination(
  current: {
    readonly destination_origin: string | null;
    readonly destination_path_prefix: string | null;
  },
  requested: McpCredentialDestination | undefined,
): McpCredentialDestination | null {
  const pinned =
    current.destination_origin !== null &&
    current.destination_path_prefix !== null
      ? {
          origin: current.destination_origin,
          pathPrefix: current.destination_path_prefix,
        }
      : null;
  if (!requested) return pinned;
  const destination = {
    origin: canonicalMcpOrigin(requested.origin),
    pathPrefix: requested.pathPrefix,
  };
  if (
    pinned &&
    (pinned.origin !== destination.origin ||
      pinned.pathPrefix !== destination.pathPrefix)
  )
    throw new HttpApiError(
      "bad_request",
      "MCP credential destination is pinned; create a new credential for another destination",
    );
  return destination;
}

/** The OAuth configuration pinned on a version, or null for other kinds. */
function pinnedOAuth(
  row: OAuthColumns,
): McpOAuthClientCredentialsConfig | null {
  if (
    row.oauth_issuer === null ||
    row.oauth_token_endpoint === null ||
    row.oauth_client_id === null ||
    row.oauth_token_endpoint_auth_method === null ||
    row.oauth_scope === null ||
    row.oauth_resource === null ||
    row.oauth_resource_metadata_url === null ||
    row.oauth_send_resource === null
  )
    return null;
  return {
    resource: row.oauth_resource,
    resourceMetadataUrl: row.oauth_resource_metadata_url,
    issuer: row.oauth_issuer,
    tokenEndpoint: row.oauth_token_endpoint,
    clientId: row.oauth_client_id,
    tokenEndpointAuthMethod: row.oauth_token_endpoint_auth_method,
    scope: row.oauth_scope,
    sendResource: row.oauth_send_resource,
  };
}

const OAUTH_VERSION_COLUMNS = `version.oauth_issuer,version.oauth_token_endpoint,
         version.oauth_client_id,version.oauth_token_endpoint_auth_method,
         version.oauth_scope,version.oauth_resource,
         version.oauth_resource_metadata_url,version.oauth_send_resource`;

function oauthValues(
  oauth: McpOAuthClientCredentialsConfig | null,
): readonly unknown[] {
  return [
    oauth?.issuer ?? null,
    oauth?.tokenEndpoint ?? null,
    oauth?.clientId ?? null,
    oauth?.tokenEndpointAuthMethod ?? null,
    oauth?.scope ?? null,
    oauth?.resource ?? null,
    oauth?.resourceMetadataUrl ?? null,
    oauth?.sendResource ?? null,
  ];
}

/**
 * The fingerprint a credential version shows. For OAuth it covers the client
 * secret together with the pinned configuration, so any re-pin changes it.
 */
export function mcpCredentialFingerprint(
  secretFingerprint: string,
  secret: string,
  oauth: McpOAuthClientCredentialsConfig | null,
): string {
  if (!oauth) return secretFingerprint;
  return digest({ clientSecret: secret, ...oauth }).toString("hex");
}

/** Decrypted OAuth material for a version, scoped to its organization. */
function oauthMaterial(
  organizationId: string,
  credentialVersionId: string,
  oauth: McpOAuthClientCredentialsConfig,
  clientSecret: string,
): McpOAuthClientCredentialsMaterial {
  return {
    kind: "oauth_client_credentials",
    organizationId,
    credentialVersionId,
    issuer: oauth.issuer,
    tokenEndpoint: oauth.tokenEndpoint,
    clientId: oauth.clientId,
    clientSecret,
    tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod,
    scope: oauth.scope,
    resource: oauth.resource,
    resourceMetadataUrl: oauth.resourceMetadataUrl,
    sendResource: oauth.sendResource,
  };
}

function server(row: ServerRow): McpServer {
  return {
    id: row.id,
    organizationId: row.organization_id,
    key: row.server_key,
    displayName: row.display_name,
    latestVersionId: row.latest_version_id,
    version: row.version,
    endpointUrl: row.endpoint_url,
    transport: row.transport,
    status: row.status,
    tools: row.tools as McpServer["tools"],
    lastDiscoveredAt: row.last_discovered_at
      ? timestamp(row.last_discovered_at)
      : null,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function credential(row: CredentialRow): McpCredential {
  return {
    id: row.id,
    organizationId: row.organization_id,
    key: row.credential_key,
    displayName: row.display_name,
    kind: row.credential_kind,
    headerName: row.header_name,
    destination:
      row.destination_origin && row.destination_path_prefix
        ? {
            origin: row.destination_origin,
            pathPrefix: row.destination_path_prefix,
          }
        : null,
    oauth: pinnedOAuth(row),
    credentialConfigured: true,
    credentialFingerprint: row.credential_fingerprint.slice(0, 12),
    credentialVersion: row.credential_version,
    status: row.status,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function policy(row: PolicyRow): McpCredentialPolicy {
  return {
    id: row.id,
    organizationId: row.organization_id,
    key: row.policy_key,
    displayName: row.display_name,
    latestVersionId: row.latest_version_id,
    version: row.version,
    credentialId: row.credential_id,
    exactOrigin: row.exact_origin,
    pathPrefix: row.path_prefix,
    timeoutMs: row.timeout_ms,
    maximumResponseBytes: row.maximum_response_bytes,
    status: row.status,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function toolset(row: ToolsetRow): McpToolset {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    key: row.toolset_key,
    displayName: row.display_name,
    latestVersionId: row.latest_version_id,
    version: row.version,
    serverVersionId: row.server_version_id,
    status: row.status,
    tools: row.tools as McpToolset["tools"],
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

const SERVER_SELECT = `
  SELECT resource.id,resource.organization_id,
         resource.server_key,resource.display_name,resource.latest_version_id,
         version.version,version.endpoint_url,version.transport,lifecycle.status,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'name',tool.remote_tool_name,
             'title',tool.title,
             'description',tool.description,
             'inputSchema',tool.input_schema,
             'outputSchema',tool.output_schema,
             'schemaHash',encode(tool.schema_hash,'hex')
           ) ORDER BY tool.remote_tool_name)
           FROM oao.mcp_server_version_tools tool
           WHERE tool.organization_id=version.organization_id
             AND tool.server_version_id=version.id
         ),'[]'::jsonb) AS tools,
         (SELECT max(tool.discovered_at)
            FROM oao.mcp_server_version_tools tool
           WHERE tool.organization_id=version.organization_id
             AND tool.server_version_id=version.id) AS last_discovered_at,
         resource.created_by_principal_id,resource.created_at,resource.updated_at
    FROM oao.mcp_servers resource
    JOIN oao.mcp_server_versions version
      ON version.organization_id=resource.organization_id
     AND version.id=resource.latest_version_id
    JOIN oao.mcp_server_version_lifecycle lifecycle
      ON lifecycle.organization_id=version.organization_id
     AND lifecycle.server_version_id=version.id`;

const CREDENTIAL_SELECT = `
  SELECT resource.id,resource.organization_id,
         resource.credential_key,resource.display_name,resource.credential_kind,
         resource.header_name,version.destination_origin,
         version.destination_path_prefix,version.credential_fingerprint,
         ${OAUTH_VERSION_COLUMNS},
         version.version AS credential_version,lifecycle.status,
         resource.created_by_principal_id,resource.created_at,resource.updated_at
    FROM oao.mcp_credentials resource
    JOIN oao.mcp_credential_versions version
      ON version.organization_id=resource.organization_id
     AND version.id=resource.active_version_id
    JOIN oao.mcp_credential_version_lifecycle lifecycle
      ON lifecycle.organization_id=version.organization_id
     AND lifecycle.credential_version_id=version.id`;

const POLICY_SELECT = `
  SELECT resource.id,resource.organization_id,
         resource.policy_key,resource.display_name,resource.latest_version_id,
         version.version,version.credential_id,version.exact_origin,
         version.path_prefix,version.timeout_ms,version.maximum_response_bytes,
         lifecycle.status,resource.created_by_principal_id,
         resource.created_at,resource.updated_at
    FROM oao.mcp_credential_policies resource
    JOIN oao.mcp_credential_policy_versions version
      ON version.organization_id=resource.organization_id
     AND version.id=resource.latest_version_id
    JOIN oao.mcp_credential_policy_version_lifecycle lifecycle
      ON lifecycle.organization_id=version.organization_id
     AND lifecycle.policy_version_id=version.id`;

const TOOLSET_SELECT = `
  SELECT resource.id,resource.organization_id,resource.project_id,
         resource.toolset_key,resource.display_name,resource.latest_version_id,
         version.version,version.server_version_id,lifecycle.status,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'remoteToolName',selection.remote_tool_name,
             'description',tool.description,
             'inputSchema',tool.input_schema,
             'outputSchema',tool.output_schema,
             'approval',selection.approval
           ) ORDER BY selection.remote_tool_name)
           FROM oao.mcp_toolset_version_tools selection
           JOIN oao.mcp_server_version_tools tool
             ON tool.organization_id=selection.organization_id
            AND tool.server_version_id=selection.server_version_id
            AND tool.remote_tool_name=selection.remote_tool_name
           WHERE selection.organization_id=version.organization_id
             AND selection.project_id=version.project_id
             AND selection.toolset_version_id=version.id
         ),'[]'::jsonb) AS tools,
         resource.created_by_principal_id,resource.created_at,resource.updated_at
    FROM oao.mcp_toolsets resource
    JOIN oao.mcp_toolset_versions version
      ON version.organization_id=resource.organization_id
     AND version.project_id=resource.project_id
     AND version.id=resource.latest_version_id
    JOIN oao.mcp_toolset_version_lifecycle lifecycle
      ON lifecycle.organization_id=version.organization_id
     AND lifecycle.project_id=version.project_id
     AND lifecycle.toolset_version_id=version.id`;

export class McpAdminService {
  constructor(
    private readonly cipher: ProviderCredentialCipher,
    private readonly remote: McpRemotePort,
  ) {}

  async listServers(
    tx: PgClient,
    actor: Principal,
  ): Promise<readonly McpServer[]> {
    const result = await tx.query<ServerRow>(
      `${SERVER_SELECT}
       WHERE resource.organization_id=$1
       ORDER BY resource.created_at DESC,resource.id DESC`,
      [actor.organizationId],
    );
    return result.rows.map(server);
  }

  async createServer(
    tx: PgClient,
    actor: Principal,
    input: CreateMcpServerInput,
  ): Promise<McpServer> {
    const id = randomUUID();
    const versionId = randomUUID();
    await tx.query(
      `INSERT INTO oao.mcp_servers (
         organization_id,id,server_key,display_name,
         created_by_principal_id
       ) VALUES ($1,$2,$3,$4,$5)`,
      [actor.organizationId, id, input.key, input.displayName, actor.id],
    );
    await tx.query(
      `INSERT INTO oao.mcp_server_versions (
         organization_id,id,server_id,version,endpoint_url,transport,
         content_hash,created_by_principal_id
       ) VALUES ($1,$2,$3,1,$4,$5,$6,$7)`,
      [
        actor.organizationId,
        versionId,
        id,
        input.endpointUrl,
        input.transport,
        digest({ endpointUrl: input.endpointUrl, transport: input.transport }),
        actor.id,
      ],
    );
    await tx.query(
      `INSERT INTO oao.mcp_server_version_lifecycle (
         organization_id,server_version_id,updated_by_principal_id
       ) VALUES ($1,$2,$3)`,
      [actor.organizationId, versionId, actor.id],
    );
    await tx.query(
      `UPDATE oao.mcp_servers SET latest_version_id=$3,updated_at=clock_timestamp()
       WHERE organization_id=$1 AND id=$2`,
      [actor.organizationId, id, versionId],
    );
    const result = await tx.query<ServerRow>(
      `${SERVER_SELECT}
       WHERE resource.organization_id=$1 AND resource.id=$2`,
      [actor.organizationId, id],
    );
    return server(result.rows[0]!);
  }

  async listCredentials(
    tx: PgClient,
    actor: Principal,
  ): Promise<readonly McpCredential[]> {
    const result = await tx.query<CredentialRow>(
      `${CREDENTIAL_SELECT}
       WHERE resource.organization_id=$1
       ORDER BY resource.created_at DESC,resource.id DESC`,
      [actor.organizationId],
    );
    return result.rows.map(credential);
  }

  async createCredential(
    tx: PgClient,
    actor: Principal,
    input: CreateMcpCredentialInput,
  ): Promise<McpCredential> {
    const id = randomUUID();
    const versionId = randomUUID();
    const oauth =
      input.kind === "oauth_client_credentials" ? input.oauth : null;
    // An OAuth credential may only reach the resource it was issued for.
    const destination =
      input.kind === "oauth_client_credentials"
        ? mcpResourceDestination(input.oauth.resource)
        : {
            origin: canonicalMcpOrigin(input.destination.origin),
            pathPrefix: input.destination.pathPrefix,
          };
    const encrypted = this.cipher.encrypt(input.secret, {
      organizationId: actor.organizationId,
      providerId: id,
      providerType: "mcp",
      keyVersion: 1,
    });
    await tx.query(
      `INSERT INTO oao.mcp_credentials (
         organization_id,id,credential_key,display_name,
         credential_kind,header_name,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        actor.organizationId,
        id,
        input.key,
        input.displayName,
        input.kind,
        input.kind === "api_key_header" ? input.headerName : null,
        actor.id,
      ],
    );
    await this.insertVersion(tx, actor, {
      id: versionId,
      credentialId: id,
      version: 1,
      kind: input.kind,
      encrypted,
      fingerprint: mcpCredentialFingerprint(
        encrypted.fingerprint,
        input.secret,
        oauth,
      ),
      destination,
      oauth,
    });
    await tx.query(
      `UPDATE oao.mcp_credentials SET active_version_id=$3,updated_at=clock_timestamp()
       WHERE organization_id=$1 AND id=$2`,
      [actor.organizationId, id, versionId],
    );
    const result = await tx.query<CredentialRow>(
      `${CREDENTIAL_SELECT}
       WHERE resource.organization_id=$1 AND resource.id=$2`,
      [actor.organizationId, id],
    );
    return credential(result.rows[0]!);
  }

  /** Inserts an immutable credential version and its active lifecycle. */
  private async insertVersion(
    tx: PgClient,
    actor: Principal,
    version: {
      readonly id: string;
      readonly credentialId: string;
      readonly version: number;
      readonly kind: CredentialKind;
      readonly encrypted: {
        readonly ciphertext: Buffer;
        readonly nonce: Buffer;
        readonly tag: Buffer;
        readonly keyVersion: number;
      };
      readonly fingerprint: string;
      readonly destination: McpCredentialDestination | null;
      readonly oauth: McpOAuthClientCredentialsConfig | null;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO oao.mcp_credential_versions (
         organization_id,id,credential_id,version,credential_kind,
         encrypted_secret,encryption_nonce,encryption_tag,encryption_key_version,
         credential_fingerprint,destination_origin,destination_path_prefix,
         oauth_issuer,oauth_token_endpoint,oauth_client_id,
         oauth_token_endpoint_auth_method,oauth_scope,oauth_resource,
         oauth_resource_metadata_url,oauth_send_resource,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        actor.organizationId,
        version.id,
        version.credentialId,
        version.version,
        version.kind,
        version.encrypted.ciphertext,
        version.encrypted.nonce,
        version.encrypted.tag,
        version.encrypted.keyVersion,
        version.fingerprint,
        version.destination?.origin ?? null,
        version.destination?.pathPrefix ?? null,
        ...oauthValues(version.oauth),
        actor.id,
      ],
    );
    await tx.query(
      `INSERT INTO oao.mcp_credential_version_lifecycle (
         organization_id,credential_version_id,updated_by_principal_id
       ) VALUES ($1,$2,$3)`,
      [actor.organizationId, version.id, actor.id],
    );
  }

  /**
   * The active version a rotation starts from, read before any network work
   * so an OAuth re-pin can be confirmed outside the write transaction.
   */
  async rotationBase(
    tx: PgClient,
    actor: Principal,
    credentialId: string,
  ): Promise<{
    readonly activeVersionId: string;
    readonly kind: CredentialKind;
    readonly oauth: McpOAuthClientCredentialsConfig | null;
  }> {
    const result = await tx.query<
      OAuthColumns & {
        active_version_id: string;
        credential_kind: CredentialKind;
      }
    >(
      `SELECT credential.active_version_id,credential.credential_kind,
              ${OAUTH_VERSION_COLUMNS}
         FROM oao.mcp_credentials credential
         JOIN oao.mcp_credential_versions version
           ON version.organization_id=credential.organization_id
          AND version.id=credential.active_version_id
        WHERE credential.organization_id=$1 AND credential.id=$2`,
      [actor.organizationId, credentialId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpApiError("not_found", "MCP credential not found");
    return {
      activeVersionId: row.active_version_id,
      kind: row.credential_kind,
      oauth: pinnedOAuth(row),
    };
  }

  /**
   * The OAuth configuration a rotation pins: the current one with the
   * requested changes. The resource, and so the destination, never moves.
   */
  rotatedOAuth(
    base: {
      readonly kind: CredentialKind;
      readonly oauth: McpOAuthClientCredentialsConfig | null;
    },
    input: RotateMcpCredentialInput,
  ): {
    readonly oauth: McpOAuthClientCredentialsConfig | null;
    /** True when the issuer, token endpoint, or metadata URL changes. */
    readonly authorizationChanged: boolean;
  } {
    if (base.kind !== "oauth_client_credentials") {
      if (input.oauth)
        throw new HttpApiError(
          "bad_request",
          "Only an OAuth client-credentials credential has an OAuth configuration",
        );
      return { oauth: null, authorizationChanged: false };
    }
    if (input.destination)
      throw new HttpApiError(
        "bad_request",
        "An OAuth credential's destination is its pinned resource",
      );
    if (!base.oauth)
      throw new HttpApiError(
        "conflict",
        "MCP credential has no OAuth configuration",
      );
    const change = input.oauth ?? {};
    const oauth: McpOAuthClientCredentialsConfig = {
      resource: base.oauth.resource,
      resourceMetadataUrl:
        change.resourceMetadataUrl ?? base.oauth.resourceMetadataUrl,
      issuer: change.issuer ?? base.oauth.issuer,
      tokenEndpoint: change.tokenEndpoint ?? base.oauth.tokenEndpoint,
      clientId: change.clientId ?? base.oauth.clientId,
      tokenEndpointAuthMethod:
        change.tokenEndpointAuthMethod ?? base.oauth.tokenEndpointAuthMethod,
      scope: change.scope ?? base.oauth.scope,
      sendResource: change.sendResource ?? base.oauth.sendResource,
    };
    return {
      oauth,
      authorizationChanged:
        oauth.issuer !== base.oauth.issuer ||
        oauth.tokenEndpoint !== base.oauth.tokenEndpoint ||
        oauth.resourceMetadataUrl !== base.oauth.resourceMetadataUrl,
    };
  }

  async rotateCredential(
    tx: PgClient,
    actor: Principal,
    credentialId: string,
    input: RotateMcpCredentialInput,
    expected?: {
      readonly activeVersionId: string;
      readonly oauth: McpOAuthClientCredentialsConfig | null;
    },
  ): Promise<McpCredential> {
    const locked = await tx.query<{
      active_version_id: string;
      credential_kind: CredentialKind;
      version: number;
      destination_origin: string | null;
      destination_path_prefix: string | null;
    }>(
      `SELECT credential.active_version_id,credential.credential_kind,
              version.version,version.destination_origin,
              version.destination_path_prefix
         FROM oao.mcp_credentials credential
         JOIN oao.mcp_credential_versions version
           ON version.organization_id=credential.organization_id
          AND version.id=credential.active_version_id
        WHERE credential.organization_id=$1
          AND credential.id=$2 FOR UPDATE OF credential`,
      [actor.organizationId, credentialId],
    );
    const current = locked.rows[0];
    if (!current)
      throw new HttpApiError("not_found", "MCP credential not found");
    if (expected && expected.activeVersionId !== current.active_version_id)
      throw new HttpApiError(
        "conflict",
        "MCP credential changed during rotation; retry",
      );
    const oauth = expected?.oauth ?? null;
    if (
      (current.credential_kind === "oauth_client_credentials") !==
      (oauth !== null)
    )
      throw new HttpApiError(
        "conflict",
        "MCP credential changed during rotation; retry",
      );
    const destination = oauth
      ? mcpResourceDestination(oauth.resource)
      : rotatedDestination(current, input.destination);
    const version = current.version + 1;
    const versionId = randomUUID();
    const encrypted = this.cipher.encrypt(input.secret, {
      organizationId: actor.organizationId,
      providerId: credentialId,
      providerType: "mcp",
      keyVersion: version,
    });
    await tx.query(
      `UPDATE oao.mcp_credential_version_lifecycle
          SET status='deprecated',updated_by_principal_id=$3,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND credential_version_id=$2`,
      [actor.organizationId, current.active_version_id, actor.id],
    );
    await this.insertVersion(tx, actor, {
      id: versionId,
      credentialId,
      version,
      kind: current.credential_kind,
      encrypted,
      fingerprint: mcpCredentialFingerprint(
        encrypted.fingerprint,
        input.secret,
        oauth,
      ),
      destination,
      oauth,
    });
    await tx.query(
      `UPDATE oao.mcp_credentials SET active_version_id=$3,updated_at=clock_timestamp()
       WHERE organization_id=$1 AND id=$2`,
      [actor.organizationId, credentialId, versionId],
    );
    const result = await tx.query<CredentialRow>(
      `${CREDENTIAL_SELECT}
       WHERE resource.organization_id=$1 AND resource.id=$2`,
      [actor.organizationId, credentialId],
    );
    return credential(result.rows[0]!);
  }

  /**
   * Confirms an OAuth configuration against live, credential-free discovery
   * of its resource, so OAO only ever pins a validated issuer, token
   * endpoint, and metadata URL.
   */
  async confirmOAuthConfiguration(
    oauth: McpOAuthClientCredentialsConfig,
    signal?: AbortSignal,
  ): Promise<void> {
    let discovery: McpAuthorizationDiscovery;
    try {
      discovery = await this.remote.discoverAuthorization(
        oauth.resource,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new HttpApiError(
        "bad_request",
        error instanceof McpRemoteError
          ? `OAuth authorization discovery failed (${error.code})`
          : "OAuth authorization discovery failed",
      );
    }
    if (!matchesPinnedAuthorization(discovery, oauth))
      throw new HttpApiError(
        "bad_request",
        "The OAuth configuration does not match the MCP server's current authorization metadata; run discovery again",
      );
  }

  discoverAuthorization(
    endpointUrl: string,
    signal?: AbortSignal,
  ): Promise<McpAuthorizationDiscovery> {
    return this.remote.discoverAuthorization(endpointUrl, signal);
  }

  /** Decrypts the active version of an active OAuth credential for a test. */
  async loadOAuthCredential(
    tx: PgClient,
    actor: Principal,
    credentialId: string,
  ): Promise<McpOAuthClientCredentialsMaterial> {
    const result = await tx.query<
      OAuthColumns & {
        version_id: string;
        credential_kind: CredentialKind;
        encrypted_secret: Buffer;
        encryption_nonce: Buffer;
        encryption_tag: Buffer;
        encryption_key_version: number;
      }
    >(
      `SELECT version.id AS version_id,credential.credential_kind,
              ${OAUTH_VERSION_COLUMNS},version.encrypted_secret,
              version.encryption_nonce,version.encryption_tag,
              version.encryption_key_version
         FROM oao.mcp_credentials credential
         JOIN oao.mcp_credential_versions version
           ON version.organization_id=credential.organization_id
          AND version.id=credential.active_version_id
         JOIN oao.mcp_credential_version_lifecycle lifecycle
           ON lifecycle.organization_id=version.organization_id
          AND lifecycle.credential_version_id=version.id
          AND lifecycle.status='active'
        WHERE credential.organization_id=$1 AND credential.id=$2`,
      [actor.organizationId, credentialId],
    );
    const row = result.rows[0];
    if (!row)
      throw new HttpApiError("not_found", "Active MCP credential not found");
    const oauth = pinnedOAuth(row);
    if (row.credential_kind !== "oauth_client_credentials" || !oauth)
      throw new HttpApiError(
        "bad_request",
        "Only an OAuth client-credentials credential can be tested",
      );
    const secret = this.cipher.decrypt(
      {
        ciphertext: row.encrypted_secret,
        nonce: row.encryption_nonce,
        tag: row.encryption_tag,
        keyVersion: row.encryption_key_version,
      },
      {
        organizationId: actor.organizationId,
        providerId: credentialId,
        providerType: "mcp",
      },
    );
    return oauthMaterial(actor.organizationId, row.version_id, oauth, secret);
  }

  testCredential(
    material: McpOAuthClientCredentialsMaterial,
    signal?: AbortSignal,
  ): Promise<McpCredentialTestResult> {
    return this.remote.testCredential(material, signal);
  }

  async revokeCredential(
    tx: PgClient,
    actor: Principal,
    credentialId: string,
  ): Promise<McpCredential> {
    const result = await tx.query(
      `UPDATE oao.mcp_credential_version_lifecycle lifecycle
          SET status='revoked',updated_by_principal_id=$3,updated_at=clock_timestamp()
         FROM oao.mcp_credentials credential
        WHERE credential.organization_id=$1
          AND credential.id=$2
          AND lifecycle.organization_id=credential.organization_id
          AND lifecycle.credential_version_id=credential.active_version_id
          AND lifecycle.status<>'revoked'`,
      [actor.organizationId, credentialId, actor.id],
    );
    if (!result.rowCount)
      throw new HttpApiError("not_found", "Active MCP credential not found");
    const revoked = await tx.query<CredentialRow>(
      `${CREDENTIAL_SELECT}
       WHERE resource.organization_id=$1 AND resource.id=$2`,
      [actor.organizationId, credentialId],
    );
    return credential(revoked.rows[0]!);
  }

  async listPolicies(
    tx: PgClient,
    actor: Principal,
  ): Promise<readonly McpCredentialPolicy[]> {
    const result = await tx.query<PolicyRow>(
      `${POLICY_SELECT}
       WHERE resource.organization_id=$1
       ORDER BY resource.created_at DESC,resource.id DESC`,
      [actor.organizationId],
    );
    return result.rows.map(policy);
  }

  async createPolicy(
    tx: PgClient,
    actor: Principal,
    input: CreateMcpCredentialPolicyInput,
  ): Promise<McpCredentialPolicy> {
    // The policy must lie inside the destination pinned on the credential's
    // active version, so a policy can never redirect an existing secret.
    const active = await tx.query<{
      destination_origin: string | null;
      within_destination: boolean | null;
    }>(
      `SELECT version.destination_origin,
              oao.mcp_policy_within_destination(
                $3,$4,version.destination_origin,version.destination_path_prefix
              ) AS within_destination
         FROM oao.mcp_credentials credential
         JOIN oao.mcp_credential_versions version
           ON version.organization_id=credential.organization_id
          AND version.id=credential.active_version_id
         JOIN oao.mcp_credential_version_lifecycle lifecycle
           ON lifecycle.organization_id=version.organization_id
          AND lifecycle.credential_version_id=version.id
          AND lifecycle.status='active'
        WHERE credential.organization_id=$1
          AND credential.id=$2`,
      [
        actor.organizationId,
        input.credentialId,
        input.exactOrigin,
        input.pathPrefix,
      ],
    );
    const credentialVersion = active.rows[0];
    if (!credentialVersion)
      throw new HttpApiError("bad_request", "MCP credential is unavailable");
    if (credentialVersion.destination_origin === null)
      throw new HttpApiError(
        "bad_request",
        "MCP credential has no pinned destination; rotate it with a destination before creating a policy",
      );
    if (credentialVersion.within_destination !== true)
      throw new HttpApiError(
        "bad_request",
        "MCP credential policy origin and path prefix must lie inside the credential's pinned destination",
      );
    const id = randomUUID();
    const versionId = randomUUID();
    await tx.query(
      `INSERT INTO oao.mcp_credential_policies (
         organization_id,id,policy_key,display_name,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,$5)`,
      [actor.organizationId, id, input.key, input.displayName, actor.id],
    );
    await tx.query(
      `INSERT INTO oao.mcp_credential_policy_versions (
         organization_id,id,policy_id,version,credential_id,
         exact_origin,path_prefix,timeout_ms,maximum_response_bytes,
         content_hash,created_by_principal_id
       ) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10)`,
      [
        actor.organizationId,
        versionId,
        id,
        input.credentialId,
        input.exactOrigin.replace(/\/$/u, ""),
        input.pathPrefix,
        input.timeoutMs,
        input.maximumResponseBytes,
        digest(input),
        actor.id,
      ],
    );
    await tx.query(
      `INSERT INTO oao.mcp_credential_policy_version_lifecycle (
         organization_id,policy_version_id,updated_by_principal_id
       ) VALUES ($1,$2,$3)`,
      [actor.organizationId, versionId, actor.id],
    );
    await tx.query(
      `UPDATE oao.mcp_credential_policies SET latest_version_id=$3,updated_at=clock_timestamp()
       WHERE organization_id=$1 AND id=$2`,
      [actor.organizationId, id, versionId],
    );
    const result = await tx.query<PolicyRow>(
      `${POLICY_SELECT}
       WHERE resource.organization_id=$1 AND resource.id=$2`,
      [actor.organizationId, id],
    );
    return policy(result.rows[0]!);
  }

  async loadConnection(
    tx: PgClient,
    actor: Principal,
    serverId: string,
    credentialPolicyVersionId?: string,
  ): Promise<{
    readonly serverVersionId: string;
    readonly connection: McpConnectionDefinition;
  }> {
    if (!credentialPolicyVersionId) {
      const result = await tx.query<{
        id: string;
        endpoint_url: string;
        transport: "streamable_http" | "legacy_sse";
      }>(
        `SELECT version.id,version.endpoint_url,version.transport
           FROM oao.mcp_servers resource
           JOIN oao.mcp_server_versions version
             ON version.organization_id=resource.organization_id
            AND version.id=resource.latest_version_id
           JOIN oao.mcp_server_version_lifecycle lifecycle
             ON lifecycle.organization_id=version.organization_id
            AND lifecycle.server_version_id=version.id
            AND lifecycle.status='active'
          WHERE resource.organization_id=$1
            AND resource.id=$2`,
        [actor.organizationId, serverId],
      );
      const row = result.rows[0];
      if (!row) throw new HttpApiError("not_found", "MCP server not found");
      return {
        serverVersionId: row.id,
        connection: { endpointUrl: row.endpoint_url, transport: row.transport },
      };
    }
    const result = await tx.query<
      ConnectionRow & { server_version_id: string }
    >(
      `SELECT server.id AS server_version_id,server.endpoint_url,server.transport,
              policy.exact_origin,policy.path_prefix,
              policy.timeout_ms,policy.maximum_response_bytes,
              credential.id AS credential_id,version.id AS credential_version_id,
              credential.credential_kind,
              credential.header_name,version.destination_origin,
              version.destination_path_prefix,${OAUTH_VERSION_COLUMNS},
              version.encrypted_secret,
              version.encryption_nonce,version.encryption_tag,
              version.encryption_key_version
         FROM oao.mcp_servers resource
         JOIN oao.mcp_server_versions server
           ON server.organization_id=resource.organization_id
          AND server.id=resource.latest_version_id
         JOIN oao.mcp_server_version_lifecycle server_lifecycle
           ON server_lifecycle.organization_id=server.organization_id
          AND server_lifecycle.server_version_id=server.id
          AND server_lifecycle.status='active'
         JOIN oao.mcp_credential_policy_versions policy
           ON policy.organization_id=resource.organization_id
          AND policy.id=$3
          AND oao.mcp_endpoint_matches_policy(
            server.endpoint_url,policy.exact_origin,policy.path_prefix
          )
         JOIN oao.mcp_credential_policy_version_lifecycle policy_lifecycle
           ON policy_lifecycle.organization_id=policy.organization_id
          AND policy_lifecycle.policy_version_id=policy.id
          AND policy_lifecycle.status='active'
         JOIN oao.mcp_credentials credential
           ON credential.organization_id=policy.organization_id
          AND credential.id=policy.credential_id
         JOIN oao.mcp_credential_versions version
           ON version.organization_id=credential.organization_id
          AND version.id=credential.active_version_id
          AND (
            version.destination_origin IS NULL
            OR oao.mcp_policy_within_destination(
              policy.exact_origin,policy.path_prefix,
              version.destination_origin,version.destination_path_prefix
            )
          )
         JOIN oao.mcp_credential_version_lifecycle credential_lifecycle
           ON credential_lifecycle.organization_id=version.organization_id
          AND credential_lifecycle.credential_version_id=version.id
          AND credential_lifecycle.status='active'
        WHERE resource.organization_id=$1
          AND resource.id=$2`,
      [actor.organizationId, serverId, credentialPolicyVersionId],
    );
    const row = result.rows[0];
    if (!row)
      throw new HttpApiError(
        "bad_request",
        "MCP server or credential policy is unavailable or outside the approved origin",
      );
    const secret = this.cipher.decrypt(
      {
        ciphertext: row.encrypted_secret,
        nonce: row.encryption_nonce,
        tag: row.encryption_tag,
        keyVersion: row.encryption_key_version,
      },
      {
        organizationId: actor.organizationId,
        providerId: row.credential_id,
        providerType: "mcp",
      },
    );
    const oauth = pinnedOAuth(row);
    const material: McpCredentialMaterial =
      row.credential_kind === "oauth_client_credentials" && oauth
        ? oauthMaterial(
            actor.organizationId,
            row.credential_version_id,
            oauth,
            secret,
          )
        : row.credential_kind === "api_key_header"
          ? {
              kind: "api_key_header",
              headerName: row.header_name!,
              secret,
            }
          : { kind: "static_bearer", secret };
    return {
      serverVersionId: row.server_version_id,
      connection: {
        endpointUrl: row.endpoint_url,
        exactOrigin: row.exact_origin,
        pathPrefix: row.path_prefix,
        transport: row.transport,
        timeoutMs: row.timeout_ms,
        maximumResponseBytes: row.maximum_response_bytes,
        credential: material,
        ...(row.destination_origin && row.destination_path_prefix
          ? {
              credentialDestination: {
                origin: row.destination_origin,
                pathPrefix: row.destination_path_prefix,
              },
            }
          : {}),
      },
    };
  }

  discover(
    connection: McpConnectionDefinition,
    signal?: AbortSignal,
  ): Promise<readonly RemoteMcpDiscoveredTool[]> {
    return this.remote.discover(connection, signal);
  }

  async storeDiscovery(
    tx: PgClient,
    actor: Principal,
    serverVersionId: string,
    tools: readonly RemoteMcpDiscoveredTool[],
  ): Promise<McpServer> {
    const existing = await tx.query<{
      remote_tool_name: string;
      title: string | null;
      description: string;
      schema_hash: Buffer;
    }>(
      `SELECT remote_tool_name,title,description,schema_hash
         FROM oao.mcp_server_version_tools
       WHERE organization_id=$1 AND server_version_id=$2
       ORDER BY remote_tool_name`,
      [actor.organizationId, serverVersionId],
    );
    const snapshots = tools
      .map((tool) => ({
        ...tool,
        schemaHash: digest({
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? null,
        }),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    let targetVersionId = serverVersionId;
    if (existing.rowCount) {
      const same =
        existing.rowCount === snapshots.length &&
        existing.rows.every(
          (row, index) =>
            row.remote_tool_name === snapshots[index]?.name &&
            row.title === (snapshots[index]?.title ?? null) &&
            row.description === snapshots[index]?.description &&
            Buffer.compare(row.schema_hash, snapshots[index]!.schemaHash) === 0,
        );
      if (!same) {
        const source = await tx.query<{
          server_id: string;
          latest_version_id: string;
          version: number;
          endpoint_url: string;
          transport: "streamable_http" | "legacy_sse";
        }>(
          `SELECT resource.id AS server_id,resource.latest_version_id,
                  version.version,version.endpoint_url,version.transport
             FROM oao.mcp_servers resource
             JOIN oao.mcp_server_versions version
               ON version.organization_id=resource.organization_id
              AND version.server_id=resource.id
              AND version.id=$2
            WHERE resource.organization_id=$1
            FOR UPDATE OF resource`,
          [actor.organizationId, serverVersionId],
        );
        const current = source.rows[0];
        if (!current)
          throw new HttpApiError("not_found", "MCP server not found");
        if (current.latest_version_id !== serverVersionId)
          throw new HttpApiError(
            "conflict",
            "MCP server changed during discovery; retry against the latest version",
          );
        targetVersionId = randomUUID();
        await tx.query(
          `INSERT INTO oao.mcp_server_versions (
             organization_id,id,server_id,version,endpoint_url,
             transport,content_hash,created_by_principal_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            actor.organizationId,
            targetVersionId,
            current.server_id,
            current.version + 1,
            current.endpoint_url,
            current.transport,
            digest({
              endpointUrl: current.endpoint_url,
              transport: current.transport,
              basedOnVersionId: serverVersionId,
              tools: snapshots.map((snapshot) => ({
                name: snapshot.name,
                title: snapshot.title ?? null,
                description: snapshot.description,
                inputSchema: snapshot.inputSchema,
                outputSchema: snapshot.outputSchema ?? null,
              })),
            }),
            actor.id,
          ],
        );
        await tx.query(
          `INSERT INTO oao.mcp_server_version_lifecycle (
             organization_id,server_version_id,updated_by_principal_id
           ) VALUES ($1,$2,$3)`,
          [actor.organizationId, targetVersionId, actor.id],
        );
      }
      if (same) targetVersionId = serverVersionId;
    }
    if (!existing.rowCount || targetVersionId !== serverVersionId) {
      for (const snapshot of snapshots)
        await tx.query(
          `INSERT INTO oao.mcp_server_version_tools (
             organization_id,server_version_id,remote_tool_name,
             title,description,input_schema,output_schema,schema_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            actor.organizationId,
            targetVersionId,
            snapshot.name,
            snapshot.title ?? null,
            snapshot.description,
            snapshot.inputSchema,
            snapshot.outputSchema ?? null,
            snapshot.schemaHash,
          ],
        );
    }
    if (targetVersionId !== serverVersionId)
      await tx.query(
        `UPDATE oao.mcp_servers
            SET latest_version_id=$3,updated_at=clock_timestamp()
          WHERE organization_id=$1 AND latest_version_id=$2`,
        [actor.organizationId, serverVersionId, targetVersionId],
      );
    const result = await tx.query<ServerRow>(
      `${SERVER_SELECT}
       WHERE resource.organization_id=$1
         AND resource.latest_version_id=$2`,
      [actor.organizationId, targetVersionId],
    );
    if (!result.rows[0])
      throw new HttpApiError("not_found", "MCP server not found");
    return server(result.rows[0]);
  }

  async listToolsets(
    tx: PgClient,
    actor: Principal,
  ): Promise<readonly McpToolset[]> {
    const result = await tx.query<ToolsetRow>(
      `${TOOLSET_SELECT}
       WHERE resource.organization_id=$1 AND resource.project_id=$2
       ORDER BY resource.created_at DESC,resource.id DESC`,
      [actor.organizationId, actor.projectId],
    );
    return result.rows.map(toolset);
  }

  async createToolset(
    tx: PgClient,
    actor: Principal,
    input: CreateMcpToolsetInput,
  ): Promise<McpToolset> {
    const available = await tx.query<{ remote_tool_name: string }>(
      `SELECT tool.remote_tool_name
         FROM oao.mcp_server_version_tools tool
         JOIN oao.mcp_server_version_lifecycle lifecycle
           ON lifecycle.organization_id=tool.organization_id
          AND lifecycle.server_version_id=tool.server_version_id
          AND lifecycle.status='active'
        WHERE tool.organization_id=$1
          AND tool.server_version_id=$2
          AND tool.remote_tool_name=ANY($3::text[])`,
      [
        actor.organizationId,
        input.serverVersionId,
        input.tools.map((tool) => tool.remoteToolName),
      ],
    );
    if (available.rowCount !== input.tools.length)
      throw new HttpApiError(
        "bad_request",
        "Toolset includes an unavailable or undiscovered MCP tool",
      );
    const id = randomUUID();
    const versionId = randomUUID();
    await tx.query(
      `INSERT INTO oao.mcp_toolsets (
         organization_id,project_id,id,toolset_key,display_name,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        actor.organizationId,
        actor.projectId,
        id,
        input.key,
        input.displayName,
        actor.id,
      ],
    );
    await tx.query(
      `INSERT INTO oao.mcp_toolset_versions (
         organization_id,project_id,id,toolset_id,version,server_version_id,
         content_hash,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
      [
        actor.organizationId,
        actor.projectId,
        versionId,
        id,
        input.serverVersionId,
        digest(input),
        actor.id,
      ],
    );
    for (const selected of input.tools)
      await tx.query(
        `INSERT INTO oao.mcp_toolset_version_tools (
           organization_id,project_id,toolset_version_id,server_version_id,
           remote_tool_name,approval
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          actor.organizationId,
          actor.projectId,
          versionId,
          input.serverVersionId,
          selected.remoteToolName,
          selected.approval,
        ],
      );
    await tx.query(
      `INSERT INTO oao.mcp_toolset_version_lifecycle (
         organization_id,project_id,toolset_version_id,updated_by_principal_id
       ) VALUES ($1,$2,$3,$4)`,
      [actor.organizationId, actor.projectId, versionId, actor.id],
    );
    await tx.query(
      `UPDATE oao.mcp_toolsets SET latest_version_id=$4,updated_at=clock_timestamp()
       WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
      [actor.organizationId, actor.projectId, id, versionId],
    );
    const result = await tx.query<ToolsetRow>(
      `${TOOLSET_SELECT}
       WHERE resource.organization_id=$1 AND resource.project_id=$2 AND resource.id=$3`,
      [actor.organizationId, actor.projectId, id],
    );
    return toolset(result.rows[0]!);
  }
}
