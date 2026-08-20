import assert from "node:assert/strict";
import test from "node:test";
import { HttpConsoleApi } from "../../apps/console/src/api/http.ts";
import type {
  AgentVersionConfig,
  SessionDetail,
} from "../../apps/console/src/api/types.ts";

const apiOrigin = process.env.OAO_TEST_API_URL;

interface RealSessionDetail extends SessionDetail {
  readonly runs: readonly {
    readonly id: string;
    readonly threadId: string;
    readonly state: string;
  }[];
  readonly transcript: readonly {
    readonly runId: string;
    readonly role: string;
    readonly redactedContent: string;
  }[];
  readonly debug: {
    readonly productEvents: readonly unknown[];
    readonly modelInvocations: readonly unknown[];
  };
}

const initialConfig: AgentVersionConfig = {
  systemPrompt: "Answer each local integration prompt succinctly.",
  modelPreset: "local-default",
  tools: [],
  sandbox: { enabled: false, network: "none" },
  limits: { maxTurns: 32, timeoutMs: 30_000 },
};

async function waitForSettledSession(
  api: HttpConsoleApi,
  sessionId: string,
  expectedRuns: number,
): Promise<RealSessionDetail> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const detail = (await api.getSession(sessionId)) as RealSessionDetail;
    if (
      detail.status === "completed" &&
      detail.runs.length === expectedRuns &&
      detail.transcript.filter((message) => message.role === "assistant")
        .length === expectedRuns
    )
      return detail;
    if (["failed", "cancelled", "timed_out"].includes(detail.status))
      throw new Error(`Run settled unexpectedly as ${detail.status}`);
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for ${expectedRuns} completed run(s); latest state was ${detail.status}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test(
  "real console adapter drives two durable local runs through API and runtime",
  { skip: apiOrigin ? false : "OAO_TEST_API_URL is required", timeout: 60_000 },
  async () => {
    assert.ok(apiOrigin);
    const api = new HttpConsoleApi({ baseUrl: `${apiOrigin}/v1` });
    const context = await api.getContext();
    assert.equal(context.project.id, "00000000-0000-4000-8000-000000000002");

    const eventKinds: string[] = [];
    const cursors: string[] = [];
    const eventErrors: Error[] = [];
    const events = api.connectEvents({
      onEvent: (event) => eventKinds.push(event.kind),
      onCursor: (cursor) => cursors.push(cursor),
      onError: (error) => eventErrors.push(error),
    });

    try {
      const agent = await api.createAgent({
        name: "Fresh stack agent",
        description: "Created by the disposable real-stack integration test.",
        initialConfig,
      });
      assert.equal(agent.model, "local-default");
      assert.equal(agent.version, 1);

      const published = await api.publishAgentVersion(agent.id, {
        ...initialConfig,
        systemPrompt: "Preserve thread history across local integration turns.",
      });
      assert.equal(published.version, 2);
      assert.equal(published.versions.length, 2);

      const createStartedAt = Date.now();
      const session = await api.createSession({
        agentId: agent.id,
        title: "Fresh stack continuity",
        initialMessage: "first local turn",
      });
      assert.ok(
        Date.now() - createStartedAt < 5_000,
        "Session creation held the HTTP request for runtime settlement",
      );
      const first = await waitForSettledSession(api, session.id, 1);
      assert.deepEqual(
        first.transcript.map((message) => message.role),
        ["user", "assistant"],
      );
      assert.equal(first.transcript[0]?.redactedContent, "first local turn");

      await api.submitMessage(session.id, "second local turn");
      const second = await waitForSettledSession(api, session.id, 2);
      assert.equal(new Set(second.runs.map((run) => run.threadId)).size, 1);
      assert.deepEqual(
        second.transcript
          .filter((message) => message.role === "user")
          .map((message) => message.redactedContent),
        ["first local turn", "second local turn"],
      );
      assert.equal(second.debug.modelInvocations.length, 2);
      assert.ok(second.debug.productEvents.length >= 4);

      const reloadedApi = new HttpConsoleApi({ baseUrl: `${apiOrigin}/v1` });
      const persisted = (await reloadedApi.getSession(
        session.id,
      )) as RealSessionDetail;
      assert.equal(persisted.runs.length, 2);
      assert.equal(persisted.transcript.length, 4);
      assert.ok(
        (await reloadedApi.listSessions({})).data.some(
          (item) => item.id === session.id,
        ),
      );

      const eventDeadline = Date.now() + 5_000;
      while (
        !eventKinds.includes("run.state_changed") &&
        Date.now() < eventDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(eventKinds.includes("run.state_changed"));
      assert.ok(cursors.length > 0);
      assert.equal(new Set(cursors).size, cursors.length);
      assert.deepEqual(eventErrors, []);
    } finally {
      events.close();
    }
  },
);
