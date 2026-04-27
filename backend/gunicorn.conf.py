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
