# OAO API

The API is a Node/Hono service backed by PostgreSQL. It supports one explicit
authentication provider per process.

## Development authentication

```sh
AUTH_PROVIDER=development \
NODE_ENV=development \
APP_ORIGIN=http://localhost:5173 \
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/oao \
pnpm --filter @oao/api dev
```

Development mode applies migrations, idempotently seeds the deterministic local
organization/project/principal, and permits non-`Secure` HttpOnly cookies only
because `NODE_ENV=development` and the callback is explicit HTTP. A Vite frontend
should proxy `/v1` to `http://127.0.0.1:3000`; browser requests then remain
same-origin at `http://localhost:5173` and satisfy CSRF checks without CORS or
database credentials in the browser.

## WorkOS AuthKit

```sh
AUTH_PROVIDER=workos \
NODE_ENV=production \
APP_ORIGIN=https://app.example.com \
DATABASE_URL=postgresql://... \
API_KEY_PEPPER=... \
WORKOS_API_KEY=... \
WORKOS_CLIENT_ID=... \
WORKOS_COOKIE_PASSWORD=... \
WORKOS_WEBHOOK_SECRET=... \
WORKOS_CALLBACK_URL=https://app.example.com/v1/auth/callback \
pnpm --filter @oao/api start
```

Environment contract:

- `AUTH_PROVIDER`: `development` (default) or `workos`.
- `APP_ORIGIN`: comma-separated exact HTTP(S) origin allowlist. The first is the
  post-login/logout application origin. HTTP is accepted only with explicit
  `NODE_ENV=development`.
- `DATABASE_URL`: PostgreSQL connection string.
- `PORT`: optional, defaults to `3000`.
- `API_KEY_PEPPER`: required outside local development.
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD` (at least 32
  characters), `WORKOS_WEBHOOK_SECRET`: required only for WorkOS.
- `WORKOS_CALLBACK_URL`: must be an `APP_ORIGIN` URL with the exact path
  `/v1/auth/callback`.

Configure these exact provider endpoints:

- AuthKit callback: `https://app.example.com/v1/auth/callback`
- WorkOS webhook: `https://app.example.com/v1/auth/workos/webhook`

The login route generates server-owned state in an HttpOnly cookie. The callback
validates that state, exchanges the code with the official `@workos-inc/node`
SDK, writes sealed session cookies, and responds `303` to the first
`APP_ORIGIN`. Caller-provided callback and return URLs are rejected or ignored.
Webhook signatures are verified from exact raw bytes by
`workos.webhooks.constructEvent` before durable deduplication and reconciliation.

WorkOS mode never runs the development seed and never creates a tenant on first
login. Provision a verified WorkOS user and organization onto an existing OAO
principal/membership with this credential-free, idempotent operator command:

```sh
DATABASE_URL=postgresql://... \
OAO_ORGANIZATION_ID=00000000-0000-4000-8000-000000000001 \
OAO_PROJECT_ID=00000000-0000-4000-8000-000000000002 \
OAO_PRINCIPAL_ID=00000000-0000-4000-8000-000000000003 \
WORKOS_USER_ID=user_... \
WORKOS_ORGANIZATION_ID=org_... \
WORKOS_USER_EMAIL=user@example.com \
pnpm --filter @oao/api provision:workos
```

The command refuses missing OAO tenants, principals, or project memberships and
refuses remapping an existing WorkOS tenant or user to a different target.

## Runtime wake integration

Run create, resume, and cancellation call `RuntimeCommandPort` inside the same
transaction as the run/control write. `PostgresRuntimeCommandPort` is pinned to
runtime migration `0004_runtime.sql` and calls:

```sql
oao.enqueue_runtime_wake(
  organization_id, project_id, wake_id, run_id, dispatch_key,
  request_hash, kind, payload_public, available_at
)
```

Submit/resume use `kind='admit'` and `dispatch_key='admit:<runId>'`; cancellation
uses `kind='cancel'` and `dispatch_key='cancel:<runId>'`. Wake IDs are
deterministic, hashes use the same canonical algorithm as
`@oao/queue-postgres`, and payloads contain only a public reason. Until runtime
migration `0004` is merged into the same branch, health/auth/read routes run but
run writes intentionally fail rather than return `202` without a durable wake.
