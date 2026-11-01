import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPool, type PgPool } from "@oao/db-postgres";
import type {
  OrganizationId,
  ProjectId,
  PrincipalId,
  RunId,
} from "@oao/domain";
import type { McpConnectionDefinition, McpRemotePort } from "@oao/mcp-remote";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import {
  createPostgresMcpToolExecutor,
  runtimeTesting,
} from "@oao/runtime-flue";

const databaseUrl = process.env.DATABASE_URL;
const testAdminDatabaseUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? databaseUrl;
const cipher = new ProviderCredentialCipher(Buffer.alloc(32, 9));

function uuid(label: string): string {
  return runtimeTesting.eventUuid(`mcp-executor-test:${label}`);
}

function hash(label: string): Buffer {
  return createHash("sha256").update(label).digest();
}

const inputSchema = {
  type: "object" as const,
  properties: { traceId: { type: "string" } },
  required: ["traceId"],
  additionalProperties: false,
};

interface Fixture {
  readonly tenant: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly sessionId: string;
    readonly runId: RunId;
    readonly flueToolCallId: string;
  };
  readonly tool: Parameters<
    ReturnType<typeof createPostgresMcpToolExecutor>["execute"]
  >[1];
  readonly credentialVersionId: string;
  readonly toolCallId: string;
}

interface FixtureOptions {
  readonly endpointUrl?: string;
  readonly policyOrigin?: string;
  readonly policyPathPrefix?: string;
  /** Null stores a credential the destination migration could not pin. */
  readonly destination?: {
    readonly origin: string;
    readonly pathPrefix: string;
  } | null;
}

