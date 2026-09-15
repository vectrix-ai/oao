import type { PostgresWakeQueue, RuntimeWakeJob } from "@oao/queue-postgres";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PgPool } from "@oao/db-postgres";
import type { OrganizationId, ProjectId, RunId } from "@oao/domain";
import { serializeSkillPackageForHash } from "@oao/domain";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import {
  FLUE_PACKAGE_VERSIONS,
  ModelPresetUnavailableError,
  ManagedRuntimeOrchestrator,
  SkillPackageUnavailableError,
  PostgresSkillRegistry,
  createManagedHarnessOperationTool,
  createManagedRunDeliveredMessage,
  createProjectModelPresetActivator,
  managedRunFileSandboxPath,
  materializeManagedRunFiles,
  runtimeTesting,
} from "../src/index.js";

const harnessOperation = {
  key: "extract_shipment",
  description: "Extract one shipment document.",
  instructions:
    "Activate the shipment-extraction Skill, read the shared fixture, and return the shipment reference.",
  resultSchema: {
    type: "object" as const,
    properties: { shipmentReference: { type: "string" } },
    required: ["shipmentReference"],
    additionalProperties: false as const,
  },
  timeoutMs: 5_000,
};

type HarnessOperationRun = (context: {
  readonly data: { readonly task: string };
  readonly harness: {
    readonly sandbox?: {
      readFile(path: string): Promise<string>;
    };
    readonly prompt: (
      prompt: string,
      options: {
        readonly result: v.GenericSchema;
        readonly signal: AbortSignal;
      },
    ) => Promise<{ readonly data: unknown }>;
  };
  readonly signal?: AbortSignal;
  readonly step: {
    do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
  };
  readonly log: {
    info(message: string, attributes?: Record<string, unknown>): void;
    warn(message: string, attributes?: Record<string, unknown>): void;
  };
  readonly toolCallId: string;
}) => Promise<{ readonly output?: unknown }>;

function harnessOperationRun(
  operation = harnessOperation,
): HarnessOperationRun {
  return createManagedHarnessOperationTool(operation)
    .run as HarnessOperationRun;
}

test("Flue packages are pinned to the planned release", () => {
  assert.deepEqual(FLUE_PACKAGE_VERSIONS, {
    runtime: "2.0.3",
    postgres: "2.0.3",
    opentelemetry: "2.0.3",
    piAi: "0.83.0",
  });
});

test("runtime projections use deterministic ids and redact unsafe arguments", () => {
  assert.equal(
    runtimeTesting.eventUuid("same"),
    runtimeTesting.eventUuid("same"),
  );
  assert.deepEqual(
    runtimeTesting.safeArguments({
      authorization: "Bearer x",
      orderId: "safe",
    }),
    { authorization: "[REDACTED]", orderId: "safe" },
  );
});

test("MCP tool names are namespaced, bounded, and deterministic", () => {
  assert.equal(
    runtimeTesting.mcpToolName("traces", "lookup_trace"),
    "mcp__traces__lookup_trace",
  );
  const first = runtimeTesting.mcpToolName("traces", "x".repeat(500));
  const second = runtimeTesting.mcpToolName("traces", "x".repeat(500));
  assert.equal(first, second);
  assert.equal(first.length, 200);
  assert.match(first, /_[a-f0-9]{12}$/u);
});

