import { randomBytes, randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  CONFIGURATION_BACKUP_FORMAT,
  CONFIGURATION_BACKUP_FORMAT_VERSION,
  agentVersionPublicationOrder,
  canonicalMcpOrigin,
  checkConfigurationBackupReferences,
  mcpResourceDestination,
  configurationBackupCounts,
  parseConfigurationBackup,
  parseConfigurationRestoreInput,
  type ConfigurationBackup,
  type ConfigurationBackupProject,
  type ConfigurationRestoreCredentials,
  type ConfigurationRestorePlan,
  type ConfigurationRestoreResult,
} from "@oao/contracts";
import type { PgClient, TenantTransactionOptions } from "@oao/db-postgres";
import {
  assertPublicPayload,
  type Principal,
  type PublicValue,
} from "@oao/domain";
import { validateWebhookEndpoint } from "@oao/event-webhooks";
import type { ProviderCredentialCipher } from "@oao/provider-credentials";
import { HttpApiError, mapPostgresError } from "./errors.js";
import { mcpCredentialFingerprint } from "./mcp.js";
import { idempotencyKey, readJsonObject, requestHash } from "./http.js";
import {
  insertModelPresetPrice,
  MODEL_PRESET_PRICE_COLUMNS,
  modelPresetPriceView,
  type ModelPresetPriceRow,
} from "./model-preset-prices.js";
import {
  insertModelPresetLimits,
  MODEL_PRESET_LIMITS_COLUMNS,
  modelPresetLimitsView,
  type ModelPresetLimitsRow,
} from "./model-preset-limits.js";

/** What the backup routes need from the API that owns them. */
export interface ConfigurationBackupContext {
  readonly store: {
    transaction<T>(
      principal: Principal,
      action: "project:admin",
      callback: (transaction: PgClient) => Promise<T>,
      options?: TenantTransactionOptions,
    ): Promise<T>;
    appendAudit(
      transaction: PgClient,
      principal: Principal,
      input: {
        readonly action: string;
        readonly resourceType: string;
        readonly resourceId: string;
        readonly detail?: Readonly<Record<string, PublicValue>>;
      },
    ): Promise<void>;
    idempotent<T extends Readonly<Record<string, unknown>>>(
      transaction: PgClient,
      principal: Principal,
      input: {
        readonly scope: string;
        readonly key: string;
        readonly hash: Uint8Array;
        readonly status: number;
        readonly execute: () => Promise<T>;
      },
    ): Promise<{ readonly body: T; readonly replayed: boolean }>;
  };
  readonly credentialCipher: ProviderCredentialCipher | undefined;
  readonly allowPrivateWebhookEndpoints: boolean;
  /** Model presets the deployment offers outside any project. */
  readonly deploymentModelPresetKeys: ReadonlySet<string>;
  readonly assertOrganizationAdministrator: (
    transaction: PgClient,
    actor: Principal,
  ) => Promise<void>;
  /** Validates a Skill version and computes its content hash, as publishing does. */
  readonly parseSkillVersionInput: (
    value: Readonly<Record<string, unknown>>,
  ) => ParsedSkillVersion;
}

export interface ParsedSkillVersion {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
  readonly files: readonly {
    readonly path: string;
    readonly contentType: string;
    readonly bytes: Buffer;
    readonly sizeBytes: number;
    readonly sha256: string;
  }[];
  readonly totalBytes: number;
  readonly contentHash: string;
}

const MAX_EVENT_WEBHOOKS_PER_PROJECT = 20;

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function fingerprint(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
    ? value.slice(0, 12)
    : null;
}

function lifecycle(value: unknown): "active" | "deprecated" | "revoked" {
  return value === "deprecated" || value === "revoked" ? value : "active";
}

async function useProject(
  transaction: PgClient,
  organizationId: string,
  projectId: string,
): Promise<void> {
  await transaction.query("SELECT oao.set_tenant_context($1,$2)", [
    organizationId,
    projectId,
  ]);
}

function groupBy<T extends Row>(
  rows: readonly T[],
  key: string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = String(row[key]);
    const group = groups.get(value);
    if (group) group.push(row);
    else groups.set(value, [row]);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportProject(
  transaction: PgClient,
  organizationId: string,
  project: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  },
): Promise<ConfigurationBackupProject> {
  await useProject(transaction, organizationId, project.id);
  const scope = [organizationId, project.id];
  const presets = await transaction.query<Row>(
    `SELECT id,preset_key,display_name,provider_id,model,routing,settings,
            archived_at IS NOT NULL AS archived
       FROM oao.project_model_presets
      WHERE organization_id=$1 AND project_id=$2
      ORDER BY created_at,id`,
    scope,
  );
  const presetPrices = await transaction.query<ModelPresetPriceRow>(
    `SELECT ${MODEL_PRESET_PRICE_COLUMNS} FROM oao.model_preset_prices
      WHERE organization_id=$1 AND project_id=$2
      ORDER BY valid_from,id`,
    scope,
  );
  const presetLimits = await transaction.query<ModelPresetLimitsRow>(
    `SELECT ${MODEL_PRESET_LIMITS_COLUMNS} FROM oao.model_preset_limits
      WHERE organization_id=$1 AND project_id=$2
      ORDER BY created_at,id`,
    scope,
  );
  const skills = await transaction.query<Row>(
    `SELECT id,skill_key,display_name,disabled_at IS NOT NULL AS disabled,
            archived_at IS NOT NULL AS archived
       FROM oao.skills WHERE organization_id=$1 AND project_id=$2
      ORDER BY created_at,id`,
    scope,
  );
  const skillVersions = await transaction.query<Row>(
    `SELECT v.id,v.skill_id,v.version,v.skill_name,v.description,v.instructions,
            v.license,v.compatibility,v.metadata,v.allowed_tools,lifecycle.status
       FROM oao.skill_versions v
       JOIN oao.skill_version_lifecycle lifecycle
         ON lifecycle.organization_id=v.organization_id
        AND lifecycle.project_id=v.project_id
        AND lifecycle.skill_version_id=v.id
      WHERE v.organization_id=$1 AND v.project_id=$2
      ORDER BY v.version`,
    scope,
  );
  const skillFiles = await transaction.query<Row>(
    `SELECT skill_version_id,file_path,content_type,content_bytes
       FROM oao.skill_version_files
      WHERE organization_id=$1 AND project_id=$2
      ORDER BY file_path`,
    scope,
  );
  const toolsets = await transaction.query<Row>(
    `SELECT id,toolset_key,display_name FROM oao.mcp_toolsets
      WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at,id`,
    scope,
  );
  const toolsetVersions = await transaction.query<Row>(
    `SELECT v.id,v.toolset_id,v.version,v.server_version_id,
            encode(v.content_hash,'hex') AS content_hash,lifecycle.status
       FROM oao.mcp_toolset_versions v
       JOIN oao.mcp_toolset_version_lifecycle lifecycle
         ON lifecycle.organization_id=v.organization_id
        AND lifecycle.project_id=v.project_id
        AND lifecycle.toolset_version_id=v.id
      WHERE v.organization_id=$1 AND v.project_id=$2
      ORDER BY v.version`,
    scope,
  );
  const toolsetTools = await transaction.query<Row>(
    `SELECT toolset_version_id,remote_tool_name,approval
       FROM oao.mcp_toolset_version_tools
      WHERE organization_id=$1 AND project_id=$2
      ORDER BY remote_tool_name`,
    scope,
  );
  const agents = await transaction.query<Row>(
    `SELECT id,agent_key,name,description,archived_at IS NOT NULL AS archived
       FROM oao.agent_definitions WHERE organization_id=$1 AND project_id=$2
      ORDER BY created_at,id`,
    scope,
  );
  const agentVersions = await transaction.query<Row>(
    `SELECT id,agent_definition_id,version,config,created_at
       FROM oao.agent_versions WHERE organization_id=$1 AND project_id=$2
      ORDER BY version`,
    scope,
  );
  const webhooks = await transaction.query<Row>(
    `SELECT id,display_name,endpoint_url,enabled,disabled_reason,event_kinds,
            include_message_content,credential_fingerprint
       FROM oao.event_webhooks WHERE organization_id=$1 AND project_id=$2
      ORDER BY created_at,id`,
    scope,
  );

  const filesByVersion = groupBy(skillFiles.rows, "skill_version_id");
  const versionsBySkill = groupBy(skillVersions.rows, "skill_id");
  const toolsByVersion = groupBy(toolsetTools.rows, "toolset_version_id");
  const versionsByToolset = groupBy(toolsetVersions.rows, "toolset_id");
  const versionsByAgent = groupBy(agentVersions.rows, "agent_definition_id");
  return {
    slug: project.slug,
    name: project.name,
    modelPresets: presets.rows.map((row) => ({
      id: String(row.id),
      key: String(row.preset_key),
      displayName: String(row.display_name),
      providerId: String(row.provider_id),
      model: String(row.model),
      routing:
        row.routing as ConfigurationBackupProject["modelPresets"][number]["routing"],
      settings: (row.settings ??
        null) as ConfigurationBackupProject["modelPresets"][number]["settings"],
      archived: row.archived === true,
      prices: presetPrices.rows
        .filter((price) => price.preset_id === row.id)
        .map((price) => {
          const view = modelPresetPriceView(price);
          return {
            id: view.id,
            inputUsdPerMillion: view.inputUsdPerMillion,
            cachedInputUsdPerMillion: view.cachedInputUsdPerMillion,
            cacheWriteUsdPerMillion: view.cacheWriteUsdPerMillion,
            outputUsdPerMillion: view.outputUsdPerMillion,
            longContext: view.longContext,
            validFrom: view.validFrom,
          };
        }),
      limits: presetLimits.rows
        .filter((limits) => limits.preset_id === row.id)
        .map((limits) => {
          const view = modelPresetLimitsView(limits);
          return {
            id: view.id,
            contextWindow: view.contextWindow,
            maxOutputTokens: view.maxOutputTokens,
            createdAt: view.createdAt,
          };
        }),
    })),
    skills: skills.rows.map((row) => ({
      id: String(row.id),
      key: String(row.skill_key),
      displayName: String(row.display_name),
      disabled: row.disabled === true,
      archived: row.archived === true,
      versions: (versionsBySkill.get(String(row.id)) ?? []).map((version) => ({
        id: String(version.id),
        version: Number(version.version),
        name: String(version.skill_name),
        description: String(version.description),
        instructions: String(version.instructions),
        license: (version.license as string | null) ?? null,
        compatibility: (version.compatibility as string | null) ?? null,
        metadata: (version.metadata ?? {}) as Record<string, string>,
        allowedTools: (version.allowed_tools as string | null) ?? null,
        status: lifecycle(version.status),
        files: (filesByVersion.get(String(version.id)) ?? []).map((file) => ({
          path: String(file.file_path),
          contentType: String(file.content_type),
          dataBase64: Buffer.from(file.content_bytes as Buffer).toString(
            "base64",
          ),
        })),
      })),
    })),
    mcpToolsets: toolsets.rows.map((row) => ({
      id: String(row.id),
      key: String(row.toolset_key),
      displayName: String(row.display_name),
      versions: (versionsByToolset.get(String(row.id)) ?? []).map(
        (version) => ({
          id: String(version.id),
          version: Number(version.version),
          serverVersionId: String(version.server_version_id),
          status: lifecycle(version.status),
          contentHash: String(version.content_hash),
          tools: (toolsByVersion.get(String(version.id)) ?? []).map((tool) => ({
            remoteToolName: String(tool.remote_tool_name),
            approval: tool.approval === "never" ? "never" : "always",
          })),
        }),
      ),
    })),
    agents: agents.rows.map((row) => ({
      id: String(row.id),
      key: String(row.agent_key),
      name: String(row.name),
      description: (row.description as string | null) ?? null,
      archived: row.archived === true,
      versions: (versionsByAgent.get(String(row.id)) ?? []).map((version) => ({
        id: String(version.id),
        version: Number(version.version),
        publishedAt: iso(version.created_at),
        config: version.config as Record<string, unknown>,
      })),
    })),
    eventWebhooks: webhooks.rows.map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      endpointUrl: String(row.endpoint_url),
      enabled: row.enabled === true,
      disabledReason:
        row.disabled_reason === "user" ||
        row.disabled_reason === "endpoint_gone"
          ? row.disabled_reason
          : null,
      eventKinds: (row.event_kinds as string[] | null) ?? null,
      includeMessageContent: row.include_message_content === true,
      credentialFingerprint: fingerprint(row.credential_fingerprint),
    })),
  };
}

