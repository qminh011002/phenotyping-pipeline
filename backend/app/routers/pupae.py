"""Pupae HTTP endpoints — mirrors the larvae router shape.

Pupae shares the same persistence path as larvae (the ``larvae_detection``,
``larvae_calibration``, and ``larvae_measurement`` tables are organism-agnostic
within polygon-based organisms), so the read/edit/measure endpoints stay on
the larvae router. Only inference is organism-specific:

  POST  /inference/pupae?batch_id=...   — run pupae segmentation on one image

Auth + ownership rules match larvae (BE-020/BE-021).
"""

from __future__ import annotations

import logging
import uuid
from pathlib import PurePath
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import select

from app.database import AsyncSession, get_session
from app.deps import (
    AnnotatedPupaeInferenceService,
    CurrentUser,
    get_model_registry,
)
from app.models.analysis import AnalysisBatch
from app.schemas.pupae import PupaeDetectionResult
from app.services.inference.egg import InvalidImageError
from app.services.model_registry import ModelNotLoadedError

logger = logging.getLogger(__name__)

router = APIRouter(tags=["pupae"])

ALLOWED_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp"})
MAX_IMAGE_BYTES = 100 * 1024 * 1024


def _validate_extension(filename: str) -> tuple[str, str]:
    stem = PurePath(filename).stem
    suffix = PurePath(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported file type {suffix!r}. "
                f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
            ),
        )
    return stem, suffix


async def _verify_batch_owned(
    batch_id: UUID, db: AsyncSession, user_id: UUID
) -> AnalysisBatch:
    batch = (
        await db.execute(
            select(AnalysisBatch)
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
    ).scalar_one_or_none()
    if batch is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )
    return batch


@router.post(
    "/inference/pupae",
    response_model=PupaeDetectionResult,
    status_code=status.HTTP_200_OK,
    summary="Run pupae segmentation on a single image",
)
async def run_pupae_inference(
    inference_svc: AnnotatedPupaeInferenceService,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
    file: Annotated[
        UploadFile, File(description="Image file (JPG, PNG, TIFF, BMP)")
    ],
    batch_id: Annotated[
        str | None,
        Query(description="Persist results into this batch (must be owned by caller)"),
    ] = None,
) -> PupaeDetectionResult:
    stem, suffix = _validate_extension(file.filename or "unknown")

    bid: UUID | None = None
    if batch_id:
        try:
            bid = UUID(batch_id)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid batch_id"
            ) from exc
        await _verify_batch_owned(bid, db, user.id)

    registry = get_model_registry()
    if registry.status("pupae") != "loaded":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Pupae model not loaded.",
        )

    data = await file.read()
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty."
        )
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {MAX_IMAGE_BYTES // (1024 * 1024)} MB)",
        )

    resolved_batch_id = batch_id or str(uuid.uuid4())

    try:
        result = await inference_svc.process_single(
            data, stem, resolved_batch_id, raw_suffix=suffix
        )
    except InvalidImageError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    except ModelNotLoadedError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc

    if bid is not None:
        # Same as larvae: the frontend follows with POST /analyses/{id}/images
        # to persist; we don't write the AnalysisImage row here.
        pass

    return result
