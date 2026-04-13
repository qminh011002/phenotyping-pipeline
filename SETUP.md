# Phenotyping Ecosystem — Setup Guide

## Prerequisites

Install the following tools before running the setup:

| Tool | Version | Install |
|------|---------|---------|
| Python | ≥ 3.11 | [python.org](https://www.python.org/downloads/) |
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org/) |
| pnpm | latest | `npm install -g pnpm` |
| Docker | latest | [docker.com](https://www.docker.com/get-started/) |
| Rust | stable | [rust-lang.org](https://www.rust-lang.org/tools/install) |

> **WSL2 users:** Install Docker Desktop for Windows or configure the `docker` CLI in WSL.
> See [WSL Docker guide](https://docs.docker.com/desktop/wsl/).

---

## Quick Start (Fresh Clone)

```bash
# 1. Clone and enter the project
git clone <repo-url>
cd phenotyping-ecosystem

# 2. Copy environment file
cp backend/.env.example backend/.env
# Edit backend/.env if PIPELINE_ROOT needs adjustment

# 3. Start everything with one command
./dev.sh
```

The script will:
- Start PostgreSQL via Docker Compose
- Create the Python virtual environment and install dependencies
- Run database migrations
- Launch the backend at `http://localhost:8000`
- Launch the frontend at `http://localhost:1420`

---

## Manual Setup (Step by Step)

### 1. PostgreSQL

```bash
# Option A: Docker Compose (recommended)
docker compose up -d

# Option B: Existing PostgreSQL instance
# Set DATABASE_URL in backend/.env to point to it.
```

### 2. Backend

```bash
cd backend

# Create virtual environment
python3 -m venv venv
source venv/bin/activate   # On Windows: venv\Scripts\activate

# Install dependencies
pip install -e ".[dev]"

# Run migrations
alembic upgrade head

# Start backend
uvicorn app.main:app --reload
```

### 3. Frontend

```bash
cd phenotyping-client
pnpm install
pnpm dev
```

---

## Project Structure

```
phenotyping-ecosystem/
├── docker-compose.yml      ← PostgreSQL (do NOT edit)
├── dev.sh                 ← One-command startup (do NOT edit)
├── SETUP.md               ← You are here
│
├── backend/
│   ├── app/
│   │   ├── main.py        ← FastAPI entry point
│   │   ├── database.py    ← Async SQLAlchemy setup
│   │   ├── models/        ← Database models
│   │   ├── routers/       ← API route handlers
│   │   ├── services/      ← Business logic
│   │   ├── schemas/       ← Pydantic models
│   │   └── ...
│   ├── alembic/           ← Database migrations
│   ├── data/results/      ← Overlay images (created at runtime)
│   └── .env               ← Environment variables (copy from .env.example)
│
└── phenotyping-client/
    ├── src/               ← React frontend source
    └── ...                ← Tauri + Vite config
```

---

## Environment Variables

All variables are in `backend/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql+asyncpg://...` | Async PostgreSQL connection string |
| `BACKEND_HOST` | `0.0.0.0` | Backend bind address |
| `BACKEND_PORT` | `8000` | Backend port |
| `PIPELINE_ROOT` | `../phenotyping_pipeline` | Path to the reference pipeline repo |
| `DATA_DIR` | `./data` | Data directory for results |
| `LOG_LEVEL` | `INFO` | Python logging level |

---

## Tauri Development

For full Tauri development (including Rust backend compilation):

```bash
./dev.sh --tauri
```

> First run downloads Rust toolchain — allow 5–10 minutes.

---

## Common Tasks

### Run migrations

```bash
cd backend
source venv/bin/activate
alembic upgrade head        # Apply migrations
alembic downgrade -1       # Roll back last migration
alembic history            # Show migration history
```

### Reset database

```bash
cd backend
source venv/bin/activate
alembic downgrade base      # Drop all tables
alembic upgrade head       # Recreate
```

### Backend API docs

- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`
- OpenAPI JSON: `http://localhost:8000/openapi.json`

---

## Troubleshooting

### PostgreSQL connection refused

```bash
# Check if container is running
docker compose ps

# Check logs
docker compose logs postgres

# Restart
docker compose restart postgres
```

### Port already in use

```bash
# Find what's using port 8000 or 5432
lsof -i :8000
lsof -i :5432

# Stop the conflicting process or change the port in .env
```

### Frontend: "Module not found"

```bash
cd phenotyping-client
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

### Backend: "Module not found"

```bash
cd backend
source venv/bin/activate
pip install -e ".[dev]"
```

---

## Development Workflow

1. Start services: `./dev.sh`
2. Make code changes
3. Backend auto-reloads on file changes
4. Frontend hot-reloads via Vite HMR
5. Press Ctrl+C to stop all services