/**
 * Reads an organization's configuration. Every column is chosen explicitly;
 * encrypted credentials, signing keys, and key hashes are never selected.
 */
export async function exportOrganizationConfiguration(
  transaction: PgClient,
  actor: Principal,
): Promise<ConfigurationBackup> {
  const organizationId = actor.organizationId;
  const organization = await transaction.query<Row>(
    "SELECT slug,name FROM oao.organizations WHERE id=$1",
    [organizationId],
  );
  const orgRow = organization.rows[0];
  if (!orgRow) throw new HttpApiError("not_found", "Organization not found");
  const org = [organizationId];
  const modelProviders = await transaction.query<Row>(
    `SELECT id,provider_key,display_name,provider_type,
            archived_at IS NOT NULL AS archived,credential_fingerprint
       FROM oao.project_model_providers WHERE organization_id=$1
      ORDER BY created_at,id`,
    org,
  );
  const sandboxProviders = await transaction.query<Row>(
    `SELECT id,provider_key,display_name,target,restricted_egress,
            credential_fingerprint
       FROM oao.project_sandbox_providers WHERE organization_id=$1
      ORDER BY created_at,id`,
    org,
  );
  const storageProviders = await transaction.query<Row>(
    `SELECT id,provider_key,display_name,endpoint,region,bucket,object_prefix,
            force_path_style,is_default,credential_fingerprint
       FROM oao.project_storage_providers WHERE organization_id=$1
      ORDER BY created_at,id`,
    org,
  );
  const servers = await transaction.query<Row>(
    `SELECT id,server_key,display_name FROM oao.mcp_servers
      WHERE organization_id=$1 ORDER BY created_at,id`,
    org,
  );
  const serverVersions = await transaction.query<Row>(
    `SELECT v.id,v.server_id,v.version,v.endpoint_url,v.transport,
            encode(v.content_hash,'hex') AS content_hash,lifecycle.status
       FROM oao.mcp_server_versions v
       JOIN oao.mcp_server_version_lifecycle lifecycle
         ON lifecycle.organization_id=v.organization_id
        AND lifecycle.server_version_id=v.id
      WHERE v.organization_id=$1 ORDER BY v.version`,
    org,
  );
  const serverTools = await transaction.query<Row>(
    `SELECT server_version_id,remote_tool_name,title,description,input_schema,
            output_schema,encode(schema_hash,'hex') AS schema_hash
       FROM oao.mcp_server_version_tools WHERE organization_id=$1
      ORDER BY remote_tool_name`,
    org,
  );
  const credentials = await transaction.query<Row>(
    `SELECT credential.id,credential.credential_key,credential.display_name,
            credential.credential_kind,credential.header_name,lifecycle.status,
            version.credential_fingerprint,version.destination_origin,
            version.destination_path_prefix,version.oauth_issuer,
            version.oauth_token_endpoint,version.oauth_client_id,
            version.oauth_token_endpoint_auth_method,version.oauth_scope,
            version.oauth_resource,version.oauth_resource_metadata_url,
            version.oauth_send_resource
       FROM oao.mcp_credentials credential
       LEFT JOIN oao.mcp_credential_versions version
         ON version.organization_id=credential.organization_id
        AND version.id=credential.active_version_id
       LEFT JOIN oao.mcp_credential_version_lifecycle lifecycle
         ON lifecycle.organization_id=credential.organization_id
        AND lifecycle.credential_version_id=credential.active_version_id
      WHERE credential.organization_id=$1
      ORDER BY credential.created_at,credential.id`,
    org,
  );
  const policies = await transaction.query<Row>(
    `SELECT id,policy_key,display_name FROM oao.mcp_credential_policies
      WHERE organization_id=$1 ORDER BY created_at,id`,
    org,
  );
  const policyVersions = await transaction.query<Row>(
    `SELECT v.id,v.policy_id,v.version,v.credential_id,v.exact_origin,
            v.path_prefix,v.timeout_ms,v.maximum_response_bytes,
            v.forward_call_context,
            encode(v.content_hash,'hex') AS content_hash,lifecycle.status
       FROM oao.mcp_credential_policy_versions v
       JOIN oao.mcp_credential_policy_version_lifecycle lifecycle
         ON lifecycle.organization_id=v.organization_id
        AND lifecycle.policy_version_id=v.id
      WHERE v.organization_id=$1 ORDER BY v.version`,
    org,
  );
  const projects = await transaction.query<Row>(
    `SELECT id,slug,name FROM oao.projects WHERE organization_id=$1
      ORDER BY created_at,id`,
    org,
  );

  const toolsByServerVersion = groupBy(serverTools.rows, "server_version_id");
  const versionsByServer = groupBy(serverVersions.rows, "server_id");
  const versionsByPolicy = groupBy(policyVersions.rows, "policy_id");
  const exportedProjects: ConfigurationBackupProject[] = [];
  for (const project of projects.rows)
    exportedProjects.push(
      await exportProject(transaction, organizationId, {
        id: String(project.id),
        slug: String(project.slug),
        name: String(project.name),
      }),
    );
  await useProject(transaction, organizationId, actor.projectId);

  return {
    format: CONFIGURATION_BACKUP_FORMAT,
    formatVersion: CONFIGURATION_BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    organization: { slug: String(orgRow.slug), name: String(orgRow.name) },
    modelProviders: modelProviders.rows.map((row) => ({
      id: String(row.id),
      key: String(row.provider_key),
      displayName: String(row.display_name),
      providerType:
        row.provider_type as ConfigurationBackup["modelProviders"][number]["providerType"],
      archived: row.archived === true,
      credentialFingerprint:
        row.archived === true ? null : fingerprint(row.credential_fingerprint),
    })),
    sandboxProviders: sandboxProviders.rows.map((row) => {
      const egress = (row.restricted_egress ?? {}) as {
        allowedDomains?: string[];
        allowedCidrs?: string[];
      };
      return {
        id: String(row.id),
        key: String(row.provider_key),
        displayName: String(row.display_name),
        providerType: "daytona" as const,
        target: (row.target as string | null) ?? null,
        restrictedEgress: {
          allowedDomains: egress.allowedDomains ?? [],
          allowedCidrs: egress.allowedCidrs ?? [],
        },
        credentialFingerprint: fingerprint(row.credential_fingerprint),
      };
    }),
    storageProviders: storageProviders.rows.map((row) => ({
      id: String(row.id),
      key: String(row.provider_key),
      displayName: String(row.display_name),
      providerType: "s3" as const,
      endpoint: (row.endpoint as string | null) ?? null,
      region: String(row.region),
      bucket: String(row.bucket),
      prefix: (row.object_prefix as string | null) ?? null,
      forcePathStyle: row.force_path_style === true,
      default: row.is_default === true,
      credentialFingerprint: fingerprint(row.credential_fingerprint),
    })),
    mcpServers: servers.rows.map((row) => ({
      id: String(row.id),
      key: String(row.server_key),
      displayName: String(row.display_name),
      versions: (versionsByServer.get(String(row.id)) ?? []).map((version) => ({
        id: String(version.id),
        version: Number(version.version),
        endpointUrl: String(version.endpoint_url),
        transport:
          version.transport === "legacy_sse"
            ? ("legacy_sse" as const)
            : ("streamable_http" as const),
        status: lifecycle(version.status),
        contentHash: String(version.content_hash),
        tools: (toolsByServerVersion.get(String(version.id)) ?? []).map(
          (tool) => ({
            name: String(tool.remote_tool_name),
            title: (tool.title as string | null) ?? null,
            description: String(tool.description),
            inputSchema: tool.input_schema as Record<string, unknown>,
            outputSchema:
              (tool.output_schema as Record<string, unknown> | null) ?? null,
            schemaHash: String(tool.schema_hash),
          }),
        ),
      })),
    })),
    mcpCredentials: credentials.rows.map((row) => ({
      id: String(row.id),
      key: String(row.credential_key),
      displayName: String(row.display_name),
      kind:
        row.credential_kind === "api_key_header"
          ? ("api_key_header" as const)
          : row.credential_kind === "oauth_client_credentials"
            ? ("oauth_client_credentials" as const)
            : ("static_bearer" as const),
      headerName: (row.header_name as string | null) ?? null,
      oauth:
        row.credential_kind === "oauth_client_credentials" &&
        typeof row.oauth_issuer === "string"
          ? {
              resource: String(row.oauth_resource),
              resourceMetadataUrl: String(row.oauth_resource_metadata_url),
              issuer: row.oauth_issuer,
              tokenEndpoint: String(row.oauth_token_endpoint),
              clientId: String(row.oauth_client_id),
              tokenEndpointAuthMethod:
                row.oauth_token_endpoint_auth_method === "client_secret_basic"
                  ? ("client_secret_basic" as const)
                  : ("client_secret_post" as const),
              scope: String(row.oauth_scope),
              sendResource: row.oauth_send_resource === true,
            }
          : null,
      destination:
        typeof row.destination_origin === "string" &&
        typeof row.destination_path_prefix === "string"
          ? {
              origin: row.destination_origin,
              pathPrefix: row.destination_path_prefix,
            }
          : null,
      status:
        row.status === "active" ? ("active" as const) : ("revoked" as const),
      credentialFingerprint:
        row.status === "active"
          ? fingerprint(row.credential_fingerprint)
          : null,
    })),
    mcpCredentialPolicies: policies.rows.map((row) => ({
      id: String(row.id),
      key: String(row.policy_key),
      displayName: String(row.display_name),
      versions: (versionsByPolicy.get(String(row.id)) ?? []).map((version) => ({
        id: String(version.id),
        version: Number(version.version),
        credentialId: String(version.credential_id),
        exactOrigin: String(version.exact_origin),
        pathPrefix: String(version.path_prefix),
        timeoutMs: Number(version.timeout_ms),
        maximumResponseBytes: Number(version.maximum_response_bytes),
        forwardCallContext: version.forward_call_context === true,
        status: lifecycle(version.status),
        contentHash: String(version.content_hash),
      })),
    })),
    projects: exportedProjects,
  };
}

