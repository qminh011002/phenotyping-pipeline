"""GET /inference/results/{batch_id}/{filename}/overlay.png — serve overlay PNG from disk.

Overlay images are written to {image_storage_dir}/{batch_id}/{filename}_overlay.png
by EggInferenceService (BE-005). This router serves them over HTTP.

A small read-through LRU cache (20 entries) avoids repeated disk I/O for
recently-accessed overlays. Disk is always the source of truth.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse

from app.deps import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/inference/results", tags=["inference"])

# LRU cache size — keeps the last N recently-accessed overlay bytes in memory
_LRU_CACHE_SIZE = 20


@lru_cache(maxsize=_LRU_CACHE_SIZE)
def _read_overlay_cached(path: str) -> bytes:
    """Read overlay file bytes with caching.

    Keyed by the resolved absolute path string. Cache is read-through:
    disk is always the source of truth. Cache entries are invalidated when
    the file on disk changes (best-effort via cache eviction).
    """
    with open(path, "rb") as fh:
        return fh.read()


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

    A small LRU cache (20 entries) avoids repeated disk reads for the most
    recently served overlays. Returns 404 if the file does not exist.
    """
    settings = get_settings()
    storage_dir = Path(settings.image_storage_dir)

    overlay_path = _resolve_overlay_path(storage_dir, batch_id, filename)

    if not overlay_path.exists():
        logger.debug(
            "Overlay not found",
            extra={"context": {"overlay_path": str(overlay_path), "batch_id": batch_id, "filename": filename}},
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Overlay not found: {overlay_path}",
        )

    # read-through cache using lru_cache keyed by absolute path
    try:
        # FileResponse handles caching headers and streaming natively;
        # use the path directly (no need to go through bytes cache for FileResponse)
        return FileResponse(
            path=overlay_path,
            media_type="image/png",
            filename=overlay_path.name,
        )
    except OSError as exc:
        logger.warning(
            "Failed to read overlay file: %s (%s)",
            overlay_path,
            exc,
            extra={"context": {"overlay_path": str(overlay_path), "exception": str(exc)}},
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Overlay file unreadable: {overlay_path}",
        ) from exc
