"""GET /analyses, GET /analyses/{batch_id}, DELETE /analyses/{batch_id}, and
GET /analyses/{batch_id}/images/{image_id}/overlay.

Provides the Recorded page and overlay image serving.
"""

from __future__ import annotations

import logging
from pathlib import Path
from uuid import UUID

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse, StreamingResponse

from app.database import AsyncSession, get_session
from app.deps import get_analysis_service, get_settings
from app.schemas.analysis import (
    AnalysisBatchDetail,
    AnalysisListResponse,
)
from app.services.analysis_service import AnalysisService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/analyses", tags=["analyses"])

# Default pagination
_DEFAULT_PAGE = 1
_DEFAULT_PAGE_SIZE = 20


@router.get(
    "",
    response_model=AnalysisListResponse,
    summary="List analysis batches with pagination and filters",
)
async def list_analyses(
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
    page: int = Query(default=_DEFAULT_PAGE, ge=1, description="1-indexed page number"),
    page_size: int = Query(default=_DEFAULT_PAGE_SIZE, ge=1, le=100, description="Items per page"),
    q: str | None = Query(default=None, description="Search by original filename"),
    organism: str | None = Query(default=None, description="Filter by organism type"),
) -> AnalysisListResponse:
    """Return a paginated list of analysis batches.

    Results are sorted by creation date descending (newest first).
    Optionally filter by organism type or search by filename fragment.
    """
    return await analysis_svc.list_batches(
        page=page,
        page_size=page_size,
        search=q,
        organism=organism,
        db=db,
    )


@router.get(
    "/{batch_id}",
    response_model=AnalysisBatchDetail,
    summary="Get full batch detail with all image results",
    responses={
        200: {"description": "Batch detail returned"},
        404: {"description": "Batch not found"},
    },
)
async def get_analysis(
    batch_id: UUID,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> AnalysisBatchDetail:
    """Return the full detail of a single analysis batch including all images."""
    detail = await analysis_svc.get_batch_detail(batch_id=batch_id, db=db)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )
    return detail


@router.delete(
    "/{batch_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a batch, its images, and associated overlay files",
    responses={
        204: {"description": "Batch deleted successfully"},
        404: {"description": "Batch not found"},
    },
)
async def delete_analysis(
    batch_id: UUID,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> None:
    """Delete an analysis batch and all its data.

    Removes the database rows and deletes overlay PNG files from disk.
    Returns 204 No Content on success.
    """
    settings = get_settings()
    storage_dir = Path(settings.image_storage_dir)
    deleted = await analysis_svc.delete_batch(
        batch_id=batch_id,
        db=db,
        storage_dir=storage_dir,
    )
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )


@router.get(
    "/{batch_id}/images/{image_id}/overlay",
    summary="Serve the overlay PNG for a processed image",
    responses={
        200: {"content": {"image/png": {}}, "description": "Overlay PNG image"},
        404: {"description": "Batch, image, or overlay file not found"},
    },
)
async def get_overlay(
    batch_id: UUID,
    image_id: UUID,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> StreamingResponse:
    """Stream the overlay PNG image for a processed image.

    The overlay is read from disk at the path stored in the database.
    Returns 404 if the batch, image, or overlay file does not exist.
    """
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    from app.models.analysis import AnalysisBatch, AnalysisImage

    stmt = (
        select(AnalysisImage)
        .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
        .where(AnalysisImage.id == image_id)
        .where(AnalysisImage.batch_id == batch_id)
    )
    result = await db.execute(stmt)
    image = result.scalar_one_or_none()

    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} in batch {batch_id} not found.",
        )

    if image.status != "completed" or not image.overlay_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} has no completed overlay.",
        )

    settings = get_settings()
    overlay_path = Path(image.overlay_path)
    if not overlay_path.is_absolute():
        overlay_path = Path(settings.image_storage_dir) / overlay_path

    if not overlay_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Overlay file not found on disk: {overlay_path}",
        )

    async def file_iterator(path: Path):
        with open(path, "rb") as f:
            while chunk := f.read(8192):
                yield chunk

    return StreamingResponse(
        file_iterator(overlay_path),
        media_type="image/png",
        headers={"Content-Disposition": f'inline; filename="{overlay_path.name}"'},
    )
