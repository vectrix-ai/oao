import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ProjectWorkspaceBackupResolver,
  type S3ObjectBody,
  type S3ObjectClient,
  type S3ObjectMetadata,
  type S3PutObjectInput,
} from "@oao/artifact-s3";
import { createPool, withTenantTransaction } from "@oao/db-postgres";
import type {
  OrganizationId,
  ProjectId,
  RunId,
  SessionId,
  ThreadId,
} from "@oao/domain";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import {
  FakeSandboxProvider,
  ManagedSandboxLifecycle,
  PostgresSandboxRepository,
  createManagedDaytonaFlueSandbox,
  type SandboxHandle,
} from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
};
const runId = "00000000-0000-4000-8000-000000000302" as RunId;
const threadId = "00000000-0000-4000-8000-000000000006" as ThreadId;
const sessionId = "00000000-0000-4000-8000-000000000007" as SessionId;

async function seedTenantFixture(
  pool: ReturnType<typeof createPool>,
): Promise<void> {
  const principalId = "00000000-0000-4000-8000-000000000003";
  const agentId = "00000000-0000-4000-8000-000000000004";
  const agentVersionId = "00000000-0000-4000-8000-000000000005";
  const config = {
    systemPrompt: "Run the sandbox integration fixture.",
    modelPreset: "integration-model",
    tools: [],
    sandbox: {
      enabled: false,
      provider: "test-daytona",
      network: "none",
      capabilities: [],
    },
    limits: { maxTurns: 32, timeoutMs: 60_000 },
  };
  await pool.query(
    `INSERT INTO oao.organizations (id,slug,name)
     VALUES ($1,'sandbox-integration','Sandbox integration')
     ON CONFLICT DO NOTHING`,
    [tenant.organizationId],
  );
  await pool.query(
    `INSERT INTO oao.projects (organization_id,id,slug,name)
     VALUES ($1,$2,'sandbox-integration','Sandbox integration')
     ON CONFLICT DO NOTHING`,
    [tenant.organizationId, tenant.projectId],
  );
  await pool.query(
    `INSERT INTO oao.principals (
       organization_id,project_id,id,kind,subject,scopes
     ) VALUES ($1,$2,$3,'human','sandbox-integration',ARRAY['*'])
     ON CONFLICT DO NOTHING`,
    [tenant.organizationId, tenant.projectId, principalId],
  );
  await pool.query(
    `INSERT INTO oao.agent_definitions (
       organization_id,project_id,id,agent_key,name
     ) VALUES ($1,$2,$3,'sandbox-integration','Sandbox integration')
     ON CONFLICT DO NOTHING`,
    [tenant.organizationId, tenant.projectId, agentId],
  );
  await pool.query(
    `INSERT INTO oao.agent_versions (
       organization_id,project_id,id,agent_definition_id,version,config,
       content_hash,created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)
     ON CONFLICT DO NOTHING`,
    [
      tenant.organizationId,
      tenant.projectId,
      agentVersionId,
      agentId,
      config,
      createHash("sha256").update(JSON.stringify(config)).digest(),
      principalId,
    ],
  );
}

class FailOnceSandboxProvider extends FakeSandboxProvider {
  #shouldFail = true;

  override async create(input: Parameters<FakeSandboxProvider["create"]>[0]) {
    if (this.#shouldFail) {
      this.#shouldFail = false;
      throw new Error("Synthetic provider failure");
    }
    return super.create(input);
  }
}

class MemoryS3Client implements S3ObjectClient {
  readonly objects = new Map<
    string,
    {
      readonly body: Uint8Array;
      readonly contentType: string;
      readonly metadata: Readonly<Record<string, string>>;
    }
  >();

  async putObject(input: S3PutObjectInput) {
    this.objects.set(`${input.bucket}/${input.key}`, {
      body: new Uint8Array(input.body),
      contentType: input.contentType,
      metadata: { ...input.metadata },
    });
    return { etag: "memory-etag" };
  }

