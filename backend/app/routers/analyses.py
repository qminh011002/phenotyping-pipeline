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
from fastapi.responses import FileResponse, StreamingResponse

from app.database import AsyncSession, get_session
from app.deps import get_analysis_service, get_cached_storage_dir, get_settings
from app.schemas.analysis import (
    ActiveBatchResponse,
    AnalysisBatchCreate,
    AnalysisBatchDetail,
    AnalysisBatchUpdate,
    AnalysisImageDetail,
    AnalysisImageResult,
    AnalysisListResponse,
    BatchDownloadRequest,
    EditedAnnotationsUpdate,
    FailBatchRequest,
)
from app.services.analysis_service import AnalysisService
from app.services.batch_export import stream_batch_archive

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
        409: {"description": "A batch is already processing"},
        422: {"description": "Validation error"},
    },
)
async def create_analysis(
    data: AnalysisBatchCreate,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> AnalysisBatchDetail:
    """Create a new analysis batch with status 'processing'.

    Returns 409 if another batch is already in 'processing' state.
    """
    active = await analysis_svc.has_active_batch(db=db)
    if active is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A batch is already processing",
            headers={"X-Active-Batch-Id": str(active.id)},
        )
    batch = await analysis_svc.create_batch(data=data, db=db)
    await db.commit()
    detail = await analysis_svc.get_batch_detail(batch_id=batch.id, db=db)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load freshly created batch",
        )
    return detail


@router.get(
    "/active",
    response_model=ActiveBatchResponse,
    summary="Get the currently-processing batch, if any",
    responses={200: {"description": "Active batch status"}},
)
async def get_active_batch(
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> ActiveBatchResponse:
    """Return the active processing batch with progress details.

    Automatically marks zombie batches (>24h old) as failed.
    """
    resp = await analysis_svc.get_active_batch(db=db)
    await db.commit()
    return resp


@router.post(
    "/{batch_id}/fail",
    status_code=status.HTTP_200_OK,
    summary="Mark a processing batch as failed",
    responses={
        200: {"description": "Batch marked as failed"},
        404: {"description": "Batch not found"},
        409: {"description": "Batch is not in processing state"},
    },
)
async def fail_analysis(
    batch_id: UUID,
    data: FailBatchRequest,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> dict:
    """Mark a batch as failed with a reason string."""
    from app.models.analysis import AnalysisBatch
    from sqlalchemy import select

    stmt = select(AnalysisBatch).where(AnalysisBatch.id == batch_id)
    result = await db.execute(stmt)
    batch = result.scalar_one_or_none()
    if batch is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Batch not found",
        )
    if batch.status != "processing":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Batch is not in processing state",
        )
    failed = await analysis_svc.fail_batch(batch_id=batch_id, error=data.reason, db=db)
    await db.commit()
    if failed is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="fail_batch returned no row after commit",
        )
    return {
        "id": str(failed.id),
        "status": failed.status,
        "failed_at": failed.failed_at.isoformat() if failed.failed_at else None,
        "failure_reason": failed.failure_reason,
    }


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
    q: str | None = Query(
        default=None,
        description=(
            "Substring match against batch name OR any image's "
            "original filename (case-insensitive)."
        ),
    ),
    organism: str | None = Query(default=None, description="Filter by organism type"),
    status: list[str] | None = Query(
        default=None,
        description=(
            "Restrict to the given statuses. Accepts multiple values "
            "(?status=draft&status=completed). Defaults to all statuses; the "
            "Records page passes ``status=completed`` so drafts stay hidden."
        ),
    ),
) -> AnalysisListResponse:
    """Return a paginated list of analysis batches.

    Results are sorted by creation date descending (newest first).
    Optionally filter by organism type; ``q`` performs a case-insensitive
    substring match on the batch ``name`` OR any image's ``original_filename``.
    """
    return await analysis_svc.list_batches(
        page=page,
        page_size=page_size,
        search=q,
        organism=organism,
        statuses=status,
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


@router.patch(
    "/{batch_id}",
    response_model=AnalysisBatchDetail,
    status_code=status.HTTP_200_OK,
    summary="Rename a batch (partial update)",
    responses={
        200: {"description": "Batch updated"},
        404: {"description": "Batch not found"},
        422: {"description": "Validation error"},
    },
)
async def patch_analysis(
    batch_id: UUID,
    data: AnalysisBatchUpdate,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> AnalysisBatchDetail:
    """Rename a batch. Only ``name`` is supported today.

    Shaped as a partial-update object so additional fields slot in without
    breaking existing clients.
    """
    updated = await analysis_svc.rename_batch(batch_id=batch_id, data=data, db=db)
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )
    await db.commit()
    return updated


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
    storage_dir = Path(get_cached_storage_dir())
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
) -> FileResponse:
    """Serve the overlay PNG image for a processed image."""
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

    overlay_path = Path(image.overlay_path)
    if not overlay_path.is_absolute():
        overlay_path = Path(get_cached_storage_dir()) / overlay_path

    if not overlay_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Overlay file not found on disk: {overlay_path}",
        )

    return FileResponse(
        overlay_path,
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
) -> FileResponse:
    """Serve the raw source image the operator uploaded."""
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

    overlay_path = Path(image.overlay_path)
    if not overlay_path.is_absolute():
        overlay_path = Path(get_cached_storage_dir()) / overlay_path

    raw_path = overlay_path.with_name(
        overlay_path.name.replace("_overlay.png", "_raw.png"),
    )

    if not raw_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Raw file not found on disk: {raw_path}",
        )

    return FileResponse(
        raw_path,
        media_type="image/png",
        headers={"Content-Disposition": f'inline; filename="{raw_path.name}"'},
    )


