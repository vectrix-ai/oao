# OAO

OAO is an open, self-hostable managed-agent platform built around Flue and PostgreSQL.

The first implementation target is a fully functional local environment. Railway, OpenRouter, Daytona, WorkOS, S3-compatible storage, and OTLP are adapters for later hosted operation; none is required to run the default local test suite.

## Workspace

- `@oao/contracts`: public Valibot schemas and wire types
- `@oao/domain`: branded IDs, authorization, run/admission rules, provider ports, and redaction
- `@oao/db-postgres`: executable migrations, RLS tenant transactions, typed repositories, ledgers, and audit/event storage
- `@oao/events`: atomic append contracts, resumable cursors, and wake-only notification boundaries
- `@oao/testkit`: deterministic identities, clocks, providers, and crash barriers
- `infra/compose`: local PostgreSQL 17, the owned-process development launcher,
  and disposable fresh-database verification harnesses

The implemented local profile runs:

- React/Vite management and debugging console
- Hono REST/SSE API
- Flue runtime worker
- PostgreSQL canonical/control/read-model storage and wake queue
- Deterministic fake model, sandbox, and identity adapters

See [docs/architecture.md](docs/architecture.md) for boundaries and implementation order.

## Development

Node.js 22.19 or newer and pnpm 10.27 are required.

```sh
pnpm install
cp .env.example .env # optional; the checked-in local defaults work as-is
pnpm dev:local
```

`dev:local` requires a running Docker-compatible daemon. It does not start
Docker Desktop or Colima. The command starts PostgreSQL if necessary, builds the
workspace packages needed by the source watchers, applies migrations, seeds the
development tenant, and launches the API on port 3000, runtime worker on 8788,
and console on 5173. Open <http://127.0.0.1:5173>. Ctrl-C stops every child and
stops the PostgreSQL container only when this invocation started it.

The default profile explicitly uses `local-default` plus the fake sandbox and
does not need OpenRouter or Daytona credentials. `.env.example` documents the
separate opt-ins for hosted providers; `DAYTONA_TARGET` is optional and is not a
residency guarantee.

## Verification

```sh
pnpm check
pnpm test:postgres:fresh
pnpm test:stack:fresh
```

The fresh-PostgreSQL command runs the database and runtime integration/race
suites. The fresh-stack command additionally starts the real API and runtime
processes and drives the real console HTTP adapter through two durable turns.
Both commands use a PostgreSQL container on a random host port and always remove
it. See [infra/compose/README.md](infra/compose/README.md) for lifecycle details.

See [apps/api/README.md](apps/api/README.md) for the runnable API commands,
development/Vite proxy setup, exact authentication environment contract, WorkOS
callback/webhook URLs, and operator identity provisioning.
