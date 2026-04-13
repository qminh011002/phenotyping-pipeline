#!/usr/bin/env bash
# =============================================================================
# Phenotyping Ecosystem — Development Startup Script
# Starts PostgreSQL, runs migrations, and launches the backend + frontend.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# -----------------------------------------------------------------------------
# Colors
# -----------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log_info()  { echo -e "${CYAN}[info]${RESET} $1"; }
log_ok()    { echo -e "${GREEN}[ ok ]${RESET} $1"; }
log_warn()  { echo -e "${YELLOW}[warn]${RESET} $1"; }
log_fail()  { echo -e "${RED}[FAIL]${RESET} $1"; }

# -----------------------------------------------------------------------------
# Prerequisites check
# -----------------------------------------------------------------------------
check_command() {
  if ! command -v "$1" &>/dev/null; then
    log_fail "Missing required command: $1. Please install $2."
    exit 1
  fi
}

log_info "Checking prerequisites..."
check_command python3  "Python 3.11+ (python3 --version)"
check_command node     "Node.js 18+ (node --version)"
check_command pnpm    "pnpm (npm install -g pnpm)"
check_command docker   "Docker (docker --version)"
check_command docker   "Docker Compose (docker compose version)"
log_ok "All prerequisites found."

# -----------------------------------------------------------------------------
# Parse arguments
# -----------------------------------------------------------------------------
TAURI_MODE=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --tauri) TAURI_MODE=true; shift ;;
    *)       echo "Unknown option: $1"; exit 1 ;;
  esac
done

# -----------------------------------------------------------------------------
# 1. Start PostgreSQL via Docker Compose
# -----------------------------------------------------------------------------
log_info "Starting PostgreSQL..."
if docker compose -f "$SCRIPT_DIR/docker-compose.yml" ps --status running 2>/dev/null \
   | grep -q phenotyping-pg; then
  log_ok "PostgreSQL already running."
else
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d
  log_ok "PostgreSQL started."

  # Wait for database to be ready
  log_info "Waiting for PostgreSQL to be ready..."
  for i in {1..30}; do
    if docker exec phenotyping-pg pg_isready -U postgres -d phenotyping &>/dev/null; then
      log_ok "PostgreSQL is ready."
      break
    fi
    if [[ $i -eq 30 ]]; then
      log_fail "PostgreSQL did not become ready in time."
      exit 1
    fi
    sleep 1
  done
fi

# -----------------------------------------------------------------------------
# 2. Backend: install dependencies and run migrations
# -----------------------------------------------------------------------------
log_info "Setting up backend..."
if [[ ! -d "$SCRIPT_DIR/backend" ]]; then
  log_fail "backend/ directory not found."
  exit 1
fi

cd "$SCRIPT_DIR/backend"

# Install Python dependencies if needed
if [[ ! -d "venv" ]] && ! python3 -c "import fastapi" 2>/dev/null; then
  log_info "Creating Python virtual environment..."
  python3 -m venv venv
  source venv/bin/activate
  pip install -e ".[dev]" --quiet
  log_ok "Python dependencies installed."
fi

# Activate venv if present
if [[ -f "venv/bin/activate" ]]; then
  source venv/bin/activate
fi

# Run Alembic migrations
log_info "Running database migrations..."
alembic upgrade head
log_ok "Migrations applied."

# -----------------------------------------------------------------------------
# 3. Frontend: install dependencies
# -----------------------------------------------------------------------------
log_info "Setting up frontend..."
if [[ ! -d "$SCRIPT_DIR/phenotyping-client" ]]; then
  log_fail "phenotyping-client/ directory not found."
  exit 1
fi

cd "$SCRIPT_DIR/phenotyping-client"
if [[ ! -d "node_modules" ]]; then
  log_info "Installing frontend dependencies..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  log_ok "Frontend dependencies installed."
fi

# -----------------------------------------------------------------------------
# 4. Start services
# -----------------------------------------------------------------------------
cd "$SCRIPT_DIR"
log_info "Starting services..."

# Cleanup function
cleanup() {
  echo ""
  log_info "Shutting down services..."
  kill %1 2>/dev/null || true
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  log_ok "Shutdown complete."
}
trap cleanup SIGINT SIGTERM

# Start backend in background
cd "$SCRIPT_DIR/backend"
if [[ -f "venv/bin/activate" ]]; then
  source venv/bin/activate
fi
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!
cd "$SCRIPT_DIR"
log_ok "Backend starting at http://localhost:8000/docs"

# Wait briefly for backend to start
sleep 3

if $TAURI_MODE; then
  log_info "Starting Tauri dev server (this takes a while on first run)..."
  cd "$SCRIPT_DIR/phenotyping-client"
  pnpm tauri dev &
  wait
else
  log_info "Starting Vite dev server..."
  cd "$SCRIPT_DIR/phenotyping-client"
  pnpm dev &
  log_ok "Frontend starting at http://localhost:1420"
  log_info "Press Ctrl+C to stop all services."
  wait
fi