test("rich tool schemas guide the model and fail closed at execution", () => {
  const compiled = runtimeTesting.compileToolInputSchema({
    type: "object",
    description: "Search input.",
    properties: {
      query: {
        type: "string",
        description: "At least two characters.",
        minLength: 2,
      },
      options: {
        type: ["object", "null"],
        description: "Provider-specific options.",
      },
      scopes: {
        type: "array",
        items: { type: "string", enum: ["customer", "shipment"] },
        maxItems: 2,
      },
    },
    required: ["query"],
    additionalProperties: false,
  } as never);

  const valid = v.safeParse(compiled, {
    query: "acme",
    options: { region: "eu" },
    scopes: ["customer"],
  });
  assert.equal(valid.success, true);
  if (valid.success)
    assert.equal(
      (
        valid.output as {
          readonly options: Readonly<Record<string, unknown>>;
        }
      ).options.region,
      "eu",
    );
  assert.equal(v.safeParse(compiled, { query: "x" }).success, false);
  assert.equal(
    v.safeParse(compiled, { query: "acme", unexpected: true }).success,
    false,
  );
  const pollutionAttempt = v.safeParse(
    compiled,
    JSON.parse('{"query":"acme","options":{"__proto__":{"polluted":true}}}'),
  );
  assert.equal(pollutionAttempt.success, true);
  if (pollutionAttempt.success) {
    const options = (
      pollutionAttempt.output as { readonly options: Record<string, unknown> }
    ).options;
    assert.equal(Object.hasOwn(options, "__proto__"), false);
    assert.equal(Object.getPrototypeOf(options), Object.prototype);
  }
  const serialized = JSON.stringify(compiled);
  assert.match(serialized, /Search input\./u);
  assert.match(serialized, /At least two characters\./u);
  assert.match(serialized, /customer/u);
  const providerSchema = toJsonSchema(compiled, { errorMode: "ignore" });
  assert.equal(providerSchema.description, "Search input.");
  assert.equal(
    (providerSchema.properties?.query as { description?: string }).description,
    "At least two characters.",
  );
  assert.equal(
    (providerSchema.properties?.query as { minLength?: number }).minLength,
    2,
  );
  assert.deepEqual(
    (providerSchema.properties?.scopes as { items?: { enum?: unknown } }).items
      ?.enum,
    ["customer", "shipment"],
  );
  const retryPrompt = runtimeTesting.managedSystemPrompt({
    systemPrompt: "Base instructions.",
    tools: [{ name: "lookup" }],
    delegates: [],
  } as never);
  assert.match(retryPrompt, /call that tool again automatically/u);
  assert.match(retryPrompt, /2 times after the initial failure/u);
  assert.match(retryPrompt, /3 total attempts/u);
  assert.match(retryPrompt, /tool_retry_exhausted/u);
});

test("Harness Operations use one durable structured prompt over the inherited sandbox", async () => {
  const files = new Map([
    ["/.oao/attachments/run-1/shipment.txt", "shipment_reference=SHP-4815"],
  ]);
  const sharedSandbox = {
    async readFile(path: string) {
      const value = files.get(path);
      if (!value) throw new Error("Fixture not found");
      return value;
    },
  };
  let promptCount = 0;
  const completedSteps = new Map<string, unknown>();
  const step = {
    async do<T>(name: string, callback: () => Promise<T> | T): Promise<T> {
      if (completedSteps.has(name)) return completedSteps.get(name) as T;
      const value = await callback();
      completedSteps.set(name, value);
      return value;
    },
  };
  const run = harnessOperationRun();
  const context = {
    data: { task: "Extract the already-materialized shipment document." },
    toolCallId: "harness-call-1",
    step,
    log: { info() {}, warn() {} },
    harness: {
      sandbox: sharedSandbox,
      async prompt(prompt: string, options: { result: v.GenericSchema }) {
        promptCount += 1;
        assert.match(prompt, /Activate the shipment-extraction Skill/u);
        assert.match(prompt, /already-materialized shipment document/u);
        assert.match(prompt, /full Skill catalog|mounted Skill catalog/u);
        assert.match(prompt, /shared sandbox/u);
        const content = await sharedSandbox.readFile(
          "/.oao/attachments/run-1/shipment.txt",
        );
        assert.equal(content, "shipment_reference=SHP-4815");
        return {
          data: v.parse(options.result, {
            shipmentReference: content.split("=")[1],
          }),
        };
      },
    },
  };
  assert.deepEqual(await run(context), {
    output: { shipmentReference: "SHP-4815" },
  });
  assert.deepEqual(await run(context), {
    output: { shipmentReference: "SHP-4815" },
  });
  assert.equal(promptCount, 1, "durable recovery must not repeat the prompt");
});

