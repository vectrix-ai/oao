import assert from "node:assert/strict";
import test from "node:test";
import { HttpConsoleApi } from "../../apps/console/src/api/http.ts";

const apiOrigin = process.env.OAO_TEST_API_URL;

test(
  "fresh stack starts without fake providers and fails closed until real providers are configured",
  { skip: apiOrigin ? false : "OAO_TEST_API_URL is required", timeout: 30_000 },
  async () => {
    assert.ok(apiOrigin);
    const api = new HttpConsoleApi({ baseUrl: `${apiOrigin}/v1` });
    const context = await api.getContext();
    assert.equal(context.project.id, "00000000-0000-4000-8000-000000000002");
    assert.deepEqual(context.activeModelPresets, []);

    const [models, modelProviders, sandboxes] = await Promise.all([
      api.listModelPresets(),
      api.listModelProviders(),
      api.listSandboxProviders(),
    ]);
    assert.deepEqual(models.data, []);
    assert.deepEqual(modelProviders, []);
    assert.deepEqual(sandboxes.data, []);

    await assert.rejects(
      api.createAgent({
        name: "Unconfigured provider agent",
        description: "The fresh stack must not substitute a fake provider.",
        initialConfig: {
          systemPrompt: "Answer succinctly.",
          modelPreset: "missing-real-preset",
          tools: [],
          sandbox: {
            enabled: false,
            provider: "missing-daytona-provider",
            network: "none",
            capabilities: [],
          },
          limits: { maxTurns: 32, timeoutMs: 30_000 },
        },
      }),
      /not an approved model preset/u,
    );
    assert.deepEqual((await api.listAgents({})).data, []);
  },
);
