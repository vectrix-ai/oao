---
title: Architecture
description: Detailed PostgreSQL-only local MVP architecture, boundaries, state machines, and implementation order.
---

# OAO MVP architecture

## Outcome

The local MVP lets an operator define a versioned managed agent, open a session, submit a run, observe the durable model/tool loop, respond to caller-owned tool requests and approvals, and inspect historical runs in a management console after process restarts.

PostgreSQL is the only application database. Runnable environments require project-scoped model and Daytona providers. Deterministic provider doubles are confined to automated tests.

## Runtime topology

```text
React/Vite console
        |
        | HTTPS/JSON + resumable SSE
        v
Hono API --------------------------------------+
  auth, tenancy, config, read models           |
        |                                       | private runtime commands/stream proxy
        v                                       v
PostgreSQL <---------------------------- Flue runtime worker
  control + audit + product events        one active owner
  session summaries + wake/lease queue     ManagedAgent + durable tools
  @flue/postgres canonical state                 |
        |                                         +--> OpenRouter/OpenAI/Anthropic adapters
        |                                         +--> Daytona adapter
        +--> S3-compatible artifacts/workspaces   +--> caller tool/approval ledger

OTel SDK -> optional Collector -> configured OTLP backend
```

## Non-negotiable invariants

1. At most one Flue submission is admitted and unsettled per thread. Later runs remain queued in platform PostgreSQL.
2. Run creation returns only after a durable PostgreSQL obligation exists; no HTTP request remains open for the run lifetime.
3. Caller-owned tool requests, claims, approvals, results, and claim fences are durable PostgreSQL records. A submitted result is distinct from a result committed into Flue history.
4. Process work is at least once. Canonical commits use idempotency keys, leases, fencing tokens, immutable results, and downstream idempotency.
5. PostgreSQL product events use durable per-aggregate sequences and a serialized project position. SSE resumes from committed positions; LISTEN/NOTIFY is only a wake hint.
6. Browser clients never receive database credentials and never query Flue tables directly.
7. Raw sensitive payloads are encrypted or retained only inside the explicitly documented Flue storage boundary. List views, events, logs, and telemetry are redacted.
8. Cancellation of an unreserved queued run is database-only. Once admission becomes ambiguous or succeeds, cancellation completes keyed admission reconciliation, performs Flue abort, and waits for canonical settlement.
9. A sandbox workspace is keyed by organization, project, and platform thread. Successive submissions in that thread reuse the same workspace; Flue callback identifiers are correlation metadata, not lifecycle identity.
10. An awaited at-least-once finish hook overwrites the thread's latest tenant-scoped workspace archive. A replacement sandbox is not exposed until the recorded object passes tenant metadata, length, checksum, and archive validation.
11. Run attachment bytes live only in the project-scoped S3-compatible object
    store. PostgreSQL keeps the immutable run manifest and provider/object
    binding, never attachment bytes or extracted text. Runtime admission
    downloads the bound object and revalidates content type, byte length, and
    SHA-256 before copying it unchanged into Daytona. Product events, audit
    details, and transcript responses contain safe metadata only.
12. Skill definitions, version contents, lifecycle, agent-version bindings,
    and session bindings are tenant-scoped PostgreSQL records. Agent versions
    pin exact active Skill version IDs; session creation copies those bindings.
    Runtime admission revalidates lifecycle and canonical/file SHA-256 values,
    exposes only discovery metadata initially, and lets Flue load instructions
    and resources progressively. Mutable `.agents/skills` workspace discovery
    is excluded from the authoritative runtime path.
13. Agent versions pin exact named delegate versions. Every delegation creates
    a separate thread, session, Flue identity, and ordered child-run ledger,
    while an immutable thread binding points coordinator and child threads at
    one PostgreSQL-authoritative workspace identity. Tool replay is keyed and
    hashed; parent cancellation cascades to unsettled child runs.
14. Remote MCP access is pinned by immutable server, toolset, and credential
    policy versions. Session bindings copy those exact IDs. The runtime performs
    live authorization/lifecycle checks before decrypting a credential, and the
    egress broker injects it only for the policy's exact HTTPS origin and path
    prefix. MCP secrets never enter Flue state, prompts, events, logs, or the
    sandbox.

## Public run states

`queued`, `running`, `waiting_for_tool`, `waiting_for_approval`, `retry_scheduled`, `completed`, `failed`, `cancelled`, `timed_out`.

`retry_scheduled` is pre-admission only. Post-admission Flue retries remain a single product run in `running`.

## Application packages

### Foundation

- `@oao/contracts`: Valibot schemas, OpenAPI/event contracts, branded IDs and cursors.
- `@oao/domain`: state machines, policy types, authorization actions, provider ports.
- `@oao/db-postgres`: migrations, tenant/RLS context, repositories, transaction helpers.
- `@oao/events`: product event append/cursor/SSE primitives.
- `@oao/testkit`: deterministic providers and crash barriers.

### Runtime

