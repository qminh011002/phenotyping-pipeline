"""Shared upload and model guards for inference routers."""

from __future__ import annotations

import logging
from inspect import isawaitable
from pathlib import PurePath
from uuid import UUID

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import select

from app.database import AsyncSession
from app.models.analysis import AnalysisBatch
from app.services.inference.egg import InvalidImageError
from app.services.model_registry import ModelNotLoadedError

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp"})
MAX_IMAGE_BYTES = 100 * 1024 * 1024


def validate_image_extension(filename: str) -> tuple[str, str]:
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


def check_upload_size_hint(file: UploadFile) -> None:
    size = getattr(file, "size", None)
    if size is not None and size > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {MAX_IMAGE_BYTES // (1024 * 1024)} MB)",
        )


async def read_image_upload(file: UploadFile) -> bytes:
    check_upload_size_hint(file)
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
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {MAX_IMAGE_BYTES // (1024 * 1024)} MB)",
        )
    return data


async def verify_batch_owned(
    batch_id: UUID, db: AsyncSession, user_id: UUID
) -> AnalysisBatch:
    maybe_batch = (
        await db.execute(
            select(AnalysisBatch)
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
    ).scalar_one_or_none()
    batch = await maybe_batch if isawaitable(maybe_batch) else maybe_batch
    if batch is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )
    return batch


async def parse_and_verify_optional_batch(
    batch_id: str | None, db: AsyncSession, user_id: UUID
) -> UUID | None:
    if not batch_id:
        return None
    try:
        bid = UUID(batch_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid batch_id",
        ) from exc
    await verify_batch_owned(bid, db, user_id)
    return bid


def ensure_status_loaded(registry, organism: str, display_name: str) -> None:
    if registry.status(organism) != "loaded":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{display_name} model not loaded.",
        )


def map_inference_error(exc: Exception) -> HTTPException:
    if isinstance(exc, InvalidImageError):
        return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if isinstance(exc, ModelNotLoadedError):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"Inference failed: {exc}",
    )
