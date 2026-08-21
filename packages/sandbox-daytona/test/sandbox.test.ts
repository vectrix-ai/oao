import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  OrganizationId,
  ProjectId,
  RunId,
  SessionId,
  ThreadId,
} from "@oao/domain";
import type { SandboxRepository } from "../src/index.js";
import {
  DAYTONA_TARGET_POSTURE,
  DaytonaManagedProvider,
  FakeSandboxProvider,
  ManagedSandboxLifecycle,
  createFakeFlueSandbox,
  daytonaSandboxRecoveryAction,
  safeSandboxToolCommand,
  sandboxWorkspaceLifecycleIdentity,
  workspaceBackupIdentityForRun,
} from "../src/index.js";
import { isReservedWorkspaceSkillPath } from "../src/flue-daytona-blueprint.js";

const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
} as const;

test("project Daytona credentials use the encrypted provider schema", async () => {
  const source = await readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /SELECT id,provider_type,encrypted_api_key,encryption_nonce,\s+encryption_tag,encryption_key_version,target,restricted_egress/u,
  );
  assert.doesNotMatch(
    source,
    /credential_(?:ciphertext|nonce|tag|key_version)/u,
  );
  assert.doesNotMatch(source, /DEFAULT_DAYTONA_IMAGE/u);
  assert.doesNotMatch(source, /flue-daytona:2\.0\.3/u);
});

test("dead Daytona builds are never reused during recovery", () => {
  assert.equal(daytonaSandboxRecoveryAction("build_failed"), "skip");
  assert.equal(daytonaSandboxRecoveryAction("destroyed"), "skip");
  assert.equal(daytonaSandboxRecoveryAction("error"), "recover");
  assert.equal(daytonaSandboxRecoveryAction("stopped"), "start");
  assert.equal(daytonaSandboxRecoveryAction("started"), "reuse");
});

test("coordinator and child threads derive one sandbox lifecycle from the workspace owner", () => {
  const root = sandboxWorkspaceLifecycleIdentity({
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    ownerThreadId: "00000000-0000-4000-8000-000000000010",
  });
  const childUsingRoot = sandboxWorkspaceLifecycleIdentity({
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    ownerThreadId: "00000000-0000-4000-8000-000000000010",
  });
  const isolatedChild = sandboxWorkspaceLifecycleIdentity({
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    ownerThreadId: "00000000-0000-4000-8000-000000000011",
  });
  assert.equal(root, childUsingRoot);
  assert.notEqual(root, isolatedChild);
});

test("workspace backups record the current owning run and preserve shared-owner identity", () => {
  const current = workspaceBackupIdentityForRun({
    ...tenant,
    runId: "00000000-0000-4000-8000-000000000021" as RunId,
    threadId: "00000000-0000-4000-8000-000000000022" as ThreadId,
    sessionId: "00000000-0000-4000-8000-000000000023" as SessionId,
    workspaceOwnerRunId: "00000000-0000-4000-8000-000000000020" as RunId,
    workspaceOwnerThreadId: "00000000-0000-4000-8000-000000000022" as ThreadId,
    workspaceOwnerSessionId:
      "00000000-0000-4000-8000-000000000023" as SessionId,
  });
  assert.equal(current.runId, "00000000-0000-4000-8000-000000000021");

  const shared = workspaceBackupIdentityForRun({
    ...tenant,
    runId: "00000000-0000-4000-8000-000000000031" as RunId,
    threadId: "00000000-0000-4000-8000-000000000032" as ThreadId,
    sessionId: "00000000-0000-4000-8000-000000000033" as SessionId,
    workspaceOwnerRunId: "00000000-0000-4000-8000-000000000020" as RunId,
    workspaceOwnerThreadId: "00000000-0000-4000-8000-000000000022" as ThreadId,
    workspaceOwnerSessionId:
      "00000000-0000-4000-8000-000000000023" as SessionId,
  });
  assert.equal(shared.runId, "00000000-0000-4000-8000-000000000020");
  assert.equal(shared.threadId, "00000000-0000-4000-8000-000000000022");
  assert.equal(shared.sessionId, "00000000-0000-4000-8000-000000000023");
});

test("mutable workspace Skills are hidden from Flue discovery", () => {
  assert.equal(isReservedWorkspaceSkillPath(".agents/skills"), true);
  assert.equal(
    isReservedWorkspaceSkillPath("/workspace/.agents/skills/local/SKILL.md"),
    true,
  );
  assert.equal(
    isReservedWorkspaceSkillPath("/workspace/.agents/skills-archive/readme.md"),
    false,
  );
  assert.equal(isReservedWorkspaceSkillPath("/workspace/src/index.ts"), false);
});

