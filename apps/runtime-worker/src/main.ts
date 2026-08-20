import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createPool, migrate } from "@oao/db-postgres";
import type { PrincipalId } from "@oao/domain";
import {
  DEFAULT_LOCAL_PRESETS,
  ImmutableModelPresetRegistry,
  createDeterministicModelProvider,
  createOpenRouterProvider,
  type ApprovedModelPreset,
} from "@oao/models-openrouter";
import { PostgresWakeQueue, WakeWorker } from "@oao/queue-postgres";
import {
  ManagedRuntimeOrchestrator,
  RuntimeProjection,
  configureVendorNeutralTelemetry,
  startManagedFlueRuntime,
} from "@oao/runtime-flue";
import { createFakeFlueSandbox } from "@oao/sandbox-daytona";
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
  if (!Array.isArray(parsed))
    throw new TypeError("OpenRouter presets must be an array");
  return parsed as ApprovedModelPreset[];
}

export interface RuntimeWorkerHandle {
  readonly port?: number;
  readonly pool: ReturnType<typeof createPool>;
  readonly queue: PostgresWakeQueue;
  readonly orchestrator: ManagedRuntimeOrchestrator;
  stop(): Promise<void>;
}

export async function startRuntimeWorker(input: {
  readonly databaseUrl: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly listen?: boolean;
  readonly port?: number;
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
  const broker = new PostgresToolBroker(pool, { servicePrincipalId });
  const hostedEnabled = env.OAO_ENABLE_HOSTED_MODELS === "true";
  const presets = new ImmutableModelPresetRegistry(
    [...DEFAULT_LOCAL_PRESETS, ...hostedPresets(env)],
    { hostedEnabled },
  );
  const fake = createDeterministicModelProvider();
  const providers = [fake.provider];
  if (hostedEnabled) {
    const routing = env.OAO_OPENROUTER_ROUTING_JSON
      ? (JSON.parse(env.OAO_OPENROUTER_ROUTING_JSON) as Record<string, unknown>)
      : undefined;
    providers.push(createOpenRouterProvider(routing));
  }
  const flue = await startManagedFlueRuntime({
    pool,
    providers,
    presets,
    broker,
    sandboxFactory: createFakeFlueSandbox(),
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
        });
      } catch {
        return context.json({ status: "not_ready" }, 503);
      }
    });
    server = serve({ fetch: app.fetch, port });
  }

  let stopped = false;
  return {
    ...(input.listen !== false ? { port } : {}),
    pool,
    queue,
    orchestrator,
    async stop() {
      if (stopped) return;
      stopped = true;
      ready = false;
      await wakeWorker.stop();
      await flue.stop();
      await projection.stop();
      if (server)
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      await telemetryStop();
      await pool.end();
    },
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const worker = await startRuntimeWorker({ databaseUrl });
  const shutdown = () => {
    void worker.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
