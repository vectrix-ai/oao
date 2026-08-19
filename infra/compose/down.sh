#!/bin/sh
set -eu

if docker compose version >/dev/null 2>&1; then
  exec docker compose -f infra/compose/docker-compose.yml down
fi
if command -v docker-compose >/dev/null 2>&1; then
  exec docker-compose -f infra/compose/docker-compose.yml down
fi

container_name=oao-postgres-local
if docker container inspect "$container_name" >/dev/null 2>&1; then
  docker stop "$container_name" >/dev/null
  docker rm "$container_name" >/dev/null
fi
