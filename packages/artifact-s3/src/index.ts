import type { ArtifactPort, TenantIdentity } from "@oao/domain";

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
  if (metadata === undefined) return;
  if (
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
