"""Phenotyping Ecosystem FastAPI application."""

from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

from fastapi import FastAPI

from app.middleware.cors import get_cors_middleware
from app.middleware.logging import RequestLoggingMiddleware
from app.errors.handlers import register_exception_handlers


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan manager.

    Startup:
        - Configure structured logging (logging_setup.py)
        - Load YOLO model via ModelRegistry (services/model_registry.py)
        - Create ThreadPoolExecutor sized by device (1 on CPU, 2 on GPU)
        - Create EggInferenceService with injected dependencies
        - Initialize database connection (INF-003)

    Shutdown:
        - Stop heartbeat task
        - Release model resources
        - Shutdown ThreadPoolExecutor
        - Close database connections
    """
    import logging as _logging

    # ── Startup ──────────────────────────────────────────────────────────────
    # Create LogBuffer first — needed for configure_logging
    from concurrent.futures import ThreadPoolExecutor

    from app.deps import _set_executor, _set_inference_service
    from app.deps import _set_log_buffer as _set_lb
    from app.deps import get_pipeline_config as _gpc
    from app.services.log_buffer import LogBuffer

    log_buffer = LogBuffer()
    _set_lb(log_buffer)

    # Configure structured logging (RingBufferHandler + JsonFormatter)
    from app.logging_setup import configure_logging

    configure_logging(log_buffer)

    settings_logger = _logging.getLogger(__name__)
    settings_logger.info(
        "Application starting",
        extra={"context": {"version": "0.1.0"}},
    )

    # Load YOLO model via ModelRegistry
    from app.services.model_registry import ModelRegistry

    pipeline_config = _gpc()
    registry = ModelRegistry()
    await registry.startup(pipeline_config)

    from app.deps import _set_model_registry as _set_mr

    _set_mr(registry)

    # Create ThreadPoolExecutor sized by device
    device = registry.device
    n_workers = 1 if device == "cpu" else 2
    executor = ThreadPoolExecutor(max_workers=n_workers, thread_name_prefix="inference_worker")
    _set_executor(executor)
    settings_logger.info(
        "Created inference ThreadPoolExecutor",
        extra={"context": {"device": device, "max_workers": n_workers}},
    )

    # Create EggInferenceService
    from app.services.inference.egg import EggInferenceService

    inference_svc = EggInferenceService(
        model_registry=registry,
        pipeline_config=pipeline_config,
        log_buffer=log_buffer,
        executor=executor,
    )
    _set_inference_service(inference_svc)

    # Initialize database (INF-003)
    from app.config import AppSettings
    from app.database import get_db

    db = get_db()
    db.init()

    # Seed app_settings singleton if not present (INF-003)
    # If the database is unavailable (e.g. PostgreSQL not yet running), log a
    # warning and continue — GET /settings will fail at runtime with a clear
    # error message, and the user must ensure the DB is up before using those endpoints.
    settings = AppSettings()
    try:
        async with db.session() as session:
            from app.models.app_settings import AppSettingsRow
            from sqlalchemy import select

            result = await session.execute(select(AppSettingsRow).where(AppSettingsRow.id == 1))
            if result.scalar_one_or_none() is None:
                session.add(AppSettingsRow(
                    id=1,
                    image_storage_dir=str(settings.image_storage_dir),
                    data_dir=str(settings.data_dir),
                ))
                await session.commit()
                settings_logger.info(
                    "Seeded app_settings singleton row",
                    extra={"context": {"image_storage_dir": str(settings.image_storage_dir)}},
                )
    except OSError as exc:
        settings_logger.warning(
            "Could not seed app_settings row — database unavailable: %s",
            exc,
            extra={"context": {"exception": str(exc)}},
        )

    # Start the 1-second heartbeat task for WebSocket log streaming
    log_buffer.start_heartbeat()

    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    # Stop heartbeat task first
    log_buffer.stop_heartbeat()

    # Shutdown executor — stop accepting new tasks, wait for running ones
    settings_logger.info("Shutting down ThreadPoolExecutor")
    executor.shutdown(wait=True)

    # Release model resources
    await registry.shutdown()

    # Close database connections (INF-003)
    from app.database import get_db as _gd

    db = _gd()
    await db.close()

    settings_logger.info("Application shutdown complete")


app = FastAPI(
    title="Phenotyping Ecosystem API",
    description="YOLOv8 inference server for insect phenotyping (egg, larvae, pupae, neonate detection)",
    version="0.1.0",
    lifespan=lifespan,
)

cors_cls, cors_kwargs = get_cors_middleware()
app.add_middleware(cors_cls, **cors_kwargs)
app.add_middleware(RequestLoggingMiddleware)
register_exception_handlers(app)

# Import and include routers — use direct module paths to avoid circular __init__.py
from app.routers import health, logs, config, inference
from app.routers.analyses import router as analysis_router
from app.routers.dashboard import router as dashboard_router
from app.routers.overlay import router as overlay_router
from app.routers.settings import router as settings_router

app.include_router(health.router)
app.include_router(logs.router)
app.include_router(config.router)
app.include_router(inference.router)
app.include_router(analysis_router)
app.include_router(dashboard_router)
app.include_router(overlay_router)
app.include_router(settings_router)
