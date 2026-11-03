import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DevelopmentAuthAdapter } from "@oao/auth-core";
import type { SessionVersionResolution } from "@oao/contracts";
import { createPool, migrate } from "@oao/db-postgres";
import {
  brandedId,
  type AuthorizationScope,
  type OrganizationId,
  type Principal,
  type PrincipalId,
  type ProjectId,
} from "@oao/domain";
import {
  isApprovedCatalogModel,
  listApprovedModelCatalog,
} from "@oao/models-openrouter";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import { createApiApp } from "../../src/app.js";
import type { RuntimeCommandPort } from "../../src/runtime-commands.js";
import { PostgresApiStore } from "../../src/store.js";

const databaseUrl = process.env.DATABASE_URL;
const principal: Principal = {
  id: brandedId<PrincipalId>("00000000-0000-4000-8000-00000000f003"),
  organizationId: brandedId<OrganizationId>(
    "00000000-0000-4000-8000-00000000f001",
  ),
  projectId: brandedId<ProjectId>("00000000-0000-4000-8000-00000000f002"),
  kind: "human",
  subject: "follow-latest-user",
  scopes: new Set<AuthorizationScope>(["*"]),
};
const projectPath = `/v1/projects/${principal.projectId}`;
const presetKey = "follow-latest-model-v1";
const sandbox = {
  enabled: false,
  provider: "daytona-primary",
  network: "none",
  capabilities: [],
} as const;
const otherSandbox = { ...sandbox, provider: "daytona-secondary" } as const;

/** Sessions are only created here; no worker runs them. */
class NoRuntimeCommands implements RuntimeCommandPort {
  enqueue(): Promise<void> {
    return Promise.resolve();
  }
}

type Delegate =
  { key: string; agentVersionId: string } | { key: string; agentId: string };

interface AgentConfigInput {
  readonly delegates?: readonly Delegate[];
  readonly skillVersionIds?: readonly string[];
  readonly skillIds?: readonly string[];
  readonly sandbox?: typeof sandbox | typeof otherSandbox;
  readonly prompt?: string;
}

function config(input: AgentConfigInput = {}) {
  return {
    systemPrompt: input.prompt ?? "Answer with safe public output.",
    modelPreset: presetKey,
    tools: [],
    ...(input.skillVersionIds
      ? { skillVersionIds: input.skillVersionIds }
      : {}),
    ...(input.skillIds ? { skillIds: input.skillIds } : {}),
    ...(input.delegates
      ? {
          delegates: input.delegates.map((delegate) => ({
            ...delegate,
            description: `Delegate ${delegate.key}.`,
          })),
        }
      : {}),
    sandbox: input.sandbox ?? sandbox,
    limits: { maxTurns: 8, timeoutMs: 60_000 },
  };
}

function write(
  body: Readonly<Record<string, unknown>>,
  method: "POST" | "PATCH" | "DELETE" = "POST",
  idempotencyKey: string = randomUUID(),
): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  };
}

