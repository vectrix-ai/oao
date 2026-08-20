import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectId, OrganizationId } from "@oao/domain";

import {
  InMemoryArtifactAdapter,
  S3ArtifactAdapter,
  tenantArtifactObjectKey,
  type S3ObjectClient,
  type S3PutObjectInput,
} from "../src/index.ts";

const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
};

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
  };
  const store = new S3ArtifactAdapter({ bucket: "artifacts", client });
  await assert.rejects(
    store.get({ tenant, key: "result.txt" }),
    /tenant metadata does not match/u,
  );
});
