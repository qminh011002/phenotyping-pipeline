"""GET /inference/results/{batch_id}/{filename}/overlay.png — serve overlay PNG from disk.

Overlay images are written to {image_storage_dir}/{batch_id}/{filename}_overlay.png
by EggInferenceService (BE-005). This router serves them over HTTP.

FileResponse handles caching headers and streaming natively; disk is the source of truth.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from app.deps import get_cached_storage_dir

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
) -> FileResponse:
    """Return the overlay PNG image for the specified batch and original filename.

    The file is read from disk at:
        {image_storage_dir}/{batch_id}/{filename}_overlay.png

    Returns 404 if the file does not exist.
    """
    storage_dir = Path(get_cached_storage_dir())
    overlay_path = _resolve_overlay_path(storage_dir, batch_id, filename)

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
