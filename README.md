# 🧬 Phenotyping Ecosystem

*A computer vision desktop application for automated insect phenotyping — built with YOLOv8, FastAPI, React, and Tauri.*

---

## ⚡ What It Does

Detect and count insect embryos (eggs, larvae, pupae, neonates) in high-resolution microscopy images using a tiling inference pipeline. Results are visualized with bounding box overlays and stored for historical analysis.

| Feature | Status |
|---------|--------|
| 🔬 Egg Detection (YOLOv8) | ✅ Active |
| 📦 Batch Processing | ✅ Active |
| 🎨 Bounding Box Overlays | ✅ Active |
| 📊 Historical Analysis | 🔜 Coming Soon |
| 🧫 Larvae / Pupae / Neonate | 🔜 Coming Soon |
| 📷 Camera Capture | 🔜 Coming Soon |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Desktop Shell** | Tauri 2 |
| **Frontend** | React 18 + TypeScript + Vite |
| **UI Components** | shadcn/ui + Tailwind CSS |
| **Backend API** | FastAPI (Python 3.11+) |
| **Inference Engine** | Ultralytics YOLOv8 |
| **Database** | PostgreSQL (async) |
| **Image Pipeline** | OpenCV tiling + NMS dedup |

---

## 🚀 Quick Start

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Python | ≥ 3.11 | [python.org](https://www.python.org/downloads/) |
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org/) |
| pnpm | latest | `npm install -g pnpm` |
| Docker | latest | [docker.com](https://www.docker.com/get-started/) |
| Rust | stable | [rust-lang.org](https://www.rust-lang.org/tools/install) |

> **WSL2 users:** Install Docker Desktop for Windows or configure the `docker` CLI in WSL. See the [WSL Docker guide](https://docs.docker.com/desktop/wsl/).

### One-command Setup

```bash
# 1. Clone and enter the project
git clone <repo-url>
cd phenotyping-ecosystem

# 2. Copy environment file
cp backend/.env.example backend/.env

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

## 📁 Project Structure

```
phenotyping-ecosystem/
├── docker-compose.yml      ← PostgreSQL (do NOT edit)
├── dev.sh                  ← One-command startup (do NOT edit)
│
├── backend/
│   ├── app/
│   │   ├── main.py         ← FastAPI entry point
│   │   ├── database.py     ← Async SQLAlchemy setup
│   │   ├── models/         ← Database models
│   │   ├── routers/        ← API route handlers
│   │   ├── services/       ← Business logic
│   │   ├── schemas/        ← Pydantic models
│   │   └── ...
│   ├── alembic/             ← Database migrations
│   ├── data/results/       ← Overlay images (created at runtime)
│   └── .env                ← Environment variables
│
└── phenotyping-client/
    ├── src/                ← React frontend source
    └── ...                 ← Tauri + Vite config
```

---

## 🔧 Manual Setup

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
python3 -m venv .venv
source .venv/bin/activate    # On Windows: .venv\Scripts\activate

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
pnpm tauri dev    # Full desktop app (Tauri + React)
# OR
pnpm dev          # Web-only (React + Vite, no Rust)
```

---

## 🧪 Inference Pipeline

```
Input Image (6000×4000 px)
        │
        ▼
┌───────────────────┐
│  Tiling Engine    │  ← Tile size: 512px, 50% overlap
│  (OpenCV)         │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  YOLOv8 Detector  │  ← Confidence threshold: 0.4
│  (Ultralytics)    │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  Dedup Engine     │  ← center_zone (default) or edge_nms
│  (NMS / Zones)    │
└────────┬──────────┘
         │
         ▼
  Overlay PNG + JSON
```

---

## 🌐 API Reference

- **Swagger UI**: `http://localhost:8000/docs`
- **ReDoc**: `http://localhost:8000/redoc`
- **OpenAPI JSON**: `http://localhost:8000/openapi.json`

---

## 🔐 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql+asyncpg://...` | Async PostgreSQL connection string |
| `BACKEND_HOST` | `0.0.0.0` | Backend bind address |
| `BACKEND_PORT` | `8000` | Backend port |
| `PIPELINE_ROOT` | `../phenotyping_pipeline` | Path to the reference pipeline repo |
| `DATA_DIR` | `./data` | Data directory for results |
| `LOG_LEVEL` | `INFO` | Python logging level |

---

## 🐛 Common Tasks

```bash
# Run migrations
cd backend && source .venv/bin/activate
alembic upgrade head        # Apply migrations
alembic downgrade -1        # Roll back last migration

# Reset database
alembic downgrade base && alembic upgrade head

# Frontend: fix module errors
cd phenotyping-client
rm -rf node_modules pnpm-lock.yaml && pnpm install
```

---

## 🔥 Troubleshooting

| Problem | Fix |
|---------|-----|
| PostgreSQL connection refused | `docker compose ps` → `docker compose logs postgres` |
| Port already in use | `lsof -i :8000` / `lsof -i :5432` |
| Backend: Module not found | `pip install -e ".[dev]"` in `.venv` |
| Tauri first run slow | Normal — downloads Rust toolchain (5–10 min) |

---

## 📜 License

MIT — Genetics Team Internal Tool
