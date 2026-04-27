# Production Deployment Guide

End-to-end runbook for deploying the phenotyping-ecosystem to a single Ubuntu server **on an internal LAN** (HTTP-only, no public exposure), with Docker and a self-hosted GitHub Actions runner driving CI/CD.

> **Verified accurate as of 2026-04-27** against the current state of `backend/` and `phenotyping-client/` in this repository, the production choice to run Postgres on Ubuntu/systemd, and the Docker/GitHub Actions versions listed in §2. Section 2 lists every version pin so you can update them later without re-reading the whole guide.

---

## How CI/CD works in this monorepo

This repository intentionally keeps the backend and frontend together. `backend/` contains the FastAPI API, and `phenotyping-client/` contains the Vite/React UI. When you push a branch and open a PR, GitHub Actions first checks which paths changed:

- If only frontend files changed, it runs the frontend checks and skips the backend lint/unit-test job.
- If only backend files changed, it runs the backend checks and skips the frontend type-check/test job.
- If shared deployment, workflow, or API-contract files changed, it treats the change as relevant to both sides.
- Every PR still runs the Docker stack smoke test, which builds both images, starts a temporary CI Postgres container + backend + frontend, and checks the app through HTTP.
- After the PR is merged to `main`, the deploy workflow builds/tags the production images, pushes them to GHCR, and the server pulls and restarts the stack.

So the monorepo stays easy to keep in sync, but CI avoids unnecessary component checks. Path filtering decides whether to run the standalone backend or frontend checks; it does not remove the full-stack verification. The final required GitHub check is `ci-success`; it passes only when every relevant job passed and the full-stack smoke test passed.

---

## 0. What this guide assumes

- **Deployment scope**: **internal LAN only**. No public internet exposure. Users on the company network reach the app at `http://192.168.x.x` (or whatever LAN IP the server has). No DNS, no HTTPS, no public certs.
- **Local machine**: macOS, Linux, or WSL2 with `git`, an editor, Docker Desktop (optional but useful for testing), and SSH.
- **Server**: a fresh **Ubuntu 24.04 LTS** machine on the company LAN (bare metal, VM, or VPS exposed only to the LAN). Outbound internet required so the server can `apt install`, pull images from GHCR, and let GitHub's runner registration reach back to GitHub. Inbound is LAN-only.
- **GitHub repo** containing this codebase, with permission to set branch rules and configure self-hosted runners.
- **CI/CD topology**: a **self-hosted GitHub Actions runner** runs on the server itself. CI (the PR gate) still runs on GitHub-hosted `ubuntu-latest`. Only the deploy job runs on the self-hosted runner — and because the runner IS the server, the deploy step doesn't SSH anywhere, it just runs `docker compose` locally.
- **Database topology**: production Postgres runs directly on the Ubuntu server via the `postgresql` systemd service. It is not part of `docker-compose.prod.yml`.
- **Stack scope**: only `backend/` (FastAPI) and `phenotyping-client/` (Vite/React) ship to production. Model weights (if any) live inside the backend image or are pulled at startup from object storage — not bind-mounted from the host.

---

## 1. Where every file goes (the master file map)

This is the single biggest source of confusion in deployment guides. Read this once and refer back as needed.

### 1.1 Repository (your laptop + GitHub)

After you finish this guide, your repo will look like this. **Bold = new files you'll create in this guide.** Everything else exists today.

```
phenotyping-ecosystem/
│
├── backend/                            ← FastAPI server (existing)
│   ├── app/                            (existing tree: routers/, models/, schemas/, services/, db/, errors/, middleware/)
│   ├── alembic/                        (existing — DB migrations)
│   ├── alembic.ini                     (existing)
│   ├── pyproject.toml                  (existing — declares deps)
│   ├── tests/                          (existing — pytest)
│   ├── scripts/init_db.py              (existing)
│   ├── .env.development                (tracked — dev defaults; loaded when APP_ENV=development)
│   ├── .env.production                 (tracked — non-secret defaults + documents required vars; NOT loaded at runtime in prod)
│   ├── **Dockerfile**                  ← NEW (§4.2)
│   ├── **gunicorn.conf.py**            ← NEW (§4.3)
│   └── **.dockerignore**               ← NEW (§4.4)
│
├── phenotyping-client/                 ← Vite/React frontend (existing)
│   ├── src/                            (existing tree: features/, components/, services/, pages/, hooks/, etc.)
│   ├── public/, index.html             (existing)
│   ├── package.json                    (existing)
│   ├── **package-lock.json**           ← NEW — commit this! (§5.1)
│   ├── vite.config.ts                  (existing)
│   ├── tsconfig.json                   (existing)
│   ├── .env.development                (tracked — Vite loads it during `npm run dev`)
│   ├── .env.production                 (tracked — placeholder; Vite loads it during `npm run build`, build arg overrides)
│   ├── **Dockerfile**                  ← NEW (§5.2)
│   ├── **nginx.conf**                  ← NEW (§5.3 — container-internal nginx)
│   └── **.dockerignore**               ← NEW (§5.4)
│
├── docker-compose.yml                  (existing — DEV ONLY: just postgres for local work)
├── **docker-compose.prod.yml**         ← NEW (§6 — prod app stack: backend + frontend; Postgres runs on Ubuntu)
├── dev.sh                              (existing)
├── CLAUDE.md, PRODUCTION.md, README.md
├── .gitignore                          (existing — needs minor fix per §13)
│
└── **.github/**                        ← NEW (§9)
    └── **workflows/**
        ├── **ci.yml**                  ← PR gate
        └── **deploy.yml**              ← runs on merge to main
```

**Rules:**

- Anything starting with `.env*` that holds **real secrets** stays gitignored. Tracked `.env.development` / `.env.production` files contain only safe defaults or build-time placeholders.
- The Dockerfile lives **inside** the directory it builds (`backend/Dockerfile`, `phenotyping-client/Dockerfile`). Each has a sibling `.dockerignore`.
- GitHub Actions workflows MUST live at exactly `.github/workflows/*.yml` at the repo root. No other path is recognized by GitHub.
- The dev `docker-compose.yml` (postgres only) stays untouched. The prod app stack goes in a separate `docker-compose.prod.yml` so you can't accidentally run dev compose on the server. Production Postgres is installed on Ubuntu and managed by systemd, not Docker.

### 1.2 Ubuntu server filesystem

> **Mental model first.** The application does **not run from files on the server's disk.** It runs from **Docker images** that GitHub Actions built and pushed to GHCR. Each image already contains a frozen copy of `backend/` (with its Python code, alembic migrations, gunicorn config) or `phenotyping-client/` (with the compiled JS bundle and nginx config).
>
> What lives on the server's disk is just the **glue**: the git checkout (so you can read the compose file and reference the source for debugging), the orchestration files, runtime data, and secrets. Editing `/opt/phenotyping/backend/app/main.py` on the server does **nothing** — the running container has its own baked-in copy.

Here is the full server layout:

```
/opt/phenotyping/                          ← git checkout of the repo (synced by deploy.yml)
├── backend/                               ← reference copy of source. NOT executed.
│   ├── app/                                  (the running backend reads /app/app inside the container,
│   ├── alembic/                               which is a frozen copy from the GHCR image)
│   ├── pyproject.toml
│   ├── Dockerfile
│   └── ...
├── phenotyping-client/                    ← reference copy of frontend source. NOT executed.
│   ├── src/
│   ├── Dockerfile
│   └── ...
├── docker-compose.prod.yml                ← the orchestration definition that compose reads
├── .env                                   ← compose-substitution vars (IMAGE_TAG)
├── .github/, dev.sh, README.md, ...       ← rest of the repo, harmless on disk
└── (no .env.production here — that's in /etc/phenotyping/)

/etc/phenotyping/                          ← server-only secrets (root:deploy, not in git)
└── .env.production                        ← real prod env vars (DATABASE_URL, JWT secrets, …)
                                              Mounted into the backend container via env_file:.

/var/lib/phenotyping/                      ← persistent data that outlives containers
└── overlays/                              ← bind-mounted into backend container at /data/overlays

/var/backups/phenotyping/                  ← pg_dump destinations (cron job, §12.4)

/etc/nginx/sites-available/phenotyping     ← host nginx site config (§8.2)
/etc/nginx/sites-enabled/phenotyping       ← symlink to the above
/etc/nginx/conf.d/                         ← extra nginx snippets if you split config

/home/deploy/                              ← unprivileged deploy user (created in §7.3)
├── .ssh/authorized_keys                   ← your laptop's public key (for SSH)
└── actions-runner/                        ← self-hosted GitHub Actions runner (§9.7)

# These are managed by Docker, not files you edit:
/var/lib/docker/overlay2/                       ← Docker image layers (cleaned by `docker image prune`)

# This is managed by Ubuntu's postgresql service, not Docker:
/var/lib/postgresql/                            ← Postgres data directory
```

### What actually runs vs. what sits on disk

| Component | Code source at runtime | Filesystem on the server |
|---|---|---|
| **Backend FastAPI** | `/app/` **inside the container**, baked from `ghcr.io/.../phenotyping-backend:<sha>` | `/opt/phenotyping/backend/` is a static copy from `git rsync`, used only for reading/debugging |
| **Frontend SPA** | `/usr/share/nginx/html/` **inside the container**, baked from `ghcr.io/.../phenotyping-frontend:<sha>` | `/opt/phenotyping/phenotyping-client/` is a static copy, used only for reading |
| **Postgres data** | Ubuntu `postgresql` service reads/writes it directly | `/var/lib/postgresql/` managed by the OS package |
| **Overlay PNGs** | container writes to `/data/overlays` | host bind mount: `/var/lib/phenotyping/overlays/` |
| **Real env vars** | container reads them from process env | `/etc/phenotyping/.env.production` (`root:deploy`, read by compose) |
| **Compose definition** | Docker reads it directly | `/opt/phenotyping/docker-compose.prod.yml` |

