# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

OAO is an open, self-hostable managed-agent platform built around Flue and PostgreSQL. `AGENTS.md` holds the canonical working rules; the essentials are folded in below.

## Commands

Node.js 22.19+, pnpm 10.27, Turbo. TypeScript ESM everywhere.

```sh
pnpm install
pnpm dev:local          # full local stack: starts/reuses Postgres 17 in Docker, migrates, seeds,
                        # runs API :3000, runtime worker :8788, console :8080
pnpm check              # format:check + lint + typecheck + unit tests + build (run before finishing)
pnpm db:migrate         # apply migrations (needs DATABASE_URL)
```

Scoped work (much faster than root runs):

```sh
pnpm turbo run typecheck test --filter @oao/api       # any package by name
pnpm --filter @oao/artifact-s3 test                   # node:test via tsx
pnpm --filter @oao/console test                       # vitest
```

Single test:

- Node packages use `node --import tsx --test`; run one file with `node --import tsx --test test/unit/foo.test.ts` from the package dir, or add `--test-name-pattern "name"`.
- Console uses Vitest: `pnpm --filter @oao/console test -- test/http.test.ts`.

Integration tests need `DATABASE_URL` pointing at a migrated Postgres and skip silently without it. Use the disposable harnesses rather than the persistent local DB (its volume holds real local data):

```sh
pnpm test:postgres:fresh   # fresh container: migrations twice, runtime-worker, db, api, tool-broker, sandbox suites
pnpm test:stack:fresh      # additionally boots real API + worker and drives the console HTTP adapter
```

The `runtime-worker` e2e suite is timing-sensitive; if it times out in `waitFor`, rerun before assuming your change broke it.

Docs (Mintlify) from `docs/`: `mint dev --port 3333`, and before finishing a docs-affecting change: `mint validate`, `mint broken-links`, `mint a11y`.

Before committing: `greptile review --agent`, review every finding, fix the correct ones.

## Non-negotiable working rules (from AGENTS.md)

- Every feature addition/change/removal must update the matching Mintlify docs under `docs/` in the same change — guides, API/event contracts, limitations, navigation. Feature work is not complete without it.
- Keep domain packages independent of Hono, React, Flue, Railway, WorkOS, Daytona, and OpenRouter implementation types. Providers are consumed through ports defined in `@oao/domain` (e.g. `ModelPort`, `SandboxPort`, `ArtifactStorePort`) with adapters in their own packages.
- Project-scoped relations repeat `organization_id`/`project_id` in keys and foreign keys; organization-shared resource families (API keys, model providers, storage providers, sandbox providers, MCP servers/credentials/policies) are keyed by `organization_id` alone with organization-wide RLS. All tenant queries run through `withTenantTransaction` (RLS).
- Never expose secrets or authorization headers in logs, traces, list views, or SSE events. Provider credentials are write-only: AES-256-GCM ciphertext in Postgres (`@oao/provider-credentials`), responses carry only fingerprint + version.
- The console (`apps/console`) consumes only public contracts and SDKs — never database or runtime packages.

## Architecture

Runtime topology: React/Vite console → Hono API (auth, tenancy, config, read models, SSE) → PostgreSQL ← Flue runtime worker (one active owner per submission; talks to OpenRouter/OpenAI/Anthropic and Daytona adapters). PostgreSQL is the only application database: control state, audit, product events, wake/lease queue, and Flue canonical state (`@flue/postgres`). S3-compatible object storage holds run attachments and workspace archives. See `docs/architecture.md` for the invariants list — read it before touching run lifecycle, tools, or workspaces.

Package layers (workspace `@oao/*`):

- **Foundation**: `contracts` (Valibot schemas, wire types, branded IDs), `domain` (state machines, authorization, provider ports, redaction), `db-postgres` (migrations in `migrations/*.sql`, RLS transactions, repositories), `events` (append/cursor/SSE primitives), `testkit` (deterministic doubles — test-only; there is no runnable fake provider profile).
- **Runtime**: `apps/runtime-worker`, `runtime-flue` (compiled ManagedAgent, Skill activation, delegation coordinator), `queue-postgres` (wake jobs/leases), `tool-broker` (caller tool claims/approvals), `models-openrouter`, `model-images` (sharp-based image detection and resizing for native model image input), `sandbox-daytona`, `provider-credentials`, `artifact-s3`.
- **API/auth**: `apps/api` (Hono REST/SSE — most routes live in one large `src/app.ts`), `auth-core`, `auth-workos`, `sdk-js` (public typed client mirroring every endpoint).
- **Console**: `apps/console` (React 19, React Router, TanStack Query). `src/api/types.ts` defines `ConsoleApi`, implemented twice: `http.ts` (real API) and `demo.ts` (in-browser demo data, the default unless `VITE_OAO_API_MODE=http`). New console features must be implemented in both and covered in `test/console.test.tsx` (renders the app against the demo API).

Core behavioral model:

- Runs are durable Postgres obligations processed at-least-once; writes require an `Idempotency-Key`, and admission/claims use leases + fencing tokens. At most one unsettled Flue submission per thread.
- Product events have per-aggregate sequences plus a serialized project position; SSE resumes from committed positions and LISTEN/NOTIFY is only a wake hint.
- A sandbox workspace is keyed by org/project/thread and reused across runs; after each completed run the whole workspace is re-tarred and overwrites `workspace-backups/threads/{threadId}/workspace.tar.gz` (single archive per thread, `generation` counter, sha256-verified restore). Run attachment bytes live only in object storage under `run-files/runs/{runId}/...`; OAO's tables keep manifests, never bytes. The one exception is the resized copy of an image attached for a vision model (`@oao/model-images`), which Flue keeps in its canonical attachment state.
- Agent versions, model presets, and Skill versions are immutable. Each Skill binding and delegate either pins an exact version or follows the latest published one; a root session resolves its whole delegate tree once at creation (`session_version_resolutions`), and delegated child sessions copy that record, so versions never change mid-session.
- Object keys in storage are tenant-scoped: `[prefix/]organizations/{org}/projects/{proj}/artifacts/{logicalKey}` with per-segment URI encoding; adapters verify tenant metadata on read and fail closed.

Cross-cutting change pattern: an API feature typically touches `apps/api/src/app.ts`, `packages/contracts`, `packages/sdk-js` (routes + client + types), the console (`types.ts`, `http.ts`, `demo.ts`, page), tests in each, and `docs/reference/http-api.mdx`.
