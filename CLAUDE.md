# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Three sibling top-level dirs matter:

- `backend/` — FastAPI inference server (Python 3.11+, async SQLAlchemy + asyncpg, Ultralytics YOLOv8). Self-contained — never import from `phenotyping_pipeline/` at runtime.
- `phenotyping-client/` — Tauri 2 + React 19 + Vite + Tailwind v4 + shadcn/ui (New York style, Slate). Path alias `@/` → `src/`.
- `phenotyping_pipeline/` — **read-only reference repo** containing model weights and the original `infer_egg.py`. Read for understanding only; never write to it. Inference logic was copied/adapted into `backend/app/services/inference/egg.py`.

`tasks/` holds the structured task system (`PROGRESS.md`, `ROADMAP.md`, and per-task files under `backend/`, `frontend/`, `fullstack/`, `infra/`, `qa/`). The `task-execution.mdc` cursor rule defines the protocol — read `tasks/PROGRESS.md` at the start of any task-driven work.

## Common commands

One-shot dev startup (Postgres + backend + Vite frontend):
```bash
./dev.sh             # web frontend (Vite at :1420, backend at :8000)
./dev.sh --tauri     # full desktop app (slow first run — Rust toolchain)
```

Backend (from `backend/`, with `venv/bin/activate` sourced):
```bash
pip install -e ".[dev]"
alembic upgrade head                       # apply migrations
alembic downgrade -1                       # rollback one
alembic revision --autogenerate -m "msg"   # new migration
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
ruff check app/ && black app/ && isort app/
pytest tests/ -v                            # if/when tests exist
python -c "from app.main import app; print('OK')"   # quick syntax check
```

Frontend (from `phenotyping-client/`):
```bash
pnpm install
pnpm dev                                   # Vite only (React in browser)
pnpm tauri dev                             # full Tauri desktop window
pnpm tsc --noEmit                          # typecheck
pnpm build                                 # tsc + vite build
pnpm dlx shadcn@latest add <component>     # add shadcn component (always use CLI)
```

DB (Docker):
```bash
docker compose up -d                       # phenotyping-pg on :5432
docker compose logs -f postgres
```

## Architecture — the parts that span files

### Backend lifespan & DI (`backend/app/main.py` + `app/deps.py`)

`main.py`'s `lifespan` is the single source of truth for startup ordering and *creates module-level singletons that `deps.py` later hands to routes via `Depends(...)`*:

1. `LogBuffer` → `_set_log_buffer` (must exist before `configure_logging`)
2. `configure_logging(log_buffer)` — wires `RingBufferHandler` → ring buffer + per-WS-client queues
3. `ModelRegistry.startup(pipeline_config)` → `_set_model_registry` (loads YOLO weights once)
4. `ThreadPoolExecutor` sized by device (1 CPU, 2 GPU) → `_set_executor`
5. `EggInferenceService(...)` → `_set_inference_service`
6. `Database.init()` and seed `app_settings` singleton row (id=1) from `.env` defaults if missing
7. `log_buffer.start_heartbeat()` (1-Hz heartbeat for WebSocket clients)

Shutdown reverses: stop heartbeat → executor.shutdown(wait=True) → registry.shutdown() → db.close().

If you add a new singleton, follow the same pattern: `_set_X` from `main.py`, `get_X` (with RuntimeError if uninitialized) from `deps.py`, optionally an `Annotated[T, Depends(get_X)]` alias for route signatures.

### Inference path

CPU/GPU work is blocking — handlers must offload to the executor:
```python
result = await loop.run_in_executor(executor, run_egg_inference, image, filename)
```
Bound concurrency with `asyncio.Semaphore(1 on CPU / 2 on GPU)`. The egg model's tiling/dedup logic lives in `app/services/inference/egg.py` (copied + adapted from `phenotyping_pipeline/2_inference/infer_egg.py`). Two dedup modes are both required:
- `center_zone` (default, O(N) — uses computed `stride = int(tile_size * (1 - overlap))`)
- `edge_nms` (legacy, O(N²) — needs global NMS pass after edge filtering)

Behavior must match the reference pipeline exactly given the same image+config.

### Image storage

Overlay PNGs are written to **local disk** under a configurable `image_storage_dir`. The DB and API exchange only path/URL strings — never base64, never binary blobs. The runtime source of truth for `image_storage_dir` is the `app_settings` singleton DB row (id=1), seeded from `.env` on first startup, mutated via `PUT /settings/storage`. There is a process-local cache (`get_cached_storage_dir` in `deps.py`) that `invalidate_storage_dir_cache` bumps on every successful update.