**A concrete example.** When a request hits the backend:

1. User opens `http://192.168.1.50/api/health` in a browser on the LAN.
2. Host nginx (port 80) sees `/api/health`, forwards to `127.0.0.1:8000`.
3. The backend **container** (started from the GHCR image) handles it. The Python code that runs is baked into the image — it is NOT `/opt/phenotyping/backend/app/main.py`.
4. The container reads env vars Docker injected at startup (from `/etc/phenotyping/.env.production`).
5. If it needs the DB, it connects to the Ubuntu Postgres service on `127.0.0.1:5432`. The backend container uses host networking in production specifically so `127.0.0.1` means the server itself.
6. If it writes an overlay PNG, it goes to `/data/overlays` inside the container — which the host bind-mount stores at `/var/lib/phenotyping/overlays/` so it survives container replacements.

### Why split between `/opt`, `/etc`, `/var`?

Linux convention (Filesystem Hierarchy Standard) — and this split makes operations safe:

| Directory | Purpose | What lives there |
|---|---|---|
| `/opt/<app>/` | Application install — replaceable | git checkout, compose files, deploy `.env` |
| `/etc/<app>/` | Configuration with secrets, hand-managed, **not in any repo** | Real prod env file |
| `/var/lib/<app>/` | App-managed mutable data, backed up | Overlay PNGs |
| `/var/backups/<app>/` | Backup destinations | `pg_dump` outputs |

A `git pull` (or rsync) in `/opt/phenotyping` cannot touch `/etc/phenotyping` or `/var/lib/phenotyping`. Even if you `rm -rf /opt/phenotyping`, no user data or secrets are lost — just re-clone.

### Why `/opt/phenotyping/backend/` still exists on the server

Yes: `/opt/phenotyping` should stay on the server and should be kept synced to the latest `main` during deploy. But it is the **deployment checkout**, not the live Python/React source that serves users.

The deploy flow uses it like this:

1. GitHub Actions checks out the latest `main` into the runner workspace.
2. The deploy job `rsync`s that checkout into `/opt/phenotyping`.
3. Docker Compose reads `/opt/phenotyping/docker-compose.prod.yml` and `/opt/phenotyping/.env`.
4. Compose pulls and runs the already-built GHCR images for the backend and frontend.

So `/opt/phenotyping/backend/` is useful because:

1. **It keeps deployment files current.** `docker-compose.prod.yml`, workflow-adjacent files, nginx references, scripts, docs, and rollback context all move forward with `main`.
2. **It gives you a readable copy of the exact source for the deployed commit.** When debugging, SSHing to the server and reading `/opt/phenotyping/backend/app/...` is fast.
3. **It is operational context.** You can inspect migrations, scripts, config examples, and docs from the server without opening GitHub.

What it does **not** mean: editing `/opt/phenotyping/backend/app/main.py` changes the running backend. It does not. The running backend uses the code baked into `ghcr.io/.../phenotyping-backend:<sha>`. To change production behavior, push code, let CI build a new image, merge to `main`, and deploy that new image.

If you deleted `/opt/phenotyping/backend/` and `/opt/phenotyping/phenotyping-client/` after a deploy, the already-running containers would keep working. But the next deploy needs `/opt/phenotyping` again so Compose has the latest deployment files and image tag.

---

## 2. Version pin reference (verified 2026-04-27)

Replace these as new versions release. All are official images / first-party actions.

| Component                    | Pin                                          | Source                                                                                                                            |
| ---------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Python base image            | `python:3.13-slim`                           | Project requires `>=3.11`. 3.13 is the last release with mature wheels for `torch` / `ultralytics`. 3.14 works but ML wheels lag. |
| Node base image              | `node:lts-alpine` (= Node 24 LTS, "Krypton") | Built 2026-04-16, Alpine 3.23.4                                                                                                   |
| nginx base image             | `nginx:1.30-alpine` (stable channel)         | Stable nginx 1.30.0 on Alpine 3.23                                                                                                |
| PostgreSQL server package    | Ubuntu `postgresql` package                  | Installed on the server and managed by systemd. Do major-version upgrades deliberately and test restore from backup first.         |
| Ubuntu server                | 24.04 LTS or 26.04 LTS                       | Both work identically for this guide.                                                                                             |
| `actions/checkout`           | `@v4`                                        | Stable since 2024                                                                                                                 |
| `actions/setup-python`       | `@v5`                                        | Stable                                                                                                                            |
| `actions/setup-node`         | `@v4`                                        | Stable                                                                                                                            |
| `docker/setup-buildx-action` | `@v3`                                        | Stable                                                                                                                            |
| `docker/login-action`        | `@v3`                                        | Stable                                                                                                                            |
| `docker/build-push-action`   | `@v7`                                        | Latest GA, default uses Buildx v0.30                                                                                              |
| `pnpm/action-setup`          | `@v4`                                        | Only needed if you switch to pnpm; this repo uses npm — see §5.1                                                                  |

---

## 3. Environment files — what's tracked, what's a secret

Each project keeps **exactly two tracked env files**: `.env.development` and `.env.production`. No `.env`, no `.env.example`. The two filenames already document themselves — `.env.development` is the example template and the dev defaults rolled into one, and `.env.production` is the contract for what production needs.

The trick is the runtime never blindly loads `.env.production` in real production. The two files exist for **different reasons**:

| File | Tracked? | Contains | Loaded at runtime when |
|---|---|---|---|
| `backend/.env.development` | ✅ | Safe local-dev values (dev DB URL, dev JWT secrets, `LOG_LEVEL=DEBUG`) | `APP_ENV=development` (dev only — see §3.1) |
| `backend/.env.production` | ✅ | Non-secret defaults + placeholder lines for required secrets | **Never loaded by the app at runtime.** It's a contract — the server reads real values from process env. |
| `phenotyping-client/.env.development` | ✅ | `VITE_API_BASE_URL=http://localhost:8000` | Vite auto-loads when `npm run dev` (mode = development) |
| `phenotyping-client/.env.production` | ✅ | `VITE_API_BASE_URL=__INJECTED__` placeholder | Vite auto-loads when `npm run build` (mode = production), then the Docker `--build-arg` overrides |
| **Server** `/etc/phenotyping/.env.production` | ❌ **NEVER** in git | Real prod secrets | Compose injects via `env_file:` into the backend container |
| **Server** `/opt/phenotyping/.env` | ❌ | `IMAGE_TAG` | Compose variable substitution only |

> Two files on the server share the name `.env.production` with two files in the repo. They serve different roles: the **repo** ones are tracked templates documenting the schema. The **server** one holds real secrets and never enters git. Same name, different jobs — don't paste real secrets into the repo files.

### 3.1 Backend: how `APP_ENV` selects the env source

`backend/app/config.py` should follow this pattern (you may already have it; if not, add it):

```python
# backend/app/config.py
import os
from pathlib import Path

APP_ENV = os.getenv("APP_ENV", "development")

if APP_ENV != "production":
    # Dev/test: pull values from .env.development on disk for ergonomics.
    from dotenv import load_dotenv
    env_file = Path(__file__).resolve().parent.parent / f".env.{APP_ENV}"
    if env_file.exists():
        load_dotenv(env_file, override=False)

# In production, dotenv is NEVER called. Real values come from the
# environment that compose / k8s / your shell provides.
DATABASE_URL = os.environ["DATABASE_URL"]
JWT_ACCESS_SECRET = os.environ["JWT_ACCESS_SECRET"]
# ...
```

**Why this design:**

