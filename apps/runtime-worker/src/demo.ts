import { createHash } from "node:crypto";
import { withTenantTransaction } from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
} from "@oao/domain";
import { startRuntimeWorker } from "./main.js";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001" as OrganizationId,
  project: "10000000-0000-4000-8000-000000000002" as ProjectId,
  principal: "10000000-0000-4000-8000-000000000003" as PrincipalId,
  service: "00000000-0000-4000-8000-000000000099" as PrincipalId,
  agent: "10000000-0000-4000-8000-000000000004",
  version: "10000000-0000-4000-8000-000000000005",
  thread: "10000000-0000-4000-8000-000000000006",
  session: "10000000-0000-4000-8000-000000000007",
  run: "10000000-0000-4000-8000-000000000008" as RunId,
  wake: "10000000-0000-4000-8000-000000000009",
} as const;

const snapshot = {
  systemPrompt: "Reply with the deterministic local response.",
  modelPreset: "local-default",
  tools: [],
  sandbox: { enabled: true, network: "none" },
  limits: { maxTurns: 32, timeoutMs: 60_000 },
};

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const worker = await startRuntimeWorker({ databaseUrl, listen: false });
  try {
    const pool = worker.pool;
    await pool.query(
      `INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'demo-runtime','Demo runtime')
       ON CONFLICT (id) DO NOTHING`,
      [ids.organization],
    );
    await pool.query(
      `INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'demo','Demo')
       ON CONFLICT (organization_id,id) DO NOTHING`,
      [ids.organization, ids.project],
    );
    await pool.query(
      `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes) VALUES
       ($1,$2,$3,'human','demo',ARRAY['*']),($1,$2,$4,'service','runtime',ARRAY['*'])
       ON CONFLICT (organization_id,project_id,id) DO NOTHING`,
      [ids.organization, ids.project, ids.principal, ids.service],
    );
    await pool.query(
      `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
       VALUES ($1,$2,$3,'demo-agent','Demo agent') ON CONFLICT DO NOTHING`,
      [ids.organization, ids.project, ids.agent],
    );
    const config = JSON.stringify(snapshot);
    await pool.query(
      `INSERT INTO oao.agent_versions (
        organization_id,project_id,id,agent_definition_id,version,config,content_hash,created_by_principal_id
       ) VALUES ($1,$2,$3,$4,1,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        ids.organization,
        ids.project,
        ids.version,
        ids.agent,
        config,
        createHash("sha256").update(config).digest(),
        ids.principal,
      ],
    );
    await pool.query(
      `INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'Demo')
       ON CONFLICT DO NOTHING`,
      [ids.organization, ids.project, ids.thread],
    );
    await pool.query(
      `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [ids.organization, ids.project, ids.session, ids.thread, ids.version],
    );
    await pool.query(
      `INSERT INTO oao.runs (
        organization_id,project_id,id,thread_id,session_id,agent_version_id,
        created_by_principal_id,idempotency_key,input_public
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'demo-runtime-run',$8) ON CONFLICT DO NOTHING`,
      [
        ids.organization,
        ids.project,
        ids.run,
        ids.thread,
        ids.session,
        ids.version,
        ids.principal,
        { message: "Run the deterministic local demo." },
      ],
    );
    await withTenantTransaction(
      pool,
      { organizationId: ids.organization, projectId: ids.project },
      (transaction) =>
        worker.queue.enqueue(transaction, {
          organizationId: ids.organization,
          projectId: ids.project,
          id: ids.wake,
          runId: ids.run,
          dispatchKey: `admit:${ids.run}`,
          kind: "admit",
          payload: { reason: "demo" },
        }),
    );
    const deadline = Date.now() + 15_000;
    for (;;) {
      const result = await pool.query<{ state: string }>(
        "SELECT state FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [ids.organization, ids.project, ids.run],
      );
      const state = result.rows[0]?.state;
      if (
        ["completed", "failed", "cancelled", "timed_out"].includes(state ?? "")
      ) {
        const messages = await pool.query<{
          role: string;
          redacted_content: string;
        }>(
          "SELECT role,redacted_content FROM oao.messages WHERE organization_id=$1 AND project_id=$2 AND run_id=$3 ORDER BY created_at",
          [ids.organization, ids.project, ids.run],
        );
        process.stdout.write(
          `${JSON.stringify({ runId: ids.run, state, messages: messages.rows })}\n`,
        );
        if (state !== "completed") process.exitCode = 1;
        break;
      }
      if (Date.now() >= deadline)
        throw new Error("Fake run did not settle before timeout");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await worker.stop();
  }
}

await run();
