#!/bin/sh
set -eu

case "${1:-api}" in
  api)
    cd /app/apps/api
    exec node dist/server.js
    ;;
  worker)
    cd /app/apps/runtime-worker
    exec node dist/main.js
    ;;
  *)
    exec "$@"
    ;;
esac