- Dev: set `APP_ENV=development` (or leave unset — it's the default). The app reads `.env.development` from disk. Devs never need a personal `.env` because the tracked file has working defaults.
- Prod: the Dockerfile sets `ENV APP_ENV=production`. `python-dotenv` is never called, so the on-disk `.env.production` is ignored. The app reads `os.environ`, populated by Docker compose's `env_file: /etc/phenotyping/.env.production`.
- The tracked `backend/.env.production` is documentation: it lists every var the production runtime needs, with placeholder values like `JWT_ACCESS_SECRET=__SET_IN_/etc/phenotyping/.env.production__`. New contributors look at it to know what env they have to set on a server.

`python-dotenv` should still be a runtime dependency (it's tiny and the `if APP_ENV != "production"` branch needs it), or move it to dev-only and `try: from dotenv import load_dotenv except ImportError: pass`.

### 3.2 Frontend: how Vite uses `MODE` (Vite's name for `NODE_ENV`)

You don't write a `NODE_ENV` check yourself — Vite handles it. Two rules:

1. `npm run dev` runs Vite in **development** mode → Vite auto-loads `.env.development`.
2. `npm run build` runs Vite in **production** mode → Vite auto-loads `.env.production`.

Vite exposes `import.meta.env.MODE` (`"development"` / `"production"`), `import.meta.env.PROD` (boolean), `import.meta.env.DEV` (boolean), and any var you prefix with `VITE_`. Internally Vite also sets `process.env.NODE_ENV` for any tooling that needs it — but in your application code, prefer `import.meta.env.MODE`.

Critically: **Vite inlines these values into the bundle at build time**. There is no runtime env in a static JS bundle. That's why `phenotyping-client/.env.production` exists in the repo as a placeholder, and the Dockerfile overrides it via `--build-arg VITE_API_BASE_URL=/api` at `npm run build` time.

### 3.3 Generate production secrets (one time, on your laptop)

```bash
# JWT secrets — must be different from each other.
openssl rand -base64 48
openssl rand -base64 48

# Postgres password — strong, no shell special chars to avoid escaping pain.
openssl rand -base64 32 | tr -d '+/=' | head -c 32
```

Save these in a password manager. You'll paste them into `/etc/phenotyping/.env.production` in §7.7.

### 3.4 What goes in each tracked file

**`backend/.env.development`** — tracked, working dev defaults:

```bash
APP_ENV=development
LOG_LEVEL=DEBUG

DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/phenotyping

DATA_DIR=./data
IMAGE_STORAGE_DIR=./data/overlays

# Dev-only secrets — NOT used in production. Safe to commit.
JWT_ACCESS_SECRET=dev-only-access-secret-change-me
JWT_REFRESH_SECRET=dev-only-refresh-secret-change-me
JWT_ALGORITHM=HS256
JWT_ACCESS_TTL_MIN=15
JWT_REFRESH_TTL_DAYS=30
```

**`backend/.env.production`** — tracked, contract + safe defaults. Real values get injected via `/etc/phenotyping/.env.production` on the server:

```bash
APP_ENV=production
LOG_LEVEL=INFO

# Required — placeholder values. Real values live in /etc/phenotyping/.env.production on the server.
DATABASE_URL=__SET_ON_SERVER__

DATA_DIR=/data
IMAGE_STORAGE_DIR=/data/overlays

JWT_ACCESS_SECRET=__SET_ON_SERVER__
JWT_REFRESH_SECRET=__SET_ON_SERVER__
JWT_ALGORITHM=HS256
JWT_ACCESS_TTL_MIN=15
JWT_REFRESH_TTL_DAYS=30
```

If anyone runs the backend with `APP_ENV=production` locally **without** providing real env vars, the app boots, hits `os.environ["DATABASE_URL"]`, sees `__SET_ON_SERVER__`, and fails to connect — that's the desired loud failure.

**`phenotyping-client/.env.development`** — tracked:

```bash
VITE_API_BASE_URL=http://localhost:8000
```

**`phenotyping-client/.env.production`** — tracked (placeholder; the build arg overrides this at `npm run build`):

```bash
VITE_API_BASE_URL=__INJECTED_AT_BUILD__
```

---

## 4. Backend production setup

The backend uses **Gunicorn** as the process supervisor with **UvicornWorker** for ASGI/async support. Gunicorn handles graceful reloads, worker recycling, and signal handling that bare uvicorn doesn't.

### 4.1 Dependencies live in `pyproject.toml` — no `requirements.txt`

This project uses `pyproject.toml` (PEP 621) as the **single source of truth** for backend dependencies. There is no `requirements.txt` and there shouldn't be one.

**Why pyproject-only is the right choice here:**

- **One place, no drift.** With both files, the answer to "what does this app depend on?" depends on which file you opened. `requirements.txt` quietly diverges from `pyproject.toml` until something breaks in production.
- **Standard tooling.** PEP 621 / PEP 660 are universally supported — `pip install -e .` works, `pip-compile pyproject.toml` works, `uv pip install` works, `hatch` / `poetry` / `pdm` all read it.
- **Optional dependency groups belong here.** `[project.optional-dependencies]` cleanly separates runtime (`pip install -e .`) from dev tools (`pip install -e ".[dev]"`). A `requirements.txt` can't express that without a second file.
- **Build metadata + deps in one config.** `[build-system]`, `[tool.ruff]`, `[tool.black]`, `[tool.isort]` already live in `pyproject.toml`. Adding deps there keeps configuration in one file.

**When you'd want a `requirements.txt` anyway** (you don't, but for completeness):

- Reproducibility lockfile with pinned hashes — generate it from pyproject with `pip-compile` or `uv pip compile`. Output is `requirements.lock` or `requirements-prod.txt`, **derived** from `pyproject.toml`, never hand-edited. We don't need this yet — Docker images are content-addressed by SHA via the deploy workflow, which is "good enough" pinning until you have multi-host fleets.
- Tooling that doesn't speak PEP 621. None of ours qualify.

So: edit `pyproject.toml`. Don't create `requirements.txt`.

### 4.1.1 Final `backend/pyproject.toml` `[project]` block

Open `/home/minhtq/company_projects/phenotyping-ecosystem/backend/pyproject.toml` and replace the `dependencies = [...]` and `[project.optional-dependencies]` blocks with this. Each line is annotated with **what actually uses it** (verified by scanning the codebase):

```toml
[project]
name = "phenotyping-backend"
version = "0.1.0"
description = "FastAPI backend for phenotyping ecosystem inference server"
readme = "README.md"
requires-python = ">=3.11"
license = { text = "MIT" }
authors = [
    { name = "Phenotyping Team" },
]

dependencies = [
    # ── Web framework ────────────────────────────────────────────────────────
    "fastapi>=0.115.0",                # app/main.py, app/routers/*
    "uvicorn[standard]>=0.30.0",       # ASGI worker class for gunicorn
    "gunicorn>=23.0.0",                # production process supervisor (§4.3)
    "python-multipart>=0.0.12",        # FastAPI file upload support (multipart/form-data)

    # ── Validation / settings ────────────────────────────────────────────────
    "pydantic>=2.9.0",                 # app/schemas/*, request/response models
    "pydantic-settings>=2.5.0",        # app/config.py settings class
    "email-validator>=2.2.0",          # required by pydantic.EmailStr (used in app/schemas/auth.py)
    "python-dotenv>=1.0.0",            # load .env.development when APP_ENV != production (§3.1)

    # ── Database / migrations ────────────────────────────────────────────────
    "sqlalchemy[asyncio]>=2.0.0",      # app/db, app/models, app/services
    "asyncpg>=0.30.0",                 # async Postgres driver used by sqlalchemy+asyncpg
    "alembic>=1.14.0",                 # alembic/ migrations directory

    # ── Inference / image processing ─────────────────────────────────────────
    "ultralytics>=8.3.0",              # app/services/inference/ — YOLOv8
    "torch>=2.4.0",                    # app/services/model_registry.py — pinned explicitly even though ultralytics also depends on it
    "opencv-python-headless>=4.10.0.84", # app/services/inference — `import cv2` (use -headless: no GUI deps)
    "numpy>=2.0.0",                    # app/services/inference — vectorized box ops

    # ── Auth ─────────────────────────────────────────────────────────────────
    "pyjwt>=2.9.0",                    # app/services/auth.py — `import jwt`
    "bcrypt>=4.2.0",                   # app/services/auth.py — password hashing

    # ── Misc ─────────────────────────────────────────────────────────────────
    "pyyaml>=6.0.2",                   # app/config.py — pipeline config.yaml read/write
    "openpyxl>=3.1.5",                 # app/routers/analyses.py — .xlsx export
    "websockets>=12.0",                # app/routers/logs.py, /stages — WS endpoints
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3.0",                   # tests/ runner
    "pytest-asyncio>=0.24.0",          # async test support
    "httpx>=0.27.2",                   # used by FastAPI TestClient in tests
    "ruff>=0.6.0",                     # linter
    "black>=24.8.0",                   # formatter
    "isort>=5.13.0",                   # import sorter
]
```

**What changed vs. the current file:**

| Added | Why |
|---|---|
| `gunicorn` | Production process supervisor (§4.3 uses it; the Dockerfile's `CMD` calls `gunicorn`). Without this, the prod image won't start. |
| `python-dotenv` | The `app/config.py` pattern in §3.1 needs it to load `.env.development` when `APP_ENV != "production"`. Production never imports it (early return in config.py). |
| `torch` (explicit) | Already pulled in by `ultralytics`, but `app/services/model_registry.py` `import torch` directly — pinning makes that contract explicit and prevents an ultralytics minor bump from silently swapping torch versions. |

**Removed** (none — everything currently listed is still used).

`httpx` appears in both `dependencies` and `dev` — that's intentional today (only tests use it; you could move it to `dev` only later if you confirm no app code calls `httpx` directly).

### 4.1.2 Install + lock

After saving `pyproject.toml`:

```bash
cd backend
pip install -e ".[dev]"     # runtime + dev tools — local development
# or
pip install -e .            # runtime only — what the production image installs
```

In CI and the Dockerfile we use the same command. There's no separate `requirements.txt` to keep in sync.

### 4.2 `backend/Dockerfile`

Create at `/home/minhtq/company_projects/phenotyping-ecosystem/backend/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.13-slim AS base

# ── Step 1: environment hygiene ──────────────────────────────────────────────
# PYTHONUNBUFFERED   – flush stdout/stderr immediately so docker logs see them
# PYTHONDONTWRITEBYTECODE – no .pyc clutter in the image
# PIP_NO_CACHE_DIR   – don't cache wheels in the image layer (smaller image)
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ── Step 2: system packages required by Python deps ──────────────────────────
# build-essential   – for any wheel that compiles C/C++ extensions
# libpq-dev         – asyncpg + psycopg compile against this
# libgl1, libglib   – OpenCV (cv2) runtime deps; opencv-python-headless still needs libgl
# curl              – used by the HEALTHCHECK below
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
        libgl1 \
        libglib2.0-0 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# ── Step 3: non-root user ────────────────────────────────────────────────────
# Containers should never run as root. We create `app` early so file ownership
# is correct from the start.
RUN useradd --create-home --shell /bin/bash app
WORKDIR /app

# ── Step 4: copy app source + metadata, then install ────────────────────────
# Hatchling's wheel build (declared in pyproject.toml under [tool.hatch.build...])
# requires the `app/` directory to exist at install time, so we copy code first
# and install second. To keep the install fast on rebuilds, we mount BuildKit's
# pip cache so wheels are reused across layer invalidations.
COPY pyproject.toml ./
COPY app ./app
COPY alembic.ini ./
COPY alembic ./alembic
COPY gunicorn.conf.py ./
COPY scripts ./scripts

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip && \
    pip install .

# ── Step 6: drop privileges ──────────────────────────────────────────────────
USER app

# ── Step 7: declare runtime contract ─────────────────────────────────────────
EXPOSE 8000

# APP_ENV=production is read by app/config.py to skip dotenv loading.
ENV APP_ENV=production

# Healthcheck — Docker swarm / compose / k8s probes call this.
# Hits the FastAPI /health route which already exists at app/routers/health.py.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

# Start under Gunicorn. Config (workers, timeouts, logging) lives in gunicorn.conf.py
# so you can tune without rebuilding the image (just bump GUNICORN_WORKERS env var).
CMD ["gunicorn", "app.main:app", "-c", "gunicorn.conf.py"]
```

### 4.3 `backend/gunicorn.conf.py`

Create at `/home/minhtq/company_projects/phenotyping-ecosystem/backend/gunicorn.conf.py`:

```python
"""Gunicorn config for production. Read at container startup."""
import os

# In normal container networking, bind to all container interfaces.
# In production host-network mode, set BACKEND_HOST=127.0.0.1 so the backend
# is reachable only through host nginx.
bind = f"{os.getenv('BACKEND_HOST', '0.0.0.0')}:{os.getenv('BACKEND_PORT', '8000')}"

# Worker count. ML inference loads the YOLO model per worker, so memory grows
# linearly. Start with 2; raise only after measuring with `docker stats`.
workers = int(os.getenv("GUNICORN_WORKERS", "2"))

# UvicornWorker is required for async FastAPI. Without it, async routes block
# the worker indefinitely.
worker_class = "uvicorn.workers.UvicornWorker"

# Recycle workers periodically to bound memory creep from long-running models.
max_requests = 1000
max_requests_jitter = 100

# Inference can take time. The default 30s timeout will kill mid-flight requests.
timeout = 120
graceful_timeout = 30
keepalive = 5

# Log to stdout/stderr so `docker logs` captures everything.
accesslog = "-"
errorlog = "-"
loglevel = os.getenv("LOG_LEVEL", "info").lower()

# preload_app=True would share model memory across workers via copy-on-write,
# but only if the lifespan/startup is fork-safe. The current backend opens DB
# connections in lifespan, which is NOT fork-safe. Keep this False unless you
# refactor to a post-fork init hook.
preload_app = False
```

### 4.4 `backend/.dockerignore`

Create at `/home/minhtq/company_projects/phenotyping-ecosystem/backend/.dockerignore`:

```gitignore
# Python build artefacts
__pycache__/
*.pyc
*.pyo
.pytest_cache/
.mypy_cache/
.ruff_cache/

# Virtualenvs (never copy these into the image)
.venv/
venv/

# Local-only files
.env
.env.local
*.log
data/

# Tests stay out of the production image
tests/

# IDE
.vscode/
.idea/
```

**Why a `.dockerignore`?** Without it, `COPY app ./app` and similar commands copy your local `__pycache__` and `.venv/` (potentially gigabytes) into the build context, slowing builds dramatically.

---

## 5. Frontend production setup

The frontend is **Vite + React**, building to a static `dist/` folder. Production serves those static files via nginx inside a small container. The `@tauri-apps/*` packages in `package.json` are present but there's no `src-tauri/` config — so this builds as a **standard web app**, not a Tauri desktop binary. Tauri is irrelevant for production deployment.

### 5.1 Lockfile — fix this first

Right now `phenotyping-client/` has **no lockfile** (`package-lock.json` is not committed, no `pnpm-lock.yaml`). That's a blocker for reproducible Docker builds. **Generate and commit a lockfile before doing anything else:**

```bash
cd phenotyping-client
npm install                  # creates package-lock.json
git add package-lock.json
git commit -m "chore: commit npm lockfile for reproducible builds"
```

The Dockerfile below uses `npm ci`, which **requires** `package-lock.json` to exist.

### 5.2 `phenotyping-client/Dockerfile`

Create at `/home/minhtq/company_projects/phenotyping-ecosystem/phenotyping-client/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

# ─── Stage 1: build the static bundle ────────────────────────────────────────
FROM node:lts-alpine AS build

WORKDIR /app

# Build args. These become env vars only during this build stage.
# Vite STRING-REPLACES these into the JS bundle at `npm run build` time.
# They are public — anything here is shipped to the user's browser.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

# Layer-cache deps separately from source. Changing src/ does not rebuild
# this layer because we copy metadata first. The BuildKit cache mount also
# preserves npm's download cache across layer invalidations (when the lockfile
# DOES change, only changed packages are re-downloaded, not all of them).
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Now copy the rest and build.
COPY . .
RUN npm run build

# ─── Stage 2: serve via nginx ────────────────────────────────────────────────
FROM nginx:1.30-alpine

# Replace the default site config with ours (SPA fallback + caching).
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy only the built static bundle from the previous stage.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost/ || exit 1
```

**Why two stages?** Stage 1 has the entire Node toolchain (~150 MB+). Stage 2 is just nginx (~20 MB) plus your static files. Final production image ships only the artifacts, not the build chain.

### 5.3 `phenotyping-client/nginx.conf`

Create at `/home/minhtq/company_projects/phenotyping-ecosystem/phenotyping-client/nginx.conf`:

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # SPA fallback: any unknown path returns index.html so React Router can
    # take over. Without this, deep-linking to /batches/123 returns 404.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Vite emits content-hashed filenames in /assets/, so they're safe to
    # cache forever — a content change produces a new filename.
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # Never cache index.html. New deploys reach users only when they
    # re-fetch this file with the new asset references.
    location = /index.html {
        add_header Cache-Control "no-store, no-cache, must-revalidate";
        expires 0;
    }

    # Security headers applied at the container nginx; the host nginx
    # adds nothing more at the edge (HTTP-only LAN deployment).
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript application/wasm image/svg+xml;
    gzip_min_length 1024;
}
```

### 5.4 `phenotyping-client/.dockerignore`

Create at `/home/minhtq/company_projects/phenotyping-ecosystem/phenotyping-client/.dockerignore`:

```gitignore
node_modules/
dist/
.parcel-cache/
.vite/
src-tauri/target/

# Local env files (gitignored anyway, but be defensive)
.env
.env.local
.env.*.local

# Tests / IDE
__tests__/
.vscode/
.idea/

# Logs
*.log
```

The `dist/` exclusion matters: you have a stale `dist/` from local builds; without this it would be copied into the build context and confuse the multi-stage build.

### 5.5 Why `VITE_API_BASE_URL=/api` (relative path)

In production, the frontend and backend are served from the **same origin** (e.g. `http://192.168.1.50/`). The host nginx routes:

- `/` → frontend container
- `/api/*` → backend container

So the JS bundle just calls `/api/auth/login` — no domain in the URL. Setting `VITE_API_BASE_URL=/api` at build time bakes that into the bundle.

---

## 5b. Caching strategy — the three layers

This deserves its own section because it's where most "why is the build slow" pain comes from. There are **three independent caches** working together; understanding which is which saves debugging.

### 5b.1 Layer 1 — Docker's built-in layer cache

This works **automatically** when you order the Dockerfile correctly: copy metadata (lockfiles, `pyproject.toml`, `package.json`) *before* source, install deps in its own `RUN`, then copy source.

| Backend | Frontend |
|---|---|
| `COPY pyproject.toml ./` then `pip install .` | `COPY package.json package-lock.json ./` then `npm ci` |
| App-only changes don't re-run `pip install`. | App-only changes don't re-run `npm ci`. |

Verify it's working: change a single file in `app/` (or `src/`) and rebuild — Docker should skip the install layer and only re-run `COPY app ./app` and below. You'll see `CACHED` next to the install step.

> **Backend caveat (already handled in §4.2):** because `pyproject.toml` declares hatchling with `packages = ["app"]`, the install needs `app/` to exist. We accept that any `app/` change invalidates the install layer — the BuildKit cache mount (Layer 2) makes that fast.

### 5b.2 Layer 2 — BuildKit cache mounts for pip / npm download caches

This is the `--mount=type=cache,target=...` line in each `RUN`. It mounts a daemon-persistent cache **only during that RUN**, so the contents survive across builds and layer invalidations.

| Tool | Cache target |
|---|---|
| pip | `/root/.cache/pip` |
| npm | `/root/.npm` |

When `pyproject.toml` or `package-lock.json` changes (and Layer 1 is invalidated), the install runs again — but downloads only the *new* packages. Existing wheels and tarballs are reused from the cache mount.

This requires `# syntax=docker/dockerfile:1.7` at the top of the Dockerfile (already there) and BuildKit enabled (default in Docker 23+).

### 5b.3 Layer 3 — GitHub Actions caches (cross-runner, cross-job)

Layers 1 and 2 only help when builds happen on the same machine. CI runners are ephemeral — every job starts on a fresh VM with no Docker daemon state. To carry caches across runs, the workflow uses **GHA's storage**.

There are two distinct GHA caches in this repo:

**a) `setup-python` / `setup-node` package caches** — wired in `ci.yml`:

```yaml
# Backend
- uses: actions/setup-python@v5
  with:
    python-version: "3.13"
    cache: pip
    cache-dependency-path: backend/pyproject.toml   # ← cache key derived from this file

# Frontend
- uses: actions/setup-node@v4
  with:
    node-version: "lts/*"
    cache: npm
    cache-dependency-path: phenotyping-client/package-lock.json
```

These cache pip's and npm's download directories at the runner OS level. When `pyproject.toml` (or `package-lock.json`) hasn't changed, `pip install -e ".[dev]"` and `npm ci` reuse the cached downloads — install in seconds instead of minutes.

**b) Docker BuildKit GHA cache** — wired in `ci.yml`'s `docker-stack-smoke` and in `deploy.yml`:

```yaml
- uses: docker/build-push-action@v7
  with:
    context: ./backend
    cache-from: type=gha,scope=backend
    cache-to: type=gha,scope=backend,mode=max
```

This stores **compiled Docker layers** in GHA's cache backend. Next run that hits the same `pyproject.toml` (or `package-lock.json`) gets the install layer back instantly — even on a brand-new runner. The `scope` separates backend and frontend caches so a frontend-only change doesn't bust the backend cache.

### 5b.4 What's NOT cached (and why that's fine)

- **`node_modules/`** is never committed and never restored from cache directly. `npm ci` is fast enough when the npm download cache (Layer 2 / 3a) is warm, and `node_modules/` has historically been a source of "works on my machine" subtle breakage.
- **`.venv/`** likewise. `pip install` from a warm wheel cache is fast.
- **`/var/lib/docker`** image layers between local laptop and CI — no, those are scoped to one daemon. That's what GHA Docker cache (3b) exists to bridge.

