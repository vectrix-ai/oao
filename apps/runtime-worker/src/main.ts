import { serve } from "@hono/node-server";
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
  createDeterministicModelProvider,
  createOpenRouterPresetProviders,
  parseApprovedModelPresets,
  withPlatformTurnLimit,
  type ApprovedModelPreset,
  type FauxResponseStep,
} from "@oao/models-openrouter";
import { PostgresWakeQueue, WakeWorker } from "@oao/queue-postgres";
import {
  ManagedRuntimeOrchestrator,
  RuntimeProjection,
  configureVendorNeutralTelemetry,
  resetManagedAgentRuntime,
  startManagedFlueRuntime,
  type PlatformToolHandler,
} from "@oao/runtime-flue";
import {
  DaytonaManagedProvider,
  createFakeFlueSandbox,
  createManagedDaytonaFlueSandbox,
  type FlueSandboxProviderPort,
  type SandboxEgressPolicy,
} from "@oao/sandbox-daytona";
import { PostgresToolBroker } from "@oao/tool-broker";
import { Hono } from "hono";

const DEFAULT_SERVICE_PRINCIPAL =
  "00000000-0000-4000-8000-000000000099" as PrincipalId;

function hostedPresets(env: NodeJS.ProcessEnv): readonly ApprovedModelPreset[] {
  if (env.OAO_ENABLE_HOSTED_MODELS !== "true") return [];
  if (!env.OAO_OPENROUTER_PRESETS_JSON)
    throw new Error(
      "OAO_OPENROUTER_PRESETS_JSON is required when hosted models are enabled",
    );
  const parsed: unknown = JSON.parse(env.OAO_OPENROUTER_PRESETS_JSON);
  return parseApprovedModelPresets(parsed);
}

function sandboxProvider(env: NodeJS.ProcessEnv): "fake" | "daytona" {
  const provider = env.OAO_SANDBOX_PROVIDER ?? "fake";
  if (provider !== "fake" && provider !== "daytona")
    throw new TypeError("OAO_SANDBOX_PROVIDER must be fake or daytona");
  return provider;
}

function daytonaEgress(env: NodeJS.ProcessEnv): SandboxEgressPolicy {
  if (!env.OAO_DAYTONA_EGRESS_JSON) return { mode: "none" };
  const value: unknown = JSON.parse(env.OAO_DAYTONA_EGRESS_JSON);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("OAO_DAYTONA_EGRESS_JSON must be an object");
  const record = value as Record<string, unknown>;
  const stringList = (entry: unknown): readonly string[] | undefined => {
    if (entry === undefined) return undefined;
    if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string"))
      throw new TypeError("Daytona egress allowlists must contain strings");
    return entry as string[];
  };
  if (record.mode !== "none" && record.mode !== "restricted")
    throw new TypeError("Daytona egress mode must be none or restricted");
  const allowedDomains = stringList(record.allowedDomains);
  const allowedCidrs = stringList(record.allowedCidrs);
  return {
    mode: record.mode,
    ...(allowedDomains ? { allowedDomains } : {}),
    ...(allowedCidrs ? { allowedCidrs } : {}),
  };
}

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
}): Promise<RuntimeWorkerHandle> {
  const env = input.env ?? process.env;
  const selectedSandbox = sandboxProvider(env);
  if (
    selectedSandbox === "daytona" &&
    !input.daytonaProvider &&
    !env.DAYTONA_API_KEY
  )
    throw new Error(
      "DAYTONA_API_KEY is required when OAO_SANDBOX_PROVIDER=daytona",
    );
  let managedDaytona: FlueSandboxProviderPort | undefined;
  if (selectedSandbox === "daytona") {
    managedDaytona =
      input.daytonaProvider ??
      new DaytonaManagedProvider({
        apiKey: env.DAYTONA_API_KEY ?? "",
        ...(env.DAYTONA_TARGET ? { target: env.DAYTONA_TARGET } : {}),
      });
  }
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
  const broker = new PostgresToolBroker(pool, { servicePrincipalId });
  const hostedEnabled = env.OAO_ENABLE_HOSTED_MODELS === "true";
  const presets = new ImmutableModelPresetRegistry(
    [...DEFAULT_LOCAL_PRESETS, ...hostedPresets(env)],
    { hostedEnabled },
  );
  const fake = input.fakeResponses
    ? createDeterministicModelProvider(input.fakeResponses)
    : createDeterministicModelProvider();
  const providers = [
    withPlatformTurnLimit(fake.provider),
    ...createOpenRouterPresetProviders(hostedPresets(env)).map((provider) =>
      withPlatformTurnLimit(provider),
    ),
  ];
  const configuredEgress = daytonaEgress(env);
  const flue = await startManagedFlueRuntime({
    pool,
    providers,
    presets,
    broker,
    ...(input.platformTools ? { platformTools: input.platformTools } : {}),
    sandboxFactory: (initial, delivery) => {
      if (selectedSandbox === "fake") return createFakeFlueSandbox();
      if (!managedDaytona) throw new Error("Daytona provider is unavailable");
      return createManagedDaytonaFlueSandbox({
        pool,
        provider: managedDaytona,
        organizationId: initial.organizationId as OrganizationId,
        projectId: initial.projectId as ProjectId,
        runId: delivery.runId as RunId,
        threadId: initial.threadId as ThreadId,
        sessionId: initial.sessionId as SessionId,
        ...(env.DAYTONA_TARGET ? { targetPreference: env.DAYTONA_TARGET } : {}),
        egress:
          initial.snapshot.sandbox.network === "none"
            ? { mode: "none" }
            : configuredEgress,
      });
    },
  });
  const projection = new RuntimeProjection(pool, queue);
  projection.start();
  const orchestrator = new ManagedRuntimeOrchestrator(pool, queue, (run) =>
    projection.trackAdmission(run),
  );
  const wakeWorker = new WakeWorker(
    queue,
    (job) => orchestrator.handleWake(job),
    { workerId: `runtime-${process.pid}`, pollMilliseconds: 100 },
  );
  await orchestrator.enqueueRecovery();
  wakeWorker.start();

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
          profile: hostedEnabled ? "hosted-opt-in" : "local-fake",
          sandbox: selectedSandbox,
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
