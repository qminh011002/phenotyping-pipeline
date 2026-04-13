"""Pydantic schemas for health check and application settings."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Response from GET /health."""

    status: Literal["ok", "degraded"]
    model_loaded: bool
    device: str
    cuda_available: bool
    uptime_seconds: float = Field(ge=0.0)
    version: str


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
