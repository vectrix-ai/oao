# OAO

OAO is an open, self-hostable managed-agent platform built around Flue and PostgreSQL.

The first implementation target is a fully functional local environment. Railway, OpenRouter, Daytona, WorkOS, S3-compatible storage, and OTLP are adapters for later hosted operation; none is required to run the default local test suite.

## Foundation packages

- `@oao/contracts`: public Valibot schemas and wire types
- `@oao/domain`: branded IDs, authorization, run/admission rules, provider ports, and redaction
- `@oao/db-postgres`: executable migrations, RLS tenant transactions, typed repositories, ledgers, and audit/event storage
- `@oao/events`: atomic append contracts, resumable cursors, and wake-only notification boundaries
- `@oao/testkit`: deterministic identities, clocks, providers, and crash barriers
- `infra/compose`: local PostgreSQL 17 and a disposable fresh-database verification harness

## Planned local services

- React/Vite management and debugging console
- Hono REST/SSE API
- Flue runtime worker
- PostgreSQL canonical/control/read-model storage and wake queue
- MinIO-compatible artifact development service
- OpenTelemetry Collector development service
- Deterministic fake model, sandbox, and identity adapters

See [docs/architecture.md](docs/architecture.md) for boundaries and implementation order.

## Development

Node.js 22.19 or newer and pnpm 10.27 are required.

```sh
pnpm install
pnpm check
pnpm test:postgres:fresh
```

The last command starts an isolated PostgreSQL container, applies the migration twice, runs all database integration/race tests, and removes the container. See [infra/compose/README.md](infra/compose/README.md) for the persistent local database workflow.
