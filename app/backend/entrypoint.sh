#!/bin/sh
# Container entrypoint.
#
# When LITESTREAM_REPLICA_URL is set (production / Azure Container Apps), the
# SQLite DB is first restored from blob storage, then the app runs *under*
# Litestream so every write is streamed back to blob and a final sync happens
# on shutdown (SIGTERM on a new revision). With the var unset (local Docker),
# the app just runs directly — no replication, nothing else changes.
set -e

CONFIG=/app/litestream.yml
DB_PATH=/app/data/ciq.db
APP_CMD="python3 -m gunicorn app:create_app -b 0.0.0.0:8000 --worker-class aiohttp.GunicornWebWorker"

if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  mkdir -p "$(dirname "$DB_PATH")"

  # Rebuild the DB from the latest blob snapshot + WAL. -if-replica-exists makes
  # the very first deploy (no backup yet) a no-op; the app then creates a fresh
  # DB via init_db. (restore won't overwrite an existing file, so the local
  # data/*.db is .dockerignored and never shipped in the image.)
  echo "[entrypoint] Restoring $DB_PATH from blob (if a prior backup exists)…"
  litestream restore -config "$CONFIG" -if-replica-exists "$DB_PATH"

  echo "[entrypoint] Starting Litestream replication + app…"
  exec litestream replicate -config "$CONFIG" -exec "$APP_CMD"
else
  echo "[entrypoint] LITESTREAM_REPLICA_URL not set — running app without replication."
  exec $APP_CMD
fi
