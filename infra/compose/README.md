# Local PostgreSQL

PostgreSQL 17 is the only application database in the local foundation profile. No hosted credentials are required.

```sh
pnpm dev:local
```

This single command starts PostgreSQL when needed, builds the workspace,
migrates and seeds the database, and launches the API, runtime worker, and Vite
console. It traps Ctrl-C and termination, stops every child, and calls `db:down`
only when it started PostgreSQL. Docker Desktop, Colima, or another
Docker-compatible daemon must already be running; OAO never starts or stops that
daemon.

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
Compose keeps the named data volume when the service is stopped.

For isolated clean-room checks, use `pnpm test:postgres:fresh` and
`pnpm test:stack:fresh`. The first applies migrations twice and runs all
database/runtime integration suites. The second launches the real API and
runtime processes and exercises two turns through the real console HTTP
adapter. Each command removes its temporary PostgreSQL container in an exit
trap, including after failure or interruption.
