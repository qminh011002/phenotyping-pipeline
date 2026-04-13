"""GET /settings, PUT /settings, GET /settings/storage, PUT /settings/storage.

Manages app-level settings including the overlay image storage directory.
Storage path changes are validated: the directory must exist or be creatable.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, status

from app.deps import get_settings
from app.schemas.health import (
    AppSettingsResponse,
    AppSettingsUpdate,
    StorageSettingsResponse,
    StorageSettingsUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


# ── Helpers ────────────────────────────────────────────────────────────────────

def _validate_storage_path(path: str) -> Path:
    """Validate and return an absolute Path for image_storage_dir.

    The parent directory must exist and be writable. Attempts to create
    the directory if it doesn't exist. Raises HTTPException(422) on failure.
    """
    p = Path(path).resolve()

    if not p.parent.exists():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Parent directory does not exist: {p.parent}. "
                "Set image_storage_dir to a path under an existing directory."
            ),
        )

    if not p.exists():
        try:
            p.mkdir(parents=True, exist_ok=True)
            logger.info(
                "Created image_storage_dir",
                extra={"context": {"image_storage_dir": str(p)}},
            )
        except OSError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Cannot create directory {p}: {exc}",
            ) from exc

    if not p.is_dir():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"image_storage_dir must be a directory: {p}",
        )

    return p


def _persist_image_storage_dir(new_path: Path) -> None:
    """Persist the image_storage_dir to the .env file.

    pydantic-settings reads IMAGE_STORAGE_DIR from .env on startup.
    We append or update it so the change survives restarts.
    """
    env_path = Path("backend/.env")
    env_key = "IMAGE_STORAGE_DIR"
    new_value = str(new_path)

    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines()
    else:
        lines = []

    # Replace existing entry or append
    key_exists = False
    updated_lines: list[str] = []
    for line in lines:
        if line.strip().startswith(f"{env_key}="):
            updated_lines.append(f"{env_key}={new_value}")
            key_exists = True
        else:
            updated_lines.append(line)

    if not key_exists:
        updated_lines.append(f"{env_key}={new_value}")

    env_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text("\n".join(updated_lines) + "\n", encoding="utf-8")


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=AppSettingsResponse,
    summary="Get application settings",
)
async def get_settings_endpoint() -> AppSettingsResponse:
    """Return the full application settings."""
    settings = get_settings()
    return AppSettingsResponse(
        image_storage_dir=str(Path(settings.image_storage_dir).resolve()),
        data_dir=str(Path(settings.data_dir).resolve()),
    )


@router.put(
    "",
    response_model=AppSettingsResponse,
    summary="Update application settings",
    responses={
        200: {"description": "Settings updated"},
        422: {"description": "Invalid path or cannot create directory"},
    },
)
async def update_settings(update: AppSettingsUpdate) -> AppSettingsResponse:
    """Update application settings.

    Only image_storage_dir is currently supported for update.
    Other settings are read-only.
    """
    resolved = _validate_storage_path(update.image_storage_dir)
    _persist_image_storage_dir(resolved)

    # Also update in-memory settings (via environment variable reload)
    import os
    os.environ["IMAGE_STORAGE_DIR"] = str(resolved)

    # Clear any cached settings so the new value is picked up
    from app.deps import get_settings as _gs
    _gs.cache_clear()

    logger.info(
        "Settings updated: image_storage_dir",
        extra={"context": {"image_storage_dir": str(resolved)}},
    )

    settings = get_settings()
    return AppSettingsResponse(
        image_storage_dir=str(Path(settings.image_storage_dir).resolve()),
        data_dir=str(Path(settings.data_dir).resolve()),
    )


@router.get(
    "/storage",
    response_model=StorageSettingsResponse,
    summary="Get overlay storage directory",
)
async def get_storage_settings() -> StorageSettingsResponse:
    """Return only the current image_storage_dir."""
    settings = get_settings()
    return StorageSettingsResponse(
        image_storage_dir=str(Path(settings.image_storage_dir).resolve()),
    )


@router.put(
    "/storage",
    response_model=StorageSettingsResponse,
    summary="Update overlay storage directory",
    responses={
        200: {"description": "Storage directory updated"},
        422: {"description": "Invalid path or cannot create directory"},
    },
)
async def update_storage_settings(update: StorageSettingsUpdate) -> StorageSettingsResponse:
    """Update the directory where overlay images are stored.

    Validates that the parent directory exists and attempts to create
    the target directory if it doesn't already exist. Persists the change
    to the .env file so it survives server restarts.

    Note: existing overlays at the old path are NOT moved. Any saved
    overlay references must continue pointing to their original locations.
    """
    resolved = _validate_storage_path(update.image_storage_dir)
    _persist_image_storage_dir(resolved)

    import os
    os.environ["IMAGE_STORAGE_DIR"] = str(resolved)

    from app.deps import get_settings as _gs
    _gs.cache_clear()

    logger.info(
        "Storage directory updated",
        extra={"context": {"image_storage_dir": str(resolved)}},
    )

    return StorageSettingsResponse(image_storage_dir=str(resolved))
