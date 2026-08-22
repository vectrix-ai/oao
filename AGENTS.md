# OAO agent instructions

## Working rules

- Use TypeScript, ESM, Node.js 22.19+, pnpm, and Turbo.
- Keep domain packages independent from Hono, React, Flue, Railway, WorkOS, Daytona, and OpenRouter implementation types; consume providers through the ports in `@oao/domain` with adapters in their own packages.
- Every tenant-owned database relation repeats organization/project identity in keys and foreign keys, and tenant queries run through the RLS transaction helpers.
- Never expose secrets, authorization headers in logs, traces, list views, or SSE events. Provider credentials are write-only: encrypted at rest, returned only as fingerprint plus version.
- A public API change is a vertical slice: update `packages/contracts`, the endpoint in `apps/api`, `packages/sdk-js` (routes, client, types), the console (`src/api/types.ts` plus both the `http.ts` and `demo.ts` implementations, and the page), tests in each package, and `docs/reference/http-api.mdx` together.
- Every feature addition, behavior change, or feature removal must update the corresponding Mintlify documentation under `docs/` in the same change. Feature work is not complete until setup guides, examples, API/event contracts, limitations, and navigation accurately reflect the implemented behavior.
- Before finishing a documentation-affecting change, run `mint validate`, `mint broken-links`, and `mint a11y` from `docs/`, in addition to the relevant repository checks. When an authorized commit, upload, or PR includes a feature change, include its Mintlify documentation updates in that same change; do not leave documentation for a later follow-up.
- Run the relevant package tests, typecheck, lint, and build before finishing work (`pnpm check` covers the whole workspace; `pnpm turbo run typecheck test --filter <package>` scopes it).
- Integration suites require `DATABASE_URL` and skip silently without it. Run them through the disposable harnesses (`pnpm test:postgres:fresh`, `pnpm test:stack:fresh`), never against the persistent local development database — its volume holds real local data.
- Before committing, run `greptile review --agent`, review every finding, and fix findings that are correct.
- Do not commit generated secrets or local `.env` files.

## Package ownership

- Foundation: `packages/contracts`, `packages/domain`, `packages/db-postgres`, `packages/events`, `packages/testkit`, `infra/compose`.
- Runtime: `apps/runtime-worker`, `packages/runtime-flue`, `packages/queue-postgres`, `packages/tool-broker`, `packages/models-openrouter`, `packages/provider-credentials`, `packages/sandbox-daytona`.
- API/auth: `apps/api`, `packages/auth-core`, `packages/auth-workos`, `packages/artifact-s3`, `packages/sdk-js`.
- Console: `apps/console` only; consume public contracts and SDKs instead of importing database/runtime packages.
