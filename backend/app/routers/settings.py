"""GET /settings, GET /settings/storage — read-only views of env-driven settings.

The overlay storage path (and other paths) are sourced from environment
variables (``IMAGE_STORAGE_DIR``, ``DATA_DIR``) loaded by ``AppSettings``.
Edit ``.env`` (or ``/etc/phenotyping/.env.production`` in prod) and restart
the backend to change them. There is no PUT endpoint — operators manage the
host filesystem and ``.env`` directly.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from app.config import AppSettings
from app.schemas.health import AppSettingsResponse, StorageSettingsResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get(
    "",
    response_model=AppSettingsResponse,
    summary="Get application settings (read-only, env-driven)",
)
async def get_settings_endpoint() -> AppSettingsResponse:
    s = AppSettings()
    return AppSettingsResponse(
        image_storage_dir=str(s.image_storage_dir),
        data_dir=str(s.data_dir),
    )


@router.get(
    "/storage",
    response_model=StorageSettingsResponse,
    summary="Get overlay storage directory (read-only, env-driven)",
)
async def get_storage_settings() -> StorageSettingsResponse:
    s = AppSettings()
    return StorageSettingsResponse(image_storage_dir=str(s.image_storage_dir))
