import { createHash } from "node:crypto";
import type * as S3Sdk from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { PgPool, TenantContext } from "@oao/db-postgres";
import { withTenantTransaction } from "@oao/db-postgres";
import type {
  ArtifactMetadata,
  ArtifactObjectEntry,
  ArtifactObjectList,
  ArtifactStorePort,
  ProjectArtifactStoreResolution,
  ProjectArtifactStoreResolverPort,
  StoredArtifact,
  TenantIdentity,
} from "@oao/domain";
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

export type {
  ArtifactMetadata,
  ArtifactObjectEntry,
  ArtifactObjectList,
  ArtifactStorePort,
  StoredArtifact,
} from "@oao/domain";

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

export interface S3ListObjectsInput {
  readonly bucket: string;
  readonly prefix: string;
  readonly delimiter?: string;
  readonly maxKeys?: number;
  readonly continuationToken?: string;
}

export interface S3ListedObject {
  readonly key: string;
  readonly sizeBytes: number;
  readonly lastModifiedAt?: string;
}

export interface S3ObjectListing {
  readonly objects: readonly S3ListedObject[];
  readonly commonPrefixes: readonly string[];
  readonly truncated: boolean;
  readonly continuationToken?: string;
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
  listObjects(input: S3ListObjectsInput): Promise<S3ObjectListing>;
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

  async listObjects(input: S3ListObjectsInput): Promise<S3ObjectListing> {
    const { client, sdk } = await this.#load();
    const response = await client.send(
      new sdk.ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        ...(input.delimiter ? { Delimiter: input.delimiter } : {}),
        ...(input.maxKeys === undefined ? {} : { MaxKeys: input.maxKeys }),
        ...(input.continuationToken
          ? { ContinuationToken: input.continuationToken }
          : {}),
      }),
    );
    return {
      objects: (response.Contents ?? []).flatMap((item) =>
        item.Key === undefined
          ? []
          : [
              {
                key: item.Key,
                sizeBytes: item.Size ?? 0,
                ...(item.LastModified
                  ? { lastModifiedAt: item.LastModified.toISOString() }
                  : {}),
              },
            ],
      ),
      commonPrefixes: (response.CommonPrefixes ?? []).flatMap((item) =>
        item.Prefix === undefined ? [] : [item.Prefix],
      ),
      truncated: response.IsTruncated ?? false,
      ...(response.NextContinuationToken
        ? { continuationToken: response.NextContinuationToken }
        : {}),
    };
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
  loadManifest(): Promise<WorkspaceBackupManifest | undefined>;
  save(bytes: Uint8Array, files: readonly WorkspaceBackupFile[]): Promise<void>;
  markRestored(): Promise<void>;
}

export interface WorkspaceBackupFile {
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface WorkspaceBackupManifest {
  readonly version: 1;
  readonly archiveSha256: string;
  readonly archiveSizeBytes: number;
  readonly files: readonly WorkspaceBackupFile[];
}

const MAX_WORKSPACE_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_WORKSPACE_MANIFEST_FILES = 10_000;

export function workspaceBackupManifestObjectKey(objectKey: string): string {
  return objectKey.endsWith(".tar.gz")
    ? `${objectKey.slice(0, -".tar.gz".length)}.manifest.json`
    : `${objectKey}.manifest.json`;
}

function validWorkspaceBackupFile(
  value: unknown,
): value is WorkspaceBackupFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Readonly<Record<string, unknown>>;
  if (
    typeof file.name !== "string" ||
    typeof file.path !== "string" ||
    typeof file.sizeBytes !== "number" ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes < 0 ||
    file.name.length < 1 ||
    file.name.length > 255 ||
    file.path.length < 1 ||
    file.path.length > 1_024 ||
    file.path.startsWith("/") ||
    file.path.includes("\0") ||
    file.path.includes("\n") ||
    file.path.includes("\r")
  )
    return false;
  const segments = file.path.split("/");
  return (
    segments.every(
      (segment) => segment && segment !== "." && segment !== "..",
    ) && segments.at(-1) === file.name
  );
}