// ---------------------------------------------------------------------------
// Restore planning
// ---------------------------------------------------------------------------

interface ProjectTarget {
  readonly slug: string;
  readonly name: string;
  readonly projectId: string | null;
  readonly action: "create" | "use_empty_project" | "blocked";
}

interface RestorePlanState {
  readonly plan: ConfigurationRestorePlan;
  readonly targets: readonly ProjectTarget[];
  readonly keepExistingDefaultStorage: boolean;
}

async function liveKeys(
  transaction: PgClient,
  sql: string,
  organizationId: string,
  keys: readonly string[],
): Promise<readonly string[]> {
  if (keys.length === 0) return [];
  const result = await transaction.query<{ key: string }>(sql, [
    organizationId,
    [...keys],
  ]);
  return result.rows.map((row) => row.key);
}

function webhookEndpointProblem(
  url: string,
  allowPrivateNetwork: boolean,
): string | undefined {
  try {
    validateWebhookEndpoint(url, { allowPrivateNetwork });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "endpoint is invalid";
  }
}

/**
 * Checks a backup against the organization without changing anything:
 * what would be created, what blocks an exact copy, and which credentials
 * must be entered.
 */
export async function planConfigurationRestore(
  transaction: PgClient,
  actor: Principal,
  backup: ConfigurationBackup,
  server: Pick<
    ConfigurationBackupContext,
    "allowPrivateWebhookEndpoints" | "deploymentModelPresetKeys"
  >,
  options: {
    /**
     * Lock each existing target project until the transaction ends. Every
     * configuration table has a foreign key to its project, and inserting
     * such a row takes a key-share lock on the project that this lock
     * conflicts with: a concurrent write either finishes before the empty
     * check, which then sees it, or waits until the restore commits.
     */
    readonly lockTargetProjects?: boolean;
  } = {},
): Promise<RestorePlanState> {
  const organizationId = actor.organizationId;
  const conflicts: { kind: string; message: string }[] =
    checkConfigurationBackupReferences(backup).map((message) => ({
      kind: "backup",
      message,
    }));
  const warnings: string[] = [];

  const collisions: readonly [string, string, readonly string[]][] = [
    [
      "model_provider",
      `SELECT provider_key AS key FROM oao.project_model_providers
        WHERE organization_id=$1 AND archived_at IS NULL AND provider_key=ANY($2)`,
      backup.modelProviders.filter((p) => !p.archived).map((p) => p.key),
    ],
    [
      "sandbox_provider",
      `SELECT provider_key AS key FROM oao.project_sandbox_providers
        WHERE organization_id=$1 AND provider_key=ANY($2)`,
      backup.sandboxProviders.map((p) => p.key),
    ],
    [
      "storage_provider",
      `SELECT provider_key AS key FROM oao.project_storage_providers
        WHERE organization_id=$1 AND provider_key=ANY($2)`,
      backup.storageProviders.map((p) => p.key),
    ],
    [
      "mcp_server",
      `SELECT server_key AS key FROM oao.mcp_servers
        WHERE organization_id=$1 AND server_key=ANY($2) AND revoked_at IS NULL`,
      backup.mcpServers.map((p) => p.key),
    ],
    [
      "mcp_credential",
      `SELECT credential_key AS key FROM oao.mcp_credentials
        WHERE organization_id=$1 AND credential_key=ANY($2) AND revoked_at IS NULL`,
      backup.mcpCredentials.map((p) => p.key),
    ],
    [
      "mcp_credential_policy",
      `SELECT policy_key AS key FROM oao.mcp_credential_policies
        WHERE organization_id=$1 AND policy_key=ANY($2) AND revoked_at IS NULL`,
      backup.mcpCredentialPolicies.map((p) => p.key),
    ],
  ];
  const labels: Readonly<Record<string, string>> = {
    model_provider: "model provider",
    sandbox_provider: "sandbox provider",
    storage_provider: "storage provider",
    mcp_server: "MCP server",
    mcp_credential: "MCP credential",
    mcp_credential_policy: "MCP credential policy",
  };
  for (const [kind, sql, keys] of collisions)
    for (const key of await liveKeys(transaction, sql, organizationId, keys))
      conflicts.push({
        kind,
        message: `The organization already has a ${labels[kind]} with the key ${key}.`,
      });

  let keepExistingDefaultStorage = false;
  const backupDefault = backup.storageProviders.find((p) => p.default);
  if (backupDefault) {
    const existingDefault = await transaction.query(
      `SELECT 1 FROM oao.project_storage_providers
        WHERE organization_id=$1 AND is_default`,
      [organizationId],
    );
    if (existingDefault.rowCount) {
      keepExistingDefaultStorage = true;
      warnings.push(
        `The organization already has a default storage provider, so ${backupDefault.key} is restored as an additional, non-default provider.`,
      );
    }
  }

  const targets: ProjectTarget[] = [];
  for (const project of backup.projects) {
    const existing = await transaction.query<{ id: string }>(
      `SELECT id FROM oao.projects WHERE organization_id=$1 AND slug=$2${
        options.lockTargetProjects ? " FOR UPDATE" : ""
      }`,
      [organizationId, project.slug],
    );
    const projectId = existing.rows[0]?.id;
    if (!projectId) {
      targets.push({ ...project, projectId: null, action: "create" });
    } else {
      await useProject(transaction, organizationId, projectId);
      const contents = await transaction.query<Row>(
        `SELECT
           (SELECT count(*)::int FROM oao.agent_definitions WHERE organization_id=$1 AND project_id=$2) AS agents,
           (SELECT count(*)::int FROM oao.skills WHERE organization_id=$1 AND project_id=$2) AS skills,
           (SELECT count(*)::int FROM oao.project_model_presets WHERE organization_id=$1 AND project_id=$2) AS presets,
           (SELECT count(*)::int FROM oao.mcp_toolsets WHERE organization_id=$1 AND project_id=$2) AS toolsets,
           (SELECT count(*)::int FROM oao.event_webhooks WHERE organization_id=$1 AND project_id=$2) AS webhooks`,
        [organizationId, projectId],
      );
      const counts = contents.rows[0] ?? {};
      const held = [
        ["agents", "agent"],
        ["skills", "Skill"],
        ["presets", "model preset"],
        ["toolsets", "MCP toolset"],
        ["webhooks", "event webhook"],
      ]
        .map(([column, noun]) => {
          const count = Number(counts[column!] ?? 0);
          return count > 0 ? `${count} ${noun}${count === 1 ? "" : "s"}` : "";
        })
        .filter(Boolean);
      if (held.length > 0) {
        targets.push({ ...project, projectId, action: "blocked" });
        conflicts.push({
          kind: "project",
          message: `Project ${project.slug} already has configuration (${held.join(", ")}). Restore only fills empty projects.`,
        });
      } else
        targets.push({ ...project, projectId, action: "use_empty_project" });
    }
    if (project.eventWebhooks.length > MAX_EVENT_WEBHOOKS_PER_PROJECT)
      conflicts.push({
        kind: "event_webhook",
        message: `Project ${project.slug} has more than ${MAX_EVENT_WEBHOOKS_PER_PROJECT} event webhooks.`,
      });
    for (const webhook of project.eventWebhooks) {
      const problem = webhookEndpointProblem(
        webhook.endpointUrl,
        server.allowPrivateWebhookEndpoints,
      );
      if (problem)
        conflicts.push({
          kind: "event_webhook",
          message: `Event webhook ${webhook.displayName} in project ${project.slug}: ${problem}`,
        });
    }
  }
  await useProject(transaction, organizationId, actor.projectId);

  for (const project of backup.projects) {
    const presets = new Set(project.modelPresets.map((preset) => preset.key));
    const unavailable = new Set(
      project.agents.flatMap((agent) =>
        agent.versions.flatMap((version) => {
          const key = version.config.modelPreset;
          return typeof key === "string" &&
            !presets.has(key) &&
            !server.deploymentModelPresetKeys.has(key)
            ? [key]
            : [];
        }),
      ),
    );
    for (const key of unavailable)
      warnings.push(
        `Agents in project ${project.slug} use the model preset ${key}, which is neither in the backup nor offered by this server. Publish new versions with an available preset before running them.`,
      );
  }
  if (
    backup.projects.some((project) =>
      project.agents.some((agent) =>
        agent.versions.some((version) => {
          const sandbox = version.config.sandbox as
            Readonly<Record<string, unknown>> | undefined;
          return sandbox?.enabled === true;
        }),
      ),
    )
  )
    warnings.push(
      "Agents with a sandbox keep their Daytona snapshot IDs. Restore into the same Daytona account, or publish new versions with a snapshot from the new account.",
    );

  const requiredCredentials: ConfigurationRestorePlan["requiredCredentials"] = [
    ...backup.modelProviders
      .filter((provider) => !provider.archived)
      .map((provider) => ({
        kind: "model_provider" as const,
        id: provider.id,
        key: provider.key,
        displayName: provider.displayName,
        providerType: provider.providerType,
        projectSlug: null,
        credentialFingerprint: provider.credentialFingerprint,
      })),
    ...backup.sandboxProviders.map((provider) => ({
      kind: "sandbox_provider" as const,
      id: provider.id,
      key: provider.key,
      displayName: provider.displayName,
      providerType: provider.providerType,
      projectSlug: null,
      credentialFingerprint: provider.credentialFingerprint,
    })),
    ...backup.storageProviders.map((provider) => ({
      kind: "storage_provider" as const,
      id: provider.id,
      key: provider.key,
      displayName: provider.displayName,
      providerType: provider.providerType,
      projectSlug: null,
      credentialFingerprint: provider.credentialFingerprint,
    })),
    ...backup.mcpCredentials
      .filter((credential) => credential.status === "active")
      .map((credential) => ({
        kind: "mcp_credential" as const,
        id: credential.id,
        key: credential.key,
        displayName: credential.displayName,
        providerType: credential.kind,
        projectSlug: null,
        credentialFingerprint: credential.credentialFingerprint,
      })),
    ...backup.projects.flatMap((project) =>
      project.eventWebhooks.map((webhook) => ({
        kind: "event_webhook" as const,
        id: webhook.id,
        key: null,
        displayName: webhook.displayName,
        providerType: null,
        projectSlug: project.slug,
        credentialFingerprint: webhook.credentialFingerprint,
      })),
    ),
  ];

  return {
    plan: {
      organization: backup.organization,
      exportedAt: backup.exportedAt,
      ready: conflicts.length === 0,
      projects: targets.map((target) => ({
        slug: target.slug,
        name: target.name,
        action: target.action,
        projectId: target.projectId,
      })),
      requiredCredentials,
      conflicts,
      warnings,
      counts: configurationBackupCounts(backup),
    },
    targets,
    keepExistingDefaultStorage,
  };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** Runs one restore step and names the resource when the database rejects it. */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpApiError)
      throw new HttpApiError(error.code, `${label}: ${error.message}`);
    try {
      mapPostgresError(error);
    } catch (mapped) {
      if (mapped instanceof HttpApiError)
        throw new HttpApiError(mapped.code, `${label}: ${mapped.message}`);
    }
    throw error;
  }
}

