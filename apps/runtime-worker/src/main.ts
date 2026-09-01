import { serve } from "@hono/node-server";
import {
  ProjectArtifactStoreResolver,
  ProjectWorkspaceBackupResolver,
} from "@oao/artifact-s3";
import type { ServerType } from "@hono/node-server";
import { createPool, migrate } from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
  SessionId,
  ThreadId,
} from "@oao/domain";
import {
  DEFAULT_LOCAL_PRESETS,
  ImmutableModelPresetRegistry,
  ProjectModelPresetRegistry,
  createDeterministicModelProvider,
  loadModelPresetConfiguration,
  withPlatformTurnLimit,
  type FauxResponseStep,
} from "@oao/models-openrouter";
import { McpRemoteClient, type McpRemotePort } from "@oao/mcp-remote";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import { PostgresWakeQueue, WakeWorker } from "@oao/queue-postgres";
import {
  ManagedRuntimeOrchestrator,
  PostgresAgentDelegationCoordinator,
  PostgresSkillRegistry,
  RuntimeProjection,
  configureVendorNeutralTelemetry,
  createProjectModelPresetActivator,
  createPostgresMcpToolExecutor,
  registerRuntimeModelProvider,
  resetManagedAgentRuntime,
  startManagedFlueRuntime,
  type PlatformToolHandler,
} from "@oao/runtime-flue";
import {
  createManagedDaytonaFlueSandbox,
  createProjectDaytonaFlueSandbox,
  type FlueSandboxProviderPort,
} from "@oao/sandbox-daytona";
import { PostgresToolBroker } from "@oao/tool-broker";
import { Hono } from "hono";

const DEFAULT_SERVICE_PRINCIPAL =
  "00000000-0000-4000-8000-000000000099" as PrincipalId;

export interface RuntimeWorkerHandle {
  readonly port?: number;
  readonly pool: ReturnType<typeof createPool>;
  readonly queue: PostgresWakeQueue;
  readonly orchestrator: ManagedRuntimeOrchestrator;
  readonly projection: RuntimeProjection;
  prepareProcessHandoff(): Promise<"disposed" | "handoff_required">;
  dispose(): Promise<void>;
  stop(): Promise<void>;
}