export function encodeWorkspaceBackupManifest(input: {
  readonly archive: Uint8Array;
  readonly files: readonly WorkspaceBackupFile[];
}): Uint8Array {
  if (
    input.files.length > MAX_WORKSPACE_MANIFEST_FILES ||
    input.files.some((file) => !validWorkspaceBackupFile(file))
  )
    throw new Error("Workspace backup file manifest is invalid");
  const manifest: WorkspaceBackupManifest = {
    version: 1,
    archiveSha256: sha256(input.archive).toString("hex"),
    archiveSizeBytes: input.archive.byteLength,
    files: [...input.files].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (bytes.byteLength > MAX_WORKSPACE_MANIFEST_BYTES)
    throw new Error("Workspace backup file manifest exceeds its size limit");
  return bytes;
}

export function parseWorkspaceBackupManifest(
  bytes: Uint8Array,
  expected?: {
    readonly archiveSha256?: string;
    readonly archiveSizeBytes?: number;
  },
): WorkspaceBackupManifest {
  if (bytes.byteLength > MAX_WORKSPACE_MANIFEST_BYTES)
    throw new Error("Workspace backup file manifest exceeds its size limit");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Workspace backup file manifest is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Workspace backup file manifest is invalid");
  const manifest = value as Readonly<Record<string, unknown>>;
  const files = manifest.files;
  if (
    manifest.version !== 1 ||
    typeof manifest.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.archiveSha256) ||
    typeof manifest.archiveSizeBytes !== "number" ||
    !Number.isSafeInteger(manifest.archiveSizeBytes) ||
    manifest.archiveSizeBytes < 0 ||
    !Array.isArray(files) ||
    files.length > MAX_WORKSPACE_MANIFEST_FILES ||
    files.some((file) => !validWorkspaceBackupFile(file)) ||
    (expected?.archiveSha256 !== undefined &&
      manifest.archiveSha256 !== expected.archiveSha256) ||
    (expected?.archiveSizeBytes !== undefined &&
      manifest.archiveSizeBytes !== expected.archiveSizeBytes)
  )
    throw new Error("Workspace backup file manifest is invalid");
  return manifest as unknown as WorkspaceBackupManifest;
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

interface ProjectStorageProviderRow {
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
}

export class ProjectArtifactStoreResolver implements ProjectArtifactStoreResolverPort {
  constructor(
    private readonly pool: PgPool,
    private readonly cipher: ProviderCredentialCipher,
    private readonly clientFactory: (
      options: S3CompatibleClientOptions,
    ) => S3ObjectClient = (options) => new AwsS3CompatibleObjectClient(options),
  ) {}

  async resolve(input: {
    readonly tenant: TenantIdentity;
    readonly providerId?: string;
  }): Promise<ProjectArtifactStoreResolution | undefined> {
    const provider = await withTenantTransaction(
      this.pool,
      input.tenant,
      async (transaction) => {
        const result = await transaction.query<ProjectStorageProviderRow>(
          `SELECT id,endpoint,region,bucket,object_prefix,force_path_style,
                  encrypted_credential,encryption_nonce,encryption_tag,
                  encryption_key_version
             FROM oao.project_storage_providers
            WHERE organization_id=$1
              AND id=COALESCE($2,(
                SELECT id FROM oao.project_storage_providers
                 WHERE organization_id=$1 AND is_default
                 LIMIT 1
              ))`,
          [input.tenant.organizationId, input.providerId ?? null],
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
        organizationId: input.tenant.organizationId,
        providerId: provider.id,
        providerType: "s3",
      },
    );
    const client = this.clientFactory({
      region: provider.region,
      ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
      forcePathStyle: provider.force_path_style,
      ...parseS3CredentialPayload(credentialText),
    });
    return {
      providerId: provider.id,
      store: new S3ArtifactAdapter({
        bucket: provider.bucket,
        client,
        ...(provider.object_prefix ? { prefix: provider.object_prefix } : {}),
      }),
    };
  }
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
               ON b.organization_id=p.organization_id AND b.project_id=$2
              AND b.thread_id=$3 AND b.storage_provider_id=p.id
            WHERE p.organization_id=$1
              AND p.id=COALESCE(
                (SELECT storage_provider_id FROM oao.thread_workspace_backups
                  WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3),
                (SELECT id FROM oao.project_storage_providers
                  WHERE organization_id=$1 AND is_default LIMIT 1)
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

  async loadManifest(): Promise<WorkspaceBackupManifest | undefined> {
    if (this.input.expectedSha256 === null) return undefined;
    const stored = await this.input.artifacts.get({
      tenant: this.input.identity,
      key: workspaceBackupManifestObjectKey(this.input.objectKey),
    });
    if (!stored) return undefined;
    return parseWorkspaceBackupManifest(stored.bytes, {
      archiveSha256: this.input.expectedSha256.toString("hex"),
      ...(this.input.expectedContentLength === null
        ? {}
        : { archiveSizeBytes: this.input.expectedContentLength }),
    });
  }

  async save(
    bytes: Uint8Array,
    files: readonly WorkspaceBackupFile[],
  ): Promise<void> {
    const digest = sha256(bytes);
    const manifest = encodeWorkspaceBackupManifest({ archive: bytes, files });
    await this.input.artifacts.put({
      tenant: this.input.identity,
      key: this.input.objectKey,
      bytes,
      contentType: "application/gzip",
    });
    await this.input.artifacts.put({
      tenant: this.input.identity,
      key: workspaceBackupManifestObjectKey(this.input.objectKey),
      bytes: manifest,
      contentType: "application/json",
    });
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

  async list(input: {
    readonly tenant: TenantIdentity;
    readonly prefix?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<ArtifactObjectList> {
    const logicalPrefix = normalizeLogicalFolderPrefix(input.prefix);
    const root = tenantArtifactRootPrefix(input.tenant, this.#prefix);
    const listing = await this.#client.listObjects({
      bucket: this.#bucket,
      prefix: `${root}${encodeLogicalPath(logicalPrefix)}`,
      delimiter: "/",
      maxKeys: clampListLimit(input.limit),
      ...(input.cursor ? { continuationToken: input.cursor } : {}),
    });
    return {
      prefix: logicalPrefix,
      folders: listing.commonPrefixes.flatMap((item) =>
        item.startsWith(root)
          ? [decodeLogicalPath(item.slice(root.length))]
          : [],
      ),
      objects: listing.objects.flatMap((item) =>
        item.key.startsWith(root)
          ? [{ ...item, key: decodeLogicalPath(item.key.slice(root.length)) }]
          : [],
      ),
      truncated: listing.truncated,
      ...(listing.continuationToken
        ? { cursor: listing.continuationToken }
        : {}),
    };
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

  async list(input: {
    readonly tenant: TenantIdentity;
    readonly prefix?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<ArtifactObjectList> {
    const logicalPrefix = normalizeLogicalFolderPrefix(input.prefix);
    const root = tenantArtifactRootPrefix(input.tenant, this.#prefix);
    const scope = `${root}${encodeLogicalPath(logicalPrefix)}`;
    const limit = clampListLimit(input.limit);
    const folders = new Set<string>();
    const objects: ArtifactObjectEntry[] = [];
    const keys = [...this.#objects.keys()]
      .filter((key) => key.startsWith(scope))
      .sort();
    const start = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
    let consumed = 0;
    let truncated = false;
    for (const key of keys.slice(start)) {
      if (folders.size + objects.length >= limit) {
        truncated = true;
        break;
      }
      consumed += 1;
      const remainder = decodeLogicalPath(key.slice(scope.length));
      const slash = remainder.indexOf("/");
      if (slash >= 0) {
        folders.add(`${logicalPrefix}${remainder.slice(0, slash + 1)}`);
        continue;
      }
      const record = this.#objects.get(key)!;
      objects.push({
        key: `${logicalPrefix}${remainder}`,
        sizeBytes: record.bytes.byteLength,
      });
    }
    return {
      prefix: logicalPrefix,
      folders: [...folders].sort(),
      objects,
      truncated,
      ...(truncated ? { cursor: String(start + consumed) } : {}),
    };
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

export function tenantArtifactRootPrefix(
  tenant: TenantIdentity,
  prefix?: string,
): string {
  const tenantPath = [
    "organizations",
    encodePathSegment(tenant.organizationId),
    "projects",
    encodePathSegment(tenant.projectId),
    "artifacts",
  ].join("/");
  return prefix === undefined
    ? `${tenantPath}/`
    : `${normalizePrefix(prefix)}/${tenantPath}/`;
}

export function normalizeLogicalFolderPrefix(
  prefix: string | undefined,
): string {
  if (prefix === undefined || prefix.length === 0) return "";
  const withoutSlash = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return `${normalizeLogicalKey(withoutSlash)}/`;
}

function encodeLogicalPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.length === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
}

function decodeLogicalPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

const MAX_LIST_LIMIT = 1_000;
const DEFAULT_LIST_LIMIT = 500;

function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1)
    return DEFAULT_LIST_LIMIT;
  return Math.min(limit, MAX_LIST_LIMIT);
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