### 5b.5 How to check that caching is actually working

```bash
# Local: rebuild and watch for CACHED:
docker buildx build ./backend --progress=plain 2>&1 | grep -E "CACHED|RUN"

# CI: in the docker-stack-smoke job log, the "Build backend image" step shows
# "importing cache manifest from gha:..." when a cache hit happens, and
# individual layer lines show "CACHED" in the build progress.
```

A typical fully-warm build is **<30s** for backend, **<20s** for frontend. A fully-cold build (lockfile changed or first ever run) is **3–6 minutes** total. If a "small change" build takes minutes, the cache isn't being hit — most common cause is editing the Dockerfile itself (any change to a `RUN` command invalidates that layer and everything below).

---

## 6. `docker-compose.prod.yml` (server-only)

Create at `/home/minhtq/company_projects/phenotyping-ecosystem/docker-compose.prod.yml`:

```yaml
services:
  backend:
    image: ghcr.io/YOUR_GH_USER/phenotyping-backend:${IMAGE_TAG:-latest}
    restart: unless-stopped
    network_mode: host
    env_file:
      - /etc/phenotyping/.env.production
    environment:
      BACKEND_HOST: "127.0.0.1"
      BACKEND_PORT: "8000"
      GUNICORN_WORKERS: "2"
    volumes:
      - /var/lib/phenotyping/overlays:/data/overlays

  frontend:
    image: ghcr.io/YOUR_GH_USER/phenotyping-frontend:${IMAGE_TAG:-latest}
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:80"
```

**Per-line rationale:**

- `image: ghcr.io/...:${IMAGE_TAG:-latest}` → the deploy workflow sets `IMAGE_TAG` to the commit SHA so rollbacks just re-run with an older value.
- `network_mode: host` on the backend → lets the backend container connect to the Ubuntu Postgres service at `127.0.0.1:5432`.
- `env_file: - /etc/phenotyping/.env.production` → real secrets read from the host filesystem, never from the repo.
- `BACKEND_HOST: "127.0.0.1"` → because the backend uses host networking, bind Gunicorn only to localhost; host nginx is the LAN-facing entry point.
- `volumes:` for backend mount the host's `/var/lib/phenotyping/overlays` so generated overlay PNGs outlive container restarts.
- The frontend port still binds to `127.0.0.1` only. The host nginx (§8) is the public entry point.

Production Postgres is intentionally absent from this compose file. It runs directly on the server through Ubuntu's `postgresql` systemd service.

---

## 7. Ubuntu server setup

### 7.1 Find the server's LAN IP

The server lives inside your company network. Users will reach it at `http://<lan-ip>` directly — no DNS, no domain.

After installing Ubuntu, log in at the console (or via your hypervisor) and run:

```bash
# All IPv4 addresses on this machine:
hostname -I
# Example output: 192.168.1.50  172.17.0.1
# The first one is usually the LAN IP. 172.17.0.1 is Docker's default bridge — ignore.

# Per-interface detail (NIC name, netmask):
ip -4 addr show

# Default gateway and route table:
ip route show

# Listening sockets (after services come up):
sudo ss -tulpn
```

**Make the LAN IP static.** If your DHCP server hands out a different address next reboot, users lose access. Two options, pick one:

- **DHCP reservation** (preferred): in your router/DHCP admin, bind the server's MAC address to a fixed IP. Get the MAC from `ip link show`.
- **Static IP on the server itself** via netplan. Edit `/etc/netplan/50-cloud-init.yaml` (or whichever file is there):
  ```yaml
  network:
    version: 2
    ethernets:
      ens18: # your NIC name from `ip link show`
        dhcp4: false
        addresses: [192.168.1.50/24]
        routes:
          - to: default
            via: 192.168.1.1 # your gateway
        nameservers:
          addresses: [192.168.1.1, 1.1.1.1]
  ```
  ```bash
  sudo netplan apply
  ```

Verify outbound internet works (the runner needs it to talk to GitHub, and Docker needs it to pull images):

```bash
curl -fsSI https://api.github.com | head -1     # should print HTTP/2 200
curl -fsSI https://ghcr.io | head -1            # should print HTTP/2 200 or 301
```

