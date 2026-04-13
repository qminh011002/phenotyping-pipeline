"""Shared FastAPI dependencies (settings, pipeline config, model registry, logger, inference)."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import TYPE_CHECKING

from app.config import AppSettings, PipelineConfigManager

if TYPE_CHECKING:
    from app.services.log_buffer import LogBuffer
    from app.services.model_registry import ModelRegistry

# Import at runtime (not inside TYPE_CHECKING) so that TypeAliasType below can
# resolve EggInferenceService at module-load time.
from app.services.inference.egg import EggInferenceService  # noqa: E402
from app.services.analysis_service import AnalysisService  # noqa: E402

# Module-level singletons set by main.py lifespan
_model_registry: "ModelRegistry | None" = None
_log_buffer: "LogBuffer | None" = None
_executor: ThreadPoolExecutor | None = None
_inference_service: EggInferenceService | None = None


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
    return PipelineConfigManager(pipeline_root=settings.pipeline_root)


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
from typing import Annotated as _Annotated
from fastapi import Depends as _Depends

AnnotatedEggInferenceService = _Annotated[
    EggInferenceService,
    _Depends(get_inference_service),
]


# AnalysisService is stateless — return a cached singleton instance
@lru_cache
def get_analysis_service() -> AnalysisService:
    """Return a cached AnalysisService instance.

    Stateless; safe to reuse across all requests.
    """
    return AnalysisService()