@router.post(
    "/{batch_id}/download",
    summary="Download a ZIP of overlay images + an .xlsx summary",
    responses={
        200: {
            "content": {"application/zip": {}},
            "description": "ZIP archive streamed to the client",
        },
        400: {"description": "No completed images match the selection"},
        404: {"description": "Batch not found"},
    },
)
async def download_analysis(
    batch_id: UUID,
    data: BatchDownloadRequest,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> StreamingResponse:
    """Build a ZIP of overlay images + a styled summary.xlsx and stream it.

    If `image_ids` is omitted the whole batch is included. Only completed
    images are ever exported.
    """
    storage_dir = Path(get_cached_storage_dir())
    try:
        result = await stream_batch_archive(
            batch_id=batch_id,
            image_ids=data.image_ids,
            db=db,
            storage_dir=storage_dir,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )

    filename, iterator = result
    return StreamingResponse(
        iterator,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
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
    summary="Finish processing — moves the batch to 'draft' for review",
    responses={
        200: {"description": "Batch moved to draft"},
        404: {"description": "Batch not found"},
    },
)
async def complete_analysis(
    batch_id: UUID,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> AnalysisBatchDetail:
    """Finalize the processing phase. Computes aggregates and moves the batch
    from ``processing`` to ``draft``. Drafts are visible to the ResultViewer
    but hidden from the Records list until the operator clicks Finish.

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
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to re-load batch after completion",
        )
    return updated


@router.post(
    "/{batch_id}/finish",
    response_model=AnalysisBatchDetail,
    status_code=status.HTTP_200_OK,
    summary="Save a draft batch to Records (promote draft → completed)",
    responses={
        200: {"description": "Batch saved to records"},
        404: {"description": "Batch not found"},
        409: {"description": "Batch is not in draft state"},
    },
)
async def finish_analysis(
    batch_id: UUID,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> AnalysisBatchDetail:
    """Explicit save-to-records step. Recomputes aggregates to pick up any
    annotation edits made in the reviewer, then marks the batch ``completed``
    and stamps ``completed_at``.
    """
    try:
        finished = await analysis_svc.finish_batch(batch_id=batch_id, db=db)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    if finished is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )
    await db.commit()
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
