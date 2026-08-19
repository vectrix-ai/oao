# OAO agent instructions

## Scope

- Build the local MVP described in `docs/architecture.md`.
- Do not deploy cloud resources, open pull requests, or change external credentials.
- Keep PostgreSQL as the only application database.
- Preserve provider seams: Flue runtime, OpenRouter models, Daytona sandboxes, WorkOS authentication, S3 artifacts, and OTLP telemetry must remain replaceable adapters.

## Working rules

- Use TypeScript, ESM, Node.js 22.19+, pnpm, and Turbo.
- Keep domain packages independent from Hono, React, Flue, Railway, WorkOS, Daytona, and OpenRouter implementation types.
- Add migrations rather than editing an already-applied migration.
- Every tenant-owned database relation repeats organization/project identity in keys and foreign keys.
- Never expose raw reasoning, secrets, authorization headers, or unredacted tool payloads in logs, traces, list views, or SSE events.
- Run the relevant package tests, typecheck, lint, and build before finishing work.
- Do not commit generated secrets or local `.env` files.

## Package ownership

- Foundation: `packages/contracts`, `packages/domain`, `packages/db-postgres`, `packages/events`, `packages/testkit`, `infra/compose`.
- Runtime: `apps/runtime-worker`, `packages/runtime-flue`, `packages/queue-postgres`, `packages/tool-broker`, `packages/models-openrouter`, `packages/sandbox-daytona`.
- API/auth: `apps/api`, `packages/auth-core`, `packages/auth-workos`, `packages/artifact-s3`, `packages/sdk-js`.
- Console: `apps/console` only; consume public contracts and SDKs instead of importing database/runtime packages.