function missingCredentials(
  plan: ConfigurationRestorePlan,
  credentials: ConfigurationRestoreCredentials,
): readonly string[] {
  const supplied: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
    {
      model_provider: credentials.modelProviders,
      sandbox_provider: credentials.sandboxProviders,
      storage_provider: credentials.storageProviders,
      mcp_credential: credentials.mcpCredentials,
      event_webhook: credentials.eventWebhooks,
    };
  return plan.requiredCredentials
    .filter((required) => supplied[required.kind]?.[required.id] === undefined)
    .map((required) =>
      required.projectSlug
        ? `${required.displayName} (${required.projectSlug})`
        : `${required.displayName} (${required.key})`,
    );
}

function unexpectedCredentials(
  plan: ConfigurationRestorePlan,
  credentials: ConfigurationRestoreCredentials,
): readonly string[] {
  const required = new Set(
    plan.requiredCredentials.map((entry) => `${entry.kind}:${entry.id}`),
  );
  const supplied: readonly [string, Readonly<Record<string, unknown>>][] = [
    ["model_provider", credentials.modelProviders],
    ["sandbox_provider", credentials.sandboxProviders],
    ["storage_provider", credentials.storageProviders],
    ["mcp_credential", credentials.mcpCredentials],
    ["event_webhook", credentials.eventWebhooks],
  ];
  return supplied.flatMap(([kind, values]) =>
    Object.keys(values)
      .filter((id) => !required.has(`${kind}:${id}`))
      .map((id) => `${kind} ${id}`),
  );
}

