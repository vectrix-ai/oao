import { createHash, randomUUID } from "node:crypto";
import type {
  CreateMcpCredentialInput,
  CreateMcpCredentialPolicyInput,
  CreateMcpServerInput,
  CreateMcpToolsetInput,
  McpCredential,
  McpCredentialPolicy,
  McpServer,
  McpToolset,
} from "@oao/contracts";
import type { Principal } from "@oao/domain";
import type { PgClient } from "@oao/db-postgres";
import type {
  McpConnectionDefinition,
  McpCredentialMaterial,
  McpDiscoveredTool as RemoteMcpDiscoveredTool,
  McpRemotePort,
} from "@oao/mcp-remote";
import type { ProviderCredentialCipher } from "@oao/provider-credentials";
import { HttpApiError } from "./errors.js";

interface ServerRow {
  id: string;
  organization_id: string;
  project_id: string;
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

interface CredentialRow {
  id: string;
  organization_id: string;
  project_id: string;
  credential_key: string;
  display_name: string;
  credential_kind: "static_bearer" | "api_key_header";
  header_name: string | null;
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
  project_id: string;
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

interface ConnectionRow {
  endpoint_url: string;
  exact_origin: string;
  path_prefix: string;
  transport: "streamable_http" | "legacy_sse";
  timeout_ms: number;
  maximum_response_bytes: number;
  credential_id: string;
  credential_kind: "static_bearer" | "api_key_header";
  header_name: string | null;
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

function server(row: ServerRow): McpServer {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
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
    projectId: row.project_id,
    key: row.credential_key,
    displayName: row.display_name,
    kind: row.credential_kind,
    headerName: row.header_name,
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
    projectId: row.project_id,
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
  SELECT resource.id,resource.organization_id,resource.project_id,
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
             AND tool.project_id=version.project_id
             AND tool.server_version_id=version.id
         ),'[]'::jsonb) AS tools,
         (SELECT max(tool.discovered_at)
            FROM oao.mcp_server_version_tools tool
           WHERE tool.organization_id=version.organization_id
             AND tool.project_id=version.project_id
             AND tool.server_version_id=version.id) AS last_discovered_at,
         resource.created_by_principal_id,resource.created_at,resource.updated_at
    FROM oao.mcp_servers resource
    JOIN oao.mcp_server_versions version
      ON version.organization_id=resource.organization_id
     AND version.project_id=resource.project_id
     AND version.id=resource.latest_version_id
    JOIN oao.mcp_server_version_lifecycle lifecycle
      ON lifecycle.organization_id=version.organization_id
     AND lifecycle.project_id=version.project_id
     AND lifecycle.server_version_id=version.id`;

const CREDENTIAL_SELECT = `
  SELECT resource.id,resource.organization_id,resource.project_id,
         resource.credential_key,resource.display_name,resource.credential_kind,
         resource.header_name,version.credential_fingerprint,
         version.version AS credential_version,lifecycle.status,
         resource.created_by_principal_id,resource.created_at,resource.updated_at
    FROM oao.mcp_credentials resource
    JOIN oao.mcp_credential_versions version
      ON version.organization_id=resource.organization_id
     AND version.project_id=resource.project_id
     AND version.id=resource.active_version_id
    JOIN oao.mcp_credential_version_lifecycle lifecycle
      ON lifecycle.organization_id=version.organization_id
     AND lifecycle.project_id=version.project_id
     AND lifecycle.credential_version_id=version.id`;

const POLICY_SELECT = `
  SELECT resource.id,resource.organization_id,resource.project_id,
         resource.policy_key,resource.display_name,resource.latest_version_id,
         version.version,version.credential_id,version.exact_origin,
         version.path_prefix,version.timeout_ms,version.maximum_response_bytes,
         lifecycle.status,resource.created_by_principal_id,
         resource.created_at,resource.updated_at
    FROM oao.mcp_credential_policies resource
    JOIN oao.mcp_credential_policy_versions version
      ON version.organization_id=resource.organization_id
     AND version.project_id=resource.project_id
     AND version.id=resource.latest_version_id
    JOIN oao.mcp_credential_policy_version_lifecycle lifecycle
      ON lifecycle.organization_id=version.organization_id
     AND lifecycle.project_id=version.project_id
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
            AND tool.project_id=selection.project_id
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
       WHERE resource.organization_id=$1 AND resource.project_id=$2
       ORDER BY resource.created_at DESC,resource.id DESC`,
      [actor.organizationId, actor.projectId],
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
         organization_id,project_id,id,server_key,display_name,
         created_by_principal_id
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
      `INSERT INTO oao.mcp_server_versions (
         organization_id,project_id,id,server_id,version,endpoint_url,transport,
         content_hash,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
      [
        actor.organizationId,
        actor.projectId,
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
         organization_id,project_id,server_version_id,updated_by_principal_id
       ) VALUES ($1,$2,$3,$4)`,
      [actor.organizationId, actor.projectId, versionId, actor.id],
    );
    await tx.query(
      `UPDATE oao.mcp_servers SET latest_version_id=$4,updated_at=clock_timestamp()
       WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
      [actor.organizationId, actor.projectId, id, versionId],
    );
    const result = await tx.query<ServerRow>(
      `${SERVER_SELECT}
       WHERE resource.organization_id=$1 AND resource.project_id=$2 AND resource.id=$3`,
      [actor.organizationId, actor.projectId, id],
    );
    return server(result.rows[0]!);
  }

