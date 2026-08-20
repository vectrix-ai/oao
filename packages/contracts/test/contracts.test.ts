import assert from "node:assert/strict";
import test from "node:test";
import * as v from "valibot";
import {
  ApiErrorSchema,
  PLATFORM_MAX_TURNS,
  ProductEventSchema,
  RunSchema,
  ToolCallSchema,
  parseManagedAgentSnapshotForPublication,
} from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const timestamp = "2026-08-20T10:00:00.000Z";

test("run and event public contracts accept safe wire representations", () => {
  assert.equal(
    v.parse(RunSchema, {
      id,
      organizationId: id,
      projectId: id,
      threadId: id,
      sessionId: id,
      agentVersionId: id,
      createdByPrincipalId: id,
      state: "queued",
      cancellationRequestedAt: null,
      admittedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).state,
    "queued",
  );
  assert.equal(
    v.parse(ProductEventSchema, {
      id,
      organizationId: id,
      projectId: id,
      aggregateType: "run",
      aggregateId: id,
      aggregateSequence: 1,
      projectPosition: "9007199254740993",
      kind: "sandbox.started",
      publicPayload: { region: "eu" },
      occurredAt: timestamp,
    }).projectPosition,
    "9007199254740993",
  );
});

test("API errors have a stable envelope", () => {
  const parsed = v.parse(ApiErrorSchema, {
    error: { code: "conflict", message: "already exists" },
  });
  assert.equal(parsed.error.code, "conflict");
});

test("tool claim fences remain precise above Number.MAX_SAFE_INTEGER", () => {
  const claimFence = "9007199254740993";
  const parsed = v.parse(ToolCallSchema, {
    id,
    organizationId: id,
    projectId: id,
    runId: id,
    toolName: "lookup",
    owner: "caller",
    stage: "caller_claimed",
    safeArguments: {},
    claimFence,
    createdAt: timestamp,
  });
  assert.equal(parsed.claimFence, claimFence);
  assert.throws(() =>
    v.parse(ToolCallSchema, { ...parsed, claimFence: "09007199254740993" }),
  );
});

test("agent publication rejects JSON schema keywords the runtime cannot enforce", () => {
  const snapshot = {
    systemPrompt: "Be deterministic",
    modelPreset: "local-fake",
    tools: [
      {
        schemaVersion: 1 as const,
        name: "lookup",
        description: "Look up a value",
        owner: "caller",
        approval: "never",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { found: { type: "boolean" } },
          required: ["found"],
          additionalProperties: false,
        },
      },
    ],
    sandbox: { enabled: false, network: "none" },
    limits: { maxTurns: PLATFORM_MAX_TURNS, timeoutMs: 60_000 },
  };
  assert.equal(
    parseManagedAgentSnapshotForPublication(snapshot).tools[0]?.name,
    "lookup",
  );
  assert.throws(() =>
    parseManagedAgentSnapshotForPublication({
      ...snapshot,
      tools: [
        {
          ...snapshot.tools[0],
          inputSchema: {
            ...snapshot.tools[0]?.inputSchema,
            properties: {
              query: { type: "string", minLength: 1 },
            },
          },
        },
      ],
    }),
  );
});