export async function startRuntimeWorker(input: {
  readonly databaseUrl: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly listen?: boolean;
  readonly port?: number;
  readonly daytonaProvider?: FlueSandboxProviderPort;
  readonly fakeResponses?: readonly FauxResponseStep[];
  readonly platformTools?: ReadonlyMap<string, PlatformToolHandler>;
  readonly mcpRemote?: McpRemotePort;
  /** Tests may admit one explicit run without claiming unrelated queued work. */
  readonly backgroundWakes?: boolean;
}): Promise<RuntimeWorkerHandle> {
  const env = input.env ?? process.env;
  const pool = createPool(input.databaseUrl);
  await migrate(pool);
  const telemetryStop = await configureVendorNeutralTelemetry({
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
    serviceName: "oao-runtime-worker",
  });
  const queue = new PostgresWakeQueue(pool);
  const servicePrincipalId =
    (env.OAO_RUNTIME_SERVICE_PRINCIPAL_ID as PrincipalId | undefined) ??
    DEFAULT_SERVICE_PRINCIPAL;
  const broker = new PostgresToolBroker(pool, {
    servicePrincipalId,
    // The model only ever sees a redacted platform_tool_failed outcome, so
    // the underlying cause must land in the worker log to stay diagnosable.
    onPlatformToolError: (error, context) => {
      console.error(
        JSON.stringify({
          level: "error",
          source: "tool-broker",
          toolName: context.toolName,
          runId: context.runId,
          ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
          errorType: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });
  const modelConfiguration = loadModelPresetConfiguration(env);
  const fake = input.fakeResponses
    ? createDeterministicModelProvider(input.fakeResponses)
    : undefined;
  const deploymentPresets = fake
    ? new ImmutableModelPresetRegistry(DEFAULT_LOCAL_PRESETS, {
        hostedEnabled: false,
      })
    : modelConfiguration.registry;
  const providers = fake ? [withPlatformTurnLimit(fake.provider)] : [];
  // Durable project presets are registered lazily, one provider identity per
  // (organization, project, preset key), so routing policy stays isolated.
  const presets = new ProjectModelPresetRegistry({
    deployment: deploymentPresets,
    registerProvider: (provider) =>
      registerRuntimeModelProvider(withPlatformTurnLimit(provider)),
  });
  const credentialCipher = env.OAO_CREDENTIAL_ENCRYPTION_KEY
    ? ProviderCredentialCipher.fromBase64(env.OAO_CREDENTIAL_ENCRYPTION_KEY)
    : undefined;
  const workspaceBackupResolver = credentialCipher
    ? new ProjectWorkspaceBackupResolver(pool, credentialCipher)
    : undefined;
  const runFileStorage = credentialCipher
    ? new ProjectArtifactStoreResolver(pool, credentialCipher)
    : undefined;
  const presetActivator = createProjectModelPresetActivator({
    pool,
    registry: presets,
    ...(credentialCipher ? { credentialCipher } : {}),
    deploymentPresetKeys: new Set(
      deploymentPresets.list().map((preset) => preset.key),
    ),
  });
  const skills = new PostgresSkillRegistry(pool);
  const delegations = new PostgresAgentDelegationCoordinator(pool, queue);
  const mcp = credentialCipher
    ? createPostgresMcpToolExecutor({
        pool,
        credentialCipher,
        remote: input.mcpRemote ?? new McpRemoteClient(),
      })
    : undefined;
  const flue = await startManagedFlueRuntime({
    pool,
    providers,
    presets,
    broker,
    skills,
    delegations,
    ...(mcp ? { mcp } : {}),
    ...(runFileStorage ? { runFileStorage } : {}),
    ...(input.platformTools ? { platformTools: input.platformTools } : {}),
    sandboxFactory: (initial, delivery) => {
      const sandbox = initial.snapshot.sandbox;
      if (!sandbox.snapshotId)
        throw new Error(
          "Sandbox-enabled agent versions must select a Daytona snapshot",
        );
      if (sandbox.provider === "local-fake") {
        throw new Error(
          "The local-fake sandbox is no longer supported; publish a new agent version with a Daytona provider",
        );
      }
      if (input.daytonaProvider)
        return createManagedDaytonaFlueSandbox({
          pool,
          provider: input.daytonaProvider,
          organizationId: initial.organizationId as OrganizationId,
          projectId: initial.projectId as ProjectId,
          runId: delivery.runId as RunId,
          threadId: initial.threadId as ThreadId,
          sessionId: initial.sessionId as SessionId,
          ...(initial.workspace
            ? {
                workspaceOwnerRunId: initial.workspace.ownerRunId as RunId,
                workspaceOwnerThreadId: initial.workspace
                  .ownerThreadId as ThreadId,
                workspaceOwnerSessionId: initial.workspace
                  .ownerSessionId as SessionId,
              }
            : {}),
          egress: { mode: "none" },
          capabilities: sandbox.capabilities,
          snapshotId: sandbox.snapshotId,
        });
      if (!credentialCipher)
        throw new Error(
          "OAO_CREDENTIAL_ENCRYPTION_KEY is required for project sandbox providers",
        );
      return createProjectDaytonaFlueSandbox({
        pool,
        credentialCipher,
        providerKey: sandbox.provider,
        organizationId: initial.organizationId as OrganizationId,
        projectId: initial.projectId as ProjectId,
        runId: delivery.runId as RunId,
        threadId: initial.threadId as ThreadId,
        sessionId: initial.sessionId as SessionId,
        ...(initial.workspace
          ? {
              workspaceOwnerRunId: initial.workspace.ownerRunId as RunId,
              workspaceOwnerThreadId: initial.workspace
                .ownerThreadId as ThreadId,
              workspaceOwnerSessionId: initial.workspace
                .ownerSessionId as SessionId,
            }
          : {}),
        network: sandbox.network,
        capabilities: sandbox.capabilities,
        snapshotId: sandbox.snapshotId,
        ...(workspaceBackupResolver ? { workspaceBackupResolver } : {}),
      });
    },
  });
  const projection = new RuntimeProjection(pool, queue);
  projection.start();
  const orchestrator = new ManagedRuntimeOrchestrator(
    pool,
    queue,
    (run) => projection.trackAdmission(run),
    presetActivator,
    skills,
  );
  const wakeWorker = new WakeWorker(
    queue,
    (job) => orchestrator.handleWake(job),
    { workerId: `runtime-${process.pid}`, pollMilliseconds: 100 },
  );
  if (input.backgroundWakes !== false) {
    await orchestrator.enqueueRecovery();
    wakeWorker.start();
  }

  let ready = true;
  let server: ServerType | undefined;
  const port = input.port ?? Number(env.PORT ?? 8788);
  if (input.listen !== false) {
    const app = new Hono();
    app.get("/healthz", (context) => context.json({ status: "ok" }));
    app.get("/readyz", async (context) => {
      if (!ready) return context.json({ status: "stopping" }, 503);
      try {
        await pool.query("SELECT 1");
        return context.json({
          status: "ready",
          profile: "project-providers",
          sandbox: "daytona",
        });
      } catch {
        return context.json({ status: "not_ready" }, 503);
      }
    });
    server = serve({ fetch: app.fetch, port });
  }

  let disposed = false;
  let handoffPrepared = false;
  const closeServer = async () => {
    if (server)
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  };
  const hasActiveDispatches = async () => {
    const result = await pool.query<{ active: boolean }>(
      "SELECT oao.runtime_has_active_dispatches() AS active",
    );
    return result.rows[0]?.active ?? false;
  };
  const dispose = async () => {
    if (disposed) return;
    if (await hasActiveDispatches())
      throw new Error(
        "Active Flue submissions require process handoff, not in-process disposal",
      );
    disposed = true;
    ready = false;
    await wakeWorker.stop();
    await projection.stop();
    await flue.stop();
    resetManagedAgentRuntime();
    await closeServer();
    await telemetryStop();
    await pool.end();
  };
  return {
    ...(input.listen !== false ? { port } : {}),
    pool,
    queue,
    orchestrator,
    projection,
    async prepareProcessHandoff() {
      if (disposed) return "disposed";
      if (handoffPrepared) return "handoff_required";
      handoffPrepared = true;
      ready = false;
      await wakeWorker.stop();
      await projection.stop();
      await closeServer();
      if (await hasActiveDispatches()) {
        // Flue 2.0.3 stop() aborts active tools and durably records that abort.
        // Leave the process-owned lease for bounded startup recovery instead;
        // the signal handler exits immediately after this method returns.
        return "handoff_required";
      }
      await flue.stop();
      resetManagedAgentRuntime();
      await telemetryStop();
      await pool.end();
      disposed = true;
      return "disposed";
    },
    dispose,
    async stop() {
      await dispose();
    },
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const worker = await startRuntimeWorker({ databaseUrl });
  const shutdown = () => {
    const forcedExit = setTimeout(() => process.exit(0), 10_000);
    void worker.prepareProcessHandoff().finally(() => {
      clearTimeout(forcedExit);
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
