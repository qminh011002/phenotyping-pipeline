"""Shared FastAPI dependencies (settings, pipeline config, model registry, logger, inference)."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import TYPE_CHECKING, Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select

from app.config import AppSettings, PipelineConfigManager
from app.services.analysis_service import AnalysisService
from app.services.app_settings_service import AppSettingsService

# Imported at runtime (not in TYPE_CHECKING) because the Annotated aliases
# below need to resolve these classes at module-load time.
from app.services.inference.calibration import CalibrationService
from app.services.inference.egg import EggInferenceService
from app.services.inference.larvae import LarvaeInferenceService
from app.services.inference.measurement import LarvaeMeasurementService
from app.services.inference.neonate import NeonateInferenceService
from app.services.inference.pupae import PupaeInferenceService
from app.services.inference.sam_refine import SamRefinementService

if TYPE_CHECKING:
    from app.models.user import User
    from app.services.log_buffer import LogBuffer
    from app.services.model_registry import ModelRegistry
    from app.services.model_storage import ModelStorage
    from app.services.model_upload_service import ModelUploadService

# Module-level singletons set by main.py lifespan
_model_registry: "ModelRegistry | None" = None
_log_buffer: "LogBuffer | None" = None
_executor: ThreadPoolExecutor | None = None
_inference_service: EggInferenceService | None = None
_neonate_inference_service: NeonateInferenceService | None = None
_larvae_inference_service: LarvaeInferenceService | None = None
_pupae_inference_service: PupaeInferenceService | None = None
_calibration_service: CalibrationService | None = None
_larvae_measurement_service: LarvaeMeasurementService | None = None
_sam_refinement_service: SamRefinementService | None = None


def _set_model_registry(registry: ModelRegistry) -> None:
    """Called by main.py lifespan to register the model registry."""
    global _model_registry
    _model_registry = registry


def _set_log_buffer(buffer: LogBuffer) -> None:
    """Called by main.py lifespan to register the log buffer."""
    global _log_buffer
    _log_buffer = buffer


def _set_executor(executor: ThreadPoolExecutor) -> None:
    """Called by main.py lifespan to register the shared ThreadPoolExecutor."""
    global _executor
    _executor = executor


def _set_inference_service(svc: EggInferenceService) -> None:
    """Called by main.py lifespan to register the inference service."""
    global _inference_service
    _inference_service = svc


def _set_neonate_inference_service(svc: NeonateInferenceService) -> None:
    """Called by main.py lifespan to register the neonate inference service."""
    global _neonate_inference_service
    _neonate_inference_service = svc


def _set_larvae_inference_service(svc: LarvaeInferenceService) -> None:
    """Called by main.py lifespan to register the larvae inference service."""
    global _larvae_inference_service
    _larvae_inference_service = svc


def _set_pupae_inference_service(svc: PupaeInferenceService) -> None:
    """Called by main.py lifespan to register the pupae inference service."""
    global _pupae_inference_service
    _pupae_inference_service = svc


def _set_calibration_service(svc: CalibrationService) -> None:
    """Called by main.py lifespan to register the calibration service."""
    global _calibration_service
    _calibration_service = svc


def _set_larvae_measurement_service(svc: LarvaeMeasurementService) -> None:
    """Called by main.py lifespan to register the measurement service."""
    global _larvae_measurement_service
    _larvae_measurement_service = svc


def _set_sam_refinement_service(svc: SamRefinementService) -> None:
    """Called by main.py lifespan to register the SAM refinement service."""
    global _sam_refinement_service
    _sam_refinement_service = svc


def get_sam_refinement_service() -> SamRefinementService:
    """Return the SamRefinementService singleton initialized at startup."""
    if _sam_refinement_service is None:
        raise RuntimeError(
            "SamRefinementService has not been initialized. "
            "This should only be called after the application lifespan startup."
        )
    return _sam_refinement_service


def get_calibration_service() -> CalibrationService:
    """Return the CalibrationService singleton initialized at startup."""
    if _calibration_service is None:
        raise RuntimeError(
            "CalibrationService has not been initialized. "
            "This should only be called after the application lifespan startup."
        )
    return _calibration_service


def get_larvae_measurement_service() -> LarvaeMeasurementService:
    """Return the LarvaeMeasurementService singleton initialized at startup."""
    if _larvae_measurement_service is None:
        raise RuntimeError(
            "LarvaeMeasurementService has not been initialized. "
            "This should only be called after the application lifespan startup."
        )
    return _larvae_measurement_service


def get_neonate_inference_service() -> NeonateInferenceService:
    """Return the NeonateInferenceService singleton initialized at startup."""
    if _neonate_inference_service is None:
        raise RuntimeError(
            "NeonateInferenceService has not been initialized. "
            "This should only be called after the application lifespan startup."
        )
    return _neonate_inference_service


def get_larvae_inference_service() -> LarvaeInferenceService:
    """Return the LarvaeInferenceService singleton initialized at startup."""
    if _larvae_inference_service is None:
        raise RuntimeError(
            "LarvaeInferenceService has not been initialized. "
            "This should only be called after the application lifespan startup."
        )
    return _larvae_inference_service


def get_pupae_inference_service() -> PupaeInferenceService:
    """Return the PupaeInferenceService singleton initialized at startup."""
    if _pupae_inference_service is None:
        raise RuntimeError(
            "PupaeInferenceService has not been initialized. "
            "This should only be called after the application lifespan startup."
        )
    return _pupae_inference_service


@lru_cache
def get_settings() -> AppSettings:
    """Return the application settings singleton.

    Cached so repeated calls return the same instance.
    """
    return AppSettings()


@lru_cache
def get_pipeline_config() -> PipelineConfigManager:
    """Return the pipeline config manager singleton.

    Cached so repeated calls return the same instance.
    Thread-safe via PipelineConfigManager's internal lock.
    """
    settings = get_settings()
    return PipelineConfigManager(
        data_dir=settings.data_dir,
        pipeline_root=settings.pipeline_root,
    )


@lru_cache
def get_model_storage() -> "ModelStorage":
    """Return the ModelStorage singleton, layout pinned at ``data_dir/models``."""
    from app.services.model_storage import ModelStorage

    settings = get_settings()
    return ModelStorage(data_dir=settings.data_dir)


@lru_cache
def get_model_upload_service() -> "ModelUploadService":
    """Return the ModelUploadService singleton."""
    from app.services.model_upload_service import ModelUploadService

    return ModelUploadService(storage=get_model_storage())


def get_model_registry() -> ModelRegistry:
    """Return the ModelRegistry singleton initialized at startup.

    Raises:
        RuntimeError: if called before the app lifespan has started.
    """
    if _model_registry is None:
        raise RuntimeError(
            "ModelRegistry has not been initialized. "
            "This should only be called after the application lifespan startup."
        )
    return _model_registry


def get_log_buffer() -> LogBuffer:
    """Return the LogBuffer singleton initialized at startup.

    Raises:
        RuntimeError: if called before the app lifespan has started.
    """
    if _log_buffer is None:
        raise RuntimeError(
            "LogBuffer has not been initialized. "
            "This should only be called after the application lifespan startup."
        )
    return _log_buffer


def get_executor() -> ThreadPoolExecutor:
    """Return the shared ThreadPoolExecutor for inference tasks.

    Raises:
        RuntimeError: if called before the app lifespan has started.
    """
    if _executor is None:
        raise RuntimeError(
            "Executor has not been initialized. "
            "This should only be called after the application lifespan startup."
        )
    return _executor


def get_inference_service() -> EggInferenceService:
    """Return the EggInferenceService singleton initialized at startup.

    Raises:
        RuntimeError: if called before the app lifespan has started.
    """
    if _inference_service is None:
        raise RuntimeError(
            "EggInferenceService has not been initialized. "
            "This should only be called after the application lifespan startup."
        )
    return _inference_service


# Annotated dependency alias for use in FastAPI route signatures.
# Resolves to EggInferenceService with Depends(get_inference_service) injected.
# Usage in routes:
#   async def handler(svc: AnnotatedEggInferenceService) -> ...:
AnnotatedEggInferenceService = Annotated[
    EggInferenceService,
    Depends(get_inference_service),
]

AnnotatedNeonateInferenceService = Annotated[
    NeonateInferenceService,
    Depends(get_neonate_inference_service),
]

AnnotatedLarvaeInferenceService = Annotated[
    LarvaeInferenceService,
    Depends(get_larvae_inference_service),
]

AnnotatedPupaeInferenceService = Annotated[
    PupaeInferenceService,
    Depends(get_pupae_inference_service),
]

AnnotatedCalibrationService = Annotated[
    CalibrationService,
    Depends(get_calibration_service),
]

AnnotatedLarvaeMeasurementService = Annotated[
    LarvaeMeasurementService,
    Depends(get_larvae_measurement_service),
]


# AnalysisService is stateless — return a cached singleton instance
@lru_cache
def get_analysis_service() -> AnalysisService:
    """Return a cached AnalysisService instance.

    Stateless; safe to reuse across all requests.
    """
    return AnalysisService()


@lru_cache
def get_app_settings_service() -> AppSettingsService:
    """Return a cached AppSettingsService instance.

    Stateless; safe to reuse across all requests.
    """
    return AppSettingsService()


# ── Auth (BE-020) ─────────────────────────────────────────────────────────────

# auto_error=False so we can return our own structured 401 with an error code,
# instead of FastAPI's default {"detail": "Not authenticated"} message.
_bearer_scheme = HTTPBearer(auto_error=False)


def _unauthorized(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": code, "message": message},
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(_bearer_scheme)
    ],
):
    """Resolve the bearer access token to a ``User`` row.

    Returns 401 with one of: ``token_invalid``, ``token_expired``.
    Refresh-token revocation is not consulted here — access tokens are not
    revoked server-side; they expire fast (see jwt_access_ttl_min).
    """
    from app.database import get_db
    from app.models.user import User
    from app.services.auth import AuthError, decode_token

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized("token_invalid", "Missing bearer token")

    settings = get_settings()
    try:
        decoded = decode_token(credentials.credentials, "access", settings)
    except AuthError as exc:
        raise _unauthorized(exc.code, str(exc)) from exc

    db = get_db()
    async with db.session() as session:
        try:
            import uuid as _uuid

            user_id = _uuid.UUID(decoded.sub)
        except ValueError as exc:
            raise _unauthorized("token_invalid", "Bad subject claim") from exc
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if user is None:
            raise _unauthorized("token_invalid", "User no longer exists")
        return user


# Type alias for route signatures: user: CurrentUser
CurrentUser = Annotated["User", Depends(get_current_user)]


async def get_session_dep():
    """FastAPI dependency yielding an async DB session for auth routes."""
    from app.database import get_db

    db = get_db()
    async with db.session() as session:
        yield session


# ── Storage dir (env-driven, read at startup) ──────────────────────────────────

_storage_dir_cache: str | None = None


def get_cached_storage_dir() -> str:
    """Return image_storage_dir, sourced from the IMAGE_STORAGE_DIR env var.

    The value is cached for the lifetime of the process — change ``.env``
    (or ``/etc/phenotyping/.env.production`` in prod) and restart the backend
    to take effect.
    """
    global _storage_dir_cache
    if _storage_dir_cache is None:
        from app.config import AppSettings

        _storage_dir_cache = str(AppSettings().image_storage_dir)
    return _storage_dir_cache
