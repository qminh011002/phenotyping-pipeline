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

# ── Step 4a: install third-party deps FIRST ──────────────────────────────────
# Splitting deps install from source copy means: changing app/ code doesn't
# invalidate the (~1 GB) torch/ultralytics layer. Only a pyproject.toml change
# busts this cache.
COPY pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip && \
    pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision && \
    python -c "import tomllib; d=tomllib.load(open('pyproject.toml','rb')); print('\n'.join(d['project']['dependencies']))" > /tmp/requirements.txt && \
    pip install -r /tmp/requirements.txt

# ── Step 4b: copy source (the layer that actually changes per commit) ────────
COPY app ./app
COPY alembic.ini ./
COPY alembic ./alembic
COPY gunicorn.conf.py ./
COPY scripts ./scripts

# ── Step 4c: install the local package itself (deps already satisfied) ───────
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps .

# Make entrypoint executable (in case host filesystem stripped the +x bit).
RUN chmod +x /app/scripts/entrypoint.sh

# Runtime data is written by the non-root app user:
# - /data/inference_config.yaml is seeded on first startup
# - /data/models/... stores default/custom model weights
# - /data/overlays/... stores generated overlay images
RUN mkdir -p /data/models /data/overlays && chown -R app:app /data

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

# Entrypoint runs `alembic upgrade head` then execs CMD. Keep CMD separate so it
# can still be overridden (e.g. for one-off shells: `docker run ... bash`).
# Set SKIP_MIGRATIONS=1 when running additional replicas that should NOT migrate.
ENTRYPOINT ["/app/scripts/entrypoint.sh"]

# Start under Gunicorn. Config (workers, timeouts, logging) lives in gunicorn.conf.py
# so you can tune without rebuilding the image (just bump GUNICORN_WORKERS env var).
CMD ["gunicorn", "app.main:app", "-c", "gunicorn.conf.py"]
