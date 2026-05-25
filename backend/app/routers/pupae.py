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
from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, UploadFile, status

from app.database import AsyncSession, get_session
from app.deps import (
    AnnotatedPupaeInferenceService,
    CurrentUser,
    get_model_registry,
)
from app.routers.inference_utils import (
    ensure_status_loaded,
    map_inference_error,
    parse_and_verify_optional_batch,
    read_image_upload,
    validate_image_extension,
)
from app.schemas.pupae import PupaeDetectionResult
from app.services.inference.egg import InvalidImageError
from app.services.model_registry import ModelNotLoadedError

logger = logging.getLogger(__name__)

router = APIRouter(tags=["pupae"])


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
    file: Annotated[UploadFile, File(description="Image file (JPG, PNG, TIFF, BMP)")],
    batch_id: Annotated[
        str | None,
        Query(description="Persist results into this batch (must be owned by caller)"),
    ] = None,
) -> PupaeDetectionResult:
    stem, suffix = validate_image_extension(file.filename or "unknown")
    bid = await parse_and_verify_optional_batch(batch_id, db, user.id)

    registry = get_model_registry()
    ensure_status_loaded(registry, "pupae", "Pupae")
    data = await read_image_upload(file)

    resolved_batch_id = batch_id or str(uuid.uuid4())

    try:
        result = await inference_svc.process_single(
            data, stem, resolved_batch_id, raw_suffix=suffix
        )
    except (InvalidImageError, ModelNotLoadedError) as exc:
        raise map_inference_error(exc) from exc

    if bid is not None:
        # Same as larvae: the frontend follows with POST /analyses/{id}/images
        # to persist; we don't write the AnalysisImage row here.
        pass

    return result
