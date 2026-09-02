import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create as createTar } from "tar";

import type { PgPool } from "@oao/db-postgres";
import type { ProjectId, OrganizationId } from "@oao/domain";
import { ProviderCredentialCipher } from "@oao/provider-credentials";

import {
  AwsS3CompatibleObjectClient,
  encodeWorkspaceBackupManifest,
  extractWorkspaceBackupFile,
  InMemoryArtifactAdapter,
  parseWorkspaceBackupManifest,
  ProjectArtifactStoreResolver,
  S3ArtifactAdapter,
  streamWorkspaceBackupFile,
  tenantArtifactObjectKey,
  tenantArtifactRootPrefix,
  workspaceBackupManifestObjectKey,
  type S3ListObjectsInput,
  type S3ObjectClient,
  type S3PutObjectInput,
} from "../src/index.ts";

const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
};

test("workspace backup manifests are deterministic and archive-bound", () => {
  const archive = new Uint8Array([31, 139, 8, 0]);
  const bytes = encodeWorkspaceBackupManifest({
    archive,
    files: [
      { name: "result.csv", path: "output/result.csv", sizeBytes: 42 },
      {
        name: "input.xlsx",
        path: ".oao/attachments/run/input.xlsx",
        sizeBytes: 10858,
      },
    ],
  });
  const parsed = parseWorkspaceBackupManifest(bytes, {
    archiveSha256:
      "fd72d30440b0bae1b1c6db6c8ad807f238ef3ca613aa7e8d5329e1e8ddf7da72",
    archiveSizeBytes: 4,
  });
  assert.deepEqual(
    parsed.files.map((file) => file.path),
    [".oao/attachments/run/input.xlsx", "output/result.csv"],
  );
  assert.equal(
    workspaceBackupManifestObjectKey(
      "workspace-backups/threads/thread/workspace.tar.gz",
    ),
    "workspace-backups/threads/thread/workspace.manifest.json",
  );
  assert.throws(
    () =>
      parseWorkspaceBackupManifest(bytes, {
        archiveSha256: "0".repeat(64),
      }),
    /manifest is invalid/u,
  );
});

test("workspace backup files are extracted from gzip archives in memory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oao-workspace-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "output"));
  await writeFile(join(directory, "output", "result.csv"), "id,total\n1,42\n");
  const stream = createTar({ cwd: directory, gzip: true }, ["output"]);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const archive = Buffer.concat(chunks);
  const file = {
    name: "result.csv",
    path: "output/result.csv",
    sizeBytes: Buffer.byteLength("id,total\n1,42\n"),
  };

  assert.equal(
    Buffer.from(await extractWorkspaceBackupFile(archive, file)).toString(
      "utf8",
    ),
    "id,total\n1,42\n",
  );
  assert.equal(
    Buffer.from(
      await new Response(
        await streamWorkspaceBackupFile(archive, file),
      ).arrayBuffer(),
    ).toString("utf8"),
    "id,total\n1,42\n",
  );
  await assert.rejects(
    extractWorkspaceBackupFile(archive, { ...file, sizeBytes: 1 }),
    /does not match its manifest/u,
  );
  await assert.rejects(
    extractWorkspaceBackupFile(archive, {
      name: "missing.txt",
      path: "output/missing.txt",
      sizeBytes: 1,
    }),
    /missing from its archive/u,
  );
});

test("in-memory artifacts are tenant isolated and defensively copied", async () => {
  const store = new InMemoryArtifactAdapter();
  const bytes = new Uint8Array([1, 2, 3]);
  const first = await store.put({
    tenant,
    key: "audit/export.json",
    bytes,
    contentType: "application/json",
  });
  bytes[0] = 9;

  assert.equal(
    first.ref,
    "artifact:///organizations/00000000-0000-4000-8000-000000000001/projects/00000000-0000-4000-8000-000000000002/artifacts/audit/export.json",
  );
  const result = await store.get({ tenant, key: "audit/export.json" });
  assert.deepEqual(result?.bytes, new Uint8Array([1, 2, 3]));
  if (result !== undefined) result.bytes[1] = 8;
  assert.deepEqual(
    (await store.get({ tenant, key: "audit/export.json" }))?.bytes,
    new Uint8Array([1, 2, 3]),
  );

  const otherTenant = {
    ...tenant,
    projectId: "00000000-0000-4000-8000-000000000003" as ProjectId,
  };
  assert.equal(
    await store.get({ tenant: otherTenant, key: "audit/export.json" }),
    undefined,
  );
});

