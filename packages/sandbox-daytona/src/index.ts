import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Daytona, SandboxState } from "@daytona/sdk";
import type { Sandbox as DaytonaSandbox } from "@daytona/sdk";
import { Type } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  sandboxFromDriver,
} from "@flue/runtime";
import type {
  FileStat,
  Sandbox,
  SandboxDriver,
  SandboxFactory,
} from "@flue/runtime";
import type {
  WorkspaceBackupFile,
  WorkspaceBackupIdentity,
  WorkspaceBackupStore,
} from "@oao/artifact-s3";
import type { SandboxCapability, SandboxSnapshotEntry } from "@oao/contracts";
import { DEFAULT_SANDBOX_CAPABILITIES } from "@oao/contracts";
import type { PgPool, Queryable, TenantContext } from "@oao/db-postgres";
import { withTenantTransaction } from "@oao/db-postgres";
import type { PublicValue, RunId, SessionId, ThreadId } from "@oao/domain";
import { assertPublicPayload, isSensitivePublicKey } from "@oao/domain";
import type { ProviderCredentialCipher } from "@oao/provider-credentials";
import {
  daytona,
  resolveDaytonaWorkspaceDirectory,
} from "./flue-daytona-blueprint.js";

const MAX_WORKSPACE_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_WORKSPACE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_WORKSPACE_MANIFEST_FILES = 10_000;
const MAX_WORKSPACE_MANIFEST_DEPTH = 100;
const WORKSPACE_BACKUP_EXCLUDED_ROOT_FILES = new Set([
  ".bash_logout",
  ".bashrc",
  ".face",
  ".face.icon",
  ".profile",
  ".zshrc",
]);
const WORKSPACE_BACKUP_TAR_EXCLUDES = [
  ".oao-workspace-backup.tar.gz",
  ".daytona",
  ...WORKSPACE_BACKUP_EXCLUDED_ROOT_FILES,
]
  .map((path) => `--exclude='./${path}'`)
  .join(" ");
const workspacePersistenceBySandbox = new WeakMap<
  Sandbox,
  () => Promise<void>
>();

/** Provider/runtime files are recreated by Daytona and are not agent output. */
function excludedFromWorkspaceBackup(path: string): boolean {
  return (
    path === ".daytona" ||
    path.startsWith(".daytona/") ||
    WORKSPACE_BACKUP_EXCLUDED_ROOT_FILES.has(path)
  );
}

function safeText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim();
  return sanitized ? sanitized.slice(0, maximumLength) : undefined;
}

function safeCommandName(command: unknown): string {
  const firstToken = safeText(command, 4_096)?.split(/\s+/u)[0];
  if (!firstToken || firstToken.includes("=")) return "command";
  const basename = firstToken.split("/").at(-1);
  return basename && /^[a-zA-Z0-9_.:+-]{1,64}$/u.test(basename)
    ? basename
    : "command";
}