  async listCredentials(
    tx: PgClient,
    actor: Principal,
  ): Promise<readonly McpCredential[]> {
    const result = await tx.query<CredentialRow>(
      `${CREDENTIAL_SELECT}
       WHERE resource.organization_id=$1 AND resource.project_id=$2
       ORDER BY resource.created_at DESC,resource.id DESC`,
      [actor.organizationId, actor.projectId],
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
    const encrypted = this.cipher.encrypt(input.secret, {
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      providerId: id,
      providerType: "mcp",
      keyVersion: 1,
    });
    await tx.query(
      `INSERT INTO oao.mcp_credentials (
         organization_id,project_id,id,credential_key,display_name,
         credential_kind,header_name,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        actor.organizationId,
        actor.projectId,
        id,
        input.key,
        input.displayName,
        input.kind,
        input.headerName,
        actor.id,
      ],
    );
    await tx.query(
      `INSERT INTO oao.mcp_credential_versions (
         organization_id,project_id,id,credential_id,version,encrypted_secret,
         encryption_nonce,encryption_tag,encryption_key_version,
         credential_fingerprint,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10)`,
      [
        actor.organizationId,
        actor.projectId,
        versionId,
        id,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        encrypted.keyVersion,
        encrypted.fingerprint,
        actor.id,
      ],
    );
    await tx.query(
      `INSERT INTO oao.mcp_credential_version_lifecycle (
         organization_id,project_id,credential_version_id,updated_by_principal_id
       ) VALUES ($1,$2,$3,$4)`,
      [actor.organizationId, actor.projectId, versionId, actor.id],
    );
    await tx.query(
      `UPDATE oao.mcp_credentials SET active_version_id=$4,updated_at=clock_timestamp()
       WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
      [actor.organizationId, actor.projectId, id, versionId],
    );
    const result = await tx.query<CredentialRow>(
      `${CREDENTIAL_SELECT}
       WHERE resource.organization_id=$1 AND resource.project_id=$2 AND resource.id=$3`,
      [actor.organizationId, actor.projectId, id],
    );
    return credential(result.rows[0]!);
  }

  async rotateCredential(
    tx: PgClient,
    actor: Principal,
    credentialId: string,
    secret: string,
  ): Promise<McpCredential> {
    const locked = await tx.query<{
      active_version_id: string;
      version: number;
    }>(
      `SELECT credential.active_version_id,version.version
         FROM oao.mcp_credentials credential
         JOIN oao.mcp_credential_versions version
           ON version.organization_id=credential.organization_id
          AND version.project_id=credential.project_id
          AND version.id=credential.active_version_id
        WHERE credential.organization_id=$1 AND credential.project_id=$2
          AND credential.id=$3 FOR UPDATE OF credential`,
      [actor.organizationId, actor.projectId, credentialId],
    );
    const current = locked.rows[0];
    if (!current)
      throw new HttpApiError("not_found", "MCP credential not found");
    const version = current.version + 1;
    const versionId = randomUUID();
    const encrypted = this.cipher.encrypt(secret, {
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      providerId: credentialId,
      providerType: "mcp",
      keyVersion: version,
    });
    await tx.query(
      `UPDATE oao.mcp_credential_version_lifecycle
          SET status='deprecated',updated_by_principal_id=$4,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND project_id=$2 AND credential_version_id=$3`,
      [
        actor.organizationId,
        actor.projectId,
        current.active_version_id,
        actor.id,
      ],
    );
    await tx.query(
      `INSERT INTO oao.mcp_credential_versions (
         organization_id,project_id,id,credential_id,version,encrypted_secret,
         encryption_nonce,encryption_tag,encryption_key_version,
         credential_fingerprint,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        actor.organizationId,
        actor.projectId,
        versionId,
        credentialId,
        version,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        encrypted.keyVersion,
        encrypted.fingerprint,
        actor.id,
      ],
    );
    await tx.query(
      `INSERT INTO oao.mcp_credential_version_lifecycle (
         organization_id,project_id,credential_version_id,updated_by_principal_id
       ) VALUES ($1,$2,$3,$4)`,
      [actor.organizationId, actor.projectId, versionId, actor.id],
    );
    await tx.query(
      `UPDATE oao.mcp_credentials SET active_version_id=$4,updated_at=clock_timestamp()
       WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
      [actor.organizationId, actor.projectId, credentialId, versionId],
    );
    const result = await tx.query<CredentialRow>(
      `${CREDENTIAL_SELECT}
       WHERE resource.organization_id=$1 AND resource.project_id=$2 AND resource.id=$3`,
      [actor.organizationId, actor.projectId, credentialId],
    );
    return credential(result.rows[0]!);
  }

  async revokeCredential(
    tx: PgClient,
    actor: Principal,
    credentialId: string,
  ): Promise<McpCredential> {
    const result = await tx.query(
      `UPDATE oao.mcp_credential_version_lifecycle lifecycle
          SET status='revoked',updated_by_principal_id=$4,updated_at=clock_timestamp()
         FROM oao.mcp_credentials credential
        WHERE credential.organization_id=$1 AND credential.project_id=$2
          AND credential.id=$3
          AND lifecycle.organization_id=credential.organization_id
          AND lifecycle.project_id=credential.project_id
          AND lifecycle.credential_version_id=credential.active_version_id
          AND lifecycle.status<>'revoked'`,
      [actor.organizationId, actor.projectId, credentialId, actor.id],
    );
    if (!result.rowCount)
      throw new HttpApiError("not_found", "Active MCP credential not found");
    const revoked = await tx.query<CredentialRow>(
      `${CREDENTIAL_SELECT}
       WHERE resource.organization_id=$1 AND resource.project_id=$2 AND resource.id=$3`,
      [actor.organizationId, actor.projectId, credentialId],
    );
    return credential(revoked.rows[0]!);
  }

  async listPolicies(
    tx: PgClient,
    actor: Principal,
  ): Promise<readonly McpCredentialPolicy[]> {
    const result = await tx.query<PolicyRow>(
      `${POLICY_SELECT}
       WHERE resource.organization_id=$1 AND resource.project_id=$2
       ORDER BY resource.created_at DESC,resource.id DESC`,
      [actor.organizationId, actor.projectId],
    );
    return result.rows.map(policy);
  }

  async createPolicy(
    tx: PgClient,
    actor: Principal,
    input: CreateMcpCredentialPolicyInput,
  ): Promise<McpCredentialPolicy> {
    const credentialExists = await tx.query(
      `SELECT 1 FROM oao.mcp_credentials credential
       JOIN oao.mcp_credential_version_lifecycle lifecycle
         ON lifecycle.organization_id=credential.organization_id
        AND lifecycle.project_id=credential.project_id
        AND lifecycle.credential_version_id=credential.active_version_id
        AND lifecycle.status='active'
       WHERE credential.organization_id=$1 AND credential.project_id=$2
         AND credential.id=$3`,
      [actor.organizationId, actor.projectId, input.credentialId],
    );
    if (!credentialExists.rowCount)
      throw new HttpApiError("bad_request", "MCP credential is unavailable");
    const id = randomUUID();
    const versionId = randomUUID();
    await tx.query(
      `INSERT INTO oao.mcp_credential_policies (
         organization_id,project_id,id,policy_key,display_name,created_by_principal_id
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
      `INSERT INTO oao.mcp_credential_policy_versions (
         organization_id,project_id,id,policy_id,version,credential_id,
         exact_origin,path_prefix,timeout_ms,maximum_response_bytes,
         content_hash,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11)`,
      [
        actor.organizationId,
        actor.projectId,
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
         organization_id,project_id,policy_version_id,updated_by_principal_id
       ) VALUES ($1,$2,$3,$4)`,
      [actor.organizationId, actor.projectId, versionId, actor.id],
    );
    await tx.query(
      `UPDATE oao.mcp_credential_policies SET latest_version_id=$4,updated_at=clock_timestamp()
       WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
      [actor.organizationId, actor.projectId, id, versionId],
    );
    const result = await tx.query<PolicyRow>(
      `${POLICY_SELECT}
       WHERE resource.organization_id=$1 AND resource.project_id=$2 AND resource.id=$3`,
      [actor.organizationId, actor.projectId, id],
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
            AND version.project_id=resource.project_id
            AND version.id=resource.latest_version_id
           JOIN oao.mcp_server_version_lifecycle lifecycle
             ON lifecycle.organization_id=version.organization_id
            AND lifecycle.project_id=version.project_id
            AND lifecycle.server_version_id=version.id
            AND lifecycle.status='active'
          WHERE resource.organization_id=$1 AND resource.project_id=$2
            AND resource.id=$3`,
        [actor.organizationId, actor.projectId, serverId],
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
              credential.id AS credential_id,credential.credential_kind,
              credential.header_name,version.encrypted_secret,
              version.encryption_nonce,version.encryption_tag,
              version.encryption_key_version
         FROM oao.mcp_servers resource
         JOIN oao.mcp_server_versions server
           ON server.organization_id=resource.organization_id
          AND server.project_id=resource.project_id
          AND server.id=resource.latest_version_id
         JOIN oao.mcp_server_version_lifecycle server_lifecycle
           ON server_lifecycle.organization_id=server.organization_id
          AND server_lifecycle.project_id=server.project_id
          AND server_lifecycle.server_version_id=server.id
          AND server_lifecycle.status='active'
         JOIN oao.mcp_credential_policy_versions policy
           ON policy.organization_id=resource.organization_id
          AND policy.project_id=resource.project_id
          AND policy.id=$4
          AND oao.mcp_endpoint_matches_policy(
            server.endpoint_url,policy.exact_origin,policy.path_prefix
          )
         JOIN oao.mcp_credential_policy_version_lifecycle policy_lifecycle
           ON policy_lifecycle.organization_id=policy.organization_id
          AND policy_lifecycle.project_id=policy.project_id
          AND policy_lifecycle.policy_version_id=policy.id
          AND policy_lifecycle.status='active'
         JOIN oao.mcp_credentials credential
           ON credential.organization_id=policy.organization_id
          AND credential.project_id=policy.project_id
          AND credential.id=policy.credential_id
         JOIN oao.mcp_credential_versions version
           ON version.organization_id=credential.organization_id
          AND version.project_id=credential.project_id
          AND version.id=credential.active_version_id
         JOIN oao.mcp_credential_version_lifecycle credential_lifecycle
           ON credential_lifecycle.organization_id=version.organization_id
          AND credential_lifecycle.project_id=version.project_id
          AND credential_lifecycle.credential_version_id=version.id
          AND credential_lifecycle.status='active'
        WHERE resource.organization_id=$1 AND resource.project_id=$2
          AND resource.id=$3`,
      [
        actor.organizationId,
        actor.projectId,
        serverId,
        credentialPolicyVersionId,
      ],
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
        projectId: actor.projectId,
        providerId: row.credential_id,
        providerType: "mcp",
      },
    );
    const material: McpCredentialMaterial =
      row.credential_kind === "static_bearer"
        ? { kind: "static_bearer", secret }
        : {
            kind: "api_key_header",
            headerName: row.header_name!,
            secret,
          };
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
       WHERE organization_id=$1 AND project_id=$2 AND server_version_id=$3
       ORDER BY remote_tool_name`,
      [actor.organizationId, actor.projectId, serverVersionId],
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
              AND version.project_id=resource.project_id
              AND version.server_id=resource.id
              AND version.id=$3
            WHERE resource.organization_id=$1 AND resource.project_id=$2
            FOR UPDATE OF resource`,
          [actor.organizationId, actor.projectId, serverVersionId],
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
             organization_id,project_id,id,server_id,version,endpoint_url,
             transport,content_hash,created_by_principal_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            actor.organizationId,
            actor.projectId,
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
             organization_id,project_id,server_version_id,updated_by_principal_id
           ) VALUES ($1,$2,$3,$4)`,
          [actor.organizationId, actor.projectId, targetVersionId, actor.id],
        );
      }
      if (same) targetVersionId = serverVersionId;
    }
    if (!existing.rowCount || targetVersionId !== serverVersionId) {
      for (const snapshot of snapshots)
        await tx.query(
          `INSERT INTO oao.mcp_server_version_tools (
             organization_id,project_id,server_version_id,remote_tool_name,
             title,description,input_schema,output_schema,schema_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            actor.organizationId,
            actor.projectId,
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
            SET latest_version_id=$4,updated_at=clock_timestamp()
          WHERE organization_id=$1 AND project_id=$2 AND latest_version_id=$3`,
        [
          actor.organizationId,
          actor.projectId,
          serverVersionId,
          targetVersionId,
        ],
      );
    const result = await tx.query<ServerRow>(
      `${SERVER_SELECT}
       WHERE resource.organization_id=$1 AND resource.project_id=$2
         AND resource.latest_version_id=$3`,
      [actor.organizationId, actor.projectId, targetVersionId],
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
          AND lifecycle.project_id=tool.project_id
          AND lifecycle.server_version_id=tool.server_version_id
          AND lifecycle.status='active'
        WHERE tool.organization_id=$1 AND tool.project_id=$2
          AND tool.server_version_id=$3
          AND tool.remote_tool_name=ANY($4::text[])`,
      [
        actor.organizationId,
        actor.projectId,
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