test("Harness Operations reject invalid structured output and nesting", async () => {
  const run = harnessOperationRun();
  await assert.rejects(
    run({
      data: { task: "Return malformed data." },
      toolCallId: "invalid-output",
      step: {
        async do(_name, callback) {
          return callback();
        },
      },
      log: { info() {}, warn() {} },
      harness: {
        async prompt(_prompt, options) {
          return { data: v.parse(options.result, { wrong: true }) };
        },
      },
    }),
    /shipmentReference/u,
  );

  const nested = harnessOperationRun({
    ...harnessOperation,
    key: "verify_shipment",
  });
  await assert.rejects(
    run({
      data: { task: "Attempt recursion." },
      toolCallId: "outer",
      step: {
        async do(_name, callback) {
          return callback();
        },
      },
      log: { info() {}, warn() {} },
      harness: {
        async prompt() {
          await nested({
            data: { task: "Nested work." },
            toolCallId: "inner",
            step: {
              async do(_name, callback) {
                return callback();
              },
            },
            log: { info() {}, warn() {} },
            harness: {
              async prompt() {
                return { data: {} };
              },
            },
          });
          return { data: { shipmentReference: "unreachable" } };
        },
      },
    }),
    /Nested Harness Operation calls are not allowed/u,
  );
});

test("Harness Operations honor timeout and parent cancellation signals", async () => {
  const run = harnessOperationRun({ ...harnessOperation, timeoutMs: 1_000 });
  const waitForAbort = (signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else {
        // AbortSignal.timeout() uses a weak timer, so keep Node 22 alive long
        // enough to observe the abort or fail this test deterministically.
        const watchdog = setTimeout(
          () => reject(new Error("Abort signal was not delivered")),
          2_000,
        );
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(watchdog);
            reject(signal.reason);
          },
          { once: true },
        );
      }
    });
  const base = {
    data: { task: "Wait until stopped." },
    toolCallId: "timeout",
    step: {
      async do<T>(_name: string, callback: () => Promise<T> | T) {
        return callback();
      },
    },
    log: { info() {}, warn() {} },
    harness: {
      async prompt(_prompt: string, options: { signal: AbortSignal }) {
        return waitForAbort(options.signal);
      },
    },
  };
  await assert.rejects(run(base), (error) => {
    assert.equal((error as DOMException).name, "TimeoutError");
    return true;
  });

  const controller = new AbortController();
  const cancelled = run({ ...base, signal: controller.signal });
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(cancelled, (error) => {
    assert.equal((error as DOMException).name, "AbortError");
    return true;
  });
});

test("runtime projections retain full model timing and thinking text", () => {
  const timing = runtimeTesting.turnWindow({
    timestamp: "2026-08-20T17:31:17.187Z",
    durationMs: 5_942,
  });
  assert.equal(timing.startedAt.toISOString(), "2026-08-20T17:31:11.245Z");
  assert.equal(timing.completedAt.toISOString(), "2026-08-20T17:31:17.187Z");
  assert.equal(
    runtimeTesting.turnThinking({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Count the words first." },
        { type: "text", text: "Done." },
        { type: "thinking", thinking: "Then count the letters." },
      ],
    }),
    "Count the words first.\n\nThen count the letters.",
  );
});

test("runtime projections explain exact provider finish errors safely", () => {
  assert.deepEqual(
    runtimeTesting.modelInvocationDiagnostics(
      {
        finishReason: "error",
        error: { message: "Model call timed out after 300000ms" },
      },
      true,
    ),
    {
      finishReason: "error",
      errorExplanation:
        "The model attempt exceeded its deadline and was aborted. OAO retries it when the retry budget and run deadline permit.",
    },
  );
  assert.deepEqual(
    runtimeTesting.modelInvocationDiagnostics(
      {
        finishReason: "error",
        error: { message: "Provider finish_reason: content_filter" },
      },
      true,
    ),
    {
      finishReason: "error",
      providerFinishReason: "content_filter",
      errorExplanation:
        "The provider stopped the response because its content filter was triggered, so OAO treated the partial response as incomplete and failed the run.",
    },
  );
  assert.deepEqual(
    runtimeTesting.modelInvocationDiagnostics(
      {
        finishReason: "error",
        providerFinishReason: "provider-specific_stop",
      },
      true,
    ),
    {
      finishReason: "error",
      providerFinishReason: "provider-specific_stop",
      errorExplanation:
        'The provider ended the response with "provider-specific_stop", which OAO treats as an incomplete model response and a failed run.',
    },
  );
  assert.deepEqual(
    runtimeTesting.modelInvocationDiagnostics(
      {
        finishReason: "error",
        error: { message: "Provider finish_reason: unsafe reason with spaces" },
      },
      true,
    ),
    {
      finishReason: "error",
      errorExplanation:
        "The model invocation ended before a complete response was returned, so OAO failed the run.",
    },
  );
});