const CREDENTIAL_TEXT =
  /((?:api[_-]?key|authorization|bearer|password|secret|token)\s*[=:]\s*)([^\s'"&,;]+)/giu;
const BEARER_TEXT = /(bearer\s+)([a-z0-9._~+/-]+)/giu;
const CREDENTIAL_QUERY =
  /([?&](?:api[_-]?key|authorization|password|secret|token)=)([^&#\s]+)/giu;
const URL_CREDENTIALS = /(https?:\/\/)[^/@:\s]+:[^/@\s]+@/giu;

function redactCredentialText(value: string): string {
  return value
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(CREDENTIAL_QUERY, "$1[REDACTED]")
    .replace(CREDENTIAL_TEXT, "$1[REDACTED]")
    .replace(BEARER_TEXT, "$1[REDACTED]");
}

/** Preserve transcript content while still removing credential-bearing fields. */
function transcriptValue(value: unknown): PublicValue {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return redactCredentialText(value);
  if (Array.isArray(value)) return value.map(transcriptValue);
  if (typeof value === "object") {
    const safe: Record<string, PublicValue> = {};
    const redactedFields: string[] = [];
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (isSensitivePublicKey(key)) redactedFields.push(key);
      else safe[key] = transcriptValue(nested);
    }
    if (redactedFields.length > 0) safe.redactedFields = redactedFields;
    return safe;
  }
  return String(value);
}

/** Persist model-facing tool arguments for the authorized session transcript. */
export function safeSandboxToolCommand(
  toolName: string,
  params: unknown,
): Readonly<Record<string, PublicValue>> {
  const safe = { toolName, arguments: transcriptValue(params) } as const;
  assertPublicPayload(safe);
  return safe;
}

async function persistRegisteredWorkspace(sandbox: Sandbox): Promise<void> {
  const persist = workspacePersistenceBySandbox.get(sandbox);
  if (!persist) throw new Error("Sandbox workspace persistence is unavailable");
  await persist();
}

export async function listDaytonaSnapshots(input: {
  readonly apiKey: string;
  readonly target?: string;
}): Promise<readonly SandboxSnapshotEntry[]> {
  const client = new Daytona({
    apiKey: input.apiKey,
    ...(input.target ? { target: input.target } : {}),
  });
  const snapshots: SandboxSnapshotEntry[] = [];
  let page = 1;
  for (;;) {
    const result = await client.snapshot.list({ page, limit: 100 });
    snapshots.push(
      ...result.items.map((snapshot) => ({
        id: snapshot.id,
        providerType: "daytona" as const,
        name: snapshot.name,
        state: snapshot.state,
        available: snapshot.state === "active",
        imageName: snapshot.imageName ?? null,
        general: snapshot.general,
        cpu: snapshot.cpu,
        gpu: snapshot.gpu,
        memoryGiB: snapshot.mem,
        diskGiB: snapshot.disk,
        regionIds: snapshot.regionIds ?? [],
        sandboxClass: snapshot.sandboxClass ?? null,
        createdAt: new Date(snapshot.createdAt).toISOString(),
        updatedAt: new Date(snapshot.updatedAt).toISOString(),
        lastUsedAt: snapshot.lastUsedAt
          ? new Date(snapshot.lastUsedAt).toISOString()
          : null,
      })),
    );
    if (page >= result.totalPages) break;
    page += 1;
  }
  return snapshots;
}

export function daytonaSandboxRecoveryAction(
  state: string | undefined,
): "skip" | "recover" | "start" | "reuse" {
  if (state === SandboxState.BUILD_FAILED || state === SandboxState.DESTROYED)
    return "skip";
  if (state === SandboxState.ERROR) return "recover";
  if (state === SandboxState.STOPPED) return "start";
  return "reuse";
}

export interface SandboxEgressPolicy {
  readonly mode: "none" | "restricted";
  readonly allowedDomains?: readonly string[];
  readonly allowedCidrs?: readonly string[];
}

export interface SandboxHandle {
  readonly providerRef: string;
  readonly target: string;
  readonly native?: unknown;
}

export interface SandboxProviderPort {
  findByCreationKey(key: string): Promise<SandboxHandle | undefined>;
  create(input: {
    readonly creationKey: string;
    readonly snapshotId: string;
    readonly targetPreference?: string;
    readonly egress: SandboxEgressPolicy;
  }): Promise<SandboxHandle>;
  execute(input: {
    readonly sandbox: SandboxHandle;
    readonly command: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly exitCode: number; readonly redactedOutput: string }>;
  stop(sandbox: SandboxHandle): Promise<void>;
}

export interface FlueSandboxProviderPort extends SandboxProviderPort {
  flueFactory(
    sandbox: SandboxHandle,
    options: {
      readonly capabilities: readonly SandboxCapability[];
      readonly egress: SandboxEgressPolicy;
    },
  ): SandboxFactory;
  captureWorkspace?(sandbox: SandboxHandle): Promise<Uint8Array>;
  listWorkspaceFiles?(
    sandbox: SandboxHandle,
  ): Promise<readonly WorkspaceBackupFile[]>;
  restoreWorkspace?(sandbox: SandboxHandle, archive: Uint8Array): Promise<void>;
}

export interface InstanceRecord extends TenantContext {
  readonly id: string;
  readonly runId: RunId;
  readonly creatorRunId: RunId;
  readonly threadId: ThreadId;
  readonly sessionId: SessionId;
  readonly creationKey: string;
  readonly fence: bigint;
  readonly state:
    "creating" | "running" | "recovering" | "stopping" | "stopped" | "failed";
  readonly providerRef?: string;
  readonly target: string;
}

export interface CommandRecord {
  readonly id: string;
  readonly fence: bigint;
  readonly state: "reserved" | "running" | "completed" | "failed" | "cancelled";
  readonly result?: {
    readonly exitCode: number;
    readonly redactedOutput: string;
    readonly output?: PublicValue;
  };
}

export interface SandboxArtifactRecord {
  readonly artifactId: string;
  readonly artifactKey: string;
  readonly artifactRef: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: Uint8Array;
}

export interface SandboxRepository {
  reserveInstance(
    input: TenantContext & {
      readonly id: string;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly sessionId: SessionId;
      readonly creationKey: string;
      readonly egress: SandboxEgressPolicy;
      readonly targetPreference?: string;
    },
  ): Promise<InstanceRecord>;
  markRunning(
    instance: InstanceRecord,
    handle: SandboxHandle,
  ): Promise<InstanceRecord>;
  markFailed(instance: InstanceRecord): Promise<void>;
  markStopped(instance: InstanceRecord): Promise<void>;
  reserveCommand(
    input: InstanceRecord & {
      readonly commandId: string;
      readonly commandKey: string;
      readonly safeCommand: Readonly<Record<string, PublicValue>>;
    },
  ): Promise<CommandRecord>;
  markCommandRunning(
    input: InstanceRecord,
    command: CommandRecord,
  ): Promise<CommandRecord>;
  completeCommand(
    input: InstanceRecord,
    command: CommandRecord,
    result: {
      readonly exitCode: number;
      readonly redactedOutput: string;
      readonly output?: PublicValue;
    },
  ): Promise<CommandRecord>;
  failCommand(
    input: InstanceRecord,
    command: CommandRecord,
  ): Promise<CommandRecord>;
  recordArtifact(
    input: InstanceRecord &
      SandboxArtifactRecord & { readonly commandId?: string },
  ): Promise<void>;
}

function sha256(value: unknown): Uint8Array {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function stableUuid(value: string): string {
  const bytes = Buffer.from(sha256(value)).subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function appendSandboxEvent(
  transaction: Queryable,
  input: InstanceRecord,
  suffix: string,
  kind: string,
  payload: Readonly<Record<string, PublicValue>>,
): Promise<void> {
  const id = stableUuid(`sandbox-event:${input.id}:${input.runId}:${suffix}`);
  const exists = await transaction.query(
    "SELECT 1 FROM oao.product_events WHERE organization_id=$1 AND project_id=$2 AND id=$3",
    [input.organizationId, input.projectId, id],
  );
  if (exists.rowCount) return;
  await transaction.query(
    "SELECT oao.append_product_event($1,$2,$3,'run',$4,$5,$6,clock_timestamp())",
    [input.organizationId, input.projectId, id, input.runId, kind, payload],
  );
}

export class PostgresSandboxRepository implements SandboxRepository {
  constructor(private readonly pool: PgPool) {}

  async reserveInstance(
    input: TenantContext & {
      readonly id: string;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly sessionId: SessionId;
      readonly creationKey: string;
      readonly egress: SandboxEgressPolicy;
      readonly targetPreference?: string;
    },
  ): Promise<InstanceRecord> {
    assertPublicPayload(input.egress as unknown as PublicValue);
    return withTenantTransaction(this.pool, input, async (transaction) => {
      await transaction.query(
        `INSERT INTO oao.sandbox_instances (
          organization_id,project_id,id,run_id,thread_id,session_id,provider,state,
          creation_key,egress_policy,target_preference
        ) VALUES ($1,$2,$3,$4,$5,$6,'daytona','creating',$7,$8,$9)
        ON CONFLICT (organization_id,project_id,creation_key) DO NOTHING`,
        [
          input.organizationId,
          input.projectId,
          input.id,
          input.runId,
          input.threadId,
          input.sessionId,
          input.creationKey,
          input.egress,
          input.targetPreference ?? "provider-default",
        ],
      );
      const result = await transaction.query(
        `SELECT organization_id,project_id,id,run_id,thread_id,session_id,creation_key,
          creation_fence,state,provider_ref,target_preference,provider_target,egress_policy
          FROM oao.sandbox_instances
         WHERE organization_id=$1 AND project_id=$2 AND creation_key=$3 FOR UPDATE`,
        [input.organizationId, input.projectId, input.creationKey],
      );
      let row = result.rows[0] as Record<string, unknown>;
      const requestedTarget = input.targetPreference ?? "provider-default";
      if (
        row.provider_ref &&
        row.provider_target == null &&
        row.target_preference !== requestedTarget
      ) {
        const reconciled = await transaction.query(
          `UPDATE oao.sandbox_instances
              SET provider_target=target_preference,target_preference=$5,
                  updated_at=clock_timestamp()
            WHERE organization_id=$1 AND project_id=$2 AND id=$3
              AND creation_fence=$4 AND provider_target IS NULL
          RETURNING organization_id,project_id,id,run_id,thread_id,session_id,
                    creation_key,creation_fence,state,provider_ref,
                    target_preference,provider_target,egress_policy`,
          [
            input.organizationId,
            input.projectId,
            row.id,
            String(row.creation_fence),
            requestedTarget,
          ],
        );
        if (!reconciled.rowCount)
          throw new Error("Stale sandbox target reconciliation fence");
        row = reconciled.rows[0] as Record<string, unknown>;
      }
      if (
        row.thread_id !== input.threadId ||
        row.session_id !== input.sessionId ||
        row.target_preference !== requestedTarget ||
        Buffer.compare(
          Buffer.from(sha256(row.egress_policy)),
          Buffer.from(sha256(input.egress)),
        ) !== 0
      )
        throw new Error("Sandbox creation idempotency conflict");
      if (row.state === "failed") {
        const recovery = await transaction.query(
          `UPDATE oao.sandbox_instances
              SET state='recovering',creation_fence=creation_fence+1,
                  provider_ref=NULL,provider_target=NULL,safe_error=NULL,
                  updated_at=clock_timestamp()
            WHERE organization_id=$1 AND project_id=$2 AND id=$3
              AND creation_fence=$4 AND state='failed'
          RETURNING organization_id,project_id,id,run_id,thread_id,session_id,
                    creation_key,creation_fence,state,provider_ref,
                    target_preference,provider_target,egress_policy`,
          [
            input.organizationId,
            input.projectId,
            row.id,
            String(row.creation_fence),
          ],
        );
        if (!recovery.rowCount) throw new Error("Stale sandbox recovery fence");
        row = recovery.rows[0] as Record<string, unknown>;
      }
      const instance = this.mapInstance(row, input.runId);
      if (instance.creatorRunId === input.runId)
        await appendSandboxEvent(
          transaction,
          instance,
          "created",
          "sandbox.created",
          { sandboxId: instance.id, targetPreference: instance.target },
        );
      return instance;
    });
  }

  async markRunning(
    instance: InstanceRecord,
    handle: SandboxHandle,
  ): Promise<InstanceRecord> {
    return withTenantTransaction(this.pool, instance, async (transaction) => {
      const result = await transaction.query(
        `UPDATE oao.sandbox_instances SET state='running',provider_ref=$5,
          provider_target=$6,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND id=$3
           AND creation_fence=$4 AND state IN ('creating','recovering','running') RETURNING *`,
        [
          instance.organizationId,
          instance.projectId,
          instance.id,
          instance.fence.toString(),
          handle.providerRef,
          handle.target,
        ],
      );
      if (!result.rowCount) throw new Error("Stale sandbox creation fence");
      const running = this.mapInstance(
        result.rows[0] as Record<string, unknown>,
        instance.runId,
      );
      await appendSandboxEvent(
        transaction,
        running,
        "started",
        "sandbox.started",
        { sandboxId: running.id, target: running.target },
      );
      return running;
    });
  }

  async markFailed(instance: InstanceRecord): Promise<void> {
    await withTenantTransaction(this.pool, instance, async (transaction) => {
      await transaction.query(
        `UPDATE oao.sandbox_instances SET state='failed',safe_error=$5,
          updated_at=clock_timestamp() WHERE organization_id=$1 AND project_id=$2
          AND id=$3 AND creation_fence=$4`,
        [
          instance.organizationId,
          instance.projectId,
          instance.id,
          instance.fence.toString(),
          {
            code: "sandbox_creation_failed",
            message: "Sandbox creation failed",
          },
        ],
      );
      await appendSandboxEvent(
        transaction,
        instance,
        "failed",
        "sandbox.failed",
        { sandboxId: instance.id },
      );
    });
  }

  async markStopped(instance: InstanceRecord): Promise<void> {
    await withTenantTransaction(this.pool, instance, async (transaction) => {
      await transaction.query(
        `UPDATE oao.sandbox_instances SET state='stopped',stopped_at=clock_timestamp(),
          updated_at=clock_timestamp() WHERE organization_id=$1 AND project_id=$2 AND id=$3
          AND creation_fence=$4`,
        [
          instance.organizationId,
          instance.projectId,
          instance.id,
          instance.fence.toString(),
        ],
      );
      await appendSandboxEvent(
        transaction,
        instance,
        "stopped",
        "sandbox.stopped",
        { sandboxId: instance.id },
      );
    });
  }

  async reserveCommand(
    input: InstanceRecord & {
      readonly commandId: string;
      readonly commandKey: string;
      readonly safeCommand: Readonly<Record<string, PublicValue>>;
    },
  ): Promise<CommandRecord> {
    assertPublicPayload(input.safeCommand);
    return withTenantTransaction(this.pool, input, async (transaction) => {
      const hash = sha256(input.safeCommand);
      await transaction.query(
        `INSERT INTO oao.sandbox_commands (
          organization_id,project_id,id,sandbox_id,run_id,command_key,request_hash,state,safe_command
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8)
        ON CONFLICT (organization_id,project_id,command_key) DO NOTHING`,
        [
          input.organizationId,
          input.projectId,
          input.commandId,
          input.id,
          input.runId,
          input.commandKey,
          hash,
          input.safeCommand,
        ],
      );
      const result = await transaction.query(
        `SELECT * FROM oao.sandbox_commands WHERE organization_id=$1 AND project_id=$2
          AND command_key=$3 FOR UPDATE`,
        [input.organizationId, input.projectId, input.commandKey],
      );
      const row = result.rows[0] as Record<string, unknown>;
      if (
        Buffer.compare(
          Buffer.from(row.request_hash as Uint8Array),
          Buffer.from(hash),
        ) !== 0
      )
        throw new Error("Sandbox command idempotency conflict");
      return this.mapCommand(row);
    });
  }

  async markCommandRunning(
    input: InstanceRecord,
    command: CommandRecord,
  ): Promise<CommandRecord> {
    return withTenantTransaction(this.pool, input, async (transaction) => {
      const result = await transaction.query(
        `UPDATE oao.sandbox_commands SET state='running',started_at=COALESCE(started_at,clock_timestamp()),
          execution_fence=execution_fence+1 WHERE organization_id=$1 AND project_id=$2 AND id=$3
          AND execution_fence=$4 AND state IN ('reserved','running') RETURNING *`,
        [
          input.organizationId,
          input.projectId,
          command.id,
          command.fence.toString(),
        ],
      );
      if (!result.rowCount) throw new Error("Stale sandbox command fence");
      const running = this.mapCommand(
        result.rows[0] as Record<string, unknown>,
      );
      await appendSandboxEvent(
        transaction,
        input,
        `command:${command.id}:started`,
        "sandbox.command_started",
        { sandboxId: input.id, commandId: command.id },
      );
      return running;
    });
  }

  async completeCommand(
    input: InstanceRecord,
    command: CommandRecord,
    resultValue: {
      readonly exitCode: number;
      readonly redactedOutput: string;
      readonly output?: PublicValue;
    },
  ): Promise<CommandRecord> {
    return withTenantTransaction(this.pool, input, async (transaction) => {
      const result = await transaction.query(
        `UPDATE oao.sandbox_commands SET state='completed',safe_result=$5,completed_at=clock_timestamp()
         WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND execution_fence=$4
           AND state='running' RETURNING *`,
        [
          input.organizationId,
          input.projectId,
          command.id,
          command.fence.toString(),
          resultValue,
        ],
      );
      if (!result.rowCount)
        throw new Error("Stale sandbox command result fence");
      const completed = this.mapCommand(
        result.rows[0] as Record<string, unknown>,
      );
      await appendSandboxEvent(
        transaction,
        input,
        `command:${command.id}:completed`,
        "sandbox.command_completed",
        {
          sandboxId: input.id,
          commandId: command.id,
          exitCode: resultValue.exitCode,
        },
      );
      return completed;
    });
  }

  async failCommand(
    input: InstanceRecord,
    command: CommandRecord,
  ): Promise<CommandRecord> {
    return withTenantTransaction(this.pool, input, async (transaction) => {
      const result = await transaction.query(
        `UPDATE oao.sandbox_commands SET state='failed',safe_result=$5,
          completed_at=clock_timestamp() WHERE organization_id=$1 AND project_id=$2
          AND id=$3 AND execution_fence=$4 AND state='running' RETURNING *`,
        [
          input.organizationId,
          input.projectId,
          command.id,
          command.fence.toString(),
          { exitCode: -1, redactedOutput: "Sandbox command failed" },
        ],
      );
      if (!result.rowCount)
        throw new Error("Stale sandbox command failure fence");
      await appendSandboxEvent(
        transaction,
        input,
        `command:${command.id}:failed`,
        "sandbox.command_failed",
        { sandboxId: input.id, commandId: command.id },
      );
      return this.mapCommand(result.rows[0] as Record<string, unknown>);
    });
  }

  async recordArtifact(
    input: InstanceRecord &
      SandboxArtifactRecord & { readonly commandId?: string },
  ): Promise<void> {
    if (input.sha256.byteLength !== 32)
      throw new TypeError("Artifact SHA-256 must be 32 bytes");
    await withTenantTransaction(this.pool, input, (transaction) =>
      transaction.query(
        `INSERT INTO oao.sandbox_artifacts (
          organization_id,project_id,id,sandbox_id,run_id,command_id,artifact_key,
          artifact_ref,content_type,size_bytes,sha256
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (organization_id,project_id,artifact_key) DO NOTHING`,
        [
          input.organizationId,
          input.projectId,
          input.artifactId,
          input.id,
          input.runId,
          input.commandId ?? null,
          input.artifactKey,
          input.artifactRef,
          input.contentType,
          input.sizeBytes,
          input.sha256,
        ],
      ),
    );
  }

  private mapInstance(
    row: Record<string, unknown>,
    activeRunId = row.run_id as RunId,
  ): InstanceRecord {
    return {
      organizationId: row.organization_id as InstanceRecord["organizationId"],
      projectId: row.project_id as InstanceRecord["projectId"],
      id: row.id as string,
      runId: activeRunId,
      creatorRunId: row.run_id as RunId,
      threadId: row.thread_id as ThreadId,
      sessionId: row.session_id as SessionId,
      creationKey: row.creation_key as string,
      fence: BigInt(row.creation_fence as string),
      state: row.state as InstanceRecord["state"],
      ...(row.provider_ref ? { providerRef: row.provider_ref as string } : {}),
      target: (row.provider_target ?? row.target_preference) as string,
    };
  }

  private mapCommand(row: Record<string, unknown>): CommandRecord {
    const safeResult = row.safe_result as {
      exitCode: number;
      redactedOutput: string;
      output?: PublicValue;
    } | null;
    return {
      id: row.id as string,
      fence: BigInt(row.execution_fence as string),
      state: row.state as CommandRecord["state"],
      ...(safeResult ? { result: safeResult } : {}),
    };
  }
}

export class ManagedSandboxLifecycle {
  constructor(
    private readonly repository: SandboxRepository,
    private readonly provider: SandboxProviderPort,
  ) {}

  async ensure(
    input: TenantContext & {
      readonly sandboxId: string;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly sessionId: SessionId;
      readonly creationKey: string;
      readonly snapshotId: string;
      readonly egress: SandboxEgressPolicy;
      readonly targetPreference?: string;
    },
  ): Promise<{
    readonly record: InstanceRecord;
    readonly handle: SandboxHandle;
    readonly created: boolean;
  }> {
    this.validateEgress(input.egress);
    let record = await this.repository.reserveInstance({
      id: input.sandboxId,
      ...input,
    });
    let handle: SandboxHandle;
    let created = false;
    try {
      const existing = await this.provider.findByCreationKey(input.creationKey);
      if (existing) handle = existing;
      else {
        created = true;
        handle = await this.provider.create({
          creationKey: input.creationKey,
          snapshotId: input.snapshotId,
          egress: input.egress,
          ...(input.targetPreference
            ? { targetPreference: input.targetPreference }
            : {}),
        });
      }
    } catch {
      await this.repository.markFailed(record);
      throw new Error("Sandbox creation failed");
    }
    record = await this.repository.markRunning(record, handle);
    return { record, handle, created };
  }

  async execute(
    instance: {
      readonly record: InstanceRecord;
      readonly handle: SandboxHandle;
    },
    input: {
      readonly commandId: string;
      readonly commandKey: string;
      readonly command: string;
      readonly timeoutMs: number;
    },
  ): Promise<{ readonly exitCode: number; readonly redactedOutput: string }> {
    let command = await this.repository.reserveCommand({
      ...instance.record,
      commandId: input.commandId,
      commandKey: input.commandKey,
      safeCommand: { commandName: safeCommandName(input.command) },
    });
    if (command.state === "completed" && command.result) return command.result;
    command = await this.repository.markCommandRunning(
      instance.record,
      command,
    );
    let result: { readonly exitCode: number; readonly redactedOutput: string };
    try {
      result = await this.provider.execute({
        sandbox: instance.handle,
        command: input.command,
        timeoutMs: input.timeoutMs,
      });
    } catch {
      await this.repository.failCommand(instance.record, command);
      throw new Error("Sandbox command failed");
    }
    const committed = await this.repository.completeCommand(
      instance.record,
      command,
      result,
    );
    if (!committed.result)
      throw new Error("Sandbox command result was not committed");
    return committed.result;
  }

  async recordArtifact(
    instance: { readonly record: InstanceRecord },
    artifact: SandboxArtifactRecord & { readonly commandId?: string },
  ): Promise<void> {
    await this.repository.recordArtifact({ ...instance.record, ...artifact });
  }

  async stop(instance: {
    readonly record: InstanceRecord;
    readonly handle: SandboxHandle;
  }): Promise<void> {
    await this.provider.stop(instance.handle);
    await this.repository.markStopped(instance.record);
  }

  private validateEgress(policy: SandboxEgressPolicy): void {
    if (
      policy.mode === "none" &&
      (policy.allowedDomains?.length || policy.allowedCidrs?.length)
    )
      throw new TypeError("Network-none policy cannot include allowlists");
    if (
      policy.mode === "restricted" &&
      !policy.allowedDomains?.length &&
      !policy.allowedCidrs?.length
    )
      throw new TypeError(
        "Restricted egress requires a domain or CIDR allowlist",
      );
  }
}

type SandboxTool = ReturnType<NonNullable<SandboxFactory["tools"]>>[number];

interface BrowserSnapshot {
  readonly accessibilityTree: unknown;
  readonly screenshotBase64?: string;
}

type BrowserInteraction =
  | { readonly action: "click"; readonly nodeId: string }
  | {
      readonly action: "set_value";
      readonly nodeId: string;
      readonly value: string;
    }
  | {
      readonly action: "press";
      readonly key: string;
      readonly modifiers?: readonly string[];
    }
  | {
      readonly action: "scroll";
      readonly direction: "up" | "down";
      readonly amount?: number;
    };

interface SandboxBrowserController {
  navigate(url: string, signal?: AbortSignal): Promise<void>;
  snapshot(signal?: AbortSignal): Promise<BrowserSnapshot>;
  interact(input: BrowserInteraction, signal?: AbortSignal): Promise<void>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
}

function isHostAllowed(hostname: string, policy: SandboxEgressPolicy): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  const loopback =
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1";
  if (loopback) return true;
  if (policy.mode === "none") return false;
  if (
    policy.allowedCidrs?.some(
      (cidr) => cidr === `${normalized}/32` || cidr === `${normalized}/128`,
    )
  )
    return true;
  return Boolean(
    policy.allowedDomains?.some((entry) => {
      const allowed = entry.toLowerCase();
      return allowed.startsWith("*.")
        ? normalized.endsWith(allowed.slice(1)) &&
            normalized !== allowed.slice(2)
        : normalized === allowed;
    }),
  );
}

function validateBrowserUrl(value: string, policy: SandboxEgressPolicy): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Browser URL must be absolute");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("Browser URL must use http or https");
  if (url.username || url.password)
    throw new TypeError("Browser URL must not include credentials");
  if (!isHostAllowed(url.hostname, policy))
    throw new Error("Browser URL is outside the sandbox egress allowlist");
  return url;
}

class DaytonaBrowserController implements SandboxBrowserController {
  #ready: Promise<void> | undefined;

  constructor(
    private readonly sandbox: DaytonaSandbox,
    private readonly egress: SandboxEgressPolicy,
  ) {}

  async navigate(value: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const url = validateBrowserUrl(value, this.egress);
    await this.ensureReady();
    throwIfAborted(signal);
    await this.sandbox.computerUse.keyboard.press("l", ["ctrl"]);
    await this.sandbox.computerUse.keyboard.type(url.toString());
    await this.sandbox.computerUse.keyboard.press("enter");
  }

  async snapshot(signal?: AbortSignal): Promise<BrowserSnapshot> {
    throwIfAborted(signal);
    await this.ensureReady();
    const [accessibilityTree, screenshot] = await Promise.all([
      this.sandbox.computerUse.accessibility.getTree({
        scope: "all",
        maxDepth: 8,
      }),
      this.sandbox.computerUse.screenshot.takeCompressed({
        format: "jpeg",
        quality: 70,
        scale: 0.75,
      }),
    ]);
    throwIfAborted(signal);
    return {
      accessibilityTree,
      ...(screenshot.screenshot
        ? { screenshotBase64: screenshot.screenshot }
        : {}),
    };
  }

  async interact(
    input: BrowserInteraction,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await this.ensureReady();
    switch (input.action) {
      case "click":
        await this.sandbox.computerUse.accessibility.invokeNode(input.nodeId);
        break;
      case "set_value":
        await this.sandbox.computerUse.accessibility.setNodeValue(
          input.nodeId,
          input.value,
        );
        break;
      case "press":
        await this.sandbox.computerUse.keyboard.press(
          input.key,
          input.modifiers ? [...input.modifiers] : undefined,
        );
        break;
      case "scroll": {
        const position = await this.sandbox.computerUse.mouse.getPosition();
        await this.sandbox.computerUse.mouse.scroll(
          position.x ?? 0,
          position.y ?? 0,
          input.direction,
          input.amount,
        );
        break;
      }
    }
    throwIfAborted(signal);
  }

  private ensureReady(): Promise<void> {
    this.#ready ??= (async () => {
      await this.sandbox.computerUse.start();
      const executable = await this.sandbox.process.executeCommand(
        "command -v chromium || command -v chromium-browser || command -v google-chrome",
      );
      const browser = executable.result?.trim().split(/\s+/u)[0];
      if (!browser)
        throw new Error("Daytona sandbox image does not include Chromium");
      await this.sandbox.process.executeCommand(
        `${browser} --no-sandbox --disable-dev-shm-usage --start-maximized about:blank >/tmp/oao-browser.log 2>&1 &`,
      );
    })();
    return this.#ready;
  }
}

class FakeBrowserController implements SandboxBrowserController {
  #url = "about:blank";

  async navigate(url: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.#url = url;
  }

  async snapshot(signal?: AbortSignal): Promise<BrowserSnapshot> {
    throwIfAborted(signal);
    return {
      accessibilityTree: {
        role: "document",
        name: `Deterministic browser at ${this.#url}`,
      },
    };
  }

  async interact(
    _input: BrowserInteraction,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
  }
}

function composeSandboxTools(
  sandbox: Sandbox,
  capabilities: readonly SandboxCapability[],
  browser: SandboxBrowserController,
): SandboxTool[] {
  const enabled = new Set(capabilities);
  const tools: SandboxTool[] = [];
  if (enabled.has("filesystem_read")) tools.push(createReadTool(sandbox));
  if (enabled.has("filesystem_write"))
    tools.push(createWriteTool(sandbox), createEditTool(sandbox));
  if (enabled.has("shell"))
    tools.push(
      createBashTool(sandbox),
      createGrepTool(sandbox),
      createGlobTool(sandbox),
    );
  if (enabled.has("browser")) {
    tools.push(
      {
        name: "browser_navigate",
        label: "Navigate browser",
        description:
          "Navigate the sandbox browser to an allowed absolute HTTP(S) URL.",
        parameters: Type.Object({ url: Type.String() }),
        async execute(
          _id: string,
          params: { readonly url: string },
          signal?: AbortSignal,
        ) {
          await browser.navigate(params.url, signal);
          return {
            content: [{ type: "text", text: `Navigated to ${params.url}` }],
            details: { url: params.url },
          };
        },
      } as SandboxTool,
      {
        name: "browser_snapshot",
        label: "Inspect browser",
        description:
          "Return the browser accessibility tree and a compressed screenshot.",
        parameters: Type.Object({}),
        async execute(_id: string, _params: unknown, signal?: AbortSignal) {
          const result = await browser.snapshot(signal);
          const serialized = JSON.stringify(result.accessibilityTree);
          const content: Array<
            | { readonly type: "text"; readonly text: string }
            | {
                readonly type: "image";
                readonly data: string;
                readonly mimeType: string;
              }
          > = [
            {
              type: "text",
              text:
                serialized.length > 30_000
                  ? `${serialized.slice(0, 30_000)}\n[truncated]`
                  : serialized,
            },
          ];
          if (result.screenshotBase64)
            content.push({
              type: "image",
              data: result.screenshotBase64,
              mimeType: "image/jpeg",
            });
          return {
            content,
            details: { screenshotIncluded: Boolean(result.screenshotBase64) },
          };
        },
      } as SandboxTool,
      {
        name: "browser_interact",
        label: "Interact with browser",
        description:
          "Click or fill an accessibility node, press a key, or scroll.",
        parameters: Type.Union([
          Type.Object({
            action: Type.Literal("click"),
            nodeId: Type.String(),
          }),
          Type.Object({
            action: Type.Literal("set_value"),
            nodeId: Type.String(),
            value: Type.String(),
          }),
          Type.Object({
            action: Type.Literal("press"),
            key: Type.String(),
            modifiers: Type.Optional(Type.Array(Type.String())),
          }),
          Type.Object({
            action: Type.Literal("scroll"),
            direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
            amount: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
          }),
        ]),
        executionMode: "sequential",
        async execute(
          _id: string,
          params: BrowserInteraction,
          signal?: AbortSignal,
        ) {
          await browser.interact(params, signal);
          return {
            content: [{ type: "text", text: `${params.action} completed` }],
            details: { action: params.action },
          };
        },
      } as SandboxTool,
    );
  }
  return tools;
}

function withDurableToolAudit(
  tools: readonly SandboxTool[],
  repository: SandboxRepository,
  instance: { readonly record: InstanceRecord },
): SandboxTool[] {
  return tools.map(
    (tool) =>
      ({
        ...tool,
        async execute(
          toolCallId: string,
          params: unknown,
          signal?: AbortSignal,
          onUpdate?: Parameters<SandboxTool["execute"]>[3],
        ) {
          let command = await repository.reserveCommand({
            ...instance.record,
            commandId: stableUuid(
              `sandbox-tool:${instance.record.id}:${toolCallId}`,
            ),
            commandKey: `sandbox-tool:${instance.record.runId}:${toolCallId}`,
            safeCommand: safeSandboxToolCommand(tool.name, params),
          });
          if (command.state === "completed")
            return {
              content: [
                {
                  type: "text",
                  text: "Sandbox tool call was already completed.",
                },
              ],
              details: { replayed: true, toolName: tool.name },
            };
          command = await repository.markCommandRunning(
            instance.record,
            command,
          );
          try {
            const result = await tool.execute(
              toolCallId,
              params,
              signal,
              onUpdate,
            );
            await repository.completeCommand(instance.record, command, {
              exitCode: 0,
              redactedOutput: "Sandbox tool completed",
              output: transcriptValue(result),
            });
            return result;
          } catch (error) {
            await repository.failCommand(instance.record, command);
            throw error;
          }
        },
      }) as SandboxTool,
  );
}

export class DaytonaManagedProvider implements FlueSandboxProviderPort {
  readonly #client: Daytona;

  constructor(input: { readonly apiKey: string; readonly target?: string }) {
    if (!input.apiKey)
      throw new Error("DAYTONA_API_KEY is required for hosted sandboxes");
    const clientOptions = {
      apiKey: input.apiKey,
      ...(input.target ? { target: input.target } : {}),
    } as ConstructorParameters<typeof Daytona>[0];
    this.#client = new Daytona(clientOptions);
  }

  async findByCreationKey(key: string): Promise<SandboxHandle | undefined> {
    for await (const sandbox of this.#client.list({
      labels: { oaoCreationKey: key },
    })) {
      const action = daytonaSandboxRecoveryAction(sandbox.state);
      if (action === "skip") continue;
      if (action === "recover") {
        try {
          await sandbox.recover();
        } catch {
          continue;
        }
      } else if (action === "start") {
        await sandbox.start();
      }
      return this.wrap(sandbox);
    }
    return undefined;
  }

  async create(input: {
    readonly creationKey: string;
    readonly snapshotId: string;
    readonly targetPreference?: string;
    readonly egress: SandboxEgressPolicy;
  }): Promise<SandboxHandle> {
    const options = {
      labels: { oaoCreationKey: input.creationKey },
      networkBlockAll: input.egress.mode === "none",
      ...(input.egress.allowedDomains?.length
        ? { domainAllowList: input.egress.allowedDomains.join(",") }
        : {}),
      ...(input.egress.allowedCidrs?.length
        ? { networkAllowList: input.egress.allowedCidrs.join(",") }
        : {}),
      autoStopInterval: 15,
      autoDeleteInterval: 60,
    };
    const sandbox = await this.#client.create({
      ...options,
      snapshot: input.snapshotId,
    });
    return this.wrap(sandbox);
  }

  async execute(input: {
    readonly sandbox: SandboxHandle;
    readonly command: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly exitCode: number; readonly redactedOutput: string }> {
    const native = this.native(input.sandbox);
    const response = await native.process.executeCommand(
      input.command,
      undefined,
      undefined,
      Math.ceil(input.timeoutMs / 1_000),
    );
    return {
      exitCode: response.exitCode ?? 0,
      redactedOutput: response.result ?? "",
    };
  }

  async stop(sandbox: SandboxHandle): Promise<void> {
    await this.native(sandbox).stop();
  }

  async captureWorkspace(sandbox: SandboxHandle): Promise<Uint8Array> {
    const native = this.native(sandbox);
    const workspaceDirectory = await resolveDaytonaWorkspaceDirectory(native);
    const archivePath = "/tmp/oao-workspace-backup.tar.gz";
    try {
      const result = await native.process.executeCommand(
        `tar ${WORKSPACE_BACKUP_TAR_EXCLUDES} -czf ${archivePath} .`,
        workspaceDirectory,
        undefined,
        300,
      );
      if ((result.exitCode ?? 0) !== 0)
        throw new Error("Workspace archive command failed");
      const size = await native.process.executeCommand(
        `test "$(stat -c%s ${archivePath})" -le ${MAX_WORKSPACE_ARCHIVE_BYTES}`,
        undefined,
        undefined,
        30,
      );
      if ((size.exitCode ?? 0) !== 0)
        throw new Error("Workspace archive exceeds the 512 MiB limit");
      const bytes = await native.fs.downloadFile(archivePath);
      if (bytes.byteLength > MAX_WORKSPACE_ARCHIVE_BYTES)
        throw new Error("Workspace archive exceeds the 512 MiB limit");
      return new Uint8Array(bytes);
    } finally {
      await native.process
        .executeCommand(`rm -f ${archivePath}`, undefined, undefined, 30)
        .catch(() => undefined);
    }
  }

  async listWorkspaceFiles(
    sandbox: SandboxHandle,
  ): Promise<readonly WorkspaceBackupFile[]> {
    const native = this.native(sandbox);
    const workspaceDirectory = await resolveDaytonaWorkspaceDirectory(native);
    const entries = await native.fs.listFiles(workspaceDirectory, {
      depth: MAX_WORKSPACE_MANIFEST_DEPTH,
    });
    const files: WorkspaceBackupFile[] = [];
    for (const entry of entries) {
      if (entry.isDir) continue;
      const reportedPath =
        entry.path ?? posix.join(workspaceDirectory, entry.name);
      const relative = posix.isAbsolute(reportedPath)
        ? posix.relative(workspaceDirectory, reportedPath)
        : reportedPath.replace(/^\.\//u, "");
      const path = posix.normalize(relative);
      if (
        !path ||
        path === "." ||
        path === ".." ||
        path.startsWith("../") ||
        path.startsWith("/") ||
        path.includes("\0") ||
        path.includes("\n") ||
        path.includes("\r") ||
        path.length > 1_024
      )
        throw new Error("Daytona returned an invalid workspace file path");
      if (excludedFromWorkspaceBackup(path)) continue;
      const name = posix.basename(path);
      if (
        name.length < 1 ||
        name.length > 255 ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      )
        throw new Error("Daytona returned invalid workspace file metadata");
      files.push({ name, path, sizeBytes: entry.size });
      if (files.length > MAX_WORKSPACE_MANIFEST_FILES)
        throw new Error("Workspace contains too many files to back up safely");
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  async restoreWorkspace(
    sandbox: SandboxHandle,
    archive: Uint8Array,
  ): Promise<void> {
    if (archive.byteLength > MAX_WORKSPACE_ARCHIVE_BYTES)
      throw new Error("Workspace archive exceeds the 512 MiB limit");
    const native = this.native(sandbox);
    const workspaceDirectory = await resolveDaytonaWorkspaceDirectory(native);
    const archivePath = "/tmp/oao-workspace-restore.tar.gz";
    try {
      await native.fs.uploadFile(Buffer.from(archive), archivePath);
      const result = await native.process.executeCommand(
        `test "$(gzip -cd ${archivePath} | head -c ${MAX_EXPANDED_WORKSPACE_BYTES + 1} | wc -c)" -le ${MAX_EXPANDED_WORKSPACE_BYTES} && tar -tzf ${archivePath} >/dev/null && tar ${WORKSPACE_BACKUP_TAR_EXCLUDES} --no-same-owner --no-same-permissions -xzf ${archivePath} -C .`,
        workspaceDirectory,
        undefined,
        300,
      );
      if ((result.exitCode ?? 0) !== 0)
        throw new Error("Workspace restore command failed");
    } finally {
      await native.process
        .executeCommand(`rm -f ${archivePath}`, undefined, undefined, 30)
        .catch(() => undefined);
    }
  }

  flueFactory(
    sandbox: SandboxHandle,
    options: {
      readonly capabilities: readonly SandboxCapability[];
      readonly egress: SandboxEgressPolicy;
    },
  ) {
    const native = this.native(sandbox);
    const base = daytona(native);
    const browser = new DaytonaBrowserController(native, options.egress);
    return {
      ...base,
      tools: (flueSandbox: Sandbox) =>
        composeSandboxTools(flueSandbox, options.capabilities, browser),
    };
  }

  private native(handle: SandboxHandle): DaytonaSandbox {
    if (!handle.native)
      throw new Error("Daytona native sandbox handle is unavailable");
    return handle.native as DaytonaSandbox;
  }

  private wrap(sandbox: DaytonaSandbox): SandboxHandle {
    return { providerRef: sandbox.id, target: sandbox.target, native: sandbox };
  }
}

export class FakeSandboxProvider implements FlueSandboxProviderPort {
  readonly calls: string[] = [];
  readonly #sandboxes = new Map<string, SandboxHandle>();

  async findByCreationKey(key: string): Promise<SandboxHandle | undefined> {
    this.calls.push(`find:${key}`);
    return this.#sandboxes.get(key);
  }
  async create(input: {
    readonly creationKey: string;
    readonly targetPreference?: string;
  }): Promise<SandboxHandle> {
    this.calls.push(`create:${input.creationKey}`);
    const handle = {
      providerRef: `fake:${input.creationKey}`,
      target: input.targetPreference ?? "provider-default",
    };
    this.#sandboxes.set(input.creationKey, handle);
    return handle;
  }
  async execute(input: {
    readonly command: string;
  }): Promise<{ readonly exitCode: number; readonly redactedOutput: string }> {
    this.calls.push(`execute:${input.command}`);
    return { exitCode: 0, redactedOutput: "deterministic sandbox output" };
  }
  async stop(sandbox: SandboxHandle): Promise<void> {
    this.calls.push(`stop:${sandbox.providerRef}`);
  }

  flueFactory(
    _sandbox: SandboxHandle,
    options: {
      readonly capabilities: readonly SandboxCapability[];
      readonly egress: SandboxEgressPolicy;
    },
  ): SandboxFactory {
    return createFakeFlueSandbox(options.capabilities);
  }
}

export interface ManagedDaytonaSandboxFactory extends SandboxFactory {
  persistWorkspace(sandbox: Sandbox): Promise<void>;
}

export function sandboxWorkspaceLifecycleIdentity(input: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly ownerThreadId: string;
}): string {
  return [
    "oao-sandbox-v1",
    input.organizationId,
    input.projectId,
    input.ownerThreadId,
  ].join(":");
}

export function createManagedDaytonaFlueSandbox(input: {
  readonly pool: PgPool;
  readonly provider: FlueSandboxProviderPort;
  readonly organizationId: TenantContext["organizationId"];
  readonly projectId: TenantContext["projectId"];
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly sessionId: SessionId;
  readonly workspaceOwnerRunId?: RunId;
  readonly workspaceOwnerThreadId?: ThreadId;
  readonly workspaceOwnerSessionId?: SessionId;
  readonly snapshotId: string;
  readonly egress: SandboxEgressPolicy;
  readonly targetPreference?: string;
  readonly capabilities?: readonly SandboxCapability[];
  readonly workspaceBackupStore?: WorkspaceBackupStore;
}): ManagedDaytonaSandboxFactory {
  const repository = new PostgresSandboxRepository(input.pool);
  const lifecycle = new ManagedSandboxLifecycle(repository, input.provider);
  const capabilities = input.capabilities ?? DEFAULT_SANDBOX_CAPABILITIES;
  let providerFactory: SandboxFactory | undefined;
  let managedInstance:
    | { readonly record: InstanceRecord; readonly handle: SandboxHandle }
    | undefined;
  const persistWorkspace = async () => {
    if (!input.workspaceBackupStore) return;
    if (!managedInstance)
      throw new Error("Managed sandbox instance is unavailable");
    if (!input.provider.captureWorkspace)
      throw new Error("Sandbox provider cannot capture workspace backups");
    const archive = await input.provider.captureWorkspace(
      managedInstance.handle,
    );
    const files = input.provider.listWorkspaceFiles
      ? await input.provider.listWorkspaceFiles(managedInstance.handle)
      : [];
    await input.workspaceBackupStore.save(archive, files);
  };
  return {
    async createSandbox({ id }) {
      const ownerRunId = input.workspaceOwnerRunId ?? input.runId;
      const ownerThreadId = input.workspaceOwnerThreadId ?? input.threadId;
      const ownerSessionId = input.workspaceOwnerSessionId ?? input.sessionId;
      const lifecycleIdentity = sandboxWorkspaceLifecycleIdentity({
        organizationId: input.organizationId,
        projectId: input.projectId,
        ownerThreadId,
      });
      const managed = await lifecycle.ensure({
        organizationId: input.organizationId,
        projectId: input.projectId,
        runId: ownerRunId,
        threadId: ownerThreadId,
        sessionId: ownerSessionId,
        sandboxId: stableUuid(lifecycleIdentity),
        creationKey: lifecycleIdentity,
        snapshotId: input.snapshotId,
        egress: input.egress,
        ...(input.targetPreference
          ? { targetPreference: input.targetPreference }
          : {}),
      });
      managedInstance = {
        ...managed,
        record: { ...managed.record, runId: input.runId },
      };
      if (managed.created && input.workspaceBackupStore) {
        try {
          const archive = await input.workspaceBackupStore.load();
          if (archive) {
            if (!input.provider.restoreWorkspace)
              throw new Error(
                "Sandbox provider cannot restore workspace backups",
              );
            await input.provider.restoreWorkspace(managed.handle, archive);
            await input.workspaceBackupStore.markRestored();
          }
        } catch {
          await repository.markFailed(managed.record);
          throw new Error("Workspace restoration failed");
        }
      }
      providerFactory = input.provider.flueFactory(managed.handle, {
        capabilities,
        egress: input.egress,
      });
      try {
        const sandbox = await providerFactory.createSandbox({ id });
        workspacePersistenceBySandbox.set(sandbox, persistWorkspace);
        return sandbox;
      } catch {
        await repository.markFailed(managed.record);
        throw new Error("Sandbox initialization failed");
      }
    },
    tools: (sandbox, options) => {
      if (!providerFactory?.tools)
        throw new Error("Sandbox tools requested before sandbox creation");
      if (!managedInstance)
        throw new Error("Managed sandbox instance is unavailable");
      return withDurableToolAudit(
        providerFactory.tools(sandbox, options),
        repository,
        managedInstance,
      );
    },
    async persistWorkspace(sandbox) {
      await persistRegisteredWorkspace(sandbox);
    },
  };
}

export function workspaceBackupIdentityForRun(input: {
  readonly organizationId: TenantContext["organizationId"];
  readonly projectId: TenantContext["projectId"];
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly sessionId: SessionId;
  readonly workspaceOwnerRunId?: RunId;
  readonly workspaceOwnerThreadId?: ThreadId;
  readonly workspaceOwnerSessionId?: SessionId;
}): WorkspaceBackupIdentity {
  const threadId = input.workspaceOwnerThreadId ?? input.threadId;
  const sessionId = input.workspaceOwnerSessionId ?? input.sessionId;
  const currentRunOwnsWorkspace =
    threadId === input.threadId && sessionId === input.sessionId;
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    threadId,
    sessionId,
    runId: currentRunOwnsWorkspace
      ? input.runId
      : (input.workspaceOwnerRunId ?? input.runId),
  };
}

export function createProjectDaytonaFlueSandbox(input: {
  readonly pool: PgPool;
  readonly credentialCipher: ProviderCredentialCipher;
  readonly providerKey: string;
  readonly organizationId: TenantContext["organizationId"];
  readonly projectId: TenantContext["projectId"];
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly sessionId: SessionId;
  readonly workspaceOwnerRunId?: RunId;
  readonly workspaceOwnerThreadId?: ThreadId;
  readonly workspaceOwnerSessionId?: SessionId;
  readonly snapshotId: string;
  readonly network: "none" | "restricted";
  readonly capabilities: readonly SandboxCapability[];
  readonly workspaceBackupResolver?: {
    resolve(
      identity: WorkspaceBackupIdentity,
    ): Promise<WorkspaceBackupStore | undefined>;
  };
}): ManagedDaytonaSandboxFactory {
  let resolved: ManagedDaytonaSandboxFactory | undefined;
  return {
    async createSandbox(options) {
      const configuration = await withTenantTransaction(
        input.pool,
        input,
        async (transaction) => {
          const result = await transaction.query<{
            readonly id: string;
            readonly provider_type: string;
            readonly encrypted_api_key: Buffer;
            readonly encryption_nonce: Buffer;
            readonly encryption_tag: Buffer;
            readonly encryption_key_version: number;
            readonly target: string | null;
            readonly restricted_egress: {
              readonly allowedDomains?: readonly string[];
              readonly allowedCidrs?: readonly string[];
            };
          }>(
            `SELECT id,provider_type,encrypted_api_key,encryption_nonce,
                    encryption_tag,encryption_key_version,target,restricted_egress
               FROM oao.project_sandbox_providers
              WHERE organization_id=$1 AND provider_key=$2`,
            [input.organizationId, input.providerKey],
          );
          const row = result.rows[0];
          if (!row)
            throw new Error(
              `Sandbox provider ${input.providerKey} is not configured for this organization`,
            );
          return row;
        },
      );
      if (configuration.provider_type !== "daytona")
        throw new Error("Unsupported sandbox provider type");
      const providerId = String(configuration.id);
      const apiKey = input.credentialCipher.decrypt(
        {
          ciphertext: configuration.encrypted_api_key,
          nonce: configuration.encryption_nonce,
          tag: configuration.encryption_tag,
          keyVersion: configuration.encryption_key_version,
        },
        {
          organizationId: input.organizationId,
          providerId,
          providerType: "daytona",
        },
      );
      const restricted = configuration.restricted_egress;
      const egress: SandboxEgressPolicy =
        input.network === "none"
          ? { mode: "none" }
          : {
              mode: "restricted",
              allowedDomains: restricted.allowedDomains ?? [],
              allowedCidrs: restricted.allowedCidrs ?? [],
            };
      const provider = new DaytonaManagedProvider({
        apiKey,
        ...(configuration.target
          ? { target: String(configuration.target) }
          : {}),
      });
      const workspaceBackupStore = await input.workspaceBackupResolver?.resolve(
        workspaceBackupIdentityForRun(input),
      );
      resolved = createManagedDaytonaFlueSandbox({
        ...input,
        provider,
        egress,
        ...(configuration.target
          ? { targetPreference: String(configuration.target) }
          : {}),
        ...(workspaceBackupStore ? { workspaceBackupStore } : {}),
      });
      return resolved.createSandbox(options);
    },
    tools(sandbox, options) {
      if (!resolved?.tools)
        throw new Error("Sandbox tools requested before provider resolution");
      return resolved.tools(sandbox, options);
    },
    async persistWorkspace(sandbox) {
      await persistRegisteredWorkspace(sandbox);
    },
  };
}

export function createFakeFlueSandbox(
  capabilities: readonly SandboxCapability[] = DEFAULT_SANDBOX_CAPABILITIES,
): SandboxFactory {
  const browser = new FakeBrowserController();
  return {
    async createSandbox() {
      const files = new Map<string, Uint8Array>();
      const driver: SandboxDriver = {
        async readFile(path) {
          const value = files.get(path);
          if (!value) throw new Error("File not found");
          return Buffer.from(value).toString("utf8");
        },
        async readFileBuffer(path) {
          const value = files.get(path);
          if (!value) throw new Error("File not found");
          return value;
        },
        async writeFile(path, content) {
          files.set(
            path,
            typeof content === "string" ? Buffer.from(content) : content,
          );
        },
        async stat(path): Promise<FileStat> {
          const value = files.get(path);
          if (!value) throw new Error("File not found");
          return {
            isFile: true,
            isDirectory: false,
            size: value.byteLength,
            mtime: new Date(0),
          };
        },
        async readdir(path) {
          const prefix = path.endsWith("/") ? path : `${path}/`;
          return [...files.keys()]
            .filter((entry) => entry.startsWith(prefix))
            .map((entry) => entry.slice(prefix.length).split("/")[0])
            .filter((entry): entry is string => Boolean(entry));
        },
        async exists(path) {
          return files.has(path);
        },
        async mkdir() {},
        async rm(path) {
          files.delete(path);
        },
        async exec(command) {
          return {
            stdout: `deterministic:${command}`,
            stderr: "",
            exitCode: 0,
          };
        },
      };
      return sandboxFromDriver(driver, "/workspace");
    },
    tools: (sandbox) => composeSandboxTools(sandbox, capabilities, browser),
  };
}

export const DAYTONA_TARGET_POSTURE = Object.freeze({
  configuredDefault: null,
  strictResidencyEnforced: false,
  statement:
    "DAYTONA_TARGET is an optional deployment preference; provider default is accepted and OAO does not claim residency enforcement.",
});
