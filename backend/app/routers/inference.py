"""POST /inference/egg (single) and POST /inference/egg/batch (multiple).

Accepts image uploads, delegates to EggInferenceService, and returns DetectionResult
shapes as defined in api-contract.mdc.
"""

from __future__ import annotations

import logging
import uuid
from pathlib import PurePath
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import JSONResponse

from app.deps import (
    AnnotatedEggInferenceService,
    AnnotatedNeonateInferenceService,
    get_model_registry,
)
from app.schemas.detection import BatchDetectionResult, DetectionResult
from app.services.inference.egg import InvalidImageError
from app.services.model_registry import ModelNotLoadedError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/inference", tags=["inference"])

# Allowed image extensions (case-insensitive)
ALLOWED_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp"})
MAX_BATCH_SIZE = 50  # max number of files per batch request
MAX_IMAGE_BYTES = 100 * 1024 * 1024  # 100 MB per image


def _check_size(file: UploadFile) -> None:
    """Reject uploads larger than MAX_IMAGE_BYTES based on Content-Length."""
    size = getattr(file, "size", None)
    if size is not None and size > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {MAX_IMAGE_BYTES // (1024 * 1024)} MB)",
        )


def _validate_extension(filename: str) -> str:
    """Return the filename stem (without extension), raising 400 on invalid extension."""
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
    return stem


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
    file: Annotated[UploadFile, File(description="Image file to analyze (JPG, PNG, TIFF, BMP)")],
    batch_id: Annotated[str | None, Query(description="Optional batch ID for overlay path")] = None,
) -> DetectionResult:
    """Run egg detection on a single uploaded image.

    The image is validated by extension, decoded in the inference thread pool,
    processed through the tiled YOLO pipeline, and the overlay is saved to disk.
    Only the overlay URL reference is returned — never base64 image data.
    """
    # Validate extension
    stem = _validate_extension(file.filename or "unknown")

    # Check model is ready
    registry = get_model_registry()
    if not registry.model_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model not loaded. The server may still be starting up.",
        )

    # Read upload bytes
    _check_size(file)
    try:
        data = await file.read()
    except Exception as exc:
        logger.error("Failed to read upload for %s: %s", file.filename, exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to read uploaded file: {file.filename!r}",
        ) from exc

    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is empty.",
        )

    resolved_batch_id = batch_id or str(uuid.uuid4())

    # Delegate to service
    try:
        result = await inference_svc.process_single(data, stem, resolved_batch_id)
    except InvalidImageError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except ModelNotLoadedError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
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
    file: Annotated[UploadFile, File(description="Image file to analyze (JPG, PNG, TIFF, BMP)")],
    batch_id: Annotated[str | None, Query(description="Optional batch ID for overlay path")] = None,
) -> DetectionResult:
    """Run neonate detection on a single uploaded image."""
    stem = _validate_extension(file.filename or "unknown")

    registry = get_model_registry()
    if not registry.neonate_model_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Neonate model not loaded. Check the 'neonate' section of config.yaml.",
        )

    _check_size(file)
    try:
        data = await file.read()
    except Exception as exc:
        logger.error("Failed to read upload for %s: %s", file.filename, exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to read uploaded file: {file.filename!r}",
        ) from exc

    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is empty.",
        )

    resolved_batch_id = batch_id or str(uuid.uuid4())

    try:
        result = await inference_svc.process_single(data, stem, resolved_batch_id)
    except InvalidImageError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except ModelNotLoadedError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
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

    validated: list[tuple[bytes, str]] = []
    for file in files:
        stem = _validate_extension(file.filename or "unknown")

        try:
            data = await file.read()
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Failed to read {file.filename!r}: {exc}",
            ) from exc

        if not data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Uploaded file is empty: {file.filename!r}",
            )
        validated.append((data, stem))

    registry = get_model_registry()
    if not registry.neonate_model_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Neonate model not loaded. Check the 'neonate' section of config.yaml.",
        )

    batch_id = str(uuid.uuid4())

    try:
        result = await inference_svc.process_batch(validated, batch_id)
    except InvalidImageError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except ModelNotLoadedError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
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

    # Validate all extensions before processing (fail-fast)
    validated: list[tuple[bytes, str]] = []
    for i, file in enumerate(files):
        stem = _validate_extension(file.filename or f"file_{i}")

        try:
            data = await file.read()
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Failed to read {file.filename!r}: {exc}",
            ) from exc

        if not data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Uploaded file is empty: {file.filename!r}",
            )
        validated.append((data, stem))

    # Check model is ready
    registry = get_model_registry()
    if not registry.model_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model not loaded. The server may still be starting up.",
        )

    batch_id = str(uuid.uuid4())

    # Delegate to service
    try:
        result = await inference_svc.process_batch(validated, batch_id)
    except InvalidImageError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except ModelNotLoadedError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
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
