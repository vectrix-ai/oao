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

# Exercise the exact non-superuser runtime boundary before test-only admin
# fixtures are introduced. The UUIDs need not exist: tenant context is a
# transaction-local RLS input, not an authorization lookup.
docker exec "$container_name" psql -v ON_ERROR_STOP=1 -U oao_runtime -d oao \
  -c "BEGIN; SET LOCAL ROLE oao_app; SELECT oao.set_tenant_context('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'); ROLLBACK; SELECT * FROM oao.list_runtime_recovery_heads(); SELECT oao.runtime_has_active_dispatches(); SELECT * FROM oao.find_runtime_dispatch('','');"

# The integration suites seed and inspect fixtures outside application RLS.
# Keep that test-only access separate while the worker continues to use the
# Cloud SQL-like runtime login above.
export OAO_TEST_ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${postgres_port}/oao"
pnpm --filter @oao/runtime-worker test
export DATABASE_URL="$OAO_TEST_ADMIN_DATABASE_URL"
unset OAO_TEST_ADMIN_DATABASE_URL
pnpm --filter @oao/db-postgres test:integration
pnpm --filter @oao/api test:integration
pnpm --filter @oao/tool-broker test:integration
pnpm --filter @oao/sandbox-daytona test:integration
