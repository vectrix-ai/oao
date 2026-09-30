import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createPool,
  PostgresEventAppender,
  withTenantTransaction,
} from "@oao/db-postgres";
import type { EventId, OrganizationId, ProjectId } from "@oao/domain";
import { ProviderCredentialCipher } from "@oao/provider-credentials";
import {
  createWebhookTransport,
  EventWebhookDispatcher,
  generateWebhookSecret,
  PostgresEventWebhookStore,
  verifyWebhookSignature,
  type ClaimedEventWebhook,
  type WebhookProductEvent,
} from "../../src/index.js";

const runtimeUrl =
  process.env.OAO_TEST_RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL;
const adminUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;

const organization = "00000000-0000-4000-8000-00000000e001" as OrganizationId;
const projectA = "00000000-0000-4000-8000-00000000e002" as ProjectId;
const projectB = "00000000-0000-4000-8000-00000000e003" as ProjectId;
const principal = "00000000-0000-4000-8000-00000000e004";
const agent = "00000000-0000-4000-8000-00000000e005";
const version = "00000000-0000-4000-8000-00000000e006";
const thread = "00000000-0000-4000-8000-00000000e007";
const session = "00000000-0000-4000-8000-00000000e008";
const run = "00000000-0000-4000-8000-00000000e009";
const userMessage = "00000000-0000-4000-8000-00000000e010";
const assistantMessage = "00000000-0000-4000-8000-00000000e011";
const tenantA = { organizationId: organization, projectId: projectA };
const tenantB = { organizationId: organization, projectId: projectB };
const cipher = new ProviderCredentialCipher(Buffer.alloc(32, 7));

