#!/bin/sh
set -eu

container_name="oao-postgres-test-$$"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run -d --name "$container_name" \
  -e POSTGRES_DB=oao -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -P --health-cmd='pg_isready -U postgres -d oao' --health-interval=1s --health-timeout=3s --health-retries=60 \
  postgres:17-alpine >/dev/null

attempt=0
while [ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" != healthy ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    docker logs "$container_name"
    exit 1
  fi
  sleep 1
done

postgres_port=$(docker port "$container_name" 5432/tcp | head -n 1 | sed 's/.*://')
# Match Cloud SQL's PostgreSQL 17 privilege model: the application credential
# owns the database and can create roles, but it is not a true superuser.
docker exec "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "CREATE ROLE oao_runtime LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT PASSWORD 'oao_runtime'"
docker exec "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "ALTER DATABASE oao OWNER TO oao_runtime"

export DATABASE_URL="postgresql://oao_runtime:oao_runtime@127.0.0.1:${postgres_port}/oao"
pnpm --filter @oao/db-postgres migrate
pnpm --filter @oao/db-postgres migrate
# Run the recovery suite before other integration fixtures enqueue synthetic
# wakes. The worker claims globally by design, so sharing those fixture wakes
# would make its intentional lease-bound restart assertion order-dependent.
pnpm --filter @oao/runtime-worker test
pnpm --filter @oao/db-postgres test:integration
pnpm --filter @oao/api test:integration
pnpm --filter @oao/tool-broker test:integration
pnpm --filter @oao/sandbox-daytona test:integration
