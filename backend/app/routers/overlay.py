"""GET /inference/results/{batch_id}/{filename}/overlay.png — serve overlay PNG from disk.

Overlay images are written to {image_storage_dir}/{batch_id}/{filename}_overlay.png
by EggInferenceService (BE-005). This router serves them over HTTP.

FileResponse handles caching headers and streaming natively; disk is the source of truth.
"""

from __future__ import annotations

import logging
import uuid as _uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.database import AsyncSession, get_session
from app.deps import CurrentUser, get_cached_storage_dir
from app.models.analysis import AnalysisBatch

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/inference/results", tags=["inference"])


def _resolve_overlay_path(storage_dir: Path, batch_id: str, filename: str) -> Path:
    """Return the absolute overlay file path for a given batch + image.

    Overlay convention: {storage_dir}/{batch_id}/{filename}_overlay.png
    """
    batch_dir = storage_dir / batch_id
    overlay_name = f"{filename}_overlay.png"
    return (batch_dir / overlay_name).resolve()


@router.get(
    "/{batch_id}/{filename}/overlay.png",
    summary="Serve the overlay PNG for a processed image",
    responses={
        200: {"content": {"image/png": {}}, "description": "Overlay PNG image"},
        404: {"description": "Overlay file not found on disk"},
    },
)
async def get_overlay(
    batch_id: str,
    filename: str,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> FileResponse:
    """Return the overlay PNG image for the specified batch and original filename.

    The file is read from disk at:
        {image_storage_dir}/{batch_id}/{filename}_overlay.png

    Requires the bearer access token; returns 404 if the batch does not belong
    to the current user (don't leak existence). Returns 404 if the file is
    missing on disk.
    """
    # Verify ownership before any disk access.
    try:
        bid = _uuid.UUID(batch_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid batch_id",
        ) from exc
    stmt = (
        select(AnalysisBatch.id)
        .where(AnalysisBatch.id == bid)
        .where(AnalysisBatch.user_id == user.id)
    )
    if (await db.execute(stmt)).scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Overlay not found for batch {batch_id}.",
        )

    storage_dir = Path(get_cached_storage_dir()).resolve()
    overlay_path = _resolve_overlay_path(storage_dir, batch_id, filename)

    # Reject crafted batch_id/filename that escape the storage root.
    if storage_dir not in overlay_path.parents:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid overlay path",
        )

    if not overlay_path.exists():
        logger.debug(
            "Overlay not found",
            extra={
                "context": {
                    "overlay_path": str(overlay_path),
                    "batch_id": batch_id,
                    "filename": filename,
                }
            },
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Overlay not found: {overlay_path}",
        )

    return FileResponse(
        path=overlay_path,
        media_type="image/png",
        filename=overlay_path.name,
    )
