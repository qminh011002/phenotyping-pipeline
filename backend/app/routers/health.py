"""GET /health and GET /ping endpoints.

GET /health — liveness check with model state, device, CUDA availability, uptime.
GET /ping  — lightweight latency check, no dependencies.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from app.deps import get_model_registry
from app.schemas.health import HealthResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["health"])


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Liveness check with model state",
    responses={
        200: {"description": "Health status returned successfully"},
    },
)
async def get_health() -> HealthResponse:
    """Return the health status of the backend.

    Returns model loaded state, active device, CUDA availability, uptime since
    model load, and the application version. Used by the frontend's
    "Test Connection" button and the Settings health display.
    """
    try:
        registry = get_model_registry()
        models_status = registry.models_status
        any_loaded = any(s == "loaded" for s in models_status.values())
        return HealthResponse(
            status="ok" if any_loaded else "degraded",
            model_loaded=registry.model_loaded,
            device=registry.device,
            cuda_available=registry.cuda_available,
            uptime_seconds=registry.uptime_seconds,
            version="0.1.0",
            models_status=models_status,
        )
    except Exception as exc:
        logger.exception("GET /health failed: %s", exc)
        return HealthResponse(
            status="degraded",
            model_loaded=False,
            device="unknown",
            cuda_available=False,
            uptime_seconds=0.0,
            version="0.1.0",
            models_status={},
        )


@router.get(
    "/ping",
    summary="Lightweight latency check",
    responses={
        200: {"description": '{"pong": true}'},
    },
)
async def get_ping() -> dict[str, bool]:
    """Return immediately with `{"pong": true}`.

    No dependencies on model state or database. Used to measure round-trip
    latency without triggering any expensive operations.
    """
    return {"pong": True}