- `@oao/runtime-flue`: generic compiled `ManagedAgent`, pinned `@flue/postgres`, verified PostgreSQL Skill registry, progressive Flue Skill activation, durable child-session coordinator, and history projection.
- `@oao/queue-postgres`: PostgreSQL wake jobs and platform dispatch leases.
- `@oao/tool-broker`: caller requests/claims/results and single-approver gates.
- `@oao/models-openrouter`: live OpenRouter/OpenAI/Anthropic catalog projections constrained by pinned runtime metadata, provider-neutral routing and generation-setting translation, project-scoped preset activation, and provider construction. The package name is retained while the adapter seam expands beyond OpenRouter.
- `@oao/provider-credentials`: AES-256-GCM encryption and decryption for tenant-scoped provider credentials. PostgreSQL stores ciphertext; the platform encryption key remains outside the database.
- `@oao/sandbox-daytona`: committed Flue Daytona blueprint plus thread-workspace lifecycle, project connection resolution, capability-filtered file/shell/browser tools, durable safe tool audit, target diagnostics, and egress-policy manager.
- `@oao/artifact-s3`: tenant-keyed S3 artifact adapter plus encrypted project storage resolution and latest-thread workspace backup records.
- `@oao/mcp-remote`: pinned MCP client adapter plus TLS-only, DNS/IP-pinned,
  exact-origin credential egress and bounded schema/result handling.

### Product surfaces

- `@oao/api`: Hono REST, authentication, authorization, idempotency, SSE, private runtime proxy.
- `@oao/auth-core` and `@oao/auth-workos`: local principal/session model and WorkOS adapter.
- `@oao/console`: React 19, Vite, React Router, TanStack Query, and an accessible management/debug UI.
- `@oao/sdk-js`: typed JavaScript client for the public HTTP/SSE API.

## Required console screens

- Skills list/detail, immutable packages and versions, and publication workflow
- Agents list/detail, immutable versions, prompts, models, exact Skill and delegate bindings, tools, and sandbox policy
- Project-scoped OpenRouter/OpenAI/Anthropic provider connections, write-only encrypted API keys, and approval of model presets from the matching provider catalog
- Project-scoped S3-compatible storage connections, automatic latest-thread workspace backup, and safe restore diagnostics
- Project-scoped remote MCP servers, write-only credentials, exact-origin
  policies, discovery snapshots, restricted toolsets, and agent bindings
- Sessions list with status, agent, usage, cost, creation and last activity
- Session detail with Transcript and Debug tabs plus persistent child-session links
- Pending tool calls and approvals
- Errors, attempts/recovery, timing waterfall, usage/cost provenance, and redacted payload inspection
- Organization/project/API-key/member/settings screens
- Hosting diagnostics for local services and optional Railway/Daytona targets; no residency claim in MVP

## Authentication

Local development uses a deterministic development identity adapter. Hosted human login uses WorkOS AuthKit behind `AuthTenantAdapter`; API keys remain platform-owned. PostgreSQL is authoritative for memberships, roles, scopes, RLS context, and audit.

The runnable local topology uses a Hono REST/SSE API, a React/Vite console, and
the Flue runtime worker. `pnpm dev:local` migrates and seeds PostgreSQL before it
starts those three processes. Operators must configure a project model provider,
approve a preset, configure Daytona, and publish an agent version against both.

## Hosting posture

The product is local-first. A project may store an encrypted Daytona connection
with an optional target preference and restricted-egress allowlist. Immutable
agent versions select that connection by key plus a network mode and exact
file, shell, and browser capabilities. The older deployment-wide
`DAYTONA_API_KEY`/`DAYTONA_TARGET` path remains a compatibility fallback.
Omitting a target uses Daytona's provider default. The MVP neither verifies nor
claims residency. A strict placement policy, if required later, belongs in a
deployment-policy layer with explicit verification and diagnostics.

The MVP publication contract accepts a single platform turn cap of 32 and rejects any other per-agent value. Runtime enforces that cap before provider calls. Each immutable agent snapshot also carries a durable product deadline; expiry aborts the Flue submission and settles the product run as `timed_out`.

Flue 2.0.3's in-process `stop()` aborts active tool executions and records that abort in conversation history. OAO therefore separates full idle-process disposal from process handoff: SIGTERM stops new wake intake, projections, and HTTP, preserves any live Flue lease without calling the aborting stop path, and exits so startup recovery can reclaim that same submission after the bounded 30-second lease. In-process hot restart with an active submission is intentionally unsupported.

## Implementation order

1. Foundation contracts, state machines, PostgreSQL schema, events, fakes, and Compose.
2. In parallel on that foundation: API/auth, runtime/tool/sandbox/model, and console vertical slices.
3. Integrate one complete run through API → PostgreSQL → runtime → configured model and Daytona providers → transcript/SSE.
4. Add caller-tool and approval waits, crash recovery, cancellation, and history/debug surfaces.
5. Run unit, integration, recovery, browser, accessibility, and local Compose end-to-end tests.
