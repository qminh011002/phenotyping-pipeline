"""POST /inference/egg (single) and POST /inference/egg/batch (multiple).

Accepts image uploads, delegates to EggInferenceService, and returns DetectionResult
shapes as defined in api-contract.mdc.
"""

from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status

from app.database import AsyncSession, get_session
from app.deps import (
    AnnotatedEggInferenceService,
    AnnotatedNeonateInferenceService,
    CurrentUser,
    get_model_registry,
)
from app.routers.inference_utils import (
    check_upload_size_hint,
    map_inference_error,
    parse_and_verify_optional_batch,
    read_image_upload,
    validate_image_extension,
)
from app.schemas.detection import BatchDetectionResult, DetectionResult
from app.services.inference.egg import InvalidImageError
from app.services.model_registry import ModelNotLoadedError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/inference", tags=["inference"])

MAX_BATCH_SIZE = 50  # max number of files per batch request
MAX_TOTAL_BATCH_BYTES = 1024 * 1024 * 1024  # 1 GB cap across an entire batch


# ─────────────────────────────────────────────────────────────────────────────
# POST /inference/egg
# ─────────────────────────────────────────────────────────────────────────────


@router.post(
    "/egg",
    response_model=DetectionResult,
    status_code=status.HTTP_200_OK,
    summary="Run egg detection on a single image",
    responses={
        400: {"description": "Invalid image format or corrupt file"},
        503: {"description": "Model not loaded"},
        500: {"description": "Inference failed"},
    },
)
async def run_single_inference(
    inference_svc: AnnotatedEggInferenceService,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
    file: Annotated[
        UploadFile, File(description="Image file to analyze (JPG, PNG, TIFF, BMP)")
    ],
    batch_id: Annotated[
        str | None, Query(description="Optional batch ID for overlay path")
    ] = None,
) -> DetectionResult:
    """Run egg detection on a single uploaded image.

    The image is validated by extension, decoded in the inference thread pool,
    processed through the tiled YOLO pipeline, and the overlay is saved to disk.
    Only the overlay URL reference is returned — never base64 image data.
    """
    # Validate extension
    stem, suffix = validate_image_extension(file.filename or "unknown")

    # Verify ownership of the supplied batch (if any) before doing any work.
    await parse_and_verify_optional_batch(batch_id, db, user.id)

    # Check model is ready
    registry = get_model_registry()
    if not registry.model_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model not loaded. The server may still be starting up.",
        )

    data = await read_image_upload(file)

    resolved_batch_id = batch_id or str(uuid.uuid4())

    # Delegate to service
    try:
        result = await inference_svc.process_single(
            data, stem, resolved_batch_id, raw_suffix=suffix
        )
    except (InvalidImageError, ModelNotLoadedError) as exc:
        raise map_inference_error(exc) from exc
    except Exception as exc:
        logger.exception(
            "Inference failed for %s",
            file.filename,
            extra={
                "context": {
                    "filename": file.filename,
                    "exception": str(exc),
                }
            },
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Inference failed: {exc}",
        ) from exc

    return result


# ─────────────────────────────────────────────────────────────────────────────
# POST /inference/neonate
# ─────────────────────────────────────────────────────────────────────────────


@router.post(
    "/neonate",
    response_model=DetectionResult,
    status_code=status.HTTP_200_OK,
    summary="Run neonate detection on a single image",
    responses={
        400: {"description": "Invalid image format or corrupt file"},
        503: {"description": "Model not loaded"},
        500: {"description": "Inference failed"},
    },
)
async def run_single_neonate_inference(
    inference_svc: AnnotatedNeonateInferenceService,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
    file: Annotated[
        UploadFile, File(description="Image file to analyze (JPG, PNG, TIFF, BMP)")
    ],
    batch_id: Annotated[
        str | None, Query(description="Optional batch ID for overlay path")
    ] = None,
) -> DetectionResult:
    """Run neonate detection on a single uploaded image."""
    stem, suffix = validate_image_extension(file.filename or "unknown")
    await parse_and_verify_optional_batch(batch_id, db, user.id)

    registry = get_model_registry()
    if not registry.neonate_model_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Neonate model not loaded. Check the 'neonate' section of config.yaml.",
        )

    data = await read_image_upload(file)

    resolved_batch_id = batch_id or str(uuid.uuid4())

    try:
        result = await inference_svc.process_single(
            data, stem, resolved_batch_id, raw_suffix=suffix
        )
    except (InvalidImageError, ModelNotLoadedError) as exc:
        raise map_inference_error(exc) from exc
    except Exception as exc:
        logger.exception(
            "Neonate inference failed for %s",
            file.filename,
            extra={"context": {"filename": file.filename, "exception": str(exc)}},
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Inference failed: {exc}",
        ) from exc

    return result


