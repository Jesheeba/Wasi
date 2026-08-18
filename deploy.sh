#!/usr/bin/env bash
# Deploy Wasi CRM: build -> migrate (gated) -> restart, in that order.
#
# The gate: migrations run in a throwaway container from the image just
# built. If that exits non-zero, the script exits before touching the
# running container, so a bad migration can't take down a working
# deployment — the old container just keeps serving traffic on the old
# schema until someone fixes the migration and re-runs this script.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Building image"
docker compose build wasi-crm

echo "==> Running migrations (gate: deploy aborts on failure, current container untouched)"
if ! docker compose run --rm wasi-crm npx node-pg-migrate up -m src/db/migrations; then
  echo "!! Migration failed — deploy aborted. Nothing was restarted." >&2
  exit 1
fi

echo "==> Migrations OK — starting/restarting the app"
docker compose up -d --no-deps wasi-crm

echo "==> Pruning dangling images"
docker image prune -f

echo "==> Done. Tail logs with: docker compose logs -f wasi-crm"
