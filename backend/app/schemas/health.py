"""Pydantic schemas for health check and application settings."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ModelStatus = Literal["loaded", "missing", "error"]


class HealthResponse(BaseModel):
    """Response from GET /health."""

    status: Literal["ok", "degraded"]
    model_loaded: bool
    device: str
    cuda_available: bool
    uptime_seconds: float = Field(ge=0.0)
    version: str
    models_status: dict[str, ModelStatus] = Field(
        default_factory=dict,
        description=(
            "Per-organism load state — one of 'loaded', 'missing', 'error'. "
            "Frontend uses this to disable Project Type cards whose model is "
            "not installed."
        ),
    )


class AppSettingsResponse(BaseModel):
    """Full application settings response."""

    image_storage_dir: str
    data_dir: str


class StorageSettingsResponse(BaseModel):
    """Image storage directory response (lightweight)."""

    image_storage_dir: str


class StorageSettingsUpdate(BaseModel):
    """Request body for PUT /settings/storage."""

    image_storage_dir: str = Field(min_length=1)


class AppSettingsUpdate(BaseModel):
    """Request body for PUT /settings."""

    image_storage_dir: str = Field(min_length=1)