const delivery = {
  version: "1" as const,
  runId: "00000000-0000-4000-8000-000000000011",
  sessionId: "00000000-0000-4000-8000-000000000012",
  snapshotHash: "a".repeat(64),
};
const runFileStorageProviderId = "00000000-0000-4000-8000-000000000016";

test("files expose sandbox paths without injecting their content", () => {
  const bytes = Buffer.from("export const x=1;", "utf8");
  const message = createManagedRunDeliveredMessage({
    delivery,
    message: "Review this file.",
    files: [
      {
        id: "00000000-0000-4000-8000-000000000013",
        name: "entry.ts",
        contentType: "application/typescript",
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        storageProviderId: runFileStorageProviderId,
        objectKey: "run-files/entry.ts",
      },
    ],
  });
  assert.equal(message.kind, "signal");
  assert.match(
    message.body,
    /\.oao\/attachments\/00000000-0000-4000-8000-000000000011\/entry\.ts/u,
  );
  assert.match(message.body, /without preprocessing/u);
  assert.doesNotMatch(message.body, /export const x=1;/u);
  assert.deepEqual(
    message.kind === "signal" ? message.attributes : {},
    delivery,
  );
});

test("image files are also copied as raw sandbox files", () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const message = createManagedRunDeliveredMessage({
    delivery,
    message: "Describe this image.",
    files: [
      {
        id: "00000000-0000-4000-8000-000000000014",
        name: "diagram.png",
        contentType: "image/png",
        sizeBytes: bytes.byteLength,
        sha256: "c".repeat(64),
        storageProviderId: runFileStorageProviderId,
        objectKey: "run-files/diagram.png",
      },
    ],
  });
  assert.equal(message.kind, "signal");
  assert.match(message.body, /diagram\.png/u);
  assert.doesNotMatch(message.body, new RegExp(bytes.toString("base64"), "u"));
});

test("raw files are materialized byte-for-byte at deterministic run paths", async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
  const writes: { readonly path: string; readonly bytes: Uint8Array }[] = [];
  await materializeManagedRunFiles(
    {
      writeFile: async (path: string, content: string | Uint8Array) => {
        writes.push({
          path,
          bytes: typeof content === "string" ? Buffer.from(content) : content,
        });
      },
    } as never,
    delivery,
    [
      {
        id: "00000000-0000-4000-8000-000000000015",
        name: "tasks.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        storageProviderId: runFileStorageProviderId,
        objectKey: "run-files/tasks.xlsx",
        bytes,
      },
    ],
  );
  assert.equal(
    writes[0]?.path,
    managedRunFileSandboxPath(delivery.runId, "tasks.xlsx"),
  );
  assert.deepEqual(writes[0]?.bytes, bytes);
});

const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
};
const providerId = "00000000-0000-4000-8000-000000000003";
const credentialCipher = new ProviderCredentialCipher(Buffer.alloc(32, 4));

test("runtime reloads run attachments only from the bound object store", async () => {
  const bytes = Buffer.from([0x01, 0x02, 0xfe, 0xff]);
  const runId = "00000000-0000-4000-8000-000000000017" as RunId;
  const objectKey = `run-files/runs/${runId}/file/report.xlsx`;
  const inputPublic = {
    message: "Inspect the workbook.",
    files: [
      {
        id: "00000000-0000-4000-8000-000000000018",
        name: "report.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        storageProviderId: runFileStorageProviderId,
        objectKey,
      },
    ],
  };
  const pool = {
    connect: async () => ({
      query: async (text: string) =>
        text.includes("SELECT input_public FROM oao.runs")
          ? { rowCount: 1, rows: [{ input_public: inputPublic }] }
          : { rowCount: 0, rows: [] },
      release() {},
    }),
  } as unknown as PgPool;
  const resolver = {
    resolve: async (input: { readonly providerId?: string }) => {
      assert.equal(input.providerId, runFileStorageProviderId);
      return {
        providerId: runFileStorageProviderId,
        store: {
          async put() {
            return { ref: "artifact:///unused" };
          },
          async get(request: { readonly key: string }) {
            assert.equal(request.key, objectKey);
            return {
              tenant,
              key: objectKey,
              bytes,
              contentType: inputPublic.files[0]!.contentType,
            };
          },
          async head() {
            return undefined;
          },
          async list() {
            return {
              prefix: "",
              folders: [],
              objects: [],
              truncated: false,
            };
          },
          async delete() {},
        },
      };
    },
  };
  const loaded = await runtimeTesting.loadManagedRunFiles(pool, resolver, {
    ...tenant,
    runId,
  });
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0]?.bytes, bytes);
});