/** Seeds one bound MCP tool and one run the executor may call it for. */
async function seedMcpCall(
  admin: PgPool,
  label: string,
  options: FixtureOptions = {},
): Promise<Fixture> {
  const organizationId = uuid(`${label}:org`) as OrganizationId;
  const projectId = uuid(`${label}:project`) as ProjectId;
  const principalId = uuid(`${label}:principal`) as PrincipalId;
  const ids = {
    server: uuid(`${label}:server`),
    serverVersion: uuid(`${label}:server-version`),
    credential: uuid(`${label}:credential`),
    credentialVersion: uuid(`${label}:credential-version`),
    policy: uuid(`${label}:policy`),
    policyVersion: uuid(`${label}:policy-version`),
    toolset: uuid(`${label}:toolset`),
    toolsetVersion: uuid(`${label}:toolset-version`),
    agent: uuid(`${label}:agent`),
    agentVersion: uuid(`${label}:agent-version`),
    thread: uuid(`${label}:thread`),
    session: uuid(`${label}:session`),
    run: uuid(`${label}:run`) as RunId,
  };
  const endpointUrl = options.endpointUrl ?? "https://mcp.example.test/mcp";
  const destination =
    options.destination === undefined
      ? { origin: "https://mcp.example.test", pathPrefix: "/mcp" }
      : options.destination;
  const flueToolCallId = `flue-${label}`;
  const toolCallId = runtimeTesting.eventUuid(
    `tool:${ids.run}:${flueToolCallId}`,
  );
  const encrypted = cipher.encrypt(`secret-for-${label}`, {
    organizationId,
    providerId: ids.credential,
    providerType: "mcp",
    keyVersion: 1,
  });
  const query = (sql: string, values: readonly unknown[]) =>
    admin.query(sql, [...values]);

  await query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,$2,$3)",
    [organizationId, `mcp-exec-${label}`, `MCP executor ${label}`],
  );
  await query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,$3,$4)",
    [organizationId, projectId, `mcp-exec-${label}`, `MCP executor ${label}`],
  );
  await query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'service',$4,ARRAY['*'])`,
    [organizationId, projectId, principalId, `mcp-exec-${label}`],
  );
  await query(
    `INSERT INTO oao.mcp_servers (organization_id,id,server_key,display_name,created_by_principal_id)
     VALUES ($1,$2,'trace-server','Trace server',$3)`,
    [organizationId, ids.server, principalId],
  );
  await query(
    `INSERT INTO oao.mcp_server_versions (
       organization_id,id,server_id,version,endpoint_url,transport,content_hash,
       created_by_principal_id
     ) VALUES ($1,$2,$3,1,$4,'streamable_http',$5,$6)`,
    [
      organizationId,
      ids.serverVersion,
      ids.server,
      endpointUrl,
      hash(`${label}:server`),
      principalId,
    ],
  );
  await query(
    `INSERT INTO oao.mcp_server_version_lifecycle (organization_id,server_version_id,updated_by_principal_id)
     VALUES ($1,$2,$3)`,
    [organizationId, ids.serverVersion, principalId],
  );
  await query(
    `INSERT INTO oao.mcp_server_version_tools (
       organization_id,server_version_id,remote_tool_name,description,input_schema,schema_hash
     ) VALUES ($1,$2,'lookup_trace','Look up a trace.',$3,$4)`,
    [organizationId, ids.serverVersion, inputSchema, hash(`${label}:schema`)],
  );
  await query(
    "UPDATE oao.mcp_servers SET latest_version_id=$3 WHERE organization_id=$1 AND id=$2",
    [organizationId, ids.server, ids.serverVersion],
  );
  await query(
    `INSERT INTO oao.mcp_credentials (
       organization_id,id,credential_key,display_name,credential_kind,header_name,
       created_by_principal_id
     ) VALUES ($1,$2,'trace-token','Trace token','static_bearer',NULL,$3)`,
    [organizationId, ids.credential, principalId],
  );
  await query(
    `INSERT INTO oao.mcp_credential_versions (
       organization_id,id,credential_id,version,encrypted_secret,encryption_nonce,
       encryption_tag,encryption_key_version,credential_fingerprint,
       destination_origin,destination_path_prefix,created_by_principal_id
     ) VALUES ($1,$2,$3,1,$4,$5,$6,1,$7,$8,$9,$10)`,
    [
      organizationId,
      ids.credentialVersion,
      ids.credential,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.tag,
      encrypted.fingerprint,
      destination?.origin ?? null,
      destination?.pathPrefix ?? null,
      principalId,
    ],
  );
  await query(
    `INSERT INTO oao.mcp_credential_version_lifecycle (organization_id,credential_version_id,updated_by_principal_id)
     VALUES ($1,$2,$3)`,
    [organizationId, ids.credentialVersion, principalId],
  );
  await query(
    "UPDATE oao.mcp_credentials SET active_version_id=$3 WHERE organization_id=$1 AND id=$2",
    [organizationId, ids.credential, ids.credentialVersion],
  );
  // Policies are written directly so a policy outside the destination can
  // exist, as one could have before destinations were pinned.
  await query(
    `INSERT INTO oao.mcp_credential_policies (organization_id,id,policy_key,display_name,created_by_principal_id)
     VALUES ($1,$2,'trace-egress','Trace egress',$3)`,
    [organizationId, ids.policy, principalId],
  );
  await query(
    `INSERT INTO oao.mcp_credential_policy_versions (
       organization_id,id,policy_id,version,credential_id,exact_origin,path_prefix,
       timeout_ms,maximum_response_bytes,content_hash,created_by_principal_id
     ) VALUES ($1,$2,$3,1,$4,$5,$6,10000,65536,$7,$8)`,
    [
      organizationId,
      ids.policyVersion,
      ids.policy,
      ids.credential,
      options.policyOrigin ?? "https://mcp.example.test",
      options.policyPathPrefix ?? "/mcp",
      hash(`${label}:policy`),
      principalId,
    ],
  );
  await query(
    `INSERT INTO oao.mcp_credential_policy_version_lifecycle (organization_id,policy_version_id,updated_by_principal_id)
     VALUES ($1,$2,$3)`,
    [organizationId, ids.policyVersion, principalId],
  );
  await query(
    "UPDATE oao.mcp_credential_policies SET latest_version_id=$3 WHERE organization_id=$1 AND id=$2",
    [organizationId, ids.policy, ids.policyVersion],
  );
  await query(
    `INSERT INTO oao.mcp_toolsets (organization_id,project_id,id,toolset_key,display_name,created_by_principal_id)
     VALUES ($1,$2,$3,'trace-tools','Trace tools',$4)`,
    [organizationId, projectId, ids.toolset, principalId],
  );
  await query(
    `INSERT INTO oao.mcp_toolset_versions (
       organization_id,project_id,id,toolset_id,version,server_version_id,content_hash,
       created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
    [
      organizationId,
      projectId,
      ids.toolsetVersion,
      ids.toolset,
      ids.serverVersion,
      hash(`${label}:toolset`),
      principalId,
    ],
  );
  await query(
    `INSERT INTO oao.mcp_toolset_version_tools (
       organization_id,project_id,toolset_version_id,server_version_id,remote_tool_name,approval
     ) VALUES ($1,$2,$3,$4,'lookup_trace','never')`,
    [organizationId, projectId, ids.toolsetVersion, ids.serverVersion],
  );
  await query(
    `INSERT INTO oao.mcp_toolset_version_lifecycle (
       organization_id,project_id,toolset_version_id,updated_by_principal_id
     ) VALUES ($1,$2,$3,$4)`,
    [organizationId, projectId, ids.toolsetVersion, principalId],
  );
  const binding = {
    toolsetVersionId: ids.toolsetVersion,
    credentialPolicyVersionId: ids.policyVersion,
    namespace: "traces",
  };
  const config = {
    systemPrompt: "Use the trace tool.",
    modelPreset: "local-default",
    tools: [],
    mcpBindings: [binding],
    sandbox: { enabled: false },
    limits: { maxTurns: 4, timeoutMs: 10_000 },
  };
  await query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,'trace-agent','Trace agent')`,
    [organizationId, projectId, ids.agent],
  );
  await query(
    `INSERT INTO oao.agent_versions (
       organization_id,project_id,id,agent_definition_id,version,config,content_hash,
       created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
    [
      organizationId,
      projectId,
      ids.agentVersion,
      ids.agent,
      config,
      hash(`${label}:agent`),
      principalId,
    ],
  );
  await query(
    `INSERT INTO oao.agent_version_mcp_bindings (
       organization_id,project_id,agent_version_id,toolset_version_id,
       credential_policy_version_id,namespace
     ) VALUES ($1,$2,$3,$4,$5,'traces')`,
    [
      organizationId,
      projectId,
      ids.agentVersion,
      ids.toolsetVersion,
      ids.policyVersion,
    ],
  );
  await query(
    "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'MCP executor')",
    [organizationId, projectId, ids.thread],
  );
  await query(
    `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [organizationId, projectId, ids.session, ids.thread, ids.agentVersion],
  );
  await query(
    `INSERT INTO oao.session_mcp_bindings (
       organization_id,project_id,session_id,agent_version_id,toolset_version_id,
       credential_policy_version_id,namespace
     ) VALUES ($1,$2,$3,$4,$5,$6,'traces')`,
    [
      organizationId,
      projectId,
      ids.session,
      ids.agentVersion,
      ids.toolsetVersion,
      ids.policyVersion,
    ],
  );
  await query(
    `INSERT INTO oao.runs (
       organization_id,project_id,id,thread_id,session_id,agent_version_id,
       created_by_principal_id,idempotency_key,input_public
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      organizationId,
      projectId,
      ids.run,
      ids.thread,
      ids.session,
      ids.agentVersion,
      principalId,
      `run-key-${label}`,
      { message: "Look up trace-1." },
    ],
  );
  await query(
    `INSERT INTO oao.tool_calls (organization_id,project_id,id,run_id,tool_name)
     VALUES ($1,$2,$3,$4,'mcp__traces__lookup_trace')`,
    [organizationId, projectId, toolCallId, ids.run],
  );
  return {
    tenant: {
      organizationId,
      projectId,
      sessionId: ids.session,
      runId: ids.run,
      flueToolCallId,
    },
    tool: {
      serverVersionId: ids.serverVersion,
      toolsetVersionId: ids.toolsetVersion,
      credentialPolicyVersionId: ids.policyVersion,
      namespace: "traces",
      remoteToolName: "lookup_trace",
      name: "mcp__traces__lookup_trace",
      description: "Look up a trace.",
      approval: "never",
      inputSchema,
      outputSchema: null,
      timeoutMs: 10_000,
      maximumResponseBytes: 65_536,
    },
    credentialVersionId: ids.credentialVersion,
    toolCallId,
  };
}