test("artifact keys reject traversal and remain under the tenant prefix", () => {
  assert.throws(() => tenantArtifactObjectKey(tenant, "../secret"), TypeError);
  assert.throws(() => tenantArtifactObjectKey(tenant, "/absolute"), TypeError);
  assert.throws(() => tenantArtifactObjectKey(tenant, "a//b"), TypeError);
  assert.match(
    tenantArtifactObjectKey(tenant, "safe/report 1.json", "hosted/v1"),
    /^hosted\/v1\/organizations\/[^/]+\/projects\/[^/]+\/artifacts\/safe\/report%201\.json$/u,
  );
});

test("project artifact resolver binds an exact encrypted S3 provider", async () => {
  const providerId = "00000000-0000-4000-8000-000000000004";
  const cipher = new ProviderCredentialCipher(Buffer.alloc(32, 7));
  const encrypted = cipher.encrypt(
    JSON.stringify({
      accessKeyId: "attachment-access-key",
      secretAccessKey: "attachment-secret-key",
    }),
    { ...tenant, providerId, providerType: "s3", keyVersion: 1 },
  );
  const queryValues: (readonly unknown[])[] = [];
  const pool = {
    connect: async () => ({
      query: async (text: string, values?: readonly unknown[]) => {
        if (text.includes("FROM oao.project_storage_providers")) {
          queryValues.push(values ?? []);
          return {
            rowCount: 1,
            rows: [
              {
                id: providerId,
                endpoint: "https://objects.example.test",
                region: "eu-test-1",
                bucket: "attachments",
                object_prefix: "oao",
                force_path_style: true,
                encrypted_credential: encrypted.ciphertext,
                encryption_nonce: encrypted.nonce,
                encryption_tag: encrypted.tag,
                encryption_key_version: encrypted.keyVersion,
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
      release() {},
    }),
  } as unknown as PgPool;
  const client: S3ObjectClient = {
    async putObject() {
      return {};
    },
    async getObject() {
      return undefined;
    },
    async headObject() {
      return undefined;
    },
    async deleteObject() {},
    async listObjects() {
      return { objects: [], commonPrefixes: [], truncated: false };
    },
  };
  const resolver = new ProjectArtifactStoreResolver(pool, cipher, (options) => {
    assert.deepEqual(options, {
      endpoint: "https://objects.example.test",
      region: "eu-test-1",
      forcePathStyle: true,
      accessKeyId: "attachment-access-key",
      secretAccessKey: "attachment-secret-key",
    });
    return client;
  });
  const resolved = await resolver.resolve({ tenant, providerId });
  assert.equal(resolved?.providerId, providerId);
  assert.equal(queryValues[0]?.[1], providerId);
});

test("S3 adapter delegates through the narrow client with tenant metadata", async () => {
  const calls: S3PutObjectInput[] = [];
  const object = new Uint8Array([4, 5]);
  const client: S3ObjectClient = {
    async putObject(input) {
      calls.push(input);
      return { etag: "etag-1" };
    },
    async getObject() {
      return {
        body: object,
        contentType: "text/plain",
        metadata: {
          "oao-organization-id": tenant.organizationId,
          "oao-project-id": tenant.projectId,
        },
      };
    },
    async headObject() {
      return undefined;
    },
    async deleteObject() {},
    async listObjects() {
      return { objects: [], commonPrefixes: [], truncated: false };
    },
  };
  const store = new S3ArtifactAdapter({ bucket: "artifacts", client });
  await store.put({
    tenant,
    key: "result.txt",
    bytes: object,
    contentType: "text/plain",
  });

  assert.equal(calls[0]?.bucket, "artifacts");
  assert.equal(calls[0]?.metadata["oao-project-id"], tenant.projectId);
  assert.deepEqual(
    (await store.get({ tenant, key: "result.txt" }))?.bytes,
    object,
  );
});

test("real S3 client sends only ASCII artifact metadata values", async (t) => {
  let metadataHeaders: Readonly<Record<string, string | readonly string[]>> =
    {};
  const server = createServer((request, response) => {
    metadataHeaders = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) =>
        name.startsWith("x-amz-meta-"),
      ),
    ) as Readonly<Record<string, string | readonly string[]>>;
    response.writeHead(200, { etag: '"capture-etag"' }).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const client = new AwsS3CompatibleObjectClient({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "eu-test-1",
    forcePathStyle: true,
    accessKeyId: "capture-access-key",
    secretAccessKey: "capture-secret-key",
  });
  const store = new S3ArtifactAdapter({ bucket: "artifacts", client });
  const key = "run-files/runs/run-1/file-1/saisie régulière.xlsx";
  await store.put({
    tenant,
    key,
    bytes: new Uint8Array([1]),
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  assert.equal(
    metadataHeaders["x-amz-meta-oao-logical-key"],
    encodeURIComponent(key),
  );
  assert.ok(Object.keys(metadataHeaders).length > 0);
  for (const value of Object.values(metadataHeaders).flat()) {
    assert.ok(
      [...value].every((character) => (character.codePointAt(0) ?? 128) <= 127),
    );
  }
});

test("S3 reads fail closed when stored tenant metadata disagrees", async () => {
  const client: S3ObjectClient = {
    async putObject() {
      return {};
    },
    async getObject() {
      return {
        body: new Uint8Array(),
        metadata: {
          "oao-organization-id": tenant.organizationId,
          "oao-project-id": "another-project",
        },
      };
    },
    async headObject() {
      return undefined;
    },
    async deleteObject() {},
    async listObjects() {
      return { objects: [], commonPrefixes: [], truncated: false };
    },
  };
  const store = new S3ArtifactAdapter({ bucket: "artifacts", client });
  await assert.rejects(
    store.get({ tenant, key: "result.txt" }),
    /tenant metadata does not match/u,
  );
});

test("S3 reads fail closed when tenant metadata is missing", async () => {
  const client: S3ObjectClient = {
    async putObject() {
      return {};
    },
    async getObject() {
      return { body: new Uint8Array([1]) };
    },
    async headObject() {
      return undefined;
    },
    async deleteObject() {},
    async listObjects() {
      return { objects: [], commonPrefixes: [], truncated: false };
    },
  };
  const store = new S3ArtifactAdapter({ bucket: "artifacts", client });
  await assert.rejects(
    store.get({ tenant, key: "result.txt" }),
    /tenant metadata does not match/u,
  );
});

test("S3 adapter lists folders and objects relative to the tenant root", async () => {
  const requests: S3ListObjectsInput[] = [];
  const root = tenantArtifactRootPrefix(tenant, "oao");
  const client: S3ObjectClient = {
    async putObject() {
      return {};
    },
    async getObject() {
      return undefined;
    },
    async headObject() {
      return undefined;
    },
    async deleteObject() {},
    async listObjects(input) {
      requests.push(input);
      return {
        objects: [
          {
            key: `${root}run-files/runs/run-1/file%20id/report.csv`,
            sizeBytes: 42,
            lastModifiedAt: "2026-08-19T10:00:00.000Z",
          },
        ],
        commonPrefixes: [`${root}run-files/runs/run-1/nested/`],
        truncated: true,
        continuationToken: "token-1",
      };
    },
  };
  const store = new S3ArtifactAdapter({
    bucket: "artifacts",
    client,
    prefix: "oao",
  });
  const listing = await store.list({
    tenant,
    prefix: "run-files/runs/run-1",
    limit: 25,
  });
  assert.deepEqual(requests[0], {
    bucket: "artifacts",
    prefix: `${root}run-files/runs/run-1/`,
    delimiter: "/",
    maxKeys: 25,
  });
  assert.equal(listing.prefix, "run-files/runs/run-1/");
  assert.deepEqual(listing.folders, ["run-files/runs/run-1/nested/"]);
  assert.deepEqual(listing.objects, [
    {
      key: "run-files/runs/run-1/file id/report.csv",
      sizeBytes: 42,
      lastModifiedAt: "2026-08-19T10:00:00.000Z",
    },
  ]);
  assert.equal(listing.truncated, true);
  assert.equal(listing.cursor, "token-1");
  await assert.rejects(
    store.list({ tenant, prefix: "../escape" }),
    /not a safe relative path/u,
  );
});

test("in-memory adapter lists one folder level at a time", async () => {
  const store = new InMemoryArtifactAdapter();
  const write = (key: string) =>
    store.put({
      tenant,
      key,
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "text/plain",
    });
  await write("run-files/runs/run-1/id-1/report.csv");
  await write("run-files/runs/run-1/id-2/notes.md");
  await write("workspace-backups/threads/thread-1/workspace.tar.gz");
  const rootListing = await store.list({ tenant });
  assert.deepEqual(rootListing.folders, ["run-files/", "workspace-backups/"]);
  assert.deepEqual(rootListing.objects, []);
  assert.equal(rootListing.truncated, false);
  const nested = await store.list({ tenant, prefix: "run-files/runs/run-1/" });
  assert.deepEqual(nested.folders, [
    "run-files/runs/run-1/id-1/",
    "run-files/runs/run-1/id-2/",
  ]);
  const leaf = await store.list({
    tenant,
    prefix: "run-files/runs/run-1/id-1",
  });
  assert.deepEqual(leaf.folders, []);
  assert.deepEqual(leaf.objects, [
    { key: "run-files/runs/run-1/id-1/report.csv", sizeBytes: 3 },
  ]);
  const otherTenant = await store.list({
    tenant: {
      organizationId: tenant.organizationId,
      projectId: "00000000-0000-4000-8000-000000000099" as ProjectId,
    },
  });
  assert.deepEqual(otherTenant.folders, []);
  assert.deepEqual(otherTenant.objects, []);
});
