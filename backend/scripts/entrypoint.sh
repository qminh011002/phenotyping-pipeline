#!/usr/bin/env bash
# Container entrypoint: apply DB migrations, then exec the main command (gunicorn).
#
# Why a script instead of just CMD?
#   - Migrations must run *before* the app boots so the schema matches the code.
#   - Running them inside the container keeps deploys to a single `docker compose up`.
#   - `exec "$@"` replaces this shell with gunicorn so SIGTERM is forwarded directly,
#     letting workers shut down cleanly during rolling restarts.
#
# Skip migrations by setting SKIP_MIGRATIONS=1 (useful when running multiple
# replicas — only one should run migrations).

set -euo pipefail

if [[ "${SKIP_MIGRATIONS:-0}" != "1" ]]; then
    echo "[entrypoint] Running alembic upgrade head..."
    alembic upgrade head
    echo "[entrypoint] Migrations complete."
else
    echo "[entrypoint] SKIP_MIGRATIONS=1 — skipping alembic upgrade."
fi

echo "[entrypoint] Starting: $*"
exec "$@"