class IdMap {
  readonly #ids = new Map<string, string>();

  add(sourceId: string): string {
    const id = randomUUID();
    this.#ids.set(sourceId, id);
    return id;
  }

  get(sourceId: unknown, label: string): string {
    const id = this.#ids.get(String(sourceId));
    if (!id)
      throw new HttpApiError(
        "bad_request",
        `${label} refers to an entry that is not in the backup`,
      );
    return id;
  }
}

function remapAgentConfig(
  config: Readonly<Record<string, unknown>>,
  ids: IdMap,
  label: string,
): Record<string, unknown> {
  const remapped: Record<string, unknown> = { ...config };
  if (Array.isArray(config.skillVersionIds))
    remapped.skillVersionIds = config.skillVersionIds.map((id) =>
      ids.get(id, label),
    );
  if (Array.isArray(config.skillIds))
    remapped.skillIds = config.skillIds.map((id) => ids.get(id, label));
  if (Array.isArray(config.mcpBindings))
    remapped.mcpBindings = config.mcpBindings.map((binding) => {
      const entry = binding as Readonly<Record<string, unknown>>;
      return {
        ...entry,
        toolsetVersionId: ids.get(entry.toolsetVersionId, label),
        credentialPolicyVersionId: ids.get(
          entry.credentialPolicyVersionId,
          label,
        ),
      };
    });
  if (Array.isArray(config.delegates))
    remapped.delegates = config.delegates.map((delegate) => {
      const entry = delegate as Readonly<Record<string, unknown>>;
      // A delegate follows an agent or pins a version of one.
      return entry.agentId === undefined
        ? { ...entry, agentVersionId: ids.get(entry.agentVersionId, label) }
        : { ...entry, agentId: ids.get(entry.agentId, label) };
    });
  return remapped;
}

