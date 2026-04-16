"""GET /analyses, GET /analyses/{batch_id}, DELETE /analyses/{batch_id}, and
GET /analyses/{batch_id}/images/{image_id}/overlay.

Provides the Recorded page and overlay image serving.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from app.database import AsyncSession, get_session
from app.deps import get_analysis_service, get_settings
from app.schemas.analysis import (
    AnalysisBatchCreate,
    AnalysisBatchDetail,
    AnalysisImageDetail,
    AnalysisImageResult,
    AnalysisListResponse,
    EditedAnnotationsUpdate,
)
from app.services.analysis_service import AnalysisService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/analyses", tags=["analyses"])

# Default pagination
_DEFAULT_PAGE = 1
_DEFAULT_PAGE_SIZE = 20


@router.post(
    "",
    response_model=AnalysisBatchDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new analysis batch",
    responses={
        201: {"description": "Batch created"},
        422: {"description": "Validation error"},
    },
)
async def create_analysis(
    data: AnalysisBatchCreate,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> AnalysisBatchDetail:
    """Create a new analysis batch with status 'processing'.

    Call this when the operator clicks "Process Images" to register the batch
    before inference begins. After processing each image,
    call POST /analyses/{id}/images to record results.
    When all images are done, call POST /analyses/{id}/complete.
    """
    batch = await analysis_svc.create_batch(data=data, db=db)
    await db.commit()
    # Re-fetch full detail for the response
    detail = await analysis_svc.get_batch_detail(batch_id=batch.id, db=db)
    assert detail is not None
    return detail


@router.get(
    "",
    response_model=AnalysisListResponse,
    summary="List analysis batches with pagination and filters",
)
async def list_analyses(
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
    page: int = Query(default=_DEFAULT_PAGE, ge=1, description="1-indexed page number"),
    page_size: int = Query(
        default=_DEFAULT_PAGE_SIZE, ge=1, le=100, description="Items per page"
    ),
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


@router.get(
    "/{batch_id}/images/{image_id}/raw",
    summary="Serve the raw (un-annotated) source image for a processed image",
    responses={
        200: {"content": {"image/png": {}}, "description": "Raw PNG image"},
        404: {"description": "Batch, image, or raw file not found"},
    },
)
async def get_raw(
    batch_id: UUID,
    image_id: UUID,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> StreamingResponse:
    """Stream the raw source image the operator uploaded.

    The raw PNG is saved alongside the overlay by the inference service.
    We derive its path from the overlay path instead of adding a new DB
    column: both live in the same batch directory, differing only by the
    ``_overlay.png`` → ``_raw.png`` suffix.
    """
    from sqlalchemy import select

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
            detail=f"Image {image_id} has no completed result.",
        )

    settings = get_settings()
    overlay_path = Path(image.overlay_path)
    if not overlay_path.is_absolute():
        overlay_path = Path(settings.image_storage_dir) / overlay_path

    raw_path = overlay_path.with_name(
        overlay_path.name.replace("_overlay.png", "_raw.png"),
    )

    if not raw_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Raw file not found on disk: {raw_path}",
        )

    async def file_iterator(path: Path):
        with open(path, "rb") as f:
            while chunk := f.read(8192):
                yield chunk

    return StreamingResponse(
        file_iterator(raw_path),
        media_type="image/png",
        headers={"Content-Disposition": f'inline; filename="{raw_path.name}"'},
    )


@router.post(
    "/{batch_id}/images",
    status_code=status.HTTP_201_CREATED,
    summary="Record a single image's inference result",
    responses={
        201: {"description": "Image result recorded"},
        404: {"description": "Batch not found"},
    },
)
async def add_image_result(
    batch_id: UUID,
    data: AnalysisImageResult,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> dict:
    """Record one image's inference result into an existing batch.

    Call this once per image after processing. The overlay PNG must already be
    saved to disk — only the path reference is stored in the database.
    """
    # Verify batch exists
    detail = await analysis_svc.get_batch_detail(batch_id=batch_id, db=db)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )

    await analysis_svc.add_image_result(batch_id=batch_id, result=data, db=db)
    await db.commit()
    return {"status": "ok", "batch_id": str(batch_id)}


@router.post(
    "/{batch_id}/complete",
    response_model=AnalysisBatchDetail,
    status_code=status.HTTP_200_OK,
    summary="Mark a batch as completed and compute aggregates",
    responses={
        200: {"description": "Batch marked as completed"},
        404: {"description": "Batch not found"},
    },
)
async def complete_analysis(
    batch_id: UUID,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> AnalysisBatchDetail:
    """Mark a batch as completed and compute aggregate statistics.

    Call this after all images have been recorded via POST /analyses/{id}/images.
    """
    detail = await analysis_svc.get_batch_detail(batch_id=batch_id, db=db)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )

    await analysis_svc.complete_batch(batch_id=batch_id, db=db)
    await db.commit()

    # Re-fetch updated detail
    updated = await analysis_svc.get_batch_detail(batch_id=batch_id, db=db)
    assert updated is not None
    return updated


@router.put(
    "/{batch_id}/images/{image_id}/annotations",
    response_model=AnalysisImageDetail,
    status_code=status.HTTP_200_OK,
    summary="Save edited annotations for a single image",
    responses={
        200: {"description": "Edited annotations saved"},
        404: {"description": "Batch or image not found"},
        422: {"description": "Validation error"},
    },
)
async def save_edited_annotations(
    batch_id: UUID,
    image_id: UUID,
    data: EditedAnnotationsUpdate,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> AnalysisImageDetail:
    """Replace the edited_annotations for a single image (full-replace semantics).

    The model's original annotations are preserved in the `annotations` column.
    Edited boxes each carry `origin: "model" | "user"` and an optional `edited_at`
    ISO-8601 timestamp.
    """
    updated = await analysis_svc.update_edited_annotations(
        batch_id=batch_id,
        image_id=image_id,
        data=data,
        db=db,
    )
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} in batch {batch_id} not found.",
        )
    await db.commit()
    return updated


@router.delete(
    "/{batch_id}/images/{image_id}/annotations",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Reset edited annotations to model output",
    responses={
        204: {"description": "Edited annotations cleared"},
        404: {"description": "Batch or image not found"},
    },
)
async def reset_edited_annotations(
    batch_id: UUID,
    image_id: UUID,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> None:
    """Clear edited_annotations back to NULL — restores the model's original output.

    This is a destructive reset with no undo on the server side; the operator is
    prompted with an AlertDialog confirmation before this is called.
    """
    cleared = await analysis_svc.clear_edited_annotations(
        batch_id=batch_id,
        image_id=image_id,
        db=db,
    )
    if not cleared:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} in batch {batch_id} not found.",
        )
    await db.commit()
