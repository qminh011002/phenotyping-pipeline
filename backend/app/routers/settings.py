"""GET /settings, PUT /settings, GET /settings/storage, PUT /settings/storage.

Manages the app_settings singleton DB row for user-configurable paths.
Storage path changes are validated: the directory must exist or be creatable.
The pydantic AppSettings from .env is only the first-run default; all runtime
reads and writes go through the AppSettingsService (DB-backed).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_app_settings_service, get_settings
from app.database import AsyncSession, get_session
from app.services.app_settings_service import AppSettingsService
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


def _persist_to_env(key: str, value: str) -> None:
    """Append or update a key=value line in backend/.env for persistence across restarts."""
    import os
    env_path = Path("backend/.env")

    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines()
    else:
        lines = []

    key_exists = False
    updated_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        # Only match KEY= (not KEY_PREFIX=) at the start of the non-comment line
        if stripped and not stripped.startswith("#"):
            eq_pos = stripped.index("=") if "=" in stripped else -1
            if eq_pos > 0 and stripped[:eq_pos] == key:
                updated_lines.append(f"{key}={value}")
                key_exists = True
            else:
                updated_lines.append(line)
        else:
            updated_lines.append(line)

    if not key_exists:
        updated_lines.append(f"{key}={value}")

    env_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text("\n".join(updated_lines) + "\n", encoding="utf-8")


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=AppSettingsResponse,
    summary="Get application settings",
)
async def get_settings_endpoint(
    svc: Annotated[AppSettingsService, Depends(get_app_settings_service)],
    db: Annotated[AsyncSession, Depends(get_session)],
) -> AppSettingsResponse:
    """Return the full application settings from the DB singleton row."""
    row = await svc.get_settings(db)
    return AppSettingsResponse(
        image_storage_dir=row.image_storage_dir,
        data_dir=row.data_dir or "",
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
async def update_settings(
    update: AppSettingsUpdate,
    svc: Annotated[AppSettingsService, Depends(get_app_settings_service)],
    db: Annotated[AsyncSession, Depends(get_session)],
) -> AppSettingsResponse:
    """Update application settings.

    Only image_storage_dir is currently supported for update.
    Changes are persisted to both the DB row and the .env file.
    """
    resolved = _validate_storage_path(update.image_storage_dir)
    _persist_to_env("IMAGE_STORAGE_DIR", str(resolved))

    import os
    os.environ["IMAGE_STORAGE_DIR"] = str(resolved)

    from app.deps import get_settings as _gs
    _gs.cache_clear()

    row = await svc.update_settings(
        db=db,
        image_storage_dir=str(resolved),
    )

    # Invalidate the cached storage_dir so inference/overlay readers pick up the new path
    from app.deps import invalidate_storage_dir_cache
    invalidate_storage_dir_cache()

    logger.info(
        "Settings updated: image_storage_dir",
        extra={"context": {"image_storage_dir": str(resolved)}},
    )

    return AppSettingsResponse(
        image_storage_dir=row.image_storage_dir,
        data_dir=row.data_dir or "",
    )


@router.get(
    "/storage",
    response_model=StorageSettingsResponse,
    summary="Get overlay storage directory",
)
async def get_storage_settings(
    svc: Annotated[AppSettingsService, Depends(get_app_settings_service)],
    db: Annotated[AsyncSession, Depends(get_session)],
) -> StorageSettingsResponse:
    """Return only the current image_storage_dir from the DB singleton row."""
    row = await svc.get_settings(db)
    return StorageSettingsResponse(image_storage_dir=row.image_storage_dir)


@router.put(
    "/storage",
    response_model=StorageSettingsResponse,
    summary="Update overlay storage directory",
    responses={
        200: {"description": "Storage directory updated"},
        422: {"description": "Invalid path or cannot create directory"},
    },
)
async def update_storage_settings(
    update: StorageSettingsUpdate,
    svc: Annotated[AppSettingsService, Depends(get_app_settings_service)],
    db: Annotated[AsyncSession, Depends(get_session)],
) -> StorageSettingsResponse:
    """Update the directory where overlay images are stored.

    Validates that the parent directory exists and attempts to create
    the target directory if it doesn't already exist. Persists the change
    to the DB row and .env file so it survives server restarts.

    Note: existing overlays at the old path are NOT moved.
    """
    resolved = _validate_storage_path(update.image_storage_dir)
    _persist_to_env("IMAGE_STORAGE_DIR", str(resolved))

    import os
    os.environ["IMAGE_STORAGE_DIR"] = str(resolved)

    from app.deps import get_settings as _gs
    _gs.cache_clear()

    row = await svc.update_storage_dir(db=db, new_dir=str(resolved))

    from app.deps import invalidate_storage_dir_cache
    invalidate_storage_dir_cache()

    logger.info(
        "Storage directory updated",
        extra={"context": {"image_storage_dir": str(resolved)}},
    )

    return StorageSettingsResponse(image_storage_dir=row.image_storage_dir)
