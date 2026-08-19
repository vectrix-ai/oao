#!/bin/sh
set -eu

if docker compose version >/dev/null 2>&1; then
  exec docker compose -f infra/compose/docker-compose.yml up -d --wait
fi
if command -v docker-compose >/dev/null 2>&1; then
  exec docker-compose -f infra/compose/docker-compose.yml up -d --wait
fi

container_name=oao-postgres-local
if docker container inspect "$container_name" >/dev/null 2>&1; then
  docker start "$container_name" >/dev/null
else
  docker run -d --name "$container_name" \
    -e POSTGRES_DB=oao -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
    -p "${OAO_POSTGRES_PORT:-5432}:5432" \
    --health-cmd='pg_isready -U postgres -d oao' --health-interval=2s --health-timeout=3s --health-retries=30 \
    postgres:17-alpine >/dev/null
fi

attempt=0
while [ "$(docker inspect --format '{{.State.Health.Status}}' "$container_name")" != healthy ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    docker logs "$container_name"
    exit 1
  fi
  sleep 1
done
