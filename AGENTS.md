# OAO agent instructions

## Scope

- Build the local MVP described in `docs/architecture.md`.
- Do not deploy cloud resources, open pull requests, or change external credentials.
- Keep PostgreSQL as the only application database.
- Preserve provider seams: Flue runtime, OpenRouter models, Daytona sandboxes, WorkOS authentication, S3 artifacts, and OTLP telemetry must remain replaceable adapters.

## Working rules

- Use TypeScript, ESM, Node.js 22.19+, pnpm, and Turbo.
- Keep domain packages independent from Hono, React, Flue, Railway, WorkOS, Daytona, and OpenRouter implementation types.
- Every tenant-owned database relation repeats organization/project identity in keys and foreign keys.
- Never expose secrets, authorization headers in logs, traces, list views, or SSE events.
- Every feature addition, behavior change, or feature removal must update the corresponding Mintlify documentation under `docs/` in the same change. Feature work is not complete until setup guides, examples, API/event contracts, limitations, and navigation accurately reflect the implemented behavior.
- Before finishing a documentation-affecting change, run `mint validate`, `mint broken-links`, and `mint a11y` from `docs/`, in addition to the relevant repository checks. When an authorized commit, upload, or PR includes a feature change, include its Mintlify documentation updates in that same change; do not leave documentation for a later follow-up.
- Run the relevant package tests, typecheck, lint, and build before finishing work.
- Do not commit generated secrets or local `.env` files.

## Package ownership

- Foundation: `packages/contracts`, `packages/domain`, `packages/db-postgres`, `packages/events`, `packages/testkit`, `infra/compose`.
- Runtime: `apps/runtime-worker`, `packages/runtime-flue`, `packages/queue-postgres`, `packages/tool-broker`, `packages/models-openrouter`, `packages/sandbox-daytona`.
- API/auth: `apps/api`, `packages/auth-core`, `packages/auth-workos`, `packages/artifact-s3`, `packages/sdk-js`.
- Console: `apps/console` only; consume public contracts and SDKs instead of importing database/runtime packages.
