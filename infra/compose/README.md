# Local PostgreSQL

PostgreSQL 17 is the only application database in the local foundation profile. No hosted credentials are required.

```sh
pnpm oao doctor
pnpm oao setup
```

The guided path validates system dependencies before installing or starting
anything, then creates a first sandbox-disabled agent using OpenRouter or
OpenAI. For manual process control, use:

```sh
pnpm dev:local
```

This single command starts PostgreSQL when needed, builds the workspace,
migrates the database, seeds the deterministic tenant only when
`AUTH_PROVIDER=development`, and launches the API, runtime worker, and Vite
console. Set `AUTH_PROVIDER=workos` with the required WorkOS values to disable
development login. The launcher traps Ctrl-C and termination, stops every
child, and calls `db:down` only when it started PostgreSQL. Docker Desktop,
Colima, or another Docker-compatible daemon must already be running; OAO never
starts or stops that daemon.

The persistent database can also be managed separately:

```sh
pnpm db:up
pnpm db:migrate
pnpm test:integration
pnpm db:down
```

`DATABASE_URL` defaults to
`postgresql://postgres:postgres@127.0.0.1:5432/oao` in `.env.example`. Set both
`OAO_POSTGRES_PORT` and the matching `DATABASE_URL` if port 5432 is occupied.
Both the Compose path and the Docker CLI fallback keep the same named
`oao-postgres-data` volume when the service is stopped, so agents, sessions,
transcripts, and debug history survive a full `dev:local` stop/start.

For isolated clean-room checks, use `pnpm test:postgres:fresh` and
`pnpm test:stack:fresh`. The first applies migrations twice and runs all
database/runtime integration suites. The second launches the real API and
runtime processes and verifies that the runnable stack fails closed without a
configured real model provider. Each command removes its temporary PostgreSQL
container in an exit trap, including after failure or interruption.