Tell users to bookmark `http://<lan-ip>` (or, optionally, add a line to each laptop's `/etc/hosts` like `192.168.1.50  phenotyping` so they can type `http://phenotyping`).

### 7.2 SSH in for the first time

From a workstation on the same LAN:

```bash
ssh root@192.168.1.50         # or whatever your server's LAN IP is
```

If the installer set up a non-root user (e.g. `ubuntu`), use that and `sudo` for the steps below.

### 7.3 Create a deploy user, lock down SSH

Running services as `root` is a footgun. Create an unprivileged user:

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy

# Copy your laptop's pubkey for the deploy user.
mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
# Paste the contents of ~/.ssh/id_ed25519.pub from your laptop:
nano /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh

# Test from a SECOND terminal on your laptop BEFORE locking root out:
#   ssh deploy@192.168.1.50
# Confirm sudo works: `sudo -v`

# Disable root SSH and password auth.
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

From now on, always SSH as `deploy@<lan-ip>`.

### 7.4 Firewall (UFW)

Internal LAN — only port 22 (SSH) and 80 (HTTP) need to be open. Skip 443 since there's no HTTPS.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp           # HTTP only
sudo ufw --force enable
sudo ufw status verbose
```

If you later restrict access further (e.g. SSH only from one admin subnet), use:

```bash
sudo ufw allow from 192.168.10.0/24 to any port 22
```

This is **defense in depth** — the frontend container binds to `127.0.0.1`, the backend binds to `127.0.0.1` through host networking, and Postgres keeps its default local-only listener. UFW guarantees nothing else is exposed if you misconfigure later.

### 7.5 Auto security updates

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

This applies security patches automatically without rebooting (kernel updates need a reboot, scheduled separately).

### 7.6 Install Postgres and Docker

Production Postgres runs directly on Ubuntu, not inside Docker.

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
sudo systemctl status postgresql --no-pager
```

Create the application database and user. Use the strong DB password you generated in §3.3:

```bash
sudo -u postgres psql
```

```sql
CREATE USER phenotyping WITH PASSWORD 'YOUR_DB_PASSWORD';
CREATE DATABASE phenotyping OWNER phenotyping;
\q
```

Keep Postgres local to the server. Do not open port `5432` in UFW. The backend container uses host networking in production, so it connects to this local Postgres service at `127.0.0.1:5432`.

Now install Docker for the backend/frontend containers.

The Ubuntu-shipped `docker.io` package is older than upstream. Use Docker's convenience script:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker deploy

# Log out and back in (or `newgrp docker`) for group change to take effect.
docker --version          # should show 27.x or newer
docker compose version    # 2.30+ — note: `docker compose` (space), not `docker-compose`
```

Configure log rotation so `/var/lib/docker/containers/*.log` doesn't fill the disk:

```bash
sudo nano /etc/docker/daemon.json
```

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "5"
  }
}
```

```bash
sudo systemctl restart docker
```

### 7.7 Create directories and place secrets

```bash
sudo mkdir -p /opt/phenotyping
sudo mkdir -p /etc/phenotyping
sudo mkdir -p /var/lib/phenotyping/overlays
sudo mkdir -p /var/backups/phenotyping

sudo chown -R deploy:deploy /opt/phenotyping /var/lib/phenotyping
sudo chown root:deploy /etc/phenotyping
sudo chmod 750 /etc/phenotyping
```

Drop the secret env file:

```bash
sudo nano /etc/phenotyping/.env.production
```

Paste — substitute your real generated secrets from §3.3:

```bash
APP_ENV=production
LOG_LEVEL=INFO

DATABASE_URL=postgresql+asyncpg://phenotyping:YOUR_DB_PASSWORD@127.0.0.1:5432/phenotyping

DATA_DIR=/data
IMAGE_STORAGE_DIR=/data/overlays

JWT_ACCESS_SECRET=YOUR_GENERATED_ACCESS_SECRET
JWT_REFRESH_SECRET=YOUR_GENERATED_REFRESH_SECRET_DIFFERENT
JWT_ALGORITHM=HS256
JWT_ACCESS_TTL_MIN=15
JWT_REFRESH_TTL_DAYS=30
```

> If `PIPELINE_ROOT` is still in `backend/app/config.py` as a required var, either remove it from config.py (preferred — it's no longer used) or set it to a placeholder here so the app can still boot.

Lock it down:

```bash
sudo chown root:deploy /etc/phenotyping/.env.production
sudo chmod 640 /etc/phenotyping/.env.production
```

Clone the repo:

```bash
cd /opt/phenotyping
git clone https://github.com/YOUR_GH_USER/phenotyping-ecosystem.git .
```

The deploy workflow (§9.4) keeps `/opt/phenotyping` in sync with `main` via `rsync` on every deploy, so this initial clone is just a seed.

Drop the compose-substitution `.env`:

```bash
nano /opt/phenotyping/.env
```

```bash
IMAGE_TAG=latest
```

```bash
chmod 600 /opt/phenotyping/.env
```

---

## 8. Host nginx (HTTP only — internal LAN)

The server runs **two layers of nginx**:

1. **Host nginx** (this section) — listens on port 80, routes traffic to the containers. No TLS.
2. **Container nginx** (inside the frontend container) — serves the SPA on its internal port 80, applies the SPA fallback rules.

This split keeps the public/private split clean (the host can be reconfigured without touching containers) and lets you add TLS later without re-architecting.

> **Why HTTP is acceptable here.** Traffic only crosses your office LAN — never the public internet. Without TLS you give up: secure cookies, Service Workers, the Web Crypto API, and the browser's HTTPS-only features. The current app doesn't depend on any of those, so the tradeoff is fine. If a compliance requirement later forces TLS, see §8.4.

### 8.1 Install nginx

```bash
sudo apt install -y nginx
# No certbot needed — there are no certificates to manage.
```

### 8.2 Site config

Create `/etc/nginx/sites-available/phenotyping`:

```nginx
server {
    listen 80;
    listen [::]:80;
    # Match any Host header. With server_name _ this block answers any LAN
    # request that lands on port 80 of this machine — IP, /etc/hosts alias,
    # internal hostname all work.
    server_name _;

    # Match your largest expected upload (see backend's settings).
    client_max_body_size 100M;

    # Frontend (SPA bundle).
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Backend API. /api/* on the public side maps to / on the backend.
    # Trailing slash on `proxy_pass` is critical — it strips /api before forwarding.
    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 120s;   # inference can be slow
        proxy_send_timeout 120s;
    }

    # WebSocket upgrade for /ws/* routes (logs, stage events).
    location /api/ws/ {
        proxy_pass http://127.0.0.1:8000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Light defensive headers (these don't require HTTPS).
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
}
```

### 8.3 Enable + reload

```bash
sudo ln -s /etc/nginx/sites-available/phenotyping /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t          # syntax check — must pass before reload
sudo systemctl reload nginx
```

Verify from another machine on the LAN:

```bash
curl -I http://192.168.1.50/        # should print HTTP/1.1 200 OK
curl http://192.168.1.50/api/health # backend health check
```

### 8.4 Adding HTTPS later (when you need it)

If a compliance requirement, browser feature need, or external user push forces TLS later, your two clean options are:

1. **Internal CA / mkcert** — generate a root cert, install it on every client laptop, then issue a server cert. One-time setup, zero ongoing cost. Real green padlock for users with the root installed; warning for everyone else.
2. **Public Let's Encrypt via DNS-01** — buy a public domain, point an A record at your LAN IP (`split-horizon DNS` so it only resolves internally), use certbot's `--preferred-challenges dns` with your DNS provider's API. Real public cert, no inbound exposure required.

Either way you'll add the existing `listen 443 ssl http2` block and the cert paths to the same `phenotyping` site config. Keep the `:80` server block as a redirect at that point.

---

## 9. GitHub Actions CI/CD

### 9.1 The flow you wanted

```
your laptop                      GitHub                       Ubuntu server
───────────                      ──────                       ─────────────
git push -u origin feat/X        Open PR against main
                                       │
                                       ▼
                              ci.yml runs (PR gate):
                                • detect changed backend/frontend paths
                                • backend lint + tests when backend-relevant files changed
                                • frontend tsc + tests when frontend-relevant files changed
                                • build BOTH Docker images
                                • run full stack
                                • health-check /health + /
                                       │
                              ◄────── ❌ if any fails: PR blocked
                                       │
                                       ▼ all green + 1 review
                              Squash & merge to main
                                       │
                                       ▼
                              deploy.yml runs:
                                • build + tag with SHA
                                • push to GHCR
                                • SSH to server  ────────► docker pull
                                                          alembic upgrade head
                                                          docker compose up -d
                                                          (~5–10s downtime)
```

`main` only ever contains code that passed the full Docker stack test. The server only ever runs images built from a `main` commit.

### 9.2 Branch protection (one-time, GitHub UI)

**Settings → Rules → Rulesets → New branch ruleset**:

- **Target branches**: `main`
- ☑ Require a pull request before merging
  - Required approvals: **1**
  - ☑ Dismiss stale approvals on new commits
- ☑ Require status checks to pass
  - ☑ Require branches to be up to date
  - **Required check** (this name must match `jobs.<id>` in the workflow):
    - `ci-success`
- ☑ Require conversation resolution
- ☑ Block force pushes
- ☑ Restrict deletions

The workflows below alone don't enforce anything — this ruleset is what makes the gate real. Require only `ci-success`, not the individual component jobs. `backend-checks` and `frontend-checks` can be skipped by path filters, and a skipped required check can otherwise leave a PR blocked.

### 9.3 `.github/workflows/ci.yml`

Create at `/home/minhtq/company_projects/phenotyping-ecosystem/.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

# Cancel superseded runs on the same ref to save minutes.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      backend: ${{ steps.filter.outputs.backend }}
      frontend: ${{ steps.filter.outputs.frontend }}
    steps:
      - uses: actions/checkout@v4

      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            backend:
              - 'backend/**'
              - 'docker-compose.yml'
              - 'docker-compose.prod.yml'
              - '.github/workflows/**'
              - '.cursor/rules/api-contract.mdc'
            frontend:
              - 'phenotyping-client/**'
              - 'docker-compose.yml'
              - 'docker-compose.prod.yml'
              - '.github/workflows/**'
              - '.cursor/rules/api-contract.mdc'

  backend-checks:
    needs: changes
    if: needs.changes.outputs.backend == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
          cache: pip
          cache-dependency-path: backend/pyproject.toml

      - name: Install backend
        working-directory: backend
        run: pip install -e ".[dev]"

      - name: Lint
        working-directory: backend
        run: |
          ruff check app/
          black --check app/
          isort --check-only app/

      - name: Unit tests
        working-directory: backend
        run: pytest tests/ -v --maxfail=3

  frontend-checks:
    needs: changes
    if: needs.changes.outputs.frontend == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "lts/*"
          cache: npm
          cache-dependency-path: phenotyping-client/package-lock.json

      - name: Install
        working-directory: phenotyping-client
        run: npm ci

      - name: Type check
        working-directory: phenotyping-client
        run: npx tsc --noEmit

      - name: Tests
        working-directory: phenotyping-client
        run: npm test

      - name: Build
        working-directory: phenotyping-client
        env:
          VITE_API_BASE_URL: /api
        run: npm run build

  docker-stack-smoke:
    runs-on: ubuntu-latest
    needs: [changes, backend-checks, frontend-checks]
    if: always() && needs.changes.result == 'success'
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - name: Build backend image (load locally)
        uses: docker/build-push-action@v7
        with:
          context: ./backend
          load: true
          tags: phenotyping-backend:ci
          cache-from: type=gha,scope=backend
          cache-to: type=gha,scope=backend,mode=max

      - name: Build frontend image (load locally)
        uses: docker/build-push-action@v7
        with:
          context: ./phenotyping-client
          load: true
          tags: phenotyping-frontend:ci
          build-args: |
            VITE_API_BASE_URL=/api
          cache-from: type=gha,scope=frontend
          cache-to: type=gha,scope=frontend,mode=max

      - name: Write CI compose override
        run: |
          cat > docker-compose.ci.yml <<'YAML'
          services:
            postgres:
              image: postgres:16-alpine
              environment:
                POSTGRES_USER: phenotyping
                POSTGRES_PASSWORD: ci_password
                POSTGRES_DB: phenotyping
              healthcheck:
                test: ["CMD-SHELL", "pg_isready -U phenotyping"]
                interval: 5s
                timeout: 3s
                retries: 10

            backend:
              image: phenotyping-backend:ci
              environment:
                APP_ENV: production
                LOG_LEVEL: INFO
                DATABASE_URL: postgresql+asyncpg://phenotyping:ci_password@postgres:5432/phenotyping
                DATA_DIR: /data
                IMAGE_STORAGE_DIR: /data/overlays
                JWT_ACCESS_SECRET: ci-access-secret-not-for-prod
                JWT_REFRESH_SECRET: ci-refresh-secret-not-for-prod
                JWT_ALGORITHM: HS256
                JWT_ACCESS_TTL_MIN: "15"
                JWT_REFRESH_TTL_DAYS: "30"
                GUNICORN_WORKERS: "1"
              ports:
                - "8000:8000"
              depends_on:
                postgres:
                  condition: service_healthy

            frontend:
              image: phenotyping-frontend:ci
              ports:
                - "8080:80"
          YAML

      - name: Run migrations
        run: docker compose -f docker-compose.ci.yml run --rm backend alembic upgrade head

      - name: Start stack
        run: docker compose -f docker-compose.ci.yml up -d

      - name: Wait for backend health
        run: |
          for i in {1..30}; do
            if curl -fsS http://localhost:8000/health; then echo "✓ backend healthy"; exit 0; fi
            echo "  waiting ($i/30)..."; sleep 2
          done
          echo "✗ backend never became healthy"
          docker compose -f docker-compose.ci.yml logs backend
          exit 1

      - name: Wait for frontend
        run: |
          for i in {1..15}; do
            if curl -fsS -o /dev/null http://localhost:8080/; then echo "✓ frontend serving"; exit 0; fi
            echo "  waiting ($i/15)..."; sleep 2
          done
          echo "✗ frontend never responded"
          docker compose -f docker-compose.ci.yml logs frontend
          exit 1

      - name: Smoke API
        run: |
          status=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8000/auth/login)
          if [[ "$status" =~ ^5 ]]; then
            echo "✗ /auth/login 5xx"
            docker compose -f docker-compose.ci.yml logs backend
            exit 1
          fi
          curl -fsS http://localhost:8000/openapi.json > /dev/null
          echo "✓ /auth/login=$status, /openapi.json reachable"

      - name: Dump logs on failure
        if: failure()
        run: docker compose -f docker-compose.ci.yml logs

      - name: Tear down
        if: always()
        run: docker compose -f docker-compose.ci.yml down -v

  ci-success:
    runs-on: ubuntu-latest
    needs: [changes, backend-checks, frontend-checks, docker-stack-smoke]
    if: always()
    steps:
      - name: Verify required jobs passed
        run: |
          fail=0
          # Skipped component jobs are OK: the path filter said they were irrelevant.
          # Failed, cancelled, or unexpectedly skipped infrastructure jobs are not OK.
          for r in '${{ needs.backend-checks.result }}' \
                   '${{ needs.frontend-checks.result }}'; do
            if [[ "$r" == "failure" || "$r" == "cancelled" ]]; then
              fail=1
            fi
          done
          for r in '${{ needs.changes.result }}' \
                   '${{ needs.docker-stack-smoke.result }}'; do
            if [[ "$r" != "success" ]]; then
              fail=1
            fi
          done
          exit $fail
```

This keeps frontend-only PRs from spending time on backend lint and unit tests, and backend-only PRs from spending time on TypeScript and Vite checks. `docker-stack-smoke` still builds both images and boots the full stack on every PR because it is the integration contract between the two halves of the monorepo.

### 9.4 `.github/workflows/deploy.yml`

Create at `/home/minhtq/company_projects/phenotyping-ecosystem/.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch: # manual trigger from Actions tab

env:
  REGISTRY: ghcr.io
  BACKEND_IMAGE: ${{ github.repository_owner }}/phenotyping-backend
  FRONTEND_IMAGE: ${{ github.repository_owner }}/phenotyping-frontend

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      image_tag: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4

      - id: meta
        run: echo "tag=${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build & push backend
        uses: docker/build-push-action@v7
        with:
          context: ./backend
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.BACKEND_IMAGE }}:${{ steps.meta.outputs.tag }}
            ${{ env.REGISTRY }}/${{ env.BACKEND_IMAGE }}:latest
          cache-from: type=gha,scope=backend-deploy
          cache-to: type=gha,scope=backend-deploy,mode=max

      - name: Build & push frontend
        uses: docker/build-push-action@v7
        with:
          context: ./phenotyping-client
          push: true
          build-args: |
            VITE_API_BASE_URL=/api
          tags: |
            ${{ env.REGISTRY }}/${{ env.FRONTEND_IMAGE }}:${{ steps.meta.outputs.tag }}
            ${{ env.REGISTRY }}/${{ env.FRONTEND_IMAGE }}:latest
          cache-from: type=gha,scope=frontend-deploy
          cache-to: type=gha,scope=frontend-deploy,mode=max

  deploy:
    needs: build-and-push
    # Runs on the SELF-HOSTED runner installed on the server in §9.7.
    # Because the runner IS the server, we don't SSH anywhere — we just run
    # docker compose locally. The runner service is configured to run as the
    # `deploy` user with docker group membership.
    runs-on: [self-hosted, phenotyping-prod]
    steps:
      - uses: actions/checkout@v4

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Pull latest code into /opt/phenotyping
        run: |
          # Workspace is the runner's checkout — but compose files live in
          # /opt/phenotyping (where secrets live in the parent /etc/phenotyping).
          # Sync the relevant files from the checkout into /opt/phenotyping
          # so the production directory tracks main.
          sudo -n rsync -a --delete \
            --exclude='.git' \
            --exclude='node_modules' \
            --exclude='__pycache__' \
            "$GITHUB_WORKSPACE/" /opt/phenotyping/

      - name: Deploy
        working-directory: /opt/phenotyping
        env:
          IMAGE_TAG: ${{ needs.build-and-push.outputs.image_tag }}
        run: |
          set -euo pipefail
          # Persist the tag so subsequent `docker compose` calls use it.
          if grep -q '^IMAGE_TAG=' .env; then
            sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${IMAGE_TAG}/" .env
          else
            echo "IMAGE_TAG=${IMAGE_TAG}" >> .env
          fi

          docker compose -f docker-compose.prod.yml pull
          docker compose -f docker-compose.prod.yml run --rm backend alembic upgrade head
          docker compose -f docker-compose.prod.yml up -d
          docker image prune -f
```

### 9.5 GitHub repo secrets

The internal-only setup needs **no SSH secrets**. The self-hosted runner runs locally on the server, and `GITHUB_TOKEN` (auto-provided) is enough to log in to GHCR and pull images.

You only need to manage:

| Where                                      | What                             | Why                                                  |
| ------------------------------------------ | -------------------------------- | ---------------------------------------------------- |
| GitHub repo Actions secrets                | (none required)                  | The runner IS the server. No SSH key, no `SSH_HOST`. |
| Server: `/etc/phenotyping/.env.production` | Real backend env                 | Mounted into the backend container.                  |
| Server: `/opt/phenotyping/.env`            | `IMAGE_TAG`                      | Compose variable substitution.                       |

### 9.6 GHCR pulls on the server

Because the deploy job logs in to GHCR via `docker/login-action@v3` _inside the workflow run_ (using the auto-provided `GITHUB_TOKEN`), the `docker compose pull` that follows uses those credentials. You do **not** need to manually `docker login` on the server, and the previous draft's `/etc/phenotyping/ghcr_token` is no longer needed.

If you ever pull manually from the server (e.g. for debugging), generate a one-off PAT with `read:packages` and run `docker login ghcr.io` interactively then.

### 9.7 Install the self-hosted runner on the server

Run this once on the Ubuntu server. It registers the server as a runner GitHub can dispatch jobs to.

```bash
# 1. Switch to the deploy user (the runner should NOT run as root).
sudo su - deploy
mkdir -p ~/actions-runner && cd ~/actions-runner

# 2. Get the latest runner. Check https://github.com/actions/runner/releases
#    for the current version, or use the API to fetch the latest tag:
LATEST=$(curl -s https://api.github.com/repos/actions/runner/releases/latest \
         | grep -oP '"tag_name":\s*"\Kv[^"]+')
ARCH=$(dpkg --print-architecture)        # amd64 or arm64
RUNNER_PKG="actions-runner-linux-${ARCH/amd64/x64}-${LATEST#v}.tar.gz"
curl -O -L "https://github.com/actions/runner/releases/download/${LATEST}/${RUNNER_PKG}"
tar xzf "$RUNNER_PKG"

# 3. Get a registration token from GitHub:
#    Repo → Settings → Actions → Runners → New self-hosted runner
#    The page shows the exact ./config.sh command including a one-time token.
#    It looks like:
#       ./config.sh --url https://github.com/YOUR_GH_USER/phenotyping-ecosystem \
#                   --token AAAA...
#    When prompted:
#       Runner group: Default
#       Runner name : phenotyping-prod
#       Labels      : phenotyping-prod          ← matches `runs-on:` in deploy.yml
#       Work folder : _work                     (default)

# 4. Install as a systemd service so it survives reboots and runs unattended.
exit                                    # back to your sudo user
cd /home/deploy/actions-runner
sudo ./svc.sh install deploy            # registers as systemd unit `actions.runner.<repo>.<name>`
sudo ./svc.sh start
sudo ./svc.sh status                    # should show: active (running)

# 5. Confirm in GitHub: repo → Settings → Actions → Runners.
#    The runner should be listed as "Idle".
```

**Make sure `deploy` can use Docker without sudo** (already done in §7.6 with `usermod -aG docker deploy`). Verify:

```bash
sudo -u deploy docker ps
```

**One last permission**: the deploy step does `sudo -n rsync ...` to sync the workspace into `/opt/phenotyping`. Allow the deploy user passwordless sudo for just that:

```bash
sudo visudo -f /etc/sudoers.d/deploy-rsync
```

Paste:

```
deploy ALL=(ALL) NOPASSWD: /usr/bin/rsync
```

```bash
sudo chmod 440 /etc/sudoers.d/deploy-rsync
```

> **Why a self-hosted runner is fine here.** The runner only accepts jobs from your own repo. Treat it like any production service: keep the OS patched (§7.5 already handles this), don't add untrusted collaborators to the repo, never set `runs-on: self-hosted` on a workflow that runs on `pull_request` from forks. Branch protection (§9.2) prevents that path because forked PRs can't merge to main.

---

## 10. First deploy (manual, one time)

After §1–9 are complete, push your changes to a branch, get the PR merged via the gated flow, and let `deploy.yml` run on the self-hosted runner. **The very first time, also run these once on the server** to seed everything (later runs are fully automated by `deploy.yml`):

```bash
ssh deploy@192.168.1.50
cd /opt/phenotyping

# One-off interactive GHCR login (only needed for the first manual seed).
# Use a PAT with read:packages scope.
docker login ghcr.io -u YOUR_GH_USER

# Pull the images that CI pushed when main was merged.
docker compose -f docker-compose.prod.yml pull

# Run migrations once before the app starts.
docker compose -f docker-compose.prod.yml run --rm backend alembic upgrade head

# Bring everything up.
docker compose -f docker-compose.prod.yml up -d

# Verify.
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f backend
curl -fsS http://192.168.1.50/api/health
```

After this, every merge to `main` triggers `deploy.yml`, which logs in to GHCR via `GITHUB_TOKEN`, pulls, migrates, and rolls the stack — no manual steps.

---

## 11. Day-to-day workflow

```bash
# 1. Always branch off the latest main.
git checkout main && git pull --ff-only
git checkout -b feat/short-description

# 2. Code, commit, push.
git push -u origin feat/short-description

# 3. Open a PR (gh CLI or web UI).
gh pr create --base main

# 4. Watch CI under the PR's Checks tab. Branch protection blocks merge until:
#       ✓ ci-success, 1 review.

# 5. Squash & merge → deploy.yml fires automatically on the self-hosted runner.
#       Watch under the repo's Actions tab.

# 6. Verify after the run shows green:
curl -fsS http://192.168.1.50/api/health
# then click around the changed feature in your browser at http://192.168.1.50/.
```

---

## 12. Operations

### 12.1 Rolling back

Image tags are short SHAs. To roll back without a code change:

```bash
ssh deploy@192.168.1.50
cd /opt/phenotyping
# Set IMAGE_TAG to the desired SHA (find it in GHCR → Packages, or git log on main).
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=abc1234/" .env
docker compose -f docker-compose.prod.yml up -d
```

For a full rollback through GitHub (rerun the deploy at an earlier commit), use **Actions → Deploy → Run workflow** with the older ref selected (`workflow_dispatch` is enabled on the workflow).

### 12.2 Logs

```bash
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs --tail=200 frontend
```

### 12.3 Health checks

```bash
curl -fsS http://192.168.1.50/api/health            # backend
curl -I http://192.168.1.50/                        # frontend
pg_isready -h 127.0.0.1 -p 5432 -U phenotyping -d phenotyping
systemctl status postgresql --no-pager
docker stats --no-stream                            # CPU/RAM per container
df -h /var/lib/phenotyping                          # overlay disk usage
```

### 12.4 Database backups

`sudo crontab -e`:

```cron
0 3 * * * /usr/sbin/runuser -u postgres -- pg_dump -d phenotyping | gzip > /var/backups/phenotyping/db-$(date +\%F).sql.gz
0 4 * * 0 find /var/backups/phenotyping -name 'db-*.sql.gz' -mtime +30 -delete
```

For the overlays directory + off-site copies, look at `restic` or `rclone` to S3-compatible storage. Out of scope here.

---

## 13. `.gitignore` fixes

Your current `.gitignore` has three issues to fix. Edit `/home/minhtq/company_projects/phenotyping-ecosystem/.gitignore`:

1. **Don't ignore `backend/alembic.ini`** — migrations need it. Remove the line `backend/alembic.ini`.
2. **The current rule ignores `.env.production` globally**, which clashes with this guide's two-file strategy. We track `.env.development` and `.env.production` in both projects (no `.env`, no `.env.example`). Replace the env block with:

   ```gitignore
   # Env strategy: track .env.development and .env.production in each project.
   # Ignore only personal/local overrides and any bare .env that someone might
   # accidentally create.
   .env
   .env.local
   .env.*.local
   ```

   You **don't** need `!`-rules to un-ignore the tracked files — there's no rule ignoring them now.

3. **The `*.md` then `!*.md` lines cancel each other** — delete both. They currently do nothing.

After editing, verify what git would track:

```bash
git check-ignore -v backend/.env.development backend/.env.production \
  phenotyping-client/.env.development phenotyping-client/.env.production
# All four should print "::" (unmatched = NOT ignored), not a rule.
```

---

## 14. Pre-launch checklist

Run through this the morning of launch. Don't skip any.

- [ ] Server has a static LAN IP (DHCP reservation or netplan).
- [ ] Server resolves outbound DNS and reaches `api.github.com` and `ghcr.io`.
- [ ] `/etc/phenotyping/.env.production` has real, distinct, 32+ byte JWT secrets (not dev defaults).
- [ ] `/etc/phenotyping/.env.production` is `root:deploy` with mode `640`.
- [ ] Postgres password is strong, stored in a password manager, not in any commit.
- [ ] Ubuntu Postgres service is active, local-only, and the `phenotyping` DB/user exist.
- [ ] Frontend `package-lock.json` committed.
- [ ] Backend `Dockerfile`, `gunicorn.conf.py`, `.dockerignore` committed.
- [ ] Frontend `Dockerfile`, `nginx.conf`, `.dockerignore` committed.
- [ ] `docker-compose.prod.yml` committed.
- [ ] `.github/workflows/ci.yml` and `deploy.yml` committed.
- [ ] Branch protection ruleset on `main` requires `ci-success`.
- [ ] Self-hosted runner registered, labeled `phenotyping-prod`, and showing **Idle** in repo Settings → Actions → Runners.
- [ ] Runner installed as a systemd service (`sudo ./svc.sh status` shows active).
- [ ] `deploy` user is in the `docker` group (`groups deploy` shows docker).
- [ ] `/etc/sudoers.d/deploy-rsync` allows passwordless `rsync`.
- [ ] First deploy via Actions completed; `curl http://<lan-ip>/api/health` returns 200 from another LAN host.
- [ ] Login flow end-to-end works at `http://<lan-ip>/`.
- [ ] WebSockets connect (open the app's Logs panel in browser DevTools → Network → WS — should show 101 status).
- [ ] File upload works at the size limit you set (`client_max_body_size 100M`).
- [ ] `pg_dump` cron installed and a test backup successfully restored to a scratch DB.
- [ ] UFW only allows 22 / 80 (`sudo ufw status`).
- [ ] `unattended-upgrades` enabled.
- [ ] Rollback drill: redeploy with `IMAGE_TAG=<older-sha>` and confirm the older version comes up.

---

## 15. Common gotchas

**Frontend can't reach the API.**
The Vite build bakes `VITE_API_BASE_URL` at build time. The Dockerfile defaults to `/api`, which is correct because the host nginx proxies `/api/*` to the backend on the same origin. If you ever build the frontend with a different value, rebuild the image.

**Backend boots, then crashes immediately with `RuntimeError: Missing required env var`.**
Compose isn't loading `/etc/phenotyping/.env.production`. Check that `env_file:` is present in `docker-compose.prod.yml`, the path is exactly that, the file is owned by `root:deploy` with mode `640`, and `/etc/phenotyping` is `root:deploy` with mode `750`. The `docker compose` CLI runs as `deploy`, so it must be able to read the env file.

**Backend cannot connect to Postgres.**
Production Postgres runs on the Ubuntu host, not in Docker. Check that `DATABASE_URL` in `/etc/phenotyping/.env.production` uses `127.0.0.1:5432`, that `network_mode: host` is set on the backend service, and that `sudo systemctl status postgresql` is active. Test from the server with `pg_isready -h 127.0.0.1 -p 5432 -U phenotyping -d phenotyping`.

**WebSockets disconnect right after connecting.**
Host nginx is missing the `Upgrade`/`Connection` headers. Verify the `/api/ws/` block exists. Test:

```bash
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  http://192.168.1.50/api/ws/logs
```

Look for `HTTP/1.1 101 Switching Protocols`.

**Self-hosted runner shows "Offline" in GitHub.**
The systemd service died. `sudo systemctl status 'actions.runner.*'`, then `sudo journalctl -u 'actions.runner.*' -n 200`. Most common causes: server rebooted and the runner service didn't auto-start (then `sudo ./svc.sh install` wasn't run — re-run it), or the runner's auth token expired (re-register from GitHub's runner page).

**Deploy job fails with `permission denied while trying to connect to the Docker daemon socket`.**
The runner is running as `deploy` but `deploy` isn't in the `docker` group, or the group change hasn't taken effect for the running service. Run `sudo usermod -aG docker deploy && sudo systemctl restart 'actions.runner.*'`.

**Deploy job fails with `sudo: a password is required`.**
The `/etc/sudoers.d/deploy-rsync` file is missing or has wrong syntax. `sudo visudo -c` to validate. The line must be exactly: `deploy ALL=(ALL) NOPASSWD: /usr/bin/rsync` (check `which rsync` matches the path).

**Docker disk filling up.**
`docker system df` will show old image bloat. The deploy workflow includes `docker image prune -f`. Run weekly via cron if you ship many builds.

**Models reload slowly after every container restart.**
With `preload_app=False`, each gunicorn worker loads YOLO on first request. Tradeoff: faster startup, slower first inference per worker. If memory allows, set `preload_app=True` after auditing that startup is fork-safe (move DB connection init to `post_fork` hook).

**`docker compose` says "no service selected" or "yaml: line N: did not find expected key".**
Wrong file — make sure you're using `-f docker-compose.prod.yml` on the server, not the dev file.

**CI smoke test passes locally but fails in GitHub.**
Almost always: a file the local docker daemon already has but isn't in git. Check that everything Dockerfile copies is committed.

---

## Sources (latest verified 2026-04-27)

- [Python official Docker images](https://hub.docker.com/_/python) — `python:3.13-slim`
- [Node official Docker images](https://hub.docker.com/_/node) — `node:lts-alpine` is Node 24
- [nginx official Docker images](https://hub.docker.com/_/nginx) — `nginx:1.30-alpine` (stable)
- Ubuntu `postgresql` packages — production DB runs on the server, not in Docker
- [Ubuntu 26.04 LTS release notes](https://documentation.ubuntu.com/release-notes/26.04/) — Apr 23, 2026
- [docker/build-push-action releases](https://github.com/docker/build-push-action/releases) — v7
- [Docker Build CI docs](https://docs.docker.com/build/ci/github-actions/)
- [pythonspeed: best Python base image (Feb 2026)](https://pythonspeed.com/articles/base-image-python-docker-images/)
