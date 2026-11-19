import { serve } from "@hono/node-server";
import {
  ProjectArtifactStoreResolver,
  ProjectWorkspaceBackupResolver,
} from "@oao/artifact-s3";
import type { ServerType } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  createPool,
  createProjectWakeWaiter,
  databasePoolMax,
  migrate,
  PostgresWakeNotifier,
  type PgPool,
} from "@oao/db-postgres";
import {
  allowPrivateWebhookNetwork,
  createWebhookTransport,
  EventWebhookDispatcher,
  PostgresEventWebhookStore,
} from "@oao/event-webhooks";
import type {
  OrganizationId,
  PrincipalId,
  ProjectArtifactStoreResolverPort,
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
  withModelCallTimeout,
  withModelLimits,
  type FauxResponseStep,
  type ModelPresetLimitsInput,
} from "@oao/models-openrouter";
import {
  McpRemoteClient,
  allowPrivateMcpNetwork,
  type McpRemotePort,
} from "@oao/mcp-remote";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import {
  PostgresWakeQueue,
  RUNTIME_WAKE_CHANNEL,
  WakeWorker,
} from "@oao/queue-postgres";
import {
  ManagedRuntimeOrchestrator,
  PostgresAgentDelegationCoordinator,
  PostgresSkillRegistry,
  RuntimeProjection,
  configureVendorNeutralTelemetry,
  createProjectModelPresetActivator,
  createOaoToolExecutor,
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
  /** Short deadlines for deterministic timeout tests; never applied to hosted providers. */
  readonly fakeModelCallTimeoutMs?: number;
  /** Preset limits on the deterministic test model, as a project preset puts them on its model. */
  readonly fakeModelLimits?: ModelPresetLimitsInput;
  readonly platformTools?: ReadonlyMap<string, PlatformToolHandler>;
  readonly mcpRemote?: McpRemotePort;
  /** Tests may route agents' OAO tool calls to an in-process API. */
  readonly oaoApiFetch?: typeof globalThis.fetch;
  /** Tests may admit one explicit run without claiming unrelated queued work. */
  readonly backgroundWakes?: boolean;
  /** Outbound event webhook delivery; defaults to on when credentials can be decrypted. */
  readonly eventWebhooks?: boolean;
  /** Tests may supply run attachment storage instead of encrypted S3 connections. */
  readonly runFileStorage?: ProjectArtifactStoreResolverPort;
  /** Tests may shorten each image download attempt before admission. */
  readonly runFileDownloadTimeoutMs?: number;
}): Promise<RuntimeWorkerHandle> {
  const env = input.env ?? process.env;
  const wakeConcurrency = integerSetting(
    env,
    "OAO_WAKE_CONCURRENCY",
    32,
    1,
    256,
  );
  const wakePollMilliseconds = integerSetting(
    env,
    "OAO_WAKE_POLL_MS",
    1_000,
    100,
    60_000,
  );
  const logPoolError = (source: string) => (error: Error) => {
    console.error(
      JSON.stringify({
        level: "warn",
        source,
        errorType: error.name,
        errorMessage: error.message,
      }),
    );
  };
  const pool = createPool(input.databaseUrl, {
    max: databasePoolMax(env),
    onIdleClientError: logPoolError("postgres-pool"),
    onClientError: logPoolError("postgres-client"),
  });
  await migrate(pool);
  const telemetryStop = await configureVendorNeutralTelemetry({
    pool,
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
    serviceName: "oao-runtime-worker",
  });
  const queue = new PostgresWakeQueue(pool);
  const servicePrincipalId =
    (env.OAO_RUNTIME_SERVICE_PRINCIPAL_ID as PrincipalId | undefined) ??
    DEFAULT_SERVICE_PRINCIPAL;
  const logListenerError = (source: string) => (error: unknown) => {
    console.error(
      JSON.stringify({
        level: "warn",
        source,
        errorType: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  // Product-event commits wake caller-tool, approval and delegation waits,
  // and the webhook dispatcher; each falls back to polling meanwhile.
  const productWakes = new PostgresWakeNotifier(pool, {
    onListenerError: logListenerError("product-event-wakes"),
  });
  const projectWakes = createProjectWakeWaiter(productWakes);
  const broker = new PostgresToolBroker(pool, {
    servicePrincipalId,
    projectWakes,
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
  const providers = fake
    ? [
        withModelCallTimeout(
          withModelLimits(fake.provider, input.fakeModelLimits),
          input.fakeModelCallTimeoutMs,
        ),
      ]
    : [];
  // Durable project presets are registered lazily, one provider identity per
  // (organization, project, preset key), so routing policy stays isolated.
  const presets = new ProjectModelPresetRegistry({
    deployment: deploymentPresets,
    registerProvider: (provider) => registerRuntimeModelProvider(provider),
  });
  const allowPrivateMcp = allowPrivateMcpNetwork(env);
  const credentialCipher = env.OAO_CREDENTIAL_ENCRYPTION_KEY
    ? ProviderCredentialCipher.fromBase64(env.OAO_CREDENTIAL_ENCRYPTION_KEY)
    : undefined;
  const workspaceBackupResolver = credentialCipher
    ? new ProjectWorkspaceBackupResolver(pool, credentialCipher)
    : undefined;
  const runFileStorage =
    input.runFileStorage ??
    (credentialCipher
      ? new ProjectArtifactStoreResolver(pool, credentialCipher)
      : undefined);
  const presetActivator = createProjectModelPresetActivator({
    pool,
    registry: presets,
    ...(credentialCipher ? { credentialCipher } : {}),
    deploymentPresetKeys: new Set(
      deploymentPresets.list().map((preset) => preset.key),
    ),
  });
  const skills = new PostgresSkillRegistry(pool);
  const delegations = new PostgresAgentDelegationCoordinator(pool, queue, {
    projectWakes,
  });
  const mcp = credentialCipher
    ? createPostgresMcpToolExecutor({
        pool,
        credentialCipher,
        remote:
          input.mcpRemote ??
          new McpRemoteClient({ allowPrivateNetwork: allowPrivateMcp }),
      })
    : undefined;
  // Agents granted OAO tools call the OAO API with a run token.
  const oaoApiUrl = env.OAO_API_URL?.trim() || undefined;
  const oaoTools = createOaoToolExecutor({
    pool,
    ...(oaoApiUrl ? { apiUrl: oaoApiUrl } : {}),
    ...(input.oaoApiFetch ? { fetch: input.oaoApiFetch } : {}),
  });
  const flue = await startManagedFlueRuntime({
    pool,
    providers,
    presets,
    broker,
    skills,
    delegations,
    oaoTools,
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
    {
      presets,
      ...(runFileStorage ? { storage: runFileStorage } : {}),
      ...(input.runFileDownloadTimeoutMs === undefined
        ? {}
        : { downloadTimeoutMs: input.runFileDownloadTimeoutMs }),
    },
  );
  // Each process needs its own lease owner: a shared id would let one
  // container complete or renew another container's claim.
  const workerId = `runtime-${hostname()}-${randomUUID()}`;
  // Enqueued wakes notify on their own channel; one LISTEN connection serves
  // the whole wake loop, and the poll is only a fallback.
  const runtimeWakes = new PostgresWakeNotifier(pool, {
    channel: RUNTIME_WAKE_CHANNEL,
    onListenerError: logListenerError("runtime-wakes"),
  });
  const wakeWorker = new WakeWorker(
    queue,
    (job) => orchestrator.handleWake(job),
    {
      workerId,
      concurrency: wakeConcurrency,
      pollMilliseconds: wakePollMilliseconds,
      subscribeToWakes: (onWake) => runtimeWakes.subscribe(onWake),
      onError: (error, job) => {
        console.error(
          JSON.stringify({
            level: "warn",
            source: "runtime-wakes",
            ...(job
              ? {
                  organizationId: job.organizationId,
                  projectId: job.projectId,
                  runId: job.runId,
                  wakeKind: job.kind,
                  attempts: job.attempts,
                }
              : {}),
            errorType: error instanceof Error ? error.name : typeof error,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          }),
        );
      },
    },
  );
  if (input.backgroundWakes !== false) {
    await repairReplayedAdmissions(orchestrator);
    await orchestrator.enqueueRecovery();
    wakeWorker.start();
  }
  const webhookDispatcher =
    credentialCipher && input.eventWebhooks !== false
      ? createEventWebhookDispatcher(pool, credentialCipher, productWakes, env)
      : undefined;
  webhookDispatcher?.start();

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
    await runtimeWakes.close();
    await webhookDispatcher?.stop();
    await productWakes.close();
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
      await runtimeWakes.close();
      // An interrupted delivery keeps its batch; the lease expires and another
      // worker resends it under the same webhook-id.
      await webhookDispatcher?.stop();
      await productWakes.close();
      await projection.stop();
      await closeServer();
      if (await hasActiveDispatches()) {
        // Flue 2.3.0 stop() aborts active tools and durably records that abort.
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

function createEventWebhookDispatcher(
  pool: PgPool,
  cipher: ProviderCredentialCipher,
  wakes: PostgresWakeNotifier,
  env: NodeJS.ProcessEnv,
): EventWebhookDispatcher {
  const pollIntervalMs = Number(env.OAO_EVENT_WEBHOOK_POLL_MS ?? 1_000);
  if (
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 50 ||
    pollIntervalMs > 60_000
  )
    throw new Error(
      "OAO_EVENT_WEBHOOK_POLL_MS must be an integer from 50 to 60000",
    );
  return new EventWebhookDispatcher({
    store: new PostgresEventWebhookStore(pool),
    transport: createWebhookTransport({
      allowPrivateNetwork: allowPrivateWebhookNetwork(env),
    }),
    decryptSigningKey: (key, context) =>
      cipher.decrypt(
        {
          ciphertext: key.ciphertext,
          nonce: key.nonce,
          tag: key.tag,
          keyVersion: key.keyVersion,
        },
        {
          organizationId: context.organizationId,
          providerId: context.webhookId,
          providerType: "event_webhook",
        },
      ),
    workerId: `webhooks-${process.pid}-${randomUUID()}`,
    pollIntervalMs,
    subscribeToWakes: (onWake) => wakes.subscribe(onWake),
    onError: (error, claim) => {
      console.error(
        JSON.stringify({
          level: "error",
          source: "event-webhooks",
          ...(claim
            ? {
                organizationId: claim.organizationId,
                projectId: claim.projectId,
                webhookId: claim.webhookId,
              }
            : {}),
          errorType: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

/** One-time repair of chats a replayed admission broke; see migration 0068. */
async function repairReplayedAdmissions(
  orchestrator: ManagedRuntimeOrchestrator,
): Promise<void> {
  try {
    const repairs = await orchestrator.repairReplayedAdmissions();
    for (const repair of repairs)
      console.error(
        JSON.stringify({
          level: repair.outcome === "repaired" ? "info" : "warn",
          source: "runtime-incarnation-repair",
          organizationId: repair.organizationId,
          projectId: repair.projectId,
          threadId: repair.threadId,
          outcome: repair.outcome,
          code: repair.code,
        }),
      );
  } catch (error) {
    // A failed repair leaves its threads pending for the next start.
    console.error(
      JSON.stringify({
        level: "error",
        source: "runtime-incarnation-repair",
        errorType: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );
  }
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
