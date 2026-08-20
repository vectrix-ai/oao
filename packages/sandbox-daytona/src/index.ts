import { createHash } from "node:crypto";
import { Daytona } from "@daytona/sdk";
import type { Sandbox as DaytonaSandbox } from "@daytona/sdk";
import { sandboxFromDriver } from "@flue/runtime";
import type { FileStat, SandboxDriver, SandboxFactory } from "@flue/runtime";
import type { PgPool, Queryable, TenantContext } from "@oao/db-postgres";
import { withTenantTransaction } from "@oao/db-postgres";
import type { PublicValue, RunId, SessionId, ThreadId } from "@oao/domain";
import { assertPublicPayload } from "@oao/domain";
import { daytona } from "./flue-daytona-blueprint.js";

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
    readonly image: string;
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
  flueFactory(sandbox: SandboxHandle): SandboxFactory;
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
    result: { readonly exitCode: number; readonly redactedOutput: string },
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
          creation_fence,state,provider_ref,target_preference,egress_policy
          FROM oao.sandbox_instances
         WHERE organization_id=$1 AND project_id=$2 AND creation_key=$3 FOR UPDATE`,
        [input.organizationId, input.projectId, input.creationKey],
      );
      const row = result.rows[0] as Record<string, unknown>;
      if (
        row.thread_id !== input.threadId ||
        row.session_id !== input.sessionId ||
        row.target_preference !==
          (input.targetPreference ?? "provider-default") ||
        Buffer.compare(
          Buffer.from(sha256(row.egress_policy)),
          Buffer.from(sha256(input.egress)),
        ) !== 0
      )
        throw new Error("Sandbox creation idempotency conflict");
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
          target_preference=$6,updated_at=clock_timestamp()
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
    resultValue: { readonly exitCode: number; readonly redactedOutput: string },
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
      target: row.target_preference as string,
    };
  }

  private mapCommand(row: Record<string, unknown>): CommandRecord {
    const safeResult = row.safe_result as {
      exitCode: number;
      redactedOutput: string;
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
      readonly image: string;
      readonly egress: SandboxEgressPolicy;
      readonly targetPreference?: string;
    },
  ): Promise<{
    readonly record: InstanceRecord;
    readonly handle: SandboxHandle;
  }> {
    this.validateEgress(input.egress);
    let record = await this.repository.reserveInstance({
      id: input.sandboxId,
      ...input,
    });
    let handle: SandboxHandle;
    try {
      handle =
        (await this.provider.findByCreationKey(input.creationKey)) ??
        (await this.provider.create({
          creationKey: input.creationKey,
          image: input.image,
          egress: input.egress,
          ...(input.targetPreference
            ? { targetPreference: input.targetPreference }
            : {}),
        }));
    } catch {
      await this.repository.markFailed(record);
      throw new Error("Sandbox creation failed");
    }
    record = await this.repository.markRunning(record, handle);
    return { record, handle };
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
      safeCommand: { commandName: input.command.split(/\s+/u)[0] ?? "command" },
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
    }))
      return this.wrap(sandbox);
    return undefined;
  }

  async create(input: {
    readonly creationKey: string;
    readonly image: string;
    readonly targetPreference?: string;
    readonly egress: SandboxEgressPolicy;
  }): Promise<SandboxHandle> {
    const sandbox = await this.#client.create({
      image: input.image,
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

  flueFactory(sandbox: SandboxHandle) {
    return daytona(this.native(sandbox));
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

  flueFactory(): SandboxFactory {
    return createFakeFlueSandbox();
  }
}

export function createManagedDaytonaFlueSandbox(input: {
  readonly pool: PgPool;
  readonly provider: FlueSandboxProviderPort;
  readonly organizationId: TenantContext["organizationId"];
  readonly projectId: TenantContext["projectId"];
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly sessionId: SessionId;
  readonly image?: string;
  readonly egress: SandboxEgressPolicy;
  readonly targetPreference?: string;
}): SandboxFactory {
  const lifecycle = new ManagedSandboxLifecycle(
    new PostgresSandboxRepository(input.pool),
    input.provider,
  );
  return {
    async createSandbox({ id }) {
      const lifecycleIdentity = [
        "oao-sandbox-v1",
        input.organizationId,
        input.projectId,
        input.threadId,
      ].join(":");
      const managed = await lifecycle.ensure({
        organizationId: input.organizationId,
        projectId: input.projectId,
        runId: input.runId,
        threadId: input.threadId,
        sessionId: input.sessionId,
        sandboxId: stableUuid(lifecycleIdentity),
        creationKey: lifecycleIdentity,
        image: input.image ?? "flue-daytona:2.0.3",
        egress: input.egress,
        ...(input.targetPreference
          ? { targetPreference: input.targetPreference }
          : {}),
      });
      return input.provider.flueFactory(managed.handle).createSandbox({ id });
    },
  };
}

export function createFakeFlueSandbox(): SandboxFactory {
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
  };
}

export const DAYTONA_TARGET_POSTURE = Object.freeze({
  configuredDefault: null,
  strictResidencyEnforced: false,
  statement:
    "DAYTONA_TARGET is an optional deployment preference; provider default is accepted and OAO does not claim residency enforcement.",
});
