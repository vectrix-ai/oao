import { createHash } from "node:crypto";
import type * as S3Sdk from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { PgPool, TenantContext } from "@oao/db-postgres";
import { withTenantTransaction } from "@oao/db-postgres";
import type { ArtifactPort, TenantIdentity } from "@oao/domain";
import type { RunId, SessionId, ThreadId } from "@oao/domain";
import type { ProviderCredentialCipher } from "@oao/provider-credentials";

export interface ArtifactLocation {
  readonly tenant: TenantIdentity;
  readonly key: string;
}

export interface ArtifactWrite extends ArtifactLocation {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface StoredArtifact extends ArtifactLocation {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly etag?: string;
}

export interface ArtifactMetadata extends ArtifactLocation {
  readonly contentLength: number;
  readonly contentType: string;
  readonly etag?: string;
}

export interface ArtifactStorePort extends ArtifactPort {
  get(input: ArtifactLocation): Promise<StoredArtifact | undefined>;
  head(input: ArtifactLocation): Promise<ArtifactMetadata | undefined>;
  delete(input: ArtifactLocation): Promise<void>;
}

export interface S3PutObjectInput {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface S3GetObjectInput {
  readonly bucket: string;
  readonly key: string;
}

export interface S3ObjectBody {
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly etag?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface S3ObjectMetadata {
  readonly contentLength: number;
  readonly contentType?: string;
  readonly etag?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Narrow seam around an S3-compatible client. Hosted wiring can translate these
 * calls to any vendor SDK without leaking that SDK's types into the application.
 */
export interface S3ObjectClient {
  putObject(input: S3PutObjectInput): Promise<{ readonly etag?: string }>;
  getObject(input: S3GetObjectInput): Promise<S3ObjectBody | undefined>;
  headObject(input: S3GetObjectInput): Promise<S3ObjectMetadata | undefined>;
  deleteObject(input: S3GetObjectInput): Promise<void>;
}

export interface S3ArtifactAdapterOptions {
  readonly bucket: string;
  readonly client: S3ObjectClient;
  readonly prefix?: string;
}

export interface S3CompatibleClientOptions {
  readonly endpoint?: string;
  readonly region: string;
  readonly forcePathStyle?: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** Real S3-compatible implementation kept behind the narrow object seam. */
export class AwsS3CompatibleObjectClient implements S3ObjectClient {
  readonly #options: S3CompatibleClientOptions;
  #runtime:
    | Promise<{
        readonly client: S3Client;
        readonly sdk: typeof S3Sdk;
      }>
    | undefined;

  constructor(options: S3CompatibleClientOptions) {
    this.#options = options;
  }

  async putObject(
    input: S3PutObjectInput,
  ): Promise<{ readonly etag?: string }> {
    const { client, sdk } = await this.#load();
    const response = await client.send(
      new sdk.PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: { ...input.metadata },
      }),
    );
    return response.ETag === undefined ? {} : { etag: response.ETag };
  }

  async getObject(input: S3GetObjectInput): Promise<S3ObjectBody | undefined> {
    try {
      const { client, sdk } = await this.#load();
      const response = await client.send(
        new sdk.GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
      );
      if (!response.Body) return undefined;
      return {
        body: await response.Body.transformToByteArray(),
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
        ...(response.ETag ? { etag: response.ETag } : {}),
        ...(response.Metadata ? { metadata: response.Metadata } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async headObject(
    input: S3GetObjectInput,
  ): Promise<S3ObjectMetadata | undefined> {
    try {
      const { client, sdk } = await this.#load();
      const response = await client.send(
        new sdk.HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
      );
      return {
        contentLength: response.ContentLength ?? 0,
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
        ...(response.ETag ? { etag: response.ETag } : {}),
        ...(response.Metadata ? { metadata: response.Metadata } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async deleteObject(input: S3GetObjectInput): Promise<void> {
    const { client, sdk } = await this.#load();
    await client.send(
      new sdk.DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
  }

  #load(): Promise<{
    readonly client: S3Client;
    readonly sdk: typeof S3Sdk;
  }> {
    this.#runtime ??= import("@aws-sdk/client-s3").then((sdk) => ({
      sdk,
      client: new sdk.S3Client({
        region: this.#options.region,
        ...(this.#options.endpoint ? { endpoint: this.#options.endpoint } : {}),
        forcePathStyle: this.#options.forcePathStyle ?? false,
        credentials: {
          accessKeyId: this.#options.accessKeyId,
          secretAccessKey: this.#options.secretAccessKey,
          ...(this.#options.sessionToken
            ? { sessionToken: this.#options.sessionToken }
            : {}),
        },
      }),
    }));
    return this.#runtime;
  }
}

export interface WorkspaceBackupStore {
  load(): Promise<Uint8Array | undefined>;
  save(bytes: Uint8Array): Promise<void>;
  markRestored(): Promise<void>;
}

export interface WorkspaceBackupIdentity extends TenantContext {
  readonly threadId: ThreadId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

interface StorageProviderRow {
  readonly id: string;
  readonly endpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly object_prefix: string | null;
  readonly force_path_style: boolean;
  readonly encrypted_credential: Buffer;
  readonly encryption_nonce: Buffer;
  readonly encryption_tag: Buffer;
  readonly encryption_key_version: number;
  readonly existing_object_key: string | null;
  readonly existing_sha256: Buffer | null;
  readonly existing_content_length: string | null;
}

interface S3CredentialPayload {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export class ProjectWorkspaceBackupResolver {
  constructor(
    private readonly pool: PgPool,
    private readonly cipher: ProviderCredentialCipher,
    private readonly clientFactory: (
      options: S3CompatibleClientOptions,
    ) => S3ObjectClient = (options) => new AwsS3CompatibleObjectClient(options),
  ) {}

  async resolve(
    identity: WorkspaceBackupIdentity,
  ): Promise<WorkspaceBackupStore | undefined> {
    const provider = await withTenantTransaction(
      this.pool,
      identity,
      async (transaction) => {
        const result = await transaction.query<StorageProviderRow>(
          `SELECT p.id,p.endpoint,p.region,p.bucket,p.object_prefix,p.force_path_style,
                  p.encrypted_credential,p.encryption_nonce,p.encryption_tag,
                  p.encryption_key_version,b.object_key AS existing_object_key,
                  b.content_sha256 AS existing_sha256,
                  b.content_length::text AS existing_content_length
             FROM oao.project_storage_providers p
             LEFT JOIN oao.thread_workspace_backups b
               ON b.organization_id=p.organization_id AND b.project_id=p.project_id
              AND b.thread_id=$3 AND b.storage_provider_id=p.id
            WHERE p.organization_id=$1 AND p.project_id=$2
              AND p.id=COALESCE(
                (SELECT storage_provider_id FROM oao.thread_workspace_backups
                  WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3),
                (SELECT id FROM oao.project_storage_providers
                  WHERE organization_id=$1 AND project_id=$2 AND is_default LIMIT 1)
              )`,
          [identity.organizationId, identity.projectId, identity.threadId],
        );
        return result.rows[0];
      },
    );
    if (!provider) return undefined;
    const credentialText = this.cipher.decrypt(
      {
        ciphertext: provider.encrypted_credential,
        nonce: provider.encryption_nonce,
        tag: provider.encryption_tag,
        keyVersion: provider.encryption_key_version,
      },
      {
        organizationId: identity.organizationId,
        projectId: identity.projectId,
        providerId: provider.id,
        providerType: "s3",
      },
    );
    const credentials = parseS3CredentialPayload(credentialText);
    const client = this.clientFactory({
      region: provider.region,
      ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
      forcePathStyle: provider.force_path_style,
      ...credentials,
    });
    const artifacts = new S3ArtifactAdapter({
      bucket: provider.bucket,
      client,
      ...(provider.object_prefix ? { prefix: provider.object_prefix } : {}),
    });
    const objectKey =
      provider.existing_object_key ??
      `workspace-backups/threads/${identity.threadId}/workspace.tar.gz`;
    return new ProjectWorkspaceBackupStore({
      pool: this.pool,
      artifacts,
      identity,
      providerId: provider.id,
      objectKey,
      expectedSha256: provider.existing_sha256,
      expectedContentLength:
        provider.existing_content_length === null
          ? null
          : Number(provider.existing_content_length),
    });
  }
}

class ProjectWorkspaceBackupStore implements WorkspaceBackupStore {
  constructor(
    private readonly input: {
      readonly pool: PgPool;
      readonly artifacts: ArtifactStorePort;
      readonly identity: WorkspaceBackupIdentity;
      readonly providerId: string;
      readonly objectKey: string;
      readonly expectedSha256: Buffer | null;
      readonly expectedContentLength: number | null;
    },
  ) {}

  async load(): Promise<Uint8Array | undefined> {
    if (this.input.expectedSha256 === null) return undefined;
    const stored = await this.input.artifacts.get({
      tenant: this.input.identity,
      key: this.input.objectKey,
    });
    if (!stored) throw new Error("Recorded workspace backup is missing");
    if (
      this.input.expectedContentLength !== null &&
      stored.bytes.byteLength !== this.input.expectedContentLength
    )
      throw new Error("Workspace backup length does not match its record");
    const digest = sha256(stored.bytes);
    if (!digest.equals(this.input.expectedSha256))
      throw new Error("Workspace backup checksum does not match its record");
    return stored.bytes;
  }

  async save(bytes: Uint8Array): Promise<void> {
    await this.input.artifacts.put({
      tenant: this.input.identity,
      key: this.input.objectKey,
      bytes,
      contentType: "application/gzip",
    });
    const digest = sha256(bytes);
    await withTenantTransaction(
      this.input.pool,
      this.input.identity,
      (transaction) =>
        transaction.query(
          `INSERT INTO oao.thread_workspace_backups (
             organization_id,project_id,thread_id,session_id,storage_provider_id,
             last_run_id,object_key,content_length,content_sha256
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (organization_id,project_id,thread_id) DO UPDATE SET
             session_id=EXCLUDED.session_id,last_run_id=EXCLUDED.last_run_id,
             object_key=EXCLUDED.object_key,content_length=EXCLUDED.content_length,
             content_sha256=EXCLUDED.content_sha256,generation=oao.thread_workspace_backups.generation+1,
             backed_up_at=clock_timestamp()`,
          [
            this.input.identity.organizationId,
            this.input.identity.projectId,
            this.input.identity.threadId,
            this.input.identity.sessionId,
            this.input.providerId,
            this.input.identity.runId,
            this.input.objectKey,
            bytes.byteLength,
            digest,
          ],
        ),
    );
  }

  async markRestored(): Promise<void> {
    await withTenantTransaction(
      this.input.pool,
      this.input.identity,
      (transaction) =>
        transaction.query(
          `UPDATE oao.thread_workspace_backups SET last_restored_at=clock_timestamp()
            WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3
              AND storage_provider_id=$4`,
          [
            this.input.identity.organizationId,
            this.input.identity.projectId,
            this.input.identity.threadId,
            this.input.providerId,
          ],
        ),
    );
  }
}

export class S3ArtifactAdapter implements ArtifactStorePort {
  readonly #bucket: string;
  readonly #client: S3ObjectClient;
  readonly #prefix: string | undefined;

  constructor(options: S3ArtifactAdapterOptions) {
    if (options.bucket.trim().length === 0) {
      throw new TypeError("Artifact bucket must not be empty");
    }
    this.#bucket = options.bucket;
    this.#client = options.client;
    this.#prefix = normalizePrefix(options.prefix);
  }

  async put(input: ArtifactWrite): Promise<{ readonly ref: string }> {
    validateContentType(input.contentType);
    const objectKey = tenantArtifactObjectKey(
      input.tenant,
      input.key,
      this.#prefix,
    );
    await this.#client.putObject({
      bucket: this.#bucket,
      key: objectKey,
      body: input.bytes,
      contentType: input.contentType,
      metadata: tenantMetadata(input),
    });
    return { ref: artifactRef(objectKey) };
  }

  async get(input: ArtifactLocation): Promise<StoredArtifact | undefined> {
    const result = await this.#client.getObject(this.#location(input));
    if (result === undefined) return undefined;
    assertTenantMetadata(result.metadata, input.tenant);
    return {
      ...input,
      bytes: new Uint8Array(result.body),
      contentType: result.contentType ?? "application/octet-stream",
      ...(result.etag === undefined ? {} : { etag: result.etag }),
    };
  }

  async head(input: ArtifactLocation): Promise<ArtifactMetadata | undefined> {
    const result = await this.#client.headObject(this.#location(input));
    if (result === undefined) return undefined;
    assertTenantMetadata(result.metadata, input.tenant);
    return {
      ...input,
      contentLength: result.contentLength,
      contentType: result.contentType ?? "application/octet-stream",
      ...(result.etag === undefined ? {} : { etag: result.etag }),
    };
  }

  async delete(input: ArtifactLocation): Promise<void> {
    await this.#client.deleteObject(this.#location(input));
  }

  #location(input: ArtifactLocation): S3GetObjectInput {
    return {
      bucket: this.#bucket,
      key: tenantArtifactObjectKey(input.tenant, input.key, this.#prefix),
    };
  }
}

interface InMemoryArtifactRecord {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
}

/** Deterministic, credential-free artifact adapter for local development/tests. */
export class InMemoryArtifactAdapter implements ArtifactStorePort {
  readonly #objects = new Map<string, InMemoryArtifactRecord>();
  readonly #prefix: string | undefined;
  #revision = 0;

  constructor(options: { readonly prefix?: string } = {}) {
    this.#prefix = normalizePrefix(options.prefix);
  }

  async put(input: ArtifactWrite): Promise<{ readonly ref: string }> {
    validateContentType(input.contentType);
    const objectKey = tenantArtifactObjectKey(
      input.tenant,
      input.key,
      this.#prefix,
    );
    this.#revision += 1;
    this.#objects.set(objectKey, {
      bytes: new Uint8Array(input.bytes),
      contentType: input.contentType,
      etag: `memory-${this.#revision.toString(16)}`,
    });
    return { ref: artifactRef(objectKey) };
  }

  async get(input: ArtifactLocation): Promise<StoredArtifact | undefined> {
    const record = this.#objects.get(
      tenantArtifactObjectKey(input.tenant, input.key, this.#prefix),
    );
    if (record === undefined) return undefined;
    return {
      ...input,
      bytes: new Uint8Array(record.bytes),
      contentType: record.contentType,
      etag: record.etag,
    };
  }

  async head(input: ArtifactLocation): Promise<ArtifactMetadata | undefined> {
    const record = this.#objects.get(
      tenantArtifactObjectKey(input.tenant, input.key, this.#prefix),
    );
    if (record === undefined) return undefined;
    return {
      ...input,
      contentLength: record.bytes.byteLength,
      contentType: record.contentType,
      etag: record.etag,
    };
  }

  async delete(input: ArtifactLocation): Promise<void> {
    this.#objects.delete(
      tenantArtifactObjectKey(input.tenant, input.key, this.#prefix),
    );
  }

  clear(): void {
    this.#objects.clear();
  }
}

export function tenantArtifactObjectKey(
  tenant: TenantIdentity,
  logicalKey: string,
  prefix?: string,
): string {
  const safeLogicalKey = normalizeLogicalKey(logicalKey);
  const tenantPath = [
    "organizations",
    encodePathSegment(tenant.organizationId),
    "projects",
    encodePathSegment(tenant.projectId),
    "artifacts",
    ...safeLogicalKey.split("/").map(encodePathSegment),
  ].join("/");
  return prefix === undefined
    ? tenantPath
    : `${normalizePrefix(prefix)}/${tenantPath}`;
}

function normalizeLogicalKey(key: string): string {
  if (
    key.length === 0 ||
    key.length > 1_024 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    hasControlCharacter(key)
  ) {
    throw new TypeError("Artifact key is not a safe relative path");
  }
  const segments = key.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError("Artifact key is not a safe relative path");
  }
  return key;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function normalizePrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined || prefix.length === 0) return undefined;
  return normalizeLogicalKey(prefix);
}

function encodePathSegment(value: string): string {
  if (value.length === 0)
    throw new TypeError("Tenant identifier must not be empty");
  return encodeURIComponent(value);
}

function artifactRef(objectKey: string): string {
  return `artifact:///${objectKey}`;
}

function tenantMetadata(
  input: ArtifactLocation,
): Readonly<Record<string, string>> {
  return {
    "oao-organization-id": input.tenant.organizationId,
    "oao-project-id": input.tenant.projectId,
    "oao-logical-key": input.key,
  };
}

function assertTenantMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
  tenant: TenantIdentity,
): void {
  if (
    metadata === undefined ||
    metadata["oao-organization-id"] !== tenant.organizationId ||
    metadata["oao-project-id"] !== tenant.projectId
  ) {
    throw new Error(
      "Artifact tenant metadata does not match the requested tenant",
    );
  }
}

function validateContentType(contentType: string): void {
  if (
    contentType.length === 0 ||
    contentType.length > 255 ||
    /[\r\n]/u.test(contentType)
  ) {
    throw new TypeError("Artifact content type is invalid");
  }
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function parseS3CredentialPayload(value: string): S3CredentialPayload {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.accessKeyId !== "string" ||
      parsed.accessKeyId.length < 3 ||
      typeof parsed.secretAccessKey !== "string" ||
      parsed.secretAccessKey.length < 8 ||
      (parsed.sessionToken !== undefined &&
        typeof parsed.sessionToken !== "string")
    )
      throw new Error("invalid");
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      ...(parsed.sessionToken ? { sessionToken: parsed.sessionToken } : {}),
    };
  } catch {
    throw new Error("S3-compatible provider credential is invalid");
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return (
    value.name === "NoSuchKey" ||
    value.name === "NotFound" ||
    value.$metadata?.httpStatusCode === 404
  );
}