function recordingRemote(): {
  readonly remote: McpRemotePort;
  readonly calls: McpConnectionDefinition[];
} {
  const calls: McpConnectionDefinition[] = [];
  return {
    calls,
    remote: {
      discover: () => Promise.reject(new Error("discovery is not expected")),
      call: (connection) => {
        calls.push(connection);
        return Promise.resolve({
          content: '{"found":true}',
          isError: false,
          responseBytes: 14,
        });
      },
    },
  };
}

test(
  "the MCP executor sends a credential only inside its pinned destination",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const admin = createPool(testAdminDatabaseUrl);
    const pool = createPool(databaseUrl);
    t.after(async () => {
      await pool.end();
      await admin.end();
    });
    const run = suffix(t.name);

    await t.test("a policy inside the destination executes", async () => {
      const fixture = await seedMcpCall(admin, `${run}-inside`);
      const { remote, calls } = recordingRemote();
      const executor = createPostgresMcpToolExecutor({
        pool,
        credentialCipher: cipher,
        remote,
      });
      const result = await executor.execute(fixture.tenant, fixture.tool, {
        traceId: "trace-1",
      });
      assert.deepEqual(result, { content: '{"found":true}', isError: false });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.credentialDestination, {
        origin: "https://mcp.example.test",
        pathPrefix: "/mcp",
      });
      assert.deepEqual(calls[0]?.credential, {
        kind: "static_bearer",
        secret: `secret-for-${run}-inside`,
      });
      const attempt = await admin.query<{
        state: string;
        credential_version_id: string;
      }>(
        `SELECT state,credential_version_id FROM oao.mcp_call_attempts
          WHERE organization_id=$1 AND project_id=$2 AND tool_call_id=$3`,
        [
          fixture.tenant.organizationId,
          fixture.tenant.projectId,
          fixture.toolCallId,
        ],
      );
      assert.deepEqual(attempt.rows, [
        {
          state: "completed",
          credential_version_id: fixture.credentialVersionId,
        },
      ]);
    });

    for (const [name, options] of [
      [
        "another origin",
        {
          endpointUrl: "https://attacker.example.test/mcp",
          policyOrigin: "https://attacker.example.test",
        },
      ],
      [
        "a broader path",
        {
          endpointUrl: "https://mcp.example.test/admin",
          policyPathPrefix: "/",
        },
      ],
      [
        "a sibling path sharing a string prefix",
        {
          endpointUrl: "https://mcp.example.test/mcpx",
          policyPathPrefix: "/mcpx",
        },
      ],
    ] as const)
      await t.test(`a policy for ${name} is refused`, async () => {
        const fixture = await seedMcpCall(
          admin,
          `${run}-${name.replaceAll(" ", "-")}`,
          options,
        );
        const { remote, calls } = recordingRemote();
        const executor = createPostgresMcpToolExecutor({
          pool,
          credentialCipher: cipher,
          remote,
        });
        await assert.rejects(
          executor.execute(fixture.tenant, fixture.tool, {
            traceId: "trace-1",
          }),
          /no longer active/u,
        );
        assert.equal(calls.length, 0);
      });

    await t.test(
      "a credential the migration could not pin keeps its existing policy",
      async () => {
        const fixture = await seedMcpCall(admin, `${run}-legacy`, {
          endpointUrl: "https://legacy.example.test/mcp",
          policyOrigin: "https://legacy.example.test",
          destination: null,
        });
        const { remote, calls } = recordingRemote();
        const executor = createPostgresMcpToolExecutor({
          pool,
          credentialCipher: cipher,
          remote,
        });
        await executor.execute(fixture.tenant, fixture.tool, {
          traceId: "trace-1",
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.credentialDestination, undefined);
      },
    );
  },
);

/** A per-process label so reruns against one database never collide. */
function suffix(name: string): string {
  return createHash("sha256")
    .update(`${name}:${process.pid}:${Date.now()}`)
    .digest("hex")
    .slice(0, 10);
}