function presetRow(input: {
  readonly preset_key: string;
  readonly model: string;
  readonly routing: unknown;
}): Record<string, unknown> {
  const encrypted = credentialCipher.encrypt("sk-runtime-test-key", {
    ...tenant,
    providerId,
    providerType: "openrouter",
    keyVersion: 1,
  });
  return {
    ...input,
    provider_id: providerId,
    provider_type: "openrouter",
    encrypted_api_key: encrypted.ciphertext,
    encryption_nonce: encrypted.nonce,
    encryption_tag: encrypted.tag,
    encryption_key_version: encrypted.keyVersion,
  };
}

/** Minimal pool that answers only the tenant-scoped preset lookup. */
function presetPool(rows: readonly Record<string, unknown>[]) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const pool = {
    connect: async () => ({
      query: async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        return text.includes("oao.project_model_presets")
          ? { rowCount: rows.length, rows }
          : { rowCount: 0, rows: [] };
      },
      release: () => undefined,
    }),
  } as unknown as PgPool;
  return { pool, queries };
}

test("deployment presets resolve after checking for a durable collision", async () => {
  const { pool, queries } = presetPool([]);
  const activator = createProjectModelPresetActivator({
    pool,
    registry: {
      activate: () => {
        throw new Error("a deployment preset must not be activated");
      },
    },
    deploymentPresetKeys: new Set(["local-default"]),
  });
  assert.equal(await activator.activate(tenant, "local-default"), undefined);
  assert.equal(
    queries.some((query) => query.text.includes("project_model_presets")),
    true,
  );
});

test("a durable preset is activated even when deployment later uses its key", async () => {
  const { pool } = presetPool([
    presetRow({
      preset_key: "stable-v1",
      model: "openrouter/anthropic/claude-sonnet-4.6",
      routing: { zeroDataRetention: true },
    }),
  ]);
  const activated: string[] = [];
  const activator = createProjectModelPresetActivator({
    pool,
    credentialCipher,
    registry: {
      activate: (preset) => {
        activated.push(preset.model);
        return {
          key: preset.key,
          model: `project/${preset.model}`,
          approvedModel: preset.model,
          origin: "project" as const,
        };
      },
    },
    deploymentPresetKeys: new Set(["local-default", "stable-v1"]),
  });
  const resolved = await activator.activate(tenant, "stable-v1");
  assert.equal(resolved?.origin, "project");
  assert.deepEqual(activated, ["openrouter/anthropic/claude-sonnet-4.6"]);
});

test("a durable project preset is loaded, tenant scoped, and activated", async () => {
  const { pool, queries } = presetPool([
    presetRow({
      preset_key: "claude-sonnet-4-6-zdr-v1",
      model: "openrouter/anthropic/claude-sonnet-4.6",
      routing: { zeroDataRetention: true, providerAllowlist: ["anthropic"] },
    }),
  ]);
  const activated: unknown[] = [];
  const activator = createProjectModelPresetActivator({
    pool,
    credentialCipher,
    registry: {
      activate: (preset) => {
        activated.push(preset);
        return {
          key: preset.key,
          model: `openrouter-project-abc/${preset.model}`,
          approvedModel: preset.model,
          origin: "project" as const,
        };
      },
    },
    deploymentPresetKeys: new Set(["local-default"]),
  });
  const resolved = await activator.activate(tenant, "claude-sonnet-4-6-zdr-v1");
  assert.equal(resolved?.origin, "project");
  assert.deepEqual(activated, [
    {
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      key: "claude-sonnet-4-6-zdr-v1",
      providerId,
      providerType: "openrouter",
      apiKey: "sk-runtime-test-key",
      credentialVersion: 1,
      model: "openrouter/anthropic/claude-sonnet-4.6",
      routing: { zeroDataRetention: true, providerAllowlist: ["anthropic"] },
      settings: null,
    },
  ]);
  const lookup = queries.find((query) =>
    query.text.includes("project_model_presets"),
  );
  assert.deepEqual(lookup?.values, [
    tenant.organizationId,
    tenant.projectId,
    "claude-sonnet-4-6-zdr-v1",
  ]);
});