test(
  "PostgreSQL event webhook delivery store",
  { skip: runtimeUrl && adminUrl ? false : "DATABASE_URL is required" },
  async (t) => {
    assert.ok(runtimeUrl && adminUrl);
    const admin = createPool(adminUrl);
    const runtime = createPool(runtimeUrl);
    const store = new PostgresEventWebhookStore(runtime);
    const appender = new PostgresEventAppender();
    let sequence = 0;
    const append = (
      tenant: typeof tenantA,
      kind: string,
      aggregateType: string,
      aggregateId: string,
      publicPayload: Record<string, string | number> = {},
    ) =>
      withTenantTransaction(runtime, tenant, (transaction) =>
        appender.append(transaction, {
          id: randomUUID() as EventId,
          ...tenant,
          aggregateType,
          aggregateId,
          kind,
          publicPayload,
          occurredAt: new Date(Date.UTC(2026, 8, 29, 12, 0, sequence++)),
        }),
      );
    const insertWebhook = async (
      tenant: typeof tenantA,
      input: {
        readonly id?: string;
        readonly url?: string;
        readonly enabled?: boolean;
        readonly includeMessageContent?: boolean;
        readonly eventKinds?: readonly string[] | null;
        readonly deliveredPosition?: bigint;
        readonly secret?: string;
      } = {},
    ) => {
      const id = input.id ?? randomUUID();
      const encrypted = cipher.encrypt(
        input.secret ?? generateWebhookSecret(),
        {
          organizationId: tenant.organizationId,
          providerId: id,
          providerType: "event_webhook",
          keyVersion: 1,
        },
      );
      await admin.query(
        `INSERT INTO oao.event_webhooks (
           organization_id,project_id,id,display_name,endpoint_url,enabled,disabled_reason,
           event_kinds,include_message_content,encrypted_signing_key,encryption_nonce,
           encryption_tag,encryption_key_version,credential_fingerprint,delivered_position,
           created_by_principal_id)
         VALUES ($1,$2,$3,'Receiver',$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,$14)`,
        [
          tenant.organizationId,
          tenant.projectId,
          id,
          input.url ?? "https://receiver.example.com/oao",
          input.enabled ?? true,
          input.enabled === false ? "user" : null,
          input.eventKinds ?? null,
          input.includeMessageContent ?? false,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          encrypted.fingerprint,
          (input.deliveredPosition ?? 0n).toString(),
          principal,
        ],
      );
      return id;
    };
    const claimFor = async (
      webhookId: string,
    ): Promise<ClaimedEventWebhook> => {
      const claims = await store.claim({
        workerId: "worker-a",
        limit: 10,
        leaseMs: 30_000,
      });
      const found = claims.find((claim) => claim.webhookId === webhookId);
      assert.ok(found, `expected a claim for ${webhookId}`);
      return found;
    };
    const row = async (webhookId: string) =>
      (
        await admin.query(
          `SELECT delivered_position::text,batch_id,batch_through_position::text,consecutive_failures,
                  enabled,disabled_reason,lease_owner,last_error_code,last_response_status,
                  next_attempt_at>clock_timestamp() AS backing_off
             FROM oao.event_webhooks WHERE id=$1`,
          [webhookId],
        )
      ).rows[0] as Record<string, unknown>;

    try {
      await admin.query(
        "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'webhook-org','Webhook org')",
        [organization],
      );
      await admin.query(
        "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'hooks-a','A'),($1,$3,'hooks-b','B')",
        [organization, projectA, projectB],
      );
      await admin.query(
        "INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes) VALUES ($1,$2,$3,'human','hooks-user',ARRAY['*'])",
        [organization, projectA, principal],
      );
      await admin.query(
        "INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name) VALUES ($1,$2,$3,'hooks','Hooks')",
        [organization, projectA, agent],
      );
      await admin.query(
        `INSERT INTO oao.agent_versions (organization_id,project_id,id,agent_definition_id,version,config,content_hash,created_by_principal_id)
         VALUES ($1,$2,$3,$4,1,'{}',digest('hooks','sha256'),$5)`,
        [organization, projectA, version, agent, principal],
      );
      await admin.query(
        "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,'Hooks')",
        [organization, projectA, thread],
      );
      await admin.query(
        "INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id) VALUES ($1,$2,$3,$4,$5)",
        [organization, projectA, session, thread, version],
      );
      await admin.query(
        `INSERT INTO oao.runs (organization_id,project_id,id,thread_id,session_id,agent_version_id,created_by_principal_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'hooks-run')`,
        [organization, projectA, run, thread, session, version, principal],
      );
      await admin.query(
        `INSERT INTO oao.messages (organization_id,project_id,id,thread_id,run_id,role,redacted_content)
         VALUES ($1,$2,$3,$4,$5,'user','What is the ETA?'),($1,$2,$6,$4,$5,'assistant','Tomorrow at 10:00.')`,
        [organization, projectA, userMessage, thread, run, assistantMessage],
      );

      await t.test(
        "claims only enabled, due endpoints with undelivered events",
        async () => {
          const active = await insertWebhook(tenantA, {
            includeMessageContent: true,
          });
          const disabled = await insertWebhook(tenantA, { enabled: false });
          await append(tenantA, "message.created", "thread", thread, {
            messageId: userMessage,
            runId: run,
            role: "user",
            fileCount: 0,
          });
          await append(tenantA, "run.state_changed", "run", run, {
            state: "running",
          });
          await append(tenantA, "message.created", "run", run, {
            role: "assistant",
          });
          await append(tenantB, "run.state_changed", "run", randomUUID(), {
            state: "running",
          });
          const caughtUp = await insertWebhook(tenantB, {
            deliveredPosition: 1n,
          });

          const claims = await store.claim({
            workerId: "worker-a",
            limit: 10,
            leaseMs: 30_000,
          });
          assert.deepEqual(
            claims.map((claim) => claim.webhookId),
            [active],
          );
          assert.ok(
            !claims.some((claim) =>
              [disabled, caughtUp].includes(claim.webhookId),
            ),
          );
          // A held lease is not claimable by another worker.
          assert.deepEqual(
            await store.claim({
              workerId: "worker-b",
              limit: 10,
              leaseMs: 30_000,
            }),
            [],
          );
          const claim = claims[0];
          assert.ok(claim);

          const work = await store.load(claim, "worker-a", 100);
          assert.ok(work);
          assert.equal(work.deliveredPosition, 0n);
          assert.equal(work.signingKeys.length, 1);
          assert.deepEqual(
            work.events.map((event) => [event.projectPosition, event.kind]),
            [
              ["1", "message.created"],
              ["2", "run.state_changed"],
              ["3", "message.created"],
            ],
          );
          const messages = work.events.map(
            (event: WebhookProductEvent) => event.message,
          );
          assert.deepEqual(messages[0], {
            id: userMessage,
            runId: run,
            role: "user",
            content: "What is the ETA?",
          });
          assert.equal(messages[1], undefined);
          assert.equal(messages[2]?.content, "Tomorrow at 10:00.");
          assert.equal(messages[2]?.id, assistantMessage);
          // A different worker, or a stale fence, cannot read or write the endpoint.
          assert.equal(await store.load(claim, "worker-b", 100), undefined);
          assert.equal(
            await store.load(
              { ...claim, leaseFence: claim.leaseFence + 1n },
              "worker-a",
              100,
            ),
            undefined,
          );

          const batch = { id: randomUUID(), throughPosition: 3n };
          assert.equal(
            await store.startBatch(claim, "worker-a", batch, 1n),
            false,
          );
          assert.equal(
            await store.startBatch(claim, "worker-a", batch, 0n),
            true,
          );
          const retried = await store.load(claim, "worker-a", 1);
          assert.deepEqual(retried?.batch, batch);
          assert.equal(
            retried?.events.length,
            3,
            "a pending batch reloads its full range",
          );

          assert.equal(
            await store.finish(
              { ...claim, leaseFence: claim.leaseFence + 1n },
              "worker-a",
              {
                kind: "delivered",
                batchId: batch.id,
                responseStatus: 200,
              },
            ),
            false,
          );
          assert.equal(
            await store.finish(claim, "worker-a", {
              kind: "delivered",
              batchId: batch.id,
              responseStatus: 204,
            }),
            true,
          );
          assert.deepEqual(await row(active), {
            delivered_position: "3",
            batch_id: null,
            batch_through_position: null,
            consecutive_failures: 0,
            enabled: true,
            disabled_reason: null,
            lease_owner: null,
            last_error_code: null,
            last_response_status: 204,
            backing_off: false,
          });
          assert.deepEqual(
            (
              await store.claim({
                workerId: "worker-a",
                limit: 10,
                leaseMs: 30_000,
              })
            ).map((next) => next.webhookId),
            [],
            "a caught-up endpoint is not claimed",
          );
          await admin.query(
            "DELETE FROM oao.event_webhooks WHERE organization_id=$1",
            [organization],
          );
        },
      );

      await t.test(
        "failures back off, keep the batch, and 410 disables the endpoint",
        async () => {
          const webhook = await insertWebhook(tenantA, {
            deliveredPosition: 3n,
          });
          await append(tenantA, "run.state_changed", "run", run, {
            state: "completed",
          });
          let claim = await claimFor(webhook);
          const batch = { id: randomUUID(), throughPosition: 4n };
          assert.equal(
            await store.startBatch(claim, "worker-a", batch, 3n),
            true,
          );
          assert.equal(
            await store.finish(claim, "worker-a", {
              kind: "failed",
              errorCode: "http_status",
              responseStatus: 503,
              retryAfterMs: 60_000,
              disable: false,
            }),
            true,
          );
          assert.deepEqual(
            { ...(await row(webhook)) },
            {
              delivered_position: "3",
              batch_id: batch.id,
              batch_through_position: "4",
              consecutive_failures: 1,
              enabled: true,
              disabled_reason: null,
              lease_owner: null,
              last_error_code: "http_status",
              last_response_status: 503,
              backing_off: true,
            },
          );
          assert.deepEqual(
            await store.claim({
              workerId: "worker-a",
              limit: 10,
              leaseMs: 30_000,
            }),
            [],
          );
          await admin.query(
            "UPDATE oao.event_webhooks SET next_attempt_at=clock_timestamp() WHERE id=$1",
            [webhook],
          );
          claim = await claimFor(webhook);
          assert.deepEqual(
            (await store.load(claim, "worker-a", 100))?.batch,
            batch,
          );
          assert.equal(
            await store.finish(claim, "worker-a", {
              kind: "failed",
              errorCode: "endpoint_gone",
              responseStatus: 410,
              retryAfterMs: 0,
              disable: true,
            }),
            true,
          );
          const disabled = await row(webhook);
          assert.equal(disabled.enabled, false);
          assert.equal(disabled.disabled_reason, "endpoint_gone");
          assert.equal(disabled.consecutive_failures, 2);
          assert.deepEqual(
            await store.claim({
              workerId: "worker-a",
              limit: 10,
              leaseMs: 30_000,
            }),
            [],
          );
          await admin.query(
            "DELETE FROM oao.event_webhooks WHERE organization_id=$1",
            [organization],
          );
        },
      );

      await t.test(
        "tenant transactions see only their own project's endpoints",
        async () => {
          await insertWebhook(tenantA);
          await insertWebhook(tenantB);
          const visible = await withTenantTransaction(
            runtime,
            tenantB,
            (transaction) =>
              transaction.query("SELECT project_id FROM oao.event_webhooks"),
          );
          assert.deepEqual(
            visible.rows.map(
              (entry) => (entry as { project_id: string }).project_id,
            ),
            [projectB],
          );
          await admin.query(
            "DELETE FROM oao.event_webhooks WHERE organization_id=$1",
            [organization],
          );
        },
      );

      await t.test(
        "the dispatcher delivers signed batches with message content end to end",
        async () => {
          const secret = generateWebhookSecret();
          const received: { headers: Record<string, string>; body: string }[] =
            [];
          const server = createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => (body += chunk));
            request.on("end", () => {
              received.push({
                headers: request.headers as Record<string, string>,
                body,
              });
              response.writeHead(received.length === 1 ? 503 : 204);
              response.end();
            });
          });
          await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
          );
          const { port } = server.address() as AddressInfo;
          const webhook = await insertWebhook(tenantA, {
            url: `http://127.0.0.1:${port}/oao`,
            includeMessageContent: true,
            eventKinds: ["message.created"],
            secret,
          });
          const dispatcher = new EventWebhookDispatcher({
            store,
            workerId: "worker-e2e",
            transport: createWebhookTransport({ allowPrivateNetwork: true }),
            decryptSigningKey: (key, context) =>
              cipher.decrypt(key, {
                organizationId: context.organizationId,
                providerId: context.webhookId,
                providerType: "event_webhook",
              }),
            retryPolicy: { baseDelayMs: 1, maxDelayMs: 1, random: () => 0 },
          });
          try {
            assert.equal(await dispatcher.runOnce(), 1);
            assert.equal((await row(webhook)).last_response_status, 503);
            await admin.query(
              "UPDATE oao.event_webhooks SET next_attempt_at=clock_timestamp() WHERE id=$1",
              [webhook],
            );
            assert.equal(await dispatcher.runOnce(), 1);
          } finally {
            server.close();
          }
          assert.equal(received.length, 2);
          const [first, second] = received;
          assert.ok(first && second);
          assert.equal(
            first.headers["webhook-id"],
            second.headers["webhook-id"],
            "a retry keeps its id",
          );
          assert.equal(
            verifyWebhookSignature({
              webhookId: second.headers["webhook-id"] ?? "",
              timestamp: Number(second.headers["webhook-timestamp"]),
              body: second.body,
              signatureHeader: second.headers["webhook-signature"] ?? "",
              secret,
            }),
            true,
          );
          const payload = JSON.parse(second.body);
          assert.equal(payload.type, "oao.events");
          assert.equal(payload.data.webhookId, webhook);
          assert.deepEqual(
            payload.data.events.map((event: WebhookProductEvent) => [
              event.kind,
              event.message?.content,
            ]),
            [
              ["message.created", "What is the ETA?"],
              ["message.created", "Tomorrow at 10:00."],
            ],
          );
          assert.equal(payload.data.throughPosition, "4");
          assert.equal((await row(webhook)).delivered_position, "4");
        },
      );
    } finally {
      await admin
        .query("DELETE FROM oao.organizations WHERE id=$1", [organization])
        .catch(() => undefined);
      await runtime.end();
      await admin.end();
    }
  },
);