async function projectPrincipal(
  transaction: PgClient,
  actor: Principal,
  projectId: string,
): Promise<Principal> {
  // Restored rows are attributed to the restoring user in every project, as
  // project creation does; this grants no project membership.
  await transaction.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (organization_id,project_id,kind,subject) DO NOTHING`,
    [
      actor.organizationId,
      projectId,
      randomUUID(),
      actor.kind,
      actor.subject,
      [...actor.scopes],
    ],
  );
  const result = await transaction.query<{ id: string }>(
    `SELECT id FROM oao.principals
      WHERE organization_id=$1 AND project_id=$2 AND kind=$3 AND subject=$4`,
    [actor.organizationId, projectId, actor.kind, actor.subject],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Restore principal was not created");
  return {
    ...actor,
    projectId: projectId as Principal["projectId"],
    id: id as Principal["id"],
  };
}

const WIPED_CREDENTIAL = [
  Buffer.from("00", "hex"),
  Buffer.alloc(12),
  Buffer.alloc(16),
  "0".repeat(64),
] as const;

async function restoreConnections(
  transaction: PgClient,
  actor: Principal,
  backup: ConfigurationBackup,
  credentials: ConfigurationRestoreCredentials,
  cipher: ProviderCredentialCipher,
  ids: IdMap,
  keepExistingDefaultStorage: boolean,
): Promise<void> {
  const org = actor.organizationId;
  for (const provider of backup.modelProviders)
    await step(`Model provider ${provider.key}`, async () => {
      const id = ids.add(provider.id);
      const apiKey = credentials.modelProviders[provider.id];
      const encrypted =
        provider.archived || apiKey === undefined
          ? undefined
          : cipher.encrypt(apiKey, {
              organizationId: org,
              providerId: id,
              providerType: provider.providerType,
              keyVersion: 1,
            });
      // An archived connection keeps its identity for the presets that
      // pinned it, with the same wiped credential archiving leaves behind.
      const [ciphertext, nonce, tag, fingerprintValue] = encrypted
        ? [
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.tag,
            encrypted.fingerprint,
          ]
        : WIPED_CREDENTIAL;
      await transaction.query(
        `INSERT INTO oao.project_model_providers
           (organization_id,id,provider_key,display_name,provider_type,
            encrypted_api_key,encryption_nonce,encryption_tag,encryption_key_version,
            credential_fingerprint,created_by_principal_id,archived_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                 CASE WHEN $12 THEN clock_timestamp() END)`,
        [
          org,
          id,
          provider.key,
          provider.displayName,
          provider.providerType,
          ciphertext,
          nonce,
          tag,
          encrypted ? encrypted.keyVersion : 2,
          fingerprintValue,
          actor.id,
          provider.archived,
        ],
      );
    });

  for (const provider of backup.sandboxProviders)
    await step(`Sandbox provider ${provider.key}`, async () => {
      const id = ids.add(provider.id);
      const encrypted = cipher.encrypt(
        credentials.sandboxProviders[provider.id]!,
        {
          organizationId: org,
          providerId: id,
          providerType: "daytona",
          keyVersion: 1,
        },
      );
      await transaction.query(
        `INSERT INTO oao.project_sandbox_providers
           (organization_id,id,provider_key,display_name,provider_type,
            encrypted_api_key,encryption_nonce,encryption_tag,encryption_key_version,
            credential_fingerprint,target,restricted_egress,created_by_principal_id)
         VALUES ($1,$2,$3,$4,'daytona',$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          org,
          id,
          provider.key,
          provider.displayName,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          encrypted.keyVersion,
          encrypted.fingerprint,
          provider.target,
          provider.restrictedEgress,
          actor.id,
        ],
      );
    });

  for (const provider of backup.storageProviders)
    await step(`Storage provider ${provider.key}`, async () => {
      const id = ids.add(provider.id);
      const supplied = credentials.storageProviders[provider.id]!;
      const encrypted = cipher.encrypt(
        JSON.stringify({
          accessKeyId: supplied.accessKeyId,
          secretAccessKey: supplied.secretAccessKey,
          ...(supplied.sessionToken
            ? { sessionToken: supplied.sessionToken }
            : {}),
        }),
        {
          organizationId: org,
          providerId: id,
          providerType: "s3",
          keyVersion: 1,
        },
      );
      await transaction.query(
        `INSERT INTO oao.project_storage_providers (
           organization_id,id,provider_key,display_name,provider_type,
           endpoint,region,bucket,object_prefix,force_path_style,is_default,
           encrypted_credential,encryption_nonce,encryption_tag,
           encryption_key_version,credential_fingerprint,created_by_principal_id
         ) VALUES ($1,$2,$3,$4,'s3',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          org,
          id,
          provider.key,
          provider.displayName,
          provider.endpoint,
          provider.region,
          provider.bucket,
          provider.prefix,
          provider.forcePathStyle,
          provider.default && !keepExistingDefaultStorage,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          encrypted.keyVersion,
          encrypted.fingerprint,
          actor.id,
        ],
      );
    });

  for (const server of backup.mcpServers)
    await step(`MCP server ${server.key}`, async () => {
      const serverId = ids.add(server.id);
      await transaction.query(
        `INSERT INTO oao.mcp_servers (
           organization_id,id,server_key,display_name,created_by_principal_id,
           revoked_at
         ) VALUES ($1,$2,$3,$4,$5,CASE WHEN $6 THEN clock_timestamp() END)`,
        [
          org,
          serverId,
          server.key,
          server.displayName,
          actor.id,
          server.versions.at(-1)?.status === "revoked",
        ],
      );
      let latest = "";
      for (const version of server.versions) {
        latest = ids.add(version.id);
        await transaction.query(
          `INSERT INTO oao.mcp_server_versions (
             organization_id,id,server_id,version,endpoint_url,transport,
             content_hash,created_by_principal_id
           ) VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8)`,
          [
            org,
            latest,
            serverId,
            version.version,
            version.endpointUrl,
            version.transport,
            version.contentHash,
            actor.id,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.mcp_server_version_lifecycle (
             organization_id,server_version_id,status,updated_by_principal_id
           ) VALUES ($1,$2,$3,$4)`,
          [org, latest, version.status, actor.id],
        );
        for (const tool of version.tools)
          await transaction.query(
            `INSERT INTO oao.mcp_server_version_tools (
               organization_id,server_version_id,remote_tool_name,
               title,description,input_schema,output_schema,schema_hash
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,decode($8,'hex'))`,
            [
              org,
              latest,
              tool.name,
              tool.title,
              tool.description,
              tool.inputSchema,
              tool.outputSchema,
              tool.schemaHash,
            ],
          );
      }
      await transaction.query(
        `UPDATE oao.mcp_servers SET latest_version_id=$3
          WHERE organization_id=$1 AND id=$2`,
        [org, serverId, latest],
      );
    });

  for (const credential of backup.mcpCredentials)
    await step(`MCP credential ${credential.key}`, async () => {
      const credentialId = ids.add(credential.id);
      const versionId = randomUUID();
      // A revoked credential is restored revoked, with a random secret
      // nobody knows, so its policies and bindings keep their history.
      const secret =
        credential.status === "active"
          ? credentials.mcpCredentials[credential.id]!
          : randomBytes(32).toString("base64url");
      const encrypted = cipher.encrypt(secret, {
        organizationId: org,
        providerId: credentialId,
        providerType: "mcp",
        keyVersion: 1,
      });
      const oauth =
        credential.kind === "oauth_client_credentials"
          ? credential.oauth
          : null;
      const destination = oauth
        ? mcpResourceDestination(oauth.resource)
        : credential.destination
          ? {
              origin: canonicalMcpOrigin(credential.destination.origin),
              pathPrefix: credential.destination.pathPrefix,
            }
          : null;
      await transaction.query(
        `INSERT INTO oao.mcp_credentials (
           organization_id,id,credential_key,display_name,
           credential_kind,header_name,created_by_principal_id,revoked_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN clock_timestamp() END)`,
        [
          org,
          credentialId,
          credential.key,
          credential.displayName,
          credential.kind,
          credential.headerName,
          actor.id,
          credential.status === "revoked",
        ],
      );
      await transaction.query(
        `INSERT INTO oao.mcp_credential_versions (
           organization_id,id,credential_id,version,credential_kind,
           encrypted_secret,encryption_nonce,encryption_tag,encryption_key_version,
           credential_fingerprint,destination_origin,destination_path_prefix,
           oauth_issuer,oauth_token_endpoint,oauth_client_id,
           oauth_token_endpoint_auth_method,oauth_scope,oauth_resource,
           oauth_resource_metadata_url,oauth_send_resource,created_by_principal_id
         ) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          org,
          versionId,
          credentialId,
          credential.kind,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          encrypted.keyVersion,
          mcpCredentialFingerprint(encrypted.fingerprint, secret, oauth),
          destination?.origin ?? null,
          destination?.pathPrefix ?? null,
          oauth?.issuer ?? null,
          oauth?.tokenEndpoint ?? null,
          oauth?.clientId ?? null,
          oauth?.tokenEndpointAuthMethod ?? null,
          oauth?.scope ?? null,
          oauth?.resource ?? null,
          oauth?.resourceMetadataUrl ?? null,
          oauth?.sendResource ?? null,
          actor.id,
        ],
      );
      await transaction.query(
        `INSERT INTO oao.mcp_credential_version_lifecycle (
           organization_id,credential_version_id,status,updated_by_principal_id
         ) VALUES ($1,$2,$3,$4)`,
        [org, versionId, credential.status, actor.id],
      );
      await transaction.query(
        `UPDATE oao.mcp_credentials SET active_version_id=$3
          WHERE organization_id=$1 AND id=$2`,
        [org, credentialId, versionId],
      );
    });

  for (const policy of backup.mcpCredentialPolicies)
    await step(`MCP credential policy ${policy.key}`, async () => {
      const policyId = ids.add(policy.id);
      await transaction.query(
        `INSERT INTO oao.mcp_credential_policies (
           organization_id,id,policy_key,display_name,created_by_principal_id,
           revoked_at
         ) VALUES ($1,$2,$3,$4,$5,CASE WHEN $6 THEN clock_timestamp() END)`,
        [
          org,
          policyId,
          policy.key,
          policy.displayName,
          actor.id,
          policy.versions.at(-1)?.status === "revoked",
        ],
      );
      let latest = "";
      for (const version of policy.versions) {
        latest = ids.add(version.id);
        await transaction.query(
          `INSERT INTO oao.mcp_credential_policy_versions (
             organization_id,id,policy_id,version,credential_id,
             exact_origin,path_prefix,timeout_ms,maximum_response_bytes,
             forward_call_context,content_hash,created_by_principal_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,decode($11,'hex'),$12)`,
          [
            org,
            latest,
            policyId,
            version.version,
            ids.get(
              version.credentialId,
              `MCP credential policy ${policy.key}`,
            ),
            version.exactOrigin,
            version.pathPrefix,
            version.timeoutMs,
            version.maximumResponseBytes,
            version.forwardCallContext,
            version.contentHash,
            actor.id,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.mcp_credential_policy_version_lifecycle (
             organization_id,policy_version_id,status,updated_by_principal_id
           ) VALUES ($1,$2,$3,$4)`,
          [org, latest, version.status, actor.id],
        );
      }
      await transaction.query(
        `UPDATE oao.mcp_credential_policies SET latest_version_id=$3
          WHERE organization_id=$1 AND id=$2`,
        [org, policyId, latest],
      );
    });
}

