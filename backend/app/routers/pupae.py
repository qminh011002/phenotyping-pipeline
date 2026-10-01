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

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile, status

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
    run_until_disconnect,
    unique_stem_in_batch,
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
    request: Request,
    file: Annotated[UploadFile, File(description="Image file (JPG, PNG, TIFF, BMP)")],
    batch_id: Annotated[
        str | None,
        Query(description="Persist results into this batch (must be owned by caller)"),
    ] = None,
    count_only: Annotated[
        bool,
        Query(
            description=(
                "Skip SAM polygon refinement. The count is unaffected; outlines "
                "can be refined later via "
                "POST /analyses/{batch_id}/images/{image_id}/refine."
            )
        ),
    ] = False,
) -> PupaeDetectionResult:
    stem, suffix = validate_image_extension(file.filename or "unknown")
    bid = await parse_and_verify_optional_batch(batch_id, db, user.id)
    stem = await unique_stem_in_batch(bid, stem, db)

    registry = get_model_registry()
    ensure_status_loaded(registry, "pupae", "Pupae")
    data = await read_image_upload(file)

    resolved_batch_id = batch_id or str(uuid.uuid4())

    # Same as larvae: the frontend follows with POST /analyses/{id}/images to
    # persist; no AnalysisImage row is written here.
    try:
        return await run_until_disconnect(
            request,
            lambda cancel: inference_svc.process_single(
                data,
                stem,
                resolved_batch_id,
                raw_suffix=suffix,
                refine=False if count_only else None,
                cancel=cancel,
            ),
        )
    except (InvalidImageError, ModelNotLoadedError) as exc:
        raise map_inference_error(exc) from exc