test("an unknown or malformed preset never reaches the provider", async () => {
  const missing = createProjectModelPresetActivator({
    pool: presetPool([]).pool,
    registry: {
      activate: () => {
        throw new Error("must not activate");
      },
    },
    deploymentPresetKeys: new Set(["local-default"]),
  });
  await assert.rejects(
    missing.activate(tenant, "never-approved-v1"),
    (error: unknown) =>
      error instanceof ModelPresetUnavailableError &&
      error.code === "model_preset_unavailable" &&
      /not approved/u.test(error.message),
  );

  // A removed provider connection is terminal too: admission must fail the
  // run instead of retrying the wake.
  const removed = createProjectModelPresetActivator({
    pool: presetPool([
      {
        ...presetRow({
          preset_key: "orphaned-v1",
          model: "openrouter/anthropic/claude-sonnet-4.6",
          routing: {},
        }),
        provider_removed: true,
      },
    ]).pool,
    credentialCipher,
    registry: {
      activate: () => {
        throw new Error("must not activate");
      },
    },
    deploymentPresetKeys: new Set(["local-default"]),
  });
  await assert.rejects(
    removed.activate(tenant, "orphaned-v1"),
    (error: unknown) =>
      error instanceof ModelPresetUnavailableError &&
      error.code === "model_provider_removed" &&
      /was removed/u.test(error.message),
  );

  const malformed = createProjectModelPresetActivator({
    pool: presetPool([
      presetRow({
        preset_key: "wire-names-v1",
        model: "openrouter/anthropic/claude-sonnet-4.6",
        routing: { allow_fallbacks: false },
      }),
    ]).pool,
    credentialCipher,
    registry: {
      activate: () => {
        throw new Error("must not activate");
      },
    },
    deploymentPresetKeys: new Set(["local-default"]),
  });
  await assert.rejects(malformed.activate(tenant, "wire-names-v1"));
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

for (const hashVersion of [1, 2])
  test(`PostgreSQL Skill v${hashVersion} hashes become verified immutable Flue definitions`, async () => {
    const skillId = "00000000-0000-4000-8000-000000000021";
    const skillVersionId = "00000000-0000-4000-8000-000000000022";
    const instructions = "Read the reference only when this procedure applies.";
    const referencePath = "references/intake-flow.md";
    const referenceBytes = Buffer.from(
      "# Intake flow\n\nFollow the approved sequence.",
      "utf8",
    );
    // SQL collation differs from JS publication ordering for these paths.
    const resources = [
      { path: referencePath, bytes: referenceBytes },
      { path: "scripts/import-audit.schema.json", bytes: Buffer.from("{}") },
      { path: "scripts/import_contract.py", bytes: Buffer.from("# helper") },
      { path: "scripts/__pycache__/import.pyc", bytes: Buffer.from([0, 1, 2]) },
    ];
    let corrupt = false;
    let databaseError = false;
    const canonical = {
      schemaVersion: 1,
      name: "shipment-intake",
      description: "Process shipment documents using the approved flow.",
      instructions,
      metadata: {},
      files: resources
        .map(({ path, bytes }) => ({
          path,
          contentType: "text/markdown",
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
    const contentHash = createHash("sha256")
      .update(
        hashVersion === 1
          ? stableJson(canonical)
          : serializeSkillPackageForHash(canonical),
      )
      .digest("hex");
    const queries: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          queries.push(text);
          if (databaseError) throw new Error("temporary database outage");
          if (text.includes("FROM oao.skill_versions version"))
            return {
              rowCount: 1,
              rows: [
                {
                  skill_id: skillId,
                  id: skillVersionId,
                  version: 1,
                  skill_name: canonical.name,
                  description: canonical.description,
                  instructions,
                  license: null,
                  compatibility: null,
                  metadata: {},
                  allowed_tools: null,
                  content_hash: Buffer.from(contentHash, "hex"),
                  total_bytes:
                    Buffer.byteLength(instructions) +
                    resources.reduce((n, f) => n + f.bytes.byteLength, 0),
                  status: "active",
                },
              ],
            };
          if (text.includes("FROM oao.skill_version_files"))
            return {
              rowCount: resources.length,
              rows: resources.map(({ path, bytes }) => ({
                file_path: path,
                content_type: "text/markdown",
                size_bytes: bytes.byteLength,
                content_sha256: createHash("sha256").update(bytes).digest(),
                content_bytes: corrupt ? Buffer.from("tampered") : bytes,
              })),
            };
          return { rowCount: 0, rows: [] };
        },
        release: () => undefined,
      }),
    } as unknown as PgPool;
    const registry = new PostgresSkillRegistry(pool);
    const binding = {
      skillId,
      skillVersionId,
      version: 1,
      name: canonical.name,
      description: canonical.description,
      contentHash,
    };
    await registry.activate(tenant, [binding]);
    const definition = registry.resolve(tenant, binding);
    assert.equal(definition.name, "shipment-intake");
    assert.equal(definition.description, canonical.description);
    assert.equal(definition.instructions, instructions);
    assert.equal(
      definition.metadata,
      undefined,
      "empty PostgreSQL metadata must be omitted for Flue 2.0.3 frontmatter compatibility",
    );
    assert.deepEqual(definition.files?.[referencePath], referenceBytes);
    assert.equal(
      queries.filter((query) => query.includes("skill_versions version"))
        .length,
      1,
    );
    await registry.activate(tenant, [binding]);
    assert.equal(
      queries.filter((query) => query.includes("skill_versions version"))
        .length,
      1,
    );
    corrupt = true;
    await assert.rejects(
      new PostgresSkillRegistry(pool).activate(tenant, [binding]),
      SkillPackageUnavailableError,
    );
    databaseError = true;
    await assert.rejects(
      new PostgresSkillRegistry(pool).activate(tenant, [binding]),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof SkillPackageUnavailableError) &&
        error.message === "temporary database outage",
    );
  });
test("model turn limit failures expose a specific bounded safe explanation", () => {
  const diagnostics = runtimeTesting.modelInvocationDiagnostics(
    { error: { message: "Model turn limit exceeded (128)" } },
    true,
  );
  assert.equal(diagnostics.errorCode, "model_turn_limit_exceeded");
  assert.match(
    diagnostics.errorExplanation ?? "",
    /maximum of 128 model turns/,
  );
  for (const message of [
    "Model turn limit exceeded (999)",
    "Model turn limit exceeded (128) secret-token",
  ]) {
    const safe = runtimeTesting.modelInvocationDiagnostics(
      { error: { message } },
      true,
    );
    assert.equal(safe.errorCode, undefined);
    assert.ok(!JSON.stringify(safe).includes("secret-token"));
  }
});

test("permanent Skill activation errors settle admission; transient errors retry", async () => {
  const runId = "00000000-0000-4000-8000-000000000031" as RunId;
  const id = "00000000-0000-4000-8000-000000000032";
  let revoked = false;
  let state = "queued";
  let cancellationRequested = false;
  let reserved = false;
  let hasAdmissionReceipt = false;
  const recoveryReached = new Error("existing admission recovery reached");
  let activations = 0;
  const queries: { text: string; values?: unknown[] }[] = [];
  const pool = {
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, ...(values ? { values } : {}) });
        if (text.includes("FROM oao.runs r JOIN oao.agent_versions"))
          return {
            rowCount: 1,
            rows: [
              {
                id: runId,
                thread_id: id,
                session_id: id,
                state,
                has_admission_receipt: hasAdmissionReceipt,
                cancellation_requested_at: cancellationRequested
                  ? new Date()
                  : null,
                agent_version_id: id,
                content_hash: "a".repeat(64),
                input_public: { message: "test" },
                config: {
                  systemPrompt: "Test",
                  modelPreset: "local-default",
                  tools: [],
                  skillVersionIds: [id],
                  sandbox: {
                    enabled: false,
                    provider: "daytona",
                    network: "none",
                    capabilities: [],
                  },
                  limits: { maxTurns: 4, timeoutMs: 60000 },
                },
                workspace_id: id,
                owner_thread_id: id,
                owner_session_id: id,
                owner_run_id: runId,
              },
            ],
          };
        if (text.includes("FROM oao.session_skill_bindings binding"))
          return {
            rowCount: 1,
            rows: [
              {
                skill_id: id,
                skill_version_id: id,
                version: 1,
                skill_name: "test-skill",
                description: "Test",
                content_hash: Buffer.alloc(32, 1),
                status: revoked ? "revoked" : "active",
              },
            ],
          };
        if (
          text.includes("SELECT state,cancellation_requested_at FROM oao.runs")
        )
          return {
            rowCount: 1,
            rows: [
              {
                state,
                cancellation_requested_at: cancellationRequested
                  ? new Date()
                  : null,
              },
            ],
          };
        if (
          text.includes("SELECT EXISTS (") &&
          text.includes("oao.runtime_dispatches")
        )
          return { rowCount: 1, rows: [{ exists: reserved }] };
        if (text.includes("INSERT INTO oao.runtime_thread_instances"))
          throw recoveryReached;
        if (text.includes("UPDATE oao.runs SET state='failed'"))
          return { rowCount: 1, rows: [] };
        return { rowCount: 0, rows: [] };
      },
      release: () => undefined,
    }),
  } as unknown as PgPool;
  const queue = {
    enqueue: async () => undefined,
  } as unknown as PostgresWakeQueue;
  let failure: Error | undefined = new SkillPackageUnavailableError();
  const orchestrator = new ManagedRuntimeOrchestrator(
    pool,
    queue,
    undefined,
    undefined,
    {
      activate: async () => {
        activations++;
        if (failure) throw failure;
      },
    },
  );
  const job = { ...tenant, runId } as RuntimeWakeJob;
  await orchestrator.admit(job);
  assert.ok(
    queries.some((q) => q.text.includes("UPDATE oao.runs SET state='failed'")),
  );
  assert.ok(
    queries.some((q) =>
      JSON.stringify(q.values ?? []).includes("skill_package_unavailable"),
    ),
  );
  assert.ok(
    !queries.some((q) => q.text.includes("INSERT INTO oao.runtime_dispatches")),
  );
  queries.length = 0;
  revoked = true;
  const previousActivations = activations;
  await orchestrator.admit(job);
  assert.equal(
    activations,
    previousActivations,
    "revocation must fail even if the Skill was cached",
  );
  assert.ok(
    queries.some((q) => q.text.includes("UPDATE oao.runs SET state='failed'")),
  );
  assert.ok(
    queries.some((q) =>
      JSON.stringify(q.values ?? []).includes("skill_package_unavailable"),
    ),
  );
  queries.length = 0;
  revoked = false;
  failure = new Error("temporary database outage");
  await assert.rejects(orchestrator.admit(job), (error) => error === failure);
  assert.ok(
    !queries.some((q) => q.text.includes("UPDATE oao.runs SET state='failed'")),
  );

  // Cancellation must reach dispatch reconciliation, even for a revoked Skill.
  revoked = true;
  cancellationRequested = true;
  hasAdmissionReceipt = true;
  for (state of [
    "running",
    "waiting_for_approval",
    "waiting_for_tool",
    "queued",
  ]) {
    queries.length = 0;
    const before = activations;
    await assert.rejects(
      orchestrator.admit(job),
      (error) => error === recoveryReached,
    );
    assert.equal(activations, before);
    assert.ok(
      !queries.some((q) =>
        q.text.includes("UPDATE oao.runs SET state='failed'"),
      ),
    );
    assert.ok(
      !queries.some((q) =>
        q.text.includes("DELETE FROM oao.thread_admission_heads"),
      ),
    );
  }
  // After a restart, an ambiguous dispatch needs activation before rendering.
  queries.length = 0;
  revoked = false;
  state = "queued";
  hasAdmissionReceipt = false;
  failure = undefined;
  const beforeRecoveryActivation = activations;
  await assert.rejects(
    orchestrator.admit(job),
    (error) => error === recoveryReached,
  );
  assert.equal(activations, beforeRecoveryActivation + 1);
  assert.ok(
    !queries.some((q) => q.text.includes("UPDATE oao.runs SET state='failed'")),
  );
  cancellationRequested = false;
  revoked = true;
  // A dispatch may still be ambiguous while the product run remains queued.
  // Neither that reservation nor an active run may be settled as pre-dispatch.
  for (const current of [
    { state: "running", reserved: false },
    { state: "queued", reserved: true },
  ]) {
    state = current.state;
    reserved = current.reserved;
    queries.length = 0;
    await assert.rejects(orchestrator.admit(job), SkillPackageUnavailableError);
    assert.ok(
      !queries.some((q) =>
        q.text.includes("UPDATE oao.runs SET state='failed'"),
      ),
    );
    assert.ok(
      !queries.some((q) =>
        q.text.includes("DELETE FROM oao.thread_admission_heads"),
      ),
    );
  }
});