test("sandbox tool transcript keeps content while masking credentials", () => {
  const write = safeSandboxToolCommand("write", {
    path: "/root/test.csv",
    content: "customer,secret\nAlice,do-not-store",
  });
  assert.deepEqual(write, {
    toolName: "write",
    arguments: {
      path: "/root/test.csv",
      content: "customer,secret\nAlice,do-not-store",
    },
  });

  const edit = safeSandboxToolCommand("edit", {
    path: "/root/test.csv",
    oldText: "Alice",
    newText: "Bob",
  });
  assert.deepEqual(edit, {
    toolName: "edit",
    arguments: {
      path: "/root/test.csv",
      oldText: "Alice",
      newText: "Bob",
    },
  });

  assert.deepEqual(
    safeSandboxToolCommand("bash", { command: "/usr/bin/python report.py" }),
    {
      toolName: "bash",
      arguments: { command: "/usr/bin/python report.py" },
    },
  );
  const secretCommand = safeSandboxToolCommand("bash", {
    command: "API_KEY=do-not-store curl https://example.test/private",
  });
  assert.deepEqual(secretCommand, {
    toolName: "bash",
    arguments: {
      command: "API_KEY=[REDACTED] curl https://example.test/private",
    },
  });
  assert.doesNotMatch(JSON.stringify(secretCommand), /do-not-store/u);

  const navigation = safeSandboxToolCommand("browser_navigate", {
    url: "https://user:password@example.test/private?token=do-not-store",
  });
  assert.deepEqual(navigation, {
    toolName: "browser_navigate",
    arguments: {
      url: "https://[REDACTED]@example.test/private?token=[REDACTED]",
    },
  });
  assert.doesNotMatch(JSON.stringify(navigation), /password|do-not-store/u);
});

test("workspace backup and restore use Daytona's model-facing workdir", async () => {
  const commands: { readonly command: string; readonly cwd?: string }[] = [];
  const uploads: { readonly path: string; readonly bytes: Buffer }[] = [];
  const native = {
    getWorkDir: async () => "/root",
    process: {
      executeCommand: async (command: string, cwd?: string) => {
        commands.push({ command, ...(cwd ? { cwd } : {}) });
        return { exitCode: 0, result: "" };
      },
    },
    fs: {
      downloadFile: async () => Buffer.from([31, 139, 8, 0]),
      listFiles: async () => [
        {
          name: ".oao",
          path: "/root/.oao",
          isDir: true,
          size: 0,
        },
        {
          name: "input.xlsx",
          path: "/root/.oao/attachments/run/input.xlsx",
          isDir: false,
          size: 10858,
        },
        {
          name: "result.csv",
          path: "/root/output/result.csv",
          isDir: false,
          size: 42,
        },
      ],
      uploadFile: async (bytes: Buffer, path: string) => {
        uploads.push({ path, bytes: Buffer.from(bytes) });
      },
    },
  };
  const handle = {
    providerRef: "sandbox-workdir-test",
    target: "test",
    native,
  };
  const provider = new DaytonaManagedProvider({ apiKey: "test-key" });

  assert.deepEqual(
    await provider.captureWorkspace(handle),
    new Uint8Array([31, 139, 8, 0]),
  );
  const capture = commands.find((entry) =>
    entry.command.startsWith("tar --exclude="),
  );
  assert.equal(capture?.cwd, "/root");
  assert.doesNotMatch(capture?.command ?? "", /home\/daytona/u);
  assert.deepEqual(await provider.listWorkspaceFiles(handle), [
    {
      name: "input.xlsx",
      path: ".oao/attachments/run/input.xlsx",
      sizeBytes: 10858,
    },
    { name: "result.csv", path: "output/result.csv", sizeBytes: 42 },
  ]);

  commands.length = 0;
  await provider.restoreWorkspace(handle, new Uint8Array([31, 139, 8, 0]));
  const restore = commands.find((entry) =>
    entry.command.includes("tar --no-same-owner"),
  );
  assert.equal(restore?.cwd, "/root");
  assert.doesNotMatch(restore?.command ?? "", /home\/daytona/u);
  assert.deepEqual(uploads, [
    {
      path: "/tmp/oao-workspace-restore.tar.gz",
      bytes: Buffer.from([31, 139, 8, 0]),
    },
  ]);
});

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
        creatorRunId: input.runId,
        threadId: input.threadId,
        sessionId: input.sessionId,
        creationKey: input.creationKey,
        fence: 1n,
        state: instanceState,
        target: "provider-default",
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
    threadId: "00000000-0000-4000-8000-000000000011" as ThreadId,
    sessionId: "00000000-0000-4000-8000-000000000012" as SessionId,
    creationKey: "sandbox:run-10",
    snapshotId: "00000000-0000-4000-8000-000000000099",
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

test("sandbox capabilities map to the exact model-facing tool set", async () => {
  const fileFactory = createFakeFlueSandbox([
    "filesystem_read",
    "filesystem_write",
  ]);
  const fileSandbox = await fileFactory.createSandbox({ id: "files" });
  assert.deepEqual(
    fileFactory
      .tools?.(fileSandbox, { subagents: {} })
      .map((tool) => tool.name),
    ["read", "write", "edit"],
  );

  const browserFactory = createFakeFlueSandbox(["browser"]);
  const browserSandbox = await browserFactory.createSandbox({ id: "browser" });
  const browserTools = browserFactory.tools?.(browserSandbox, {
    subagents: {},
  });
  assert.deepEqual(
    browserTools?.map((tool) => tool.name),
    ["browser_navigate", "browser_snapshot", "browser_interact"],
  );
  const navigate = browserTools?.find(
    (tool) => tool.name === "browser_navigate",
  );
  const snapshot = browserTools?.find(
    (tool) => tool.name === "browser_snapshot",
  );
  assert.ok(navigate && snapshot);
  await navigate.execute("call-1", { url: "https://example.test/path" });
  const result = await snapshot.execute("call-2", {});
  assert.match(
    result.content.find((entry) => entry.type === "text")?.text ?? "",
    /https:\/\/example\.test\/path/u,
  );
});