### Pipeline config

`phenotyping_pipeline/config.yaml` holds inference parameters (per organism: `egg`, `larvae`, `pupae`, `neonate`). `PipelineConfigManager` (in `app/config.py`) loads, validates the `egg` block as `EggConfig`, exposes it via `GET /config`, and atomically rewrites the file on `PUT /config` while preserving non-egg sections. Always validate before writing — never persist unvalidated YAML.

### Logging → WebSocket

All logs go through stdlib `logging`, never `print()`. `RingBufferHandler` fans out into a deque (`maxlen=1000`) and per-client `asyncio.Queue(maxsize=500)`. From worker threads, bridge with `loop.call_soon_threadsafe(queue.put_nowait, ...)` — never block the event loop. On full queue, drop oldest + bump `dropped_logs`. Pass structured fields via `extra={...}` (the JsonFormatter pulls them into `context`); never f-string them into the message. The 1-Hz heartbeat task is independent of log emission. See `.cursor/rules/logging.mdc` for the canonical event table.

### Frontend structure

Feature-first under `src/features/{upload,recorded,results,settings,logs}/` with shared shadcn/Radix primitives in `src/components/ui/`. Pages in `src/pages/`. API client wraps `fetch` in `src/services/{api,http,websocket,errors}.ts`. Global state via Zustand in `src/stores/`. The processing flow (per `tasks/PROGRESS.md`):

1. ProcessingPage creates a DB batch (`POST /analyses`)
2. Sends per-image inference requests (`POST /inference/egg?batch_id=...`)
3. Persists each result (`POST /analyses/{id}/images`)
4. Marks complete (`POST /analyses/{id}/complete`)

DB batch UUID is stored in `sessionStorage` and used to build overlay URLs. The folder picker uses `@tauri-apps/plugin-dialog` (`open({ directory: true })`) with the `dialog:default` capability — installed on both JS and Rust sides.

## API contract

`.cursor/rules/api-contract.mdc` is the **single source of truth** for HTTP/WebSocket shapes. When changing any request/response, update all three in lockstep:
1. `backend/app/schemas/` (Pydantic v2)
2. `phenotyping-client/src/types/api.ts` (TypeScript)
3. `.cursor/rules/api-contract.mdc`

Overlay responses must reference `overlay_url` (string), never embed base64.

## Project rules — read these before non-trivial work

The `.cursor/rules/*.mdc` files are authoritative and apply to Claude Code too. Most are `alwaysApply: true`. Key ones:

- `task-execution.mdc` — read `tasks/PROGRESS.md` first; testing protocol is mandatory after every task
- `api-contract.mdc` — canonical request/response shapes
- `fastapi.mdc` — `from __future__ import annotations`; lifespan; Pydantic v2 only; async route handlers; `pathlib.Path` over `os.path`
- `yolov8.mdc` — model loading, device selection, tiling/dedup details, copy-from-pipeline rule
- `logging.mdc` — structured logging + WebSocket streaming requirements
- `react.mdc`, `shadcn-tailwind.mdc` — frontend patterns; `cn()` for class composition; semantic color tokens (never raw `bg-blue-500`); add shadcn components via CLI only
- `tauri.mdc` — Rust patterns; granular capabilities, never wildcard

## Hard rules

1. **Never modify `phenotyping_pipeline/`.** It is read-only reference code (config.yaml is the one exception — it's edited via `PUT /config`).
2. **Never `importlib`/`sys.path`-import from `phenotyping_pipeline/`** at runtime — backend must be self-contained.
3. **No authentication** — single-tenant desktop app.
4. **MVP scope = Upload + Egg only.** Camera capture and larvae/pupae/neonate are deferred placeholders.
5. **Testing is mandatory after each task** — use the protocol in `task-execution.mdc` (start server, hit endpoints, `pnpm tsc --noEmit`, etc.) before reporting done.
6. **CUDA fallback:** if config requests CUDA and `torch.cuda.is_available()` is false, log a warning and fall back to CPU — never crash.

## Environment variables (backend `.env`)

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://postgres:postgres@localhost:5432/phenotyping` | Must use the `+asyncpg` driver |
| `PIPELINE_ROOT` | `../phenotyping_pipeline` | Resolved to absolute on startup |
| `IMAGE_STORAGE_DIR` | `./data/overlays` | Seeds the `app_settings` DB row on first run; runtime value comes from DB |
| `DATA_DIR` | `./data` | |
| `BACKEND_HOST` / `BACKEND_PORT` | `0.0.0.0` / `8000` | |
| `LOG_LEVEL` | `INFO` | |