async function restoreProject(
  transaction: PgClient,
  context: ConfigurationBackupContext,
  projectActor: Principal,
  project: ConfigurationBackupProject,
  credentials: ConfigurationRestoreCredentials,
  cipher: ProviderCredentialCipher,
  ids: IdMap,
): Promise<void> {
  const scope = [projectActor.organizationId, projectActor.projectId] as const;
  const where = `Project ${project.slug}`;

  for (const preset of project.modelPresets)
    await step(`${where}, model preset ${preset.key}`, async () => {
      const presetId = ids.add(preset.id);
      await transaction.query(
        `INSERT INTO oao.project_model_presets
           (organization_id,project_id,id,preset_key,display_name,provider_id,
            model,routing,settings,created_by_principal_id,archived_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 CASE WHEN $11 THEN clock_timestamp() END)`,
        [
          ...scope,
          presetId,
          preset.key,
          preset.displayName,
          ids.get(preset.providerId, `Model preset ${preset.key}`),
          preset.model,
          preset.routing,
          preset.settings,
          projectActor.id,
          preset.archived,
        ],
      );
      for (const { id, validFrom, ...rates } of preset.prices)
        await insertModelPresetPrice(transaction, {
          tenant: projectActor,
          id: ids.add(id),
          presetId,
          rates,
          validFrom,
          createdByPrincipalId: projectActor.id,
        });
      for (const { id, createdAt, ...limits } of preset.limits)
        await insertModelPresetLimits(transaction, {
          tenant: projectActor,
          id: ids.add(id),
          presetId,
          limits,
          createdAt,
          createdByPrincipalId: projectActor.id,
        });
    });

  for (const skill of project.skills)
    await step(`${where}, Skill ${skill.key}`, async () => {
      const skillId = ids.add(skill.id);
      await transaction.query(
        `INSERT INTO oao.skills (
           organization_id,project_id,id,skill_key,display_name,
           created_by_principal_id,disabled_at,archived_at
         ) VALUES ($1,$2,$3,$4,$5,$6,
                   CASE WHEN $7 THEN clock_timestamp() END,
                   CASE WHEN $8 THEN clock_timestamp() END)`,
        [
          ...scope,
          skillId,
          skill.key,
          skill.displayName,
          projectActor.id,
          skill.disabled,
          skill.archived,
        ],
      );
      let latest = "";
      for (const version of skill.versions) {
        const input = context.parseSkillVersionInput({
          name: version.name,
          description: version.description,
          instructions: version.instructions,
          ...(version.license ? { license: version.license } : {}),
          ...(version.compatibility
            ? { compatibility: version.compatibility }
            : {}),
          metadata: version.metadata,
          ...(version.allowedTools
            ? { allowedTools: version.allowedTools }
            : {}),
          files: version.files,
        });
        latest = ids.add(version.id);
        await transaction.query(
          `INSERT INTO oao.skill_versions (
             organization_id,project_id,id,skill_id,version,skill_name,description,
             instructions,license,compatibility,metadata,allowed_tools,content_hash,
             total_bytes,created_by_principal_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,decode($13,'hex'),$14,$15)`,
          [
            ...scope,
            latest,
            skillId,
            version.version,
            input.name,
            input.description,
            input.instructions,
            input.license ?? null,
            input.compatibility ?? null,
            input.metadata,
            input.allowedTools ?? null,
            input.contentHash,
            input.totalBytes,
            projectActor.id,
          ],
        );
        for (const file of input.files)
          await transaction.query(
            `INSERT INTO oao.skill_version_files (
               organization_id,project_id,skill_version_id,file_path,content_type,
               size_bytes,content_sha256,content_bytes
             ) VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8)`,
            [
              ...scope,
              latest,
              file.path,
              file.contentType,
              file.sizeBytes,
              file.sha256,
              file.bytes,
            ],
          );
        await transaction.query(
          `INSERT INTO oao.skill_version_lifecycle (
             organization_id,project_id,skill_version_id,status,updated_by_principal_id
           ) VALUES ($1,$2,$3,$4,$5)`,
          [...scope, latest, version.status, projectActor.id],
        );
      }
      await transaction.query(
        `UPDATE oao.skills SET latest_version_id=$4
          WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
        [...scope, skillId, latest],
      );
    });

  for (const toolset of project.mcpToolsets)
    await step(`${where}, MCP toolset ${toolset.key}`, async () => {
      const toolsetId = ids.add(toolset.id);
      await transaction.query(
        `INSERT INTO oao.mcp_toolsets (
           organization_id,project_id,id,toolset_key,display_name,created_by_principal_id,
           revoked_at
         ) VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN clock_timestamp() END)`,
        [
          ...scope,
          toolsetId,
          toolset.key,
          toolset.displayName,
          projectActor.id,
          toolset.versions.at(-1)?.status === "revoked",
        ],
      );
      let latest = "";
      for (const version of toolset.versions) {
        latest = ids.add(version.id);
        const serverVersionId = ids.get(
          version.serverVersionId,
          `MCP toolset ${toolset.key}`,
        );
        await transaction.query(
          `INSERT INTO oao.mcp_toolset_versions (
             organization_id,project_id,id,toolset_id,version,server_version_id,
             content_hash,created_by_principal_id
           ) VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8)`,
          [
            ...scope,
            latest,
            toolsetId,
            version.version,
            serverVersionId,
            version.contentHash,
            projectActor.id,
          ],
        );
        for (const tool of version.tools)
          await transaction.query(
            `INSERT INTO oao.mcp_toolset_version_tools (
               organization_id,project_id,toolset_version_id,server_version_id,
               remote_tool_name,approval
             ) VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              ...scope,
              latest,
              serverVersionId,
              tool.remoteToolName,
              tool.approval,
            ],
          );
        await transaction.query(
          `INSERT INTO oao.mcp_toolset_version_lifecycle (
             organization_id,project_id,toolset_version_id,status,updated_by_principal_id
           ) VALUES ($1,$2,$3,$4,$5)`,
          [...scope, latest, version.status, projectActor.id],
        );
      }
      await transaction.query(
        `UPDATE oao.mcp_toolsets SET latest_version_id=$4
          WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
        [...scope, toolsetId, latest],
      );
    });

  const latestAgentVersions = new Map<string, string>();
  for (const agent of project.agents)
    await step(`${where}, agent ${agent.key}`, async () => {
      await transaction.query(
        `INSERT INTO oao.agent_definitions
           (organization_id,project_id,id,agent_key,name,description,archived_at)
         VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN clock_timestamp() END)`,
        [
          ...scope,
          ids.add(agent.id),
          agent.key,
          agent.name,
          agent.description,
          agent.archived,
        ],
      );
    });
  // Delegates are published before the coordinator versions that name them.
  const versions = agentVersionPublicationOrder(project.agents);
  if (!versions)
    throw new HttpApiError(
      "bad_request",
      `${where}: agent versions delegate to each other in a cycle`,
    );
  for (const { agent, version } of versions)
    await step(
      `${where}, agent ${agent.key} version ${version.version}`,
      async () => {
        const label = `Agent ${agent.key} version ${version.version}`;
        const config = remapAgentConfig(version.config, ids, label);
        assertPublicPayload(config as Readonly<Record<string, PublicValue>>);
        const valid = await transaction.query<{ valid: boolean }>(
          "SELECT oao.is_valid_agent_publication_config_with_mcp($1) AS valid",
          [config],
        );
        if (valid.rows[0]?.valid !== true)
          throw new HttpApiError(
            "bad_request",
            "the configuration does not match the agent publication contract",
          );
        const agentId = ids.get(agent.id, label);
        const versionId = ids.add(version.id);
        await transaction.query(
          `INSERT INTO oao.agent_versions (
           organization_id,project_id,id,agent_definition_id,version,config,
           content_hash,created_by_principal_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            ...scope,
            versionId,
            agentId,
            version.version,
            config,
            Buffer.from(requestHash(config)),
            projectActor.id,
          ],
        );
        await transaction.query(
          `INSERT INTO oao.agent_version_skill_bindings (
           organization_id,project_id,agent_version_id,skill_version_id,skill_name
         )
         SELECT $1,$2,$3,sv.id,sv.skill_name FROM oao.skill_versions sv
          WHERE sv.organization_id=$1 AND sv.project_id=$2 AND sv.id=ANY($4::uuid[])`,
          [
            ...scope,
            versionId,
            (config.skillVersionIds as string[] | undefined) ?? [],
          ],
        );
        for (const binding of (config.mcpBindings ?? []) as readonly Readonly<
          Record<string, unknown>
        >[])
          await transaction.query(
            `INSERT INTO oao.agent_version_mcp_bindings (
             organization_id,project_id,agent_version_id,toolset_version_id,
             credential_policy_version_id,namespace
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              ...scope,
              versionId,
              binding.toolsetVersionId,
              binding.credentialPolicyVersionId,
              binding.namespace,
            ],
          );
        latestAgentVersions.set(agentId, versionId);
      },
    );
  for (const [agentId, versionId] of latestAgentVersions)
    await transaction.query(
      `UPDATE oao.agent_definitions SET latest_version_id=$4
        WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
      [...scope, agentId, versionId],
    );

  if (project.eventWebhooks.length > 0) {
    const position = await transaction.query<{ committed_position: string }>(
      `SELECT committed_position::text FROM oao.project_event_positions
        WHERE organization_id=$1 AND project_id=$2`,
      [...scope],
    );
    const deliveredPosition = position.rows[0]?.committed_position ?? "0";
    for (const webhook of project.eventWebhooks)
      await step(`${where}, event webhook ${webhook.displayName}`, async () => {
        const webhookId = ids.add(webhook.id);
        const endpoint = validateWebhookEndpoint(webhook.endpointUrl, {
          allowPrivateNetwork: context.allowPrivateWebhookEndpoints,
        });
        const encrypted = cipher.encrypt(
          credentials.eventWebhooks[webhook.id]!,
          {
            organizationId: projectActor.organizationId,
            providerId: webhookId,
            providerType: "event_webhook",
            keyVersion: 1,
          },
        );
        // Delivery starts from now: a restored endpoint never receives the
        // events this project produced before it existed.
        await transaction.query(
          `INSERT INTO oao.event_webhooks
             (organization_id,project_id,id,display_name,endpoint_url,enabled,disabled_reason,
              event_kinds,include_message_content,encrypted_signing_key,encryption_nonce,
              encryption_tag,encryption_key_version,credential_fingerprint,
              delivered_position,created_by_principal_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            ...scope,
            webhookId,
            webhook.displayName,
            endpoint.href,
            webhook.enabled,
            webhook.enabled ? null : (webhook.disabledReason ?? "user"),
            webhook.eventKinds,
            webhook.includeMessageContent,
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.tag,
            encrypted.keyVersion,
            encrypted.fingerprint,
            deliveredPosition,
            projectActor.id,
          ],
        );
      });
  }
}

/**
 * Restores a backup as an exact copy: new projects (or empty ones with the
 * same slug), the shared connections, and every version with its lifecycle
 * state. Runs in the caller's transaction, so it either completes or leaves
 * nothing behind.
 */
export async function restoreOrganizationConfiguration(
  transaction: PgClient,
  context: ConfigurationBackupContext,
  actor: Principal,
  backup: ConfigurationBackup,
  credentials: ConfigurationRestoreCredentials,
): Promise<ConfigurationRestoreResult> {
  const cipher = context.credentialCipher;
  if (!cipher)
    throw new HttpApiError(
      "internal_error",
      "Provider credential encryption is not configured",
    );
  const { plan, targets, keepExistingDefaultStorage } =
    await planConfigurationRestore(transaction, actor, backup, context, {
      lockTargetProjects: true,
    });
  if (!plan.ready)
    throw new HttpApiError(
      "conflict",
      `Restore is blocked: ${plan.conflicts.map((conflict) => conflict.message).join(" ")}`,
    );
  const missing = missingCredentials(plan, credentials);
  if (missing.length > 0)
    throw new HttpApiError(
      "bad_request",
      `Enter the credentials for: ${missing.join(", ")}`,
    );
  const unexpected = unexpectedCredentials(plan, credentials);
  if (unexpected.length > 0)
    throw new HttpApiError(
      "bad_request",
      `Credentials were given for entries this backup does not need: ${unexpected.join(", ")}`,
    );

  const ids = new IdMap();
  await restoreConnections(
    transaction,
    actor,
    backup,
    credentials,
    cipher,
    ids,
    keepExistingDefaultStorage,
  );

  const restoredProjects: ConfigurationRestoreResult["projects"] = [];
  for (const [index, project] of backup.projects.entries()) {
    const target = targets[index]!;
    let projectId = target.projectId;
    if (target.action === "create") {
      projectId = randomUUID();
      // Project creation copies the restoring user's identity rows, which
      // it reads under the user's own project.
      await useProject(transaction, actor.organizationId, actor.projectId);
      await step(`Project ${project.slug}`, () =>
        transaction.query(
          "SELECT * FROM oao.create_organization_project($1,$2,$3,$4,$5)",
          [
            actor.organizationId,
            projectId,
            project.slug,
            project.name,
            actor.id,
          ],
        ),
      );
    } else {
      // A filled empty project takes the backup's name, as the preview shows.
      await useProject(transaction, actor.organizationId, projectId!);
      await step(`Project ${project.slug}`, () =>
        transaction.query(
          "UPDATE oao.projects SET name=$3 WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, projectId, project.name],
        ),
      );
    }
    await useProject(transaction, actor.organizationId, projectId!);
    const projectActor = await projectPrincipal(transaction, actor, projectId!);
    await restoreProject(
      transaction,
      context,
      projectActor,
      project,
      credentials,
      cipher,
      ids,
    );
    const counts = configurationBackupCounts({
      ...backup,
      projects: [project],
    });
    await context.store.appendAudit(transaction, projectActor, {
      action: "configuration.restored",
      resourceType: "project",
      resourceId: projectId!,
      detail: {
        exportedAt: backup.exportedAt,
        sourceOrganization: backup.organization.slug,
        agents: counts.agents,
        agentVersions: counts.agentVersions,
        skills: counts.skills,
        skillVersions: counts.skillVersions,
        modelPresets: counts.modelPresets,
        mcpToolsets: counts.mcpToolsets,
        eventWebhooks: counts.eventWebhooks,
      },
    });
    restoredProjects.push({
      slug: project.slug,
      projectId: projectId!,
      created: target.action === "create",
    });
  }
  // A failed statement aborts the transaction, which then rolls back, so
  // the project context is only reset after success. Resetting in a
  // `finally` would replace the error that names the failed resource.
  await useProject(transaction, actor.organizationId, actor.projectId);
  const counts = configurationBackupCounts(backup);
  await context.store.appendAudit(transaction, actor, {
    action: "configuration.restored",
    resourceType: "organization",
    resourceId: actor.organizationId,
    detail: {
      exportedAt: backup.exportedAt,
      sourceOrganization: backup.organization.slug,
      projects: counts.projects,
      modelProviders: counts.modelProviders,
      sandboxProviders: counts.sandboxProviders,
      storageProviders: counts.storageProviders,
      mcpServers: counts.mcpServers,
      mcpCredentials: counts.mcpCredentials,
      mcpCredentialPolicies: counts.mcpCredentialPolicies,
    },
  });
  return {
    restored: true,
    projects: restoredProjects,
    counts,
    warnings: plan.warnings,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function parseBackupBody<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    const issue =
      error && typeof error === "object" && "issues" in error
        ? (
            error as {
              issues: readonly {
                message: string;
                path?: readonly { key: unknown }[];
              }[];
            }
          ).issues[0]
        : undefined;
    const path = issue?.path?.map((entry) => String(entry.key)).join(".");
    throw new HttpApiError(
      "bad_request",
      issue
        ? `The backup is not a valid OAO configuration backup${path ? ` at ${path}` : ""}: ${issue.message}`
        : "The backup is not a valid OAO configuration backup",
    );
  }
}

function backupFilename(backup: ConfigurationBackup): string {
  const slug = backup.organization.slug.replace(/[^a-z0-9-]/giu, "-") || "oao";
  const stamp = backup.exportedAt
    .slice(0, 19)
    .replaceAll(":", "")
    .replace("T", "-");
  return `${slug}-${stamp}.oao-backup.json`;
}

type ApiVariables = { principal: Principal; requestId: string };

export function registerConfigurationBackupRoutes(
  app: Hono<{ Variables: ApiVariables }>,
  context: ConfigurationBackupContext,
): void {
  const organizationActor = (
    c: Context<{ Variables: ApiVariables }>,
  ): Principal => {
    const actor = c.get("principal");
    if (actor.organizationId !== c.req.param("organizationId"))
      throw new HttpApiError(
        "forbidden",
        "Organization is outside the principal scope",
      );
    return actor;
  };

  app.get(
    "/v1/organizations/:organizationId/configuration-backup",
    async (c) => {
      const actor = organizationActor(c);
      // One read-only snapshot, so an agent version never refers to a Skill
      // or toolset version published while the export was running.
      const backup = await context.store.transaction(
        actor,
        "project:admin",
        async (tx) => {
          await context.assertOrganizationAdministrator(tx, actor);
          return exportOrganizationConfiguration(tx, actor);
        },
        { snapshot: true },
      );
      const counts = configurationBackupCounts(backup);
      await context.store.transaction(actor, "project:admin", (tx) =>
        context.store.appendAudit(tx, actor, {
          action: "configuration.exported",
          resourceType: "organization",
          resourceId: actor.organizationId,
          detail: {
            projects: counts.projects,
            agents: counts.agents,
            skills: counts.skills,
            modelProviders: counts.modelProviders,
          },
        }),
      );
      c.header("cache-control", "no-store");
      c.header(
        "content-disposition",
        `attachment; filename="${backupFilename(backup)}"`,
      );
      return c.json(backup);
    },
  );

  app.post(
    "/v1/organizations/:organizationId/configuration-restore/preview",
    async (c) => {
      const actor = organizationActor(c);
      // Preview changes nothing, so it needs no Idempotency-Key.
      const body = await readJsonObject(c.req.raw);
      const backup = parseBackupBody(() =>
        parseConfigurationBackup(body.backup),
      );
      const plan = await context.store.transaction(
        actor,
        "project:admin",
        async (tx) => {
          await context.assertOrganizationAdministrator(tx, actor);
          return (await planConfigurationRestore(tx, actor, backup, context))
            .plan;
        },
      );
      return c.json(plan);
    },
  );

  app.post(
    "/v1/organizations/:organizationId/configuration-restore",
    async (c) => {
      const actor = organizationActor(c);
      const body = await readJsonObject(c.req.raw);
      const idem = idempotencyKey(c.req.raw);
      const input = parseBackupBody(() => parseConfigurationRestoreInput(body));
      return context.store.transaction(actor, "project:admin", async (tx) => {
        await context.assertOrganizationAdministrator(tx, actor);
        const response = await context.store.idempotent(tx, actor, {
          scope: "POST:/configuration-restore",
          key: idem,
          hash: requestHash(body),
          status: 201,
          execute: () =>
            restoreOrganizationConfiguration(
              tx,
              context,
              actor,
              input.backup,
              input.credentials,
            ),
        });
        c.header("idempotency-replayed", String(response.replayed));
        return c.json(response.body, 201);
      });
    },
  );
}
