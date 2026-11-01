import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPool, migrate } from "../../src/index.js";

const adminUrl = process.env.DATABASE_URL;
// The disposable harness exports the Cloud SQL-like migration login: it owns
// the database but is neither a superuser nor BYPASSRLS.
const runtimeUrl = process.env.OAO_TEST_RUNTIME_DATABASE_URL;
const migrations = fileURLToPath(new URL("../../migrations", import.meta.url));
const DESTINATION_MIGRATION = "0054_mcp_credential_destination.sql";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

test(
  "the destination migration pins existing MCP credentials from their policies",
  {
    skip:
      adminUrl && runtimeUrl
        ? false
        : "DATABASE_URL and OAO_TEST_RUNTIME_DATABASE_URL are required",
    timeout: 120_000,
  },
  async (t) => {
    assert.ok(adminUrl && runtimeUrl);
    const database = `oao_mcp_destination_${process.pid}`;
    const admin = createPool(adminUrl);
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`CREATE DATABASE ${database} OWNER oao_runtime`);
    const before = await mkdtemp(join(tmpdir(), "oao-migrations-"));
    const seed = createPool(withDatabase(adminUrl, database));
    const runtime = createPool(withDatabase(runtimeUrl, database));
    t.after(async () => {
      await runtime.end();
      await seed.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    });

    for (const name of await readdir(migrations))
      if (/^\d+_.+\.sql$/u.test(name) && name < DESTINATION_MIGRATION)
        await cp(join(migrations, name), join(before, name));
    await migrate(runtime, before);

    const organizationId = randomUUID();
    const principalId = randomUUID();
    await seed.query(
      "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'destination','Destination')",
      [organizationId],
    );
    const credentialVersions = new Map<string, string[]>();
    async function credential(
      key: string,
      versions: number,
      policies: readonly (readonly [origin: string, pathPrefix: string])[],
    ): Promise<void> {
      const credentialId = randomUUID();
      await seed.query(
        `INSERT INTO oao.mcp_credentials (
           organization_id,id,credential_key,display_name,credential_kind,
           header_name,created_by_principal_id
         ) VALUES ($1,$2,$3,$3,'static_bearer',NULL,$4)`,
        [organizationId, credentialId, key, principalId],
      );
      const ids: string[] = [];
      for (let version = 1; version <= versions; version += 1) {
        const versionId = randomUUID();
        ids.push(versionId);
        await seed.query(
          `INSERT INTO oao.mcp_credential_versions (
             organization_id,id,credential_id,version,encrypted_secret,
             encryption_nonce,encryption_tag,encryption_key_version,
             credential_fingerprint,created_by_principal_id
           ) VALUES ($1,$2,$3,$4,'\\x01',$5,$6,$4,$7,$8)`,
          [
            organizationId,
            versionId,
            credentialId,
            version,
            Buffer.alloc(12),
            Buffer.alloc(16),
            "0".repeat(64),
            principalId,
          ],
        );
      }
      await seed.query(
        "UPDATE oao.mcp_credentials SET active_version_id=$3 WHERE organization_id=$1 AND id=$2",
        [organizationId, credentialId, ids.at(-1)],
      );
      credentialVersions.set(key, ids);
      for (const [index, [origin, pathPrefix]] of policies.entries()) {
        const policyId = randomUUID();
        await seed.query(
          `INSERT INTO oao.mcp_credential_policies (
             organization_id,id,policy_key,display_name,created_by_principal_id
           ) VALUES ($1,$2,$3,$3,$4)`,
          [organizationId, policyId, `${key}-policy-${index}`, principalId],
        );
        await seed.query(
          `INSERT INTO oao.mcp_credential_policy_versions (
             organization_id,id,policy_id,version,credential_id,exact_origin,
             path_prefix,timeout_ms,maximum_response_bytes,content_hash,
             created_by_principal_id
           ) VALUES ($1,$2,$3,1,$4,$5,$6,30000,1048576,$7,$8)`,
          [
            organizationId,
            randomUUID(),
            policyId,
            credentialId,
            origin,
            pathPrefix,
            createHash("sha256").update(`${key}:${index}`).digest(),
            principalId,
          ],
        );
      }
    }
    await credential("one-policy", 2, [
      ["https://One.Example.test:443/", "/mcp"],
      ["https://one.example.test", "/mcp"],
    ]);
    await credential("same-origin", 1, [
      ["https://two.example.test", "/a"],
      ["https://two.example.test", "/b"],
    ]);
    await credential("two-origins", 1, [
      ["https://three.example.test", "/mcp"],
      ["https://four.example.test", "/mcp"],
    ]);
    await credential("no-policy", 1, []);
    await credential("string-prefix", 1, [
      ["https://five.example.test", "/mcp"],
    ]);
    await credential("legacy-sse", 1, [
      ["https://six.example.test", "/api/sse"],
    ]);
    // Servers the policies above already serve.
    async function serverVersion(
      endpointUrl: string,
      transport: "streamable_http" | "legacy_sse",
    ): Promise<void> {
      const serverId = randomUUID();
      await seed.query(
        `INSERT INTO oao.mcp_servers (
           organization_id,id,server_key,display_name,created_by_principal_id
         ) VALUES ($1,$2,$3,$3,$4)`,
        [
          organizationId,
          serverId,
          `server-${serverId.slice(0, 8)}`,
          principalId,
        ],
      );
      await seed.query(
        `INSERT INTO oao.mcp_server_versions (
           organization_id,id,server_id,version,endpoint_url,transport,
           content_hash,created_by_principal_id
         ) VALUES ($1,$2,$3,1,$4,$5,$6,$7)`,
        [
          organizationId,
          randomUUID(),
          serverId,
          endpointUrl,
          transport,
          createHash("sha256").update(endpointUrl).digest(),
          principalId,
        ],
      );
    }
    await serverVersion("https://one.example.test/mcp/v1", "streamable_http");
    await serverVersion("https://five.example.test/mcpx", "streamable_http");
    await serverVersion("https://six.example.test/api/sse", "legacy_sse");

    const result = await migrate(runtime);
    assert.equal(result.applied.at(0), DESTINATION_MIGRATION);
    assert.ok(result.applied.includes("0055_mcp_oauth_client_credentials.sql"));

    const pinned = await seed.query<{
      id: string;
      credential_kind: string;
      destination_origin: string | null;
      destination_path_prefix: string | null;
    }>(
      `SELECT id,credential_kind,destination_origin,destination_path_prefix
         FROM oao.mcp_credential_versions WHERE organization_id=$1`,
      [organizationId],
    );
    // 0055 copies each credential's kind onto its versions.
    assert.equal(pinned.rowCount, 7);
    assert.ok(
      pinned.rows.every((row) => row.credential_kind === "static_bearer"),
    );
    const destination = (key: string) =>
      credentialVersions
        .get(key)!
        .map((id) => pinned.rows.find((row) => row.id === id))
        .map((row) => [row?.destination_origin, row?.destination_path_prefix]);
    assert.deepEqual(destination("one-policy"), [
      ["https://one.example.test", "/mcp"],
      ["https://one.example.test", "/mcp"],
    ]);
    assert.deepEqual(destination("same-origin"), [
      ["https://two.example.test", "/"],
    ]);
    assert.deepEqual(destination("two-origins"), [[null, null]]);
    // "/mcp" served "/mcpx" as a string prefix, so the parent is pinned.
    assert.deepEqual(destination("string-prefix"), [
      ["https://five.example.test", "/"],
    ]);
    // A legacy SSE server may post messages to a sibling path.
    assert.deepEqual(destination("legacy-sse"), [
      ["https://six.example.test", "/api/"],
    ]);
    assert.deepEqual(destination("no-policy"), [[null, null]]);

    // Forced row-level security and immutability are back in force.
    const forced = await seed.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relnamespace='oao'::regnamespace
          AND relname IN (
            'mcp_credential_versions','mcp_credential_policy_versions',
            'mcp_server_versions'
          )
          AND relforcerowsecurity`,
    );
    assert.equal(forced.rowCount, 3);
    await assert.rejects(
      seed.query(
        "UPDATE oao.mcp_credential_versions SET destination_origin=NULL WHERE organization_id=$1",
        [organizationId],
      ),
    );
  },
);