test(
  "delegates and Skills that follow the latest version",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    await migrate(pool);
    t.after(() => pool.end());
    await pool.query(
      `SELECT oao.bootstrap_project(
        $1,'follow-latest','Follow latest organization',
        $2,'follow-latest','Follow latest project',$3,$4,'development'
      )`,
      [
        principal.organizationId,
        principal.projectId,
        principal.id,
        principal.subject,
      ],
    );
    const app = createApiApp({
      store: new PostgresApiStore(pool, "follow-latest-pepper"),
      auth: new DevelopmentAuthAdapter({ principal }),
      runtimeCommands: new NoRuntimeCommands(),
      credentialCipher: new ProviderCredentialCipher(Buffer.alloc(32, 7)),
      modelCatalog: {
        deploymentPresets: [],
        listCatalog: (input) => listApprovedModelCatalog(input?.providerType),
        isApprovedModel: isApprovedCatalogModel,
      },
    });
    const model = listApprovedModelCatalog("openrouter")[0]?.model;
    assert.ok(model);
    const provider = await app.request(
      `${projectPath}/model-providers`,
      write({
        key: "follow-latest-openrouter",
        displayName: "Follow latest OpenRouter",
        providerType: "openrouter",
        apiKey: "sk-follow-latest-provider-secret",
      }),
    );
    assert.equal(provider.status, 201, await provider.clone().text());
    const preset = await app.request(
      `${projectPath}/model-presets`,
      write({
        key: presetKey,
        displayName: "Follow latest model",
        providerId: ((await provider.json()) as { id: string }).id,
        model,
      }),
    );
    assert.equal(preset.status, 201, await preset.clone().text());

    const createAgent = async (key: string, input: AgentConfigInput = {}) => {
      const response = await app.request(
        `${projectPath}/agents`,
        write({ key, name: key, config: config(input) }),
      );
      assert.equal(response.status, 201, await response.clone().text());
      const body = (await response.json()) as {
        id: string;
        latestVersionId: string;
      };
      return { id: body.id, versionId: body.latestVersionId };
    };
    const publish = (agentId: string, input: AgentConfigInput = {}) =>
      app.request(
        `${projectPath}/agents/${agentId}/versions`,
        write({ config: config(input) }),
      );
    const publishOk = async (agentId: string, input: AgentConfigInput = {}) => {
      const response = await publish(agentId, input);
      assert.equal(response.status, 201, await response.clone().text());
      return ((await response.json()) as { id: string }).id;
    };
    const createSkill = async (key: string, name = key) => {
      const response = await app.request(
        `${projectPath}/skills`,
        write({
          key,
          displayName: key,
          name,
          description: `The ${key} Skill.`,
          instructions: `Use ${key} version 1.`,
        }),
      );
      assert.equal(response.status, 201, await response.clone().text());
      const body = (await response.json()) as {
        id: string;
        latestVersion: { id: string };
      };
      return { id: body.id, versionId: body.latestVersion.id };
    };
    const publishSkill = async (
      skillId: string,
      name: string,
      instructions: string,
    ) => {
      const response = await app.request(
        `${projectPath}/skills/${skillId}/versions`,
        write({
          name,
          description: `The ${name} Skill.`,
          instructions,
        }),
      );
      assert.equal(response.status, 201, await response.clone().text());
      return ((await response.json()) as { id: string }).id;
    };
    const startSession = (agentId: string) =>
      app.request(
        `${projectPath}/sessions`,
        write({ agentId, initialMessage: "Start." }),
      );
    const startSessionOk = async (agentId: string) => {
      const response = await startSession(agentId);
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()) as {
        id: string;
        resolvedVersions: SessionVersionResolution;
      };
    };
    const sessionDetail = async (sessionId: string) => {
      const response = await app.request(
        `${projectPath}/sessions/${sessionId}`,
      );
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as {
        resolvedVersions: SessionVersionResolution | null;
        skills: readonly { skillVersionId: string }[];
      };
    };
    const errorMessage = async (response: Response) =>
      ((await response.json()) as { error: { message: string } }).error.message;
    const entry = (resolution: SessionVersionResolution, versionId: string) => {
      const found = resolution.agentVersions.find(
        (candidate) => candidate.agentVersionId === versionId,
      );
      assert.ok(found, `resolution has no entry for ${versionId}`);
      return found;
    };

    await t.test(
      "pinned links keep their stored shape and resolve to themselves",
      async () => {
        const skill = await createSkill("pinned-skill");
        const child = await createAgent("pinned-child");
        const coordinator = await createAgent("pinned-coordinator", {
          delegates: [{ key: "child", agentVersionId: child.versionId }],
          skillVersionIds: [skill.versionId],
        });
        const stored = await pool.query<{ config: Record<string, unknown> }>(
          "SELECT config FROM oao.agent_versions WHERE id=$1",
          [coordinator.versionId],
        );
        assert.equal("skillIds" in stored.rows[0]!.config, false);
        assert.deepEqual(stored.rows[0]!.config.delegates, [
          {
            key: "child",
            description: "Delegate child.",
            agentVersionId: child.versionId,
            maxParallel: 1,
          },
        ]);

        // New child and Skill versions do not reach a pinned coordinator.
        await publishOk(child.id, { prompt: "Child version 2." });
        await publishSkill(skill.id, "pinned-skill", "Use version 2.");
        const session = await startSessionOk(coordinator.id);
        const root = entry(session.resolvedVersions, coordinator.versionId);
        assert.deepEqual(root.delegates, [
          {
            key: "child",
            agentId: child.id,
            agentVersionId: child.versionId,
            version: 1,
            followsLatest: false,
          },
        ]);
        assert.deepEqual(
          root.skills.map((bound) => [
            bound.skillVersionId,
            bound.followsLatest,
          ]),
          [[skill.versionId, false]],
        );
        const detail = await sessionDetail(session.id);
        assert.deepEqual(detail.resolvedVersions, session.resolvedVersions);
        assert.deepEqual(
          detail.skills.map((bound) => bound.skillVersionId),
          [skill.versionId],
        );
      },
    );

    await t.test(
      "followed links resolve once at session start and stay frozen",
      async () => {
        const skill = await createSkill("import-contract");
        const validator = await createAgent("validator", {
          skillIds: [skill.id],
        });
        const extraction = await createAgent("extraction", {
          delegates: [{ key: "validate", agentId: validator.id }],
        });
        const coordinator = await createAgent("coordinator", {
          delegates: [{ key: "extract", agentId: extraction.id }],
        });
        const edge = await pool.query<{
          child_agent_version_id: string | null;
          child_agent_definition_id: string | null;
        }>(
          `SELECT child_agent_version_id,child_agent_definition_id
             FROM oao.agent_version_delegates WHERE parent_agent_version_id=$1`,
          [coordinator.versionId],
        );
        assert.deepEqual(edge.rows, [
          {
            child_agent_version_id: null,
            child_agent_definition_id: extraction.id,
          },
        ]);

        const first = await startSessionOk(coordinator.id);
        assert.equal(first.resolvedVersions.rootSessionId, first.id);
        assert.deepEqual(
          first.resolvedVersions.agentVersions.map(
            (resolved) => resolved.agentVersionId,
          ),
          [coordinator.versionId, extraction.versionId, validator.versionId],
        );
        assert.deepEqual(
          entry(first.resolvedVersions, coordinator.versionId).delegates,
          [
            {
              key: "extract",
              agentId: extraction.id,
              agentVersionId: extraction.versionId,
              version: 1,
              followsLatest: true,
            },
          ],
        );
        assert.deepEqual(
          entry(first.resolvedVersions, validator.versionId).skills,
          [
            {
              skillId: skill.id,
              skillVersionId: skill.versionId,
              version: 1,
              name: "import-contract",
              followsLatest: true,
            },
          ],
        );

        // The Skill and the bottom of the chain change; nothing above them
        // is republished.
        const skillV2 = await publishSkill(
          skill.id,
          "import-contract",
          "Use version 2, which adds validate-drafts.",
        );
        const validatorV2 = await publishOk(validator.id, {
          skillIds: [skill.id],
          prompt: "Validator version 2.",
        });

        // The running session keeps what it resolved.
        const frozen = await sessionDetail(first.id);
        assert.deepEqual(frozen.resolvedVersions, first.resolvedVersions);
        const stored = await pool.query<{ resolution: unknown }>(
          "SELECT resolution FROM oao.session_version_resolutions WHERE session_id=$1",
          [first.id],
        );
        assert.deepEqual(stored.rows[0]?.resolution, first.resolvedVersions);

        // A new session picks up the new versions through the whole chain.
        const second = await startSessionOk(coordinator.id);
        assert.deepEqual(
          second.resolvedVersions.agentVersions.map(
            (resolved) => resolved.agentVersionId,
          ),
          [coordinator.versionId, extraction.versionId, validatorV2],
        );
        assert.equal(
          entry(second.resolvedVersions, validatorV2).skills[0]?.skillVersionId,
          skillV2,
        );
        assert.equal(
          entry(second.resolvedVersions, extraction.versionId).delegates[0]
            ?.version,
          2,
        );

        // A Skill bound on the root session is copied into its bindings.
        const root = await createAgent("skill-root", { skillIds: [skill.id] });
        const rooted = await startSessionOk(root.id);
        assert.deepEqual(
          (await sessionDetail(rooted.id)).skills.map(
            (bound) => bound.skillVersionId,
          ),
          [skillV2],
        );
      },
    );

    await t.test(
      "publication refuses unsafe followed links with clear errors",
      async () => {
        const incompatible = await createAgent("other-sandbox-child", {
          sandbox: otherSandbox,
        });
        const coordinator = await createAgent("guarded-coordinator");
        const sandboxMismatch = await publish(coordinator.id, {
          delegates: [{ key: "child", agentId: incompatible.id }],
        });
        assert.equal(sandboxMismatch.status, 400);
        assert.match(
          await errorMessage(sandboxMismatch),
          /same sandbox enabled state, provider, snapshot, and network policy/u,
        );

        const self = await publish(coordinator.id, {
          delegates: [{ key: "self", agentId: coordinator.id }],
        });
        assert.equal(self.status, 400);
        assert.match(
          await errorMessage(self),
          /cannot follow the coordinator/u,
        );

        // first follows second; second following first closes a cycle.
        const second = await createAgent("cycle-second");
        const first = await createAgent("cycle-first", {
          delegates: [{ key: "next", agentId: second.id }],
        });
        const cycle = await publish(second.id, {
          delegates: [{ key: "back", agentId: first.id }],
        });
        assert.equal(cycle.status, 400);
        assert.match(await errorMessage(cycle), /would create an agent cycle/u);
        // Pinning a version of an agent that follows back is a cycle too.
        const pinnedCycle = await publish(second.id, {
          delegates: [{ key: "back", agentVersionId: first.versionId }],
        });
        assert.equal(pinnedCycle.status, 400);

        const removed = await createAgent("removed-child");
        const deleted = await app.request(
          `${projectPath}/agents/${removed.id}`,
          write({}, "DELETE"),
        );
        assert.equal(deleted.status, 200, await deleted.clone().text());
        const followsRemoved = await publish(coordinator.id, {
          delegates: [{ key: "gone", agentId: removed.id }],
        });
        assert.equal(followsRemoved.status, 400);
        assert.match(await errorMessage(followsRemoved), /not available/u);

        const unpublishedId = randomUUID();
        await pool.query(
          `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
           VALUES ($1,$2,$3,'unpublished-child','Unpublished child')`,
          [principal.organizationId, principal.projectId, unpublishedId],
        );
        const followsUnpublished = await publish(coordinator.id, {
          delegates: [{ key: "draft", agentId: unpublishedId }],
        });
        assert.equal(followsUnpublished.status, 400);
        assert.match(
          await errorMessage(followsUnpublished),
          /has no published version/u,
        );

        const skill = await createSkill("guarded-skill");
        const both = await publish(coordinator.id, {
          skillVersionIds: [skill.versionId],
          skillIds: [skill.id],
        });
        assert.equal(both.status, 400);
        assert.match(await errorMessage(both), /both pinned and followed/u);

        const disabledSkill = await createSkill("disabled-skill");
        const disabled = await app.request(
          `${projectPath}/skills/${disabledSkill.id}`,
          write({ enabled: false }, "PATCH"),
        );
        assert.equal(disabled.status, 200, await disabled.clone().text());
        const followsDisabled = await publish(coordinator.id, {
          skillIds: [disabledSkill.id],
        });
        assert.equal(followsDisabled.status, 400);
        assert.match(await errorMessage(followsDisabled), /is disabled/u);

        const emptySkillId = randomUUID();
        await pool.query(
          `INSERT INTO oao.skills (organization_id,project_id,id,skill_key,display_name,created_by_principal_id)
           VALUES ($1,$2,$3,'empty-skill','Empty skill',$4)`,
          [
            principal.organizationId,
            principal.projectId,
            emptySkillId,
            principal.id,
          ],
        );
        const followsEmpty = await publish(coordinator.id, {
          skillIds: [emptySkillId],
        });
        assert.equal(followsEmpty.status, 400);
        assert.match(
          await errorMessage(followsEmpty),
          /has no published version/u,
        );

        // The database guard keeps the same rules without the API.
        await assert.rejects(
          pool.query("SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)", [
            principal.organizationId,
            principal.projectId,
            coordinator.id,
            randomUUID(),
            config({ delegates: [{ key: "self", agentId: coordinator.id }] }),
            Buffer.alloc(32, 1),
            principal.id,
          ]),
          /delegate agent version is missing, duplicated, or belongs to the coordinator agent/u,
        );
        await assert.rejects(
          pool.query("SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)", [
            principal.organizationId,
            principal.projectId,
            second.id,
            randomUUID(),
            config({ delegates: [{ key: "back", agentId: first.id }] }),
            Buffer.alloc(32, 2),
            principal.id,
          ]),
          /agent-definition cycle/u,
        );
        await assert.rejects(
          pool.query("SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)", [
            principal.organizationId,
            principal.projectId,
            coordinator.id,
            randomUUID(),
            config({ skillIds: [disabledSkill.id] }),
            Buffer.alloc(32, 3),
            principal.id,
          ]),
          /followed Skill is missing, unavailable/u,
        );
        for (const [agentId, label] of [
          [removed.id, "removed"],
          [unpublishedId, "unpublished"],
        ] as const)
          await assert.rejects(
            pool.query(
              "SELECT oao.publish_agent_version($1,$2,$3,$4,$5,$6,$7)",
              [
                principal.organizationId,
                principal.projectId,
                coordinator.id,
                randomUUID(),
                config({ delegates: [{ key: "gone", agentId }] }),
                Buffer.alloc(32, label === "removed" ? 4 : 5),
                principal.id,
              ],
            ),
            /followed delegate agent is missing, removed, or has no published version/u,
            label,
          );
        const shape = await pool.query<{ valid: boolean }>(
          "SELECT oao.is_valid_agent_publication_config_with_mcp($1) AS valid",
          [
            {
              ...config(),
              delegates: [
                {
                  key: "both",
                  description: "Both targets.",
                  agentId: first.id,
                  agentVersionId: first.versionId,
                },
              ],
            },
          ],
        );
        assert.equal(shape.rows[0]?.valid, false);
      },
    );

    await t.test(
      "a retried publication replays even after its followed Skill changed",
      async () => {
        const skill = await createSkill("replayed-skill");
        const coordinator = await createAgent("replayed-coordinator");
        const request = () =>
          app.request(
            `${projectPath}/agents/${coordinator.id}/versions`,
            write(
              { config: config({ skillIds: [skill.id] }) },
              "POST",
              "replayed-publication",
            ),
          );
        const first = await request();
        assert.equal(first.status, 201, await first.clone().text());
        const disabled = await app.request(
          `${projectPath}/skills/${skill.id}`,
          write({ enabled: false }, "PATCH"),
        );
        assert.equal(disabled.status, 200, await disabled.clone().text());
        const replay = await request();
        assert.equal(replay.status, 201, await replay.clone().text());
        assert.equal(replay.headers.get("idempotency-replayed"), "true");
        assert.deepEqual(await replay.json(), await first.json());
      },
    );

    await t.test(
      "session start fails clearly when a followed link is no longer usable",
      async () => {
        // An incompatible child publication is accepted; coordinators that
        // follow it fail at session start until they are republished.
        const child = await createAgent("drifting-child");
        const coordinator = await createAgent("drifting-coordinator", {
          delegates: [{ key: "child", agentId: child.id }],
        });
        await startSessionOk(coordinator.id);
        await publishOk(child.id, { sandbox: otherSandbox });
        const drifted = await startSession(coordinator.id);
        assert.equal(drifted.status, 409);
        assert.match(
          await errorMessage(drifted),
          /Agent "drifting-coordinator" version 1: delegate child follows agent "drifting-child", whose latest version 2 uses a different sandbox/u,
        );
        await publishOk(coordinator.id, {
          delegates: [{ key: "child", agentId: child.id }],
          sandbox: otherSandbox,
        });
        await startSessionOk(coordinator.id);

        const removedChild = await createAgent("removed-followed-child");
        const followsRemoved = await createAgent("follows-removed", {
          delegates: [{ key: "child", agentId: removedChild.id }],
        });
        const deleted = await app.request(
          `${projectPath}/agents/${removedChild.id}`,
          write({}, "DELETE"),
        );
        assert.equal(deleted.status, 200, await deleted.clone().text());
        const removed = await startSession(followsRemoved.id);
        assert.equal(removed.status, 409);
        assert.match(
          await errorMessage(removed),
          /follows agent "removed-followed-child", which was deleted/u,
        );

        const skill = await createSkill("lifecycle-skill");
        const follower = await createAgent("skill-follower", {
          skillIds: [skill.id],
        });
        const disabled = await app.request(
          `${projectPath}/skills/${skill.id}`,
          write({ enabled: false }, "PATCH"),
        );
        assert.equal(disabled.status, 200, await disabled.clone().text());
        const whileDisabled = await startSession(follower.id);
        assert.equal(whileDisabled.status, 409);
        assert.match(await errorMessage(whileDisabled), /which is disabled/u);
        const enabled = await app.request(
          `${projectPath}/skills/${skill.id}`,
          write({ enabled: true }, "PATCH"),
        );
        assert.equal(enabled.status, 200, await enabled.clone().text());
        await startSessionOk(follower.id);

        const revokedVersion = await publishSkill(
          skill.id,
          "lifecycle-skill",
          "A broken version 2.",
        );
        const revoked = await app.request(
          `${projectPath}/skills/${skill.id}/versions/${revokedVersion}/lifecycle`,
          write({ status: "revoked" }, "PATCH"),
        );
        assert.equal(revoked.status, 200, await revoked.clone().text());
        const whileRevoked = await startSession(follower.id);
        assert.equal(whileRevoked.status, 409);
        assert.match(
          await errorMessage(whileRevoked),
          /whose latest version 2 is revoked/u,
        );
        await publishSkill(skill.id, "lifecycle-skill", "A fixed version 3.");
        await startSessionOk(follower.id);

        const archived = await app.request(
          `${projectPath}/skills/${skill.id}`,
          write({}, "DELETE"),
        );
        assert.equal(archived.status, 200, await archived.clone().text());
        const whileArchived = await startSession(follower.id);
        assert.equal(whileArchived.status, 409);
        assert.match(await errorMessage(whileArchived), /which was deleted/u);

        // A followed Skill renamed onto a pinned one's name.
        const alpha = await createSkill("alpha-skill", "alpha");
        const beta = await createSkill("beta-skill", "beta");
        const named = await createAgent("named-skills", {
          skillVersionIds: [alpha.versionId],
          skillIds: [beta.id],
        });
        await publishSkill(beta.id, "alpha", "Beta, renamed to alpha.");
        const collision = await startSession(named.id);
        assert.equal(collision.status, 409);
        assert.match(
          await errorMessage(collision),
          /would bind two Skills named alpha/u,
        );

        // A cycle the publication checks never saw, written directly.
        const loopChild = await createAgent("loop-child");
        const loopRoot = await createAgent("loop-root", {
          delegates: [{ key: "child", agentId: loopChild.id }],
        });
        await pool.query(
          `INSERT INTO oao.agent_version_delegates (
             organization_id,project_id,parent_agent_version_id,delegate_key,
             description,child_agent_definition_id
           ) VALUES ($1,$2,$3,'back','Back to the root.',$4)`,
          [
            principal.organizationId,
            principal.projectId,
            loopChild.versionId,
            loopRoot.id,
          ],
        );
        const loop = await startSession(loopRoot.id);
        assert.equal(loop.status, 409);
        assert.match(
          await errorMessage(loop),
          /The delegates form a cycle: "loop-root" version 1 → "loop-child" version 1 → "loop-root" version 1/u,
        );
        const sessions = await pool.query(
          `SELECT 1 FROM oao.sessions s
             JOIN oao.agent_versions v ON v.id=s.agent_version_id
            WHERE v.agent_definition_id=$1`,
          [loopRoot.id],
        );
        assert.equal(sessions.rowCount, 0);
      },
    );
  },
);