# ─────────────────────────────────────────────────────────────────────────────
# POST /inference/neonate/batch
# ─────────────────────────────────────────────────────────────────────────────


@router.post(
    "/neonate/batch",
    response_model=BatchDetectionResult,
    status_code=status.HTTP_200_OK,
    summary="Run neonate detection on multiple images",
    responses={
        400: {"description": "One or more invalid images in the batch"},
        413: {"description": "Batch size exceeds the limit"},
        503: {"description": "Model not loaded"},
        500: {"description": "Inference failed"},
    },
)
async def run_batch_neonate_inference(
    files: Annotated[
        list[UploadFile],
        File(description="Image files to analyze (JPG, PNG, TIFF, BMP). Max 50 files."),
    ],
    inference_svc: AnnotatedNeonateInferenceService,
    user: CurrentUser,
) -> BatchDetectionResult:
    """Run neonate detection on multiple uploaded images sequentially."""
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No files uploaded.",
        )

    if len(files) > MAX_BATCH_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Batch size {len(files)} exceeds the maximum of {MAX_BATCH_SIZE}.",
        )

    # Validate model availability *before* buffering any bytes, so a misbehaving
    # client can't trigger a multi-GB read just to get a 503.
    registry = get_model_registry()
    if not registry.neonate_model_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Neonate model not loaded. Check the 'neonate' section of config.yaml.",
        )

    validated: list[tuple[bytes, str, str]] = []
    total_bytes = 0
    for file in files:
        stem, suffix = validate_image_extension(file.filename or "unknown")
        check_upload_size_hint(file)
        data = await read_image_upload(file)
        total_bytes += len(data)
        if total_bytes > MAX_TOTAL_BATCH_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    f"Batch exceeds {MAX_TOTAL_BATCH_BYTES // (1024 * 1024)} MB total"
                ),
            )
        validated.append((data, stem, suffix))

    batch_id = str(uuid.uuid4())

    try:
        result = await inference_svc.process_batch(validated, batch_id)
    except (InvalidImageError, ModelNotLoadedError) as exc:
        raise map_inference_error(exc) from exc
    except Exception as exc:
        logger.exception(
            "Neonate batch inference failed (%d files)",
            len(files),
            extra={"context": {"batch_size": len(files), "exception": str(exc)}},
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Batch inference failed: {exc}",
        ) from exc

    return result


# ─────────────────────────────────────────────────────────────────────────────
# POST /inference/egg/batch
# ─────────────────────────────────────────────────────────────────────────────


@router.post(
    "/egg/batch",
    response_model=BatchDetectionResult,
    status_code=status.HTTP_200_OK,
    summary="Run egg detection on multiple images",
    responses={
        400: {"description": "One or more invalid images in the batch"},
        413: {"description": "Batch size exceeds the limit"},
        503: {"description": "Model not loaded"},
        500: {"description": "Inference failed"},
    },
)
async def run_batch_inference(
    files: Annotated[
        list[UploadFile],
        File(description="Image files to analyze (JPG, PNG, TIFF, BMP). Max 50 files."),
    ],
    inference_svc: AnnotatedEggInferenceService,
    user: CurrentUser,
) -> BatchDetectionResult:
    """Run egg detection on multiple uploaded images sequentially.

    Images are processed one at a time. Each overlay is saved to disk and
    referenced by a URL in the result. Processing order is preserved.
    """
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No files uploaded.",
        )

    if len(files) > MAX_BATCH_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Batch size {len(files)} exceeds the maximum of {MAX_BATCH_SIZE}.",
        )

    # Check model is ready *before* buffering uploads, so misbehaving clients
    # can't push hundreds of MB through just to get a 503.
    registry = get_model_registry()
    if not registry.model_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model not loaded. The server may still be starting up.",
        )

    # Validate all extensions before processing (fail-fast)
    validated: list[tuple[bytes, str, str]] = []
    total_bytes = 0
    for i, file in enumerate(files):
        stem, suffix = validate_image_extension(file.filename or f"file_{i}")
        check_upload_size_hint(file)
        data = await read_image_upload(file)
        total_bytes += len(data)
        if total_bytes > MAX_TOTAL_BATCH_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    f"Batch exceeds {MAX_TOTAL_BATCH_BYTES // (1024 * 1024)} MB total"
                ),
            )
        validated.append((data, stem, suffix))

    batch_id = str(uuid.uuid4())

    # Delegate to service
    try:
        result = await inference_svc.process_batch(validated, batch_id)
    except (InvalidImageError, ModelNotLoadedError) as exc:
        raise map_inference_error(exc) from exc
    except Exception as exc:
        logger.exception(
            "Batch inference failed (%d files)",
            len(files),
            extra={
                "context": {
                    "batch_size": len(files),
                    "exception": str(exc),
                }
            },
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Batch inference failed: {exc}",
        ) from exc

    return result
