# OAO MVP architecture

## Outcome

The local MVP lets an operator define a versioned managed agent, open a session, submit a run, observe the durable model/tool loop, respond to caller-owned tool requests and approvals, and inspect historical runs in a management console after process restarts.

PostgreSQL is the only application database. The default local profile uses deterministic fake identity, model, and sandbox adapters so the complete test suite does not require hosted services.

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
        |                                         +--> OpenRouter adapter / fake model
        |                                         +--> Daytona adapter / fake sandbox
        +--> S3-compatible artifacts              +--> caller tool/approval ledger

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

- `@oao/runtime-flue`: generic compiled `ManagedAgent`, pinned `@flue/postgres`, history projection.
- `@oao/queue-postgres`: PostgreSQL wake jobs and platform dispatch leases.
- `@oao/tool-broker`: caller requests/claims/results and single-approver gates.
- `@oao/models-openrouter`: immutable presets and OpenRouter provider construction.
- `@oao/sandbox-daytona`: committed Flue Daytona blueprint plus thread-workspace lifecycle, target diagnostics, and egress-policy manager.

### Product surfaces

- `@oao/api`: Hono REST, authentication, authorization, idempotency, SSE, private runtime proxy.
- `@oao/auth-core` and `@oao/auth-workos`: local principal/session model and WorkOS adapter.
- `@oao/console`: React 19, Vite, React Router, TanStack Query, and an accessible management/debug UI.
- `@oao/sdk`: generated/typed JavaScript client.

## Required console screens

- Agents list/detail, immutable versions, prompts, models, tools, and sandbox policy
- Sessions list with status, agent, usage, cost, creation and last activity
- Session detail with Transcript and Debug tabs
- Pending tool calls and approvals
- Errors, attempts/recovery, timing waterfall, usage/cost provenance, and redacted payload inspection
- Organization/project/API-key/member/settings screens
- Hosting diagnostics for local services and optional Railway/Daytona targets; no residency claim in MVP

## Authentication

Local development uses a deterministic development identity adapter. Hosted human login uses WorkOS AuthKit behind `AuthTenantAdapter`; API keys remain platform-owned. PostgreSQL is authoritative for memberships, roles, scopes, RLS context, and audit.

The runnable local topology uses a Hono REST/SSE API, a React/Vite console, and
the Flue runtime worker. `pnpm dev:local` migrates and seeds PostgreSQL before it
starts those three processes. Local fake model and sandbox adapters are the
default; hosted adapters are explicit opt-ins.

## Hosting posture

The product is local-first. A deployment may set `DAYTONA_TARGET` as a provider placement preference; omitting it uses Daytona's provider default. The MVP neither verifies nor claims residency. A strict placement policy, if required later, belongs in a deployment-policy layer with explicit verification and diagnostics.

The MVP publication contract accepts a single platform turn cap of 32 and rejects any other per-agent value. Runtime enforces that cap before provider calls. Each immutable agent snapshot also carries a durable product deadline; expiry aborts the Flue submission and settles the product run as `timed_out`.

Flue 2.0.3's in-process `stop()` aborts active tool executions and records that abort in conversation history. OAO therefore separates full idle-process disposal from process handoff: SIGTERM stops new wake intake, projections, and HTTP, preserves any live Flue lease without calling the aborting stop path, and exits so startup recovery can reclaim that same submission after the bounded 30-second lease. In-process hot restart with an active submission is intentionally unsupported.

## Implementation order

1. Foundation contracts, state machines, PostgreSQL schema, events, fakes, and Compose.
2. In parallel on that foundation: API/auth, runtime/tool/sandbox/model, and console vertical slices.
3. Integrate one complete run through API → PostgreSQL → runtime → fake model → transcript/SSE.
4. Add caller-tool and approval waits, crash recovery, cancellation, and history/debug surfaces.
5. Run unit, integration, recovery, browser, accessibility, and local Compose end-to-end tests.
