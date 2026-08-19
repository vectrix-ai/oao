# Local PostgreSQL

PostgreSQL 17 is the only application database in the local foundation profile. No hosted credentials are required.

```sh
pnpm db:up
pnpm db:migrate
pnpm test:integration
pnpm db:down
```

`DATABASE_URL` defaults to `postgresql://postgres:postgres@localhost:5432/oao` in `.env.example`. Set `OAO_POSTGRES_PORT` before `db:up` if port 5432 is occupied, and set the matching `DATABASE_URL` for migration/tests.

For an isolated clean-room check, run `pnpm test:postgres:fresh`. It starts a temporary PostgreSQL container on a random host port, applies the migration twice to verify idempotency, executes the database integration suite, and always removes the container.
