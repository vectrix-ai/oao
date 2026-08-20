import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { OrganizationId, ProjectId, RunId } from "@oao/domain";
import type { SandboxRepository } from "../src/index.js";
import {
  DAYTONA_TARGET_POSTURE,
  FakeSandboxProvider,
  ManagedSandboxLifecycle,
} from "../src/index.js";

const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
} as const;

test("fake sandbox creation, recovery and command results are fenced", async () => {
  let instanceState: "creating" | "running" | "stopped" = "creating";
  let commandResult:
    { readonly exitCode: number; readonly redactedOutput: string } | undefined;
  const repository: SandboxRepository = {
    async reserveInstance(input) {
      return {
        ...tenant,
        id: input.id,
        runId: input.runId,
        creationKey: input.creationKey,
        fence: 1n,
        state: instanceState,
        target: "eu",
      };
    },
    async markRunning(record, handle) {
      instanceState = "running";
      return { ...record, state: "running", providerRef: handle.providerRef };
    },
    async markFailed() {
      instanceState = "stopped";
    },
    async markStopped() {
      instanceState = "stopped";
    },
    async reserveCommand(input) {
      return {
        id: input.commandId,
        fence: 1n,
        state: commandResult ? "completed" : "reserved",
        ...(commandResult ? { result: commandResult } : {}),
      };
    },
    async markCommandRunning(_input, command) {
      return { ...command, fence: command.fence + 1n, state: "running" };
    },
    async completeCommand(_input, command, result) {
      commandResult = result;
      return { ...command, state: "completed", result };
    },
    async failCommand(_input, command) {
      return {
        ...command,
        state: "failed",
        result: { exitCode: -1, redactedOutput: "Sandbox command failed" },
      };
    },
    async recordArtifact(input) {
      assert.equal(input.artifactRef, "s3://artifacts/result.txt");
    },
  };
  const provider = new FakeSandboxProvider();
  const manager = new ManagedSandboxLifecycle(repository, provider);
  const input = {
    ...tenant,
    sandboxId: "00000000-0000-4000-8000-000000000020",
    runId: "00000000-0000-4000-8000-000000000010" as RunId,
    creationKey: "sandbox:run-10",
    image: "daytonaio/sandbox:latest",
    egress: { mode: "none" as const },
  };
  const first = await manager.ensure(input);
  const recovered = await manager.ensure(input);
  assert.equal(first.handle.providerRef, recovered.handle.providerRef);
  assert.equal(
    provider.calls.filter((call) => call.startsWith("create:")).length,
    1,
  );
  const command = {
    commandId: "00000000-0000-4000-8000-000000000030",
    commandKey: "command:run-10:1",
    command: "printf safe",
    timeoutMs: 1_000,
  };
  assert.deepEqual(await manager.execute(first, command), {
    exitCode: 0,
    redactedOutput: "deterministic sandbox output",
  });
  assert.deepEqual(await manager.execute(first, command), commandResult);
  assert.equal(
    provider.calls.filter((call) => call.startsWith("execute:")).length,
    1,
  );
  await manager.recordArtifact(first, {
    artifactId: "00000000-0000-4000-8000-000000000031",
    commandId: command.commandId,
    artifactKey: "result.txt",
    artifactRef: "s3://artifacts/result.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    sha256: createHash("sha256").update("safe").digest(),
  });
  assert.equal(DAYTONA_TARGET_POSTURE.strictResidencyEnforced, false);
});