  async getObject(input: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<S3ObjectBody | undefined> {
    const object = this.objects.get(`${input.bucket}/${input.key}`);
    return object
      ? {
          body: new Uint8Array(object.body),
          contentType: object.contentType,
          metadata: object.metadata,
        }
      : undefined;
  }

  async headObject(input: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<S3ObjectMetadata | undefined> {
    const object = this.objects.get(`${input.bucket}/${input.key}`);
    return object
      ? {
          contentLength: object.body.byteLength,
          contentType: object.contentType,
          metadata: object.metadata,
        }
      : undefined;
  }

  async deleteObject(input: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<void> {
    this.objects.delete(`${input.bucket}/${input.key}`);
  }
}

class WorkspaceSandboxProvider extends FakeSandboxProvider {
  restoredArchive: Uint8Array | undefined;

  async captureWorkspace(): Promise<Uint8Array> {
    return new Uint8Array([31, 139, 8, 0, 1, 2, 3]);
  }

  async listWorkspaceFiles() {
    return [
      {
        name: "result.csv",
        path: "output/result.csv",
        sizeBytes: 42,
      },
    ];
  }

  async restoreWorkspace(
    _sandbox: SandboxHandle,
    archive: Uint8Array,
  ): Promise<void> {
    this.restoredArchive = new Uint8Array(archive);
  }
}

test(
  "sandbox lifecycle persists fenced commands, artifacts, and safe status events",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    try {
      await seedTenantFixture(pool);
      await withTenantTransaction(pool, tenant, (transaction) =>
        transaction.query(
          `WITH thread AS (
             INSERT INTO oao.threads (organization_id,project_id,id,title)
             VALUES ($1,$2,$4,'Sandbox integration')
             ON CONFLICT DO NOTHING
           ), session AS (
             INSERT INTO oao.sessions (
               organization_id,project_id,id,thread_id,agent_version_id
             ) VALUES ($1,$2,$5,$4,$6)
             ON CONFLICT DO NOTHING
           )
           INSERT INTO oao.runs (
             organization_id,project_id,id,thread_id,session_id,agent_version_id,
             created_by_principal_id,idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'sandbox-integration')
           ON CONFLICT DO NOTHING`,
          [
            tenant.organizationId,
            tenant.projectId,
            runId,
            threadId,
            sessionId,
            "00000000-0000-4000-8000-000000000005",
            "00000000-0000-4000-8000-000000000003",
          ],
        ),
      );
      const manager = new ManagedSandboxLifecycle(
        new PostgresSandboxRepository(pool),
        new FailOnceSandboxProvider(),
      );
      const sandboxInput = {
        ...tenant,
        sandboxId: "00000000-0000-4000-8000-000000000303",
        runId,
        threadId,
        sessionId,
        creationKey: `sandbox:${runId}`,
        snapshotId: "00000000-0000-4000-8000-000000000099",
        egress: { mode: "none" },
      } as const;
      await assert.rejects(
        manager.ensure(sandboxInput),
        /Sandbox creation failed/u,
      );
      const instance = await manager.ensure(sandboxInput);
      const command = {
        commandId: "00000000-0000-4000-8000-000000000304",
        commandKey: `command:${runId}:1`,
        command: "printf safe",
        timeoutMs: 1_000,
      };
      assert.equal((await manager.execute(instance, command)).exitCode, 0);
      assert.equal((await manager.execute(instance, command)).exitCode, 0);
      await manager.recordArtifact(instance, {
        artifactId: "00000000-0000-4000-8000-000000000305",
        commandId: command.commandId,
        artifactKey: `artifact:${runId}:1`,
        artifactRef: "s3://safe-bucket/result.txt",
        contentType: "text/plain",
        sizeBytes: 4,
        sha256: createHash("sha256").update("safe").digest(),
      });
      await manager.stop(instance);
      const events = await pool.query<{ event_kind: string }>(
        "SELECT event_kind FROM oao.product_events WHERE aggregate_id=$1 ORDER BY project_position",
        [runId],
      );
      assert.deepEqual(
        events.rows.map((row) => row.event_kind),
        [
          "sandbox.created",
          "sandbox.failed",
          "sandbox.started",
          "sandbox.command_started",
          "sandbox.command_completed",
          "sandbox.stopped",
        ],
      );
      const artifacts = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM oao.sandbox_artifacts WHERE run_id=$1",
        [runId],
      );
      assert.equal(artifacts.rows[0]?.count, "1");
      const correlation = await pool.query<{
        thread_id: string;
        session_id: string;
        target_preference: string;
        provider_target: string;
      }>(
        "SELECT thread_id,session_id,target_preference,provider_target FROM oao.sandbox_instances WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [tenant.organizationId, tenant.projectId, instance.record.id],
      );
      assert.equal(correlation.rows[0]?.thread_id, threadId);
      assert.equal(correlation.rows[0]?.session_id, sessionId);
      assert.equal(correlation.rows[0]?.target_preference, "provider-default");
      assert.equal(correlation.rows[0]?.provider_target, "provider-default");

      const storageProviderId = "00000000-0000-4000-8000-000000000306";
      const cipher = new ProviderCredentialCipher(Buffer.alloc(32, 6));
      const encrypted = cipher.encrypt(
        JSON.stringify({
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-access-key",
        }),
        {
          ...tenant,
          providerId: storageProviderId,
          providerType: "s3",
          keyVersion: 1,
        },
      );
      await withTenantTransaction(pool, tenant, (transaction) =>
        transaction.query(
          `INSERT INTO oao.project_storage_providers (
             organization_id,project_id,id,provider_key,display_name,provider_type,
             endpoint,region,bucket,object_prefix,force_path_style,is_default,
             encrypted_credential,encryption_nonce,encryption_tag,encryption_key_version,
             credential_fingerprint,created_by_principal_id
           ) VALUES ($1,$2,$3,'workspace-test','Workspace test','s3',NULL,'test-1',
                     'workspace-bucket','integration',true,true,$4,$5,$6,$7,$8,$9)`,
          [
            tenant.organizationId,
            tenant.projectId,
            storageProviderId,
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.tag,
            encrypted.keyVersion,
            encrypted.fingerprint,
            "00000000-0000-4000-8000-000000000003",
          ],
        ),
      );
      const objectClient = new MemoryS3Client();
      const backupResolver = new ProjectWorkspaceBackupResolver(
        pool,
        cipher,
        () => objectClient,
      );
      const workspaceThreadId =
        "00000000-0000-4000-8000-000000000307" as ThreadId;
      const workspaceSessionId =
        "00000000-0000-4000-8000-000000000308" as SessionId;
      const workspaceRunId = "00000000-0000-4000-8000-000000000309" as RunId;
      await withTenantTransaction(pool, tenant, (transaction) =>
        transaction.query(
          `WITH thread AS (
             INSERT INTO oao.threads (organization_id,project_id,id,title)
             VALUES ($1,$2,$3,'Workspace backup integration')
           ), session AS (
             INSERT INTO oao.sessions (
               organization_id,project_id,id,thread_id,agent_version_id
             ) VALUES ($1,$2,$4,$3,$5)
           )
           INSERT INTO oao.runs (
             organization_id,project_id,id,thread_id,session_id,agent_version_id,
             created_by_principal_id,idempotency_key
           ) VALUES ($1,$2,$6,$3,$4,$5,$7,'workspace-backup-integration')`,
          [
            tenant.organizationId,
            tenant.projectId,
            workspaceThreadId,
            workspaceSessionId,
            "00000000-0000-4000-8000-000000000005",
            workspaceRunId,
            "00000000-0000-4000-8000-000000000003",
          ],
        ),
      );
      const identity = {
        ...tenant,
        runId: workspaceRunId,
        threadId: workspaceThreadId,
        sessionId: workspaceSessionId,
      };
      const firstStore = await backupResolver.resolve(identity);
      assert.ok(firstStore);
      const firstProvider = new WorkspaceSandboxProvider();
      const firstFactory = createManagedDaytonaFlueSandbox({
        pool,
        provider: firstProvider,
        ...identity,
        snapshotId: "00000000-0000-4000-8000-000000000099",
        egress: { mode: "none" },
        workspaceBackupStore: firstStore,
      });
      const firstSandbox = await firstFactory.createSandbox({
        id: "workspace-first",
      });
      const finishRenderFactory = createManagedDaytonaFlueSandbox({
        pool,
        provider: firstProvider,
        ...identity,
        snapshotId: "00000000-0000-4000-8000-000000000099",
        egress: { mode: "none" },
        workspaceBackupStore: firstStore,
      });
      await finishRenderFactory.persistWorkspace(firstSandbox);

      const replacementStore = await backupResolver.resolve(identity);
      assert.ok(replacementStore);
      const storedManifest = await replacementStore.loadManifest();
      assert.equal(storedManifest?.version, 1);
      assert.deepEqual(storedManifest?.files, [
        {
          name: "result.csv",
          path: "output/result.csv",
          sizeBytes: 42,
        },
      ]);
      const replacementProvider = new WorkspaceSandboxProvider();
      const replacementFactory = createManagedDaytonaFlueSandbox({
        pool,
        provider: replacementProvider,
        ...identity,
        snapshotId: "00000000-0000-4000-8000-000000000099",
        egress: { mode: "none" },
        workspaceBackupStore: replacementStore,
      });
      await replacementFactory.createSandbox({ id: "workspace-replacement" });
      assert.deepEqual(
        replacementProvider.restoredArchive,
        new Uint8Array([31, 139, 8, 0, 1, 2, 3]),
      );
      const backup = await pool.query<{
        generation: string;
        last_restored_at: Date | null;
      }>(
        `SELECT generation::text,last_restored_at
           FROM oao.thread_workspace_backups
          WHERE organization_id=$1 AND project_id=$2 AND thread_id=$3`,
        [tenant.organizationId, tenant.projectId, workspaceThreadId],
      );
      assert.equal(backup.rows[0]?.generation, "1");
      assert.ok(backup.rows[0]?.last_restored_at);
      const [objectKey, storedObject] =
        [...objectClient.objects.entries()][0] ?? [];
      assert.ok(objectKey && storedObject);
      objectClient.objects.set(objectKey, {
        ...storedObject,
        body: new Uint8Array([0]),
      });
      const corruptStore = await backupResolver.resolve(identity);
      assert.ok(corruptStore);
      await assert.rejects(
        corruptStore.load(),
        /length does not match|checksum does not match/u,
      );
    } finally {
      await pool.end();
    }
  },
);
