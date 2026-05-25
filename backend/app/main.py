"""Phenotyping Ecosystem FastAPI application."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.errors.handlers import register_exception_handlers
from app.middleware.cors import get_cors_middleware
from app.middleware.logging import RequestLoggingMiddleware


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

    # ── Determinism (parity with phenotyping_pipeline) ───────────────────────
    # Force every YOLO/SAM inference to be byte-reproducible across runs and
    # platforms. Without these flags, cuDNN picks the fastest conv kernel on
    # the first batch (auto-tune) which is non-deterministic, and FP16 paths
    # introduce sub-pixel mask jitter that propagates into polygon points and
    # bbox coordinates → divergence from the reference pipeline output.
    #
    # Seeded once at process start so every request shares the same RNG state.
    import os as _os
    import random as _random

    import numpy as _np

    _os.environ.setdefault("PYTHONHASHSEED", "0")
    _os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")  # required by torch
    _random.seed(0)
    _np.random.seed(0)
    try:
        import torch as _torch

        _torch.manual_seed(0)
        _torch.cuda.manual_seed_all(0)
        _torch.use_deterministic_algorithms(True, warn_only=True)
        _torch.backends.cudnn.deterministic = True
        _torch.backends.cudnn.benchmark = False
    except (ImportError, AttributeError):
        # torch not available in some test environments — fine to skip.
        pass

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

    # ── Auth secrets check (BE-020) ───────────────────────────────────────────
    from app.config import AppSettings as _AppSettings

    _auth_settings = _AppSettings()
    _DEV_PLACEHOLDERS = {
        "dev-only-access-secret-change-me",
        "dev-only-refresh-secret-change-me",
    }
    if (
        _auth_settings.jwt_access_secret in _DEV_PLACEHOLDERS
        or _auth_settings.jwt_refresh_secret in _DEV_PLACEHOLDERS
    ):
        settings_logger.warning(
            "JWT secrets are placeholders — set JWT_ACCESS_SECRET and "
            "JWT_REFRESH_SECRET in .env before any non-dev use."
        )
    if _auth_settings.jwt_access_secret == _auth_settings.jwt_refresh_secret:
        raise RuntimeError(
            "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values."
        )

    # Resolve filesystem layout + load every organism's weights best-effort.
    from sqlalchemy.exc import SQLAlchemyError

    from app.deps import get_model_storage, get_model_upload_service
    from app.services.model_registry import ModelRegistry

    pipeline_config = _gpc()
    storage = get_model_storage()
    storage.ensure_layout()

    # Pull custom-model assignments from the DB so the registry can prefer them
    # over defaults. Best-effort — if the DB is unreachable we just load defaults.
    from app.database import get_db as _gdb

    custom_assignments: dict[str, "object"] = {}
    try:
        db_for_assign = _gdb()
        db_for_assign.init()
        upload_svc = get_model_upload_service()
        async with db_for_assign.session() as session:
            # One-shot legacy migration before reading assignments.
            await upload_svc.migrate_legacy_layout(session)
            await session.commit()
            for organism in ("egg", "larvae", "pupae", "neonate"):
                p = await upload_svc.get_active_custom_path(session, organism)
                if p is not None:
                    custom_assignments[organism] = p
    except (SQLAlchemyError, OSError, RuntimeError) as exc:
        settings_logger.warning(
            "Could not load custom model assignments at startup: %s",
            exc,
        )

    registry = ModelRegistry(storage=storage)
    await registry.startup(pipeline_config, custom_assignments=custom_assignments)

    from app.deps import _set_model_registry as _set_mr

    _set_mr(registry)

    # Create ThreadPoolExecutor sized by the loaded model devices. Older code
    # only looked at egg.device; larvae/pupae can be on GPU even when egg is CPU.
    loaded_devices = [
        registry.device_for(org)
        for org, model_status in registry.models_status.items()
        if model_status == "loaded"
    ]
    device = "cuda" if any(d != "cpu" for d in loaded_devices) else "cpu"
    n_workers = 1 if device == "cpu" else 2
    executor = ThreadPoolExecutor(
        max_workers=n_workers, thread_name_prefix="inference_worker"
    )
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

    # Create NeonateInferenceService (uses the same executor/log buffer)
    from app.deps import _set_neonate_inference_service
    from app.services.inference.neonate import NeonateInferenceService

    neonate_svc = NeonateInferenceService(
        model_registry=registry,
        pipeline_config=pipeline_config,
        log_buffer=log_buffer,
        executor=executor,
    )
    _set_neonate_inference_service(neonate_svc)

    # Create CalibrationService (shares the inference executor) — must be
    # constructed before LarvaeInferenceService since the latter consumes it.
    from app.deps import _set_calibration_service
    from app.services.inference.calibration import CalibrationService

    calibration_svc = CalibrationService(executor=executor)
    _set_calibration_service(calibration_svc)

    # Create SamRefinementService (lazy-loads weights on first refine call)
    from app.deps import _set_sam_refinement_service
    from app.services.inference.sam_refine import SamRefinementService

    sam_weights_dir = storage.root / "sam"
    sam_weights_dir.mkdir(parents=True, exist_ok=True)
    sam_svc = SamRefinementService(executor=executor, weights_dir=sam_weights_dir)
    _set_sam_refinement_service(sam_svc)

    # Create LarvaeInferenceService (segmentation; same executor/log buffer)
    from app.deps import _set_larvae_inference_service
    from app.services.inference.larvae import LarvaeInferenceService

    larvae_svc = LarvaeInferenceService(
        model_registry=registry,
        pipeline_config=pipeline_config,
        log_buffer=log_buffer,
        executor=executor,
        calibration_service=calibration_svc,
        sam_service=sam_svc,
    )
    _set_larvae_inference_service(larvae_svc)

    # Create PupaeInferenceService — same shape as larvae (polygon + MWIS + SAM)
    from app.deps import _set_pupae_inference_service
    from app.services.inference.pupae import PupaeInferenceService

    pupae_svc = PupaeInferenceService(
        model_registry=registry,
        pipeline_config=pipeline_config,
        log_buffer=log_buffer,
        executor=executor,
        calibration_service=calibration_svc,
        sam_service=sam_svc,
    )
    _set_pupae_inference_service(pupae_svc)

    # Create LarvaeMeasurementService (shares the inference executor)
    from app.deps import _set_larvae_measurement_service
    from app.services.inference.measurement import LarvaeMeasurementService

    measurement_svc = LarvaeMeasurementService(executor=executor)
    _set_larvae_measurement_service(measurement_svc)

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
            from sqlalchemy import select

            from app.models.app_settings import AppSettingsRow

            result = await session.execute(
                select(AppSettingsRow).where(AppSettingsRow.id == 1).limit(1)
            )
            if result.scalar_one_or_none() is None:
                session.add(
                    AppSettingsRow(
                        id=1,
                        image_storage_dir=str(settings.image_storage_dir),
                        data_dir=str(settings.data_dir),
                    )
                )
                await session.commit()
                settings_logger.info(
                    "Seeded app_settings singleton row",
                    extra={
                        "context": {
                            "image_storage_dir": str(settings.image_storage_dir)
                        }
                    },
                )
    except Exception as exc:  # noqa: BLE001 — database may be unreachable
        settings_logger.warning(
            "Could not seed app_settings row — database unavailable: %s",
            exc,
            extra={"context": {"exception": str(exc)}},
        )

    # Start the 1-second heartbeat task for WebSocket log streaming
    log_buffer.start_heartbeat()

    # Bind the running loop to the stage broker so inference worker threads
    # can emit stage events safely via run_coroutine_threadsafe.
    import asyncio as _asyncio

    from app.services.stage_broker import get_broker as _get_stage_broker

    _get_stage_broker().bind_loop(_asyncio.get_running_loop())

    try:
        yield
    finally:
        # Stop heartbeat task first
        log_buffer.stop_heartbeat()

        # Shutdown executor — stop accepting new tasks, wait for running ones
        settings_logger.info("Shutting down ThreadPoolExecutor")
        executor.shutdown(wait=True, cancel_futures=True)

        # Release model resources
        try:
            await registry.shutdown()
        except Exception as exc:  # noqa: BLE001
            settings_logger.warning("registry.shutdown failed: %s", exc)

        try:
            await get_db().close()
        except Exception as exc:  # noqa: BLE001
            settings_logger.warning("db.close failed: %s", exc)

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

# Import and include routers — use direct module paths to avoid circular __init__.py.
# These imports must run after `app` is constructed above; E402 is intentional.
from app.routers import config, health, inference, logs, stages  # noqa: E402
from app.routers.analyses import router as analysis_router  # noqa: E402
from app.routers.auth import router as auth_router  # noqa: E402
from app.routers.dashboard import router as dashboard_router  # noqa: E402
from app.routers.larvae import router as larvae_router  # noqa: E402
from app.routers.models import router as models_router  # noqa: E402
from app.routers.overlay import router as overlay_router  # noqa: E402
from app.routers.pupae import router as pupae_router  # noqa: E402
from app.routers.sam_models import router as sam_models_router  # noqa: E402
from app.routers.settings import router as settings_router  # noqa: E402

app.include_router(health.router)
app.include_router(logs.router)
app.include_router(stages.router)
app.include_router(config.router)
app.include_router(inference.router)
app.include_router(auth_router)
app.include_router(analysis_router)
app.include_router(larvae_router)
app.include_router(pupae_router)
app.include_router(dashboard_router)
app.include_router(models_router)
app.include_router(overlay_router)
app.include_router(sam_models_router)
app.include_router(settings_router)
