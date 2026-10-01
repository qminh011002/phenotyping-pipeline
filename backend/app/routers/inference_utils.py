"""Shared upload and model guards for inference routers."""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Awaitable, Callable
from inspect import isawaitable
from pathlib import PurePath
from typing import TypeVar
from uuid import UUID

from fastapi import HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import select

from app.database import AsyncSession
from app.errors.exceptions import InferenceCancelledError
from app.models.analysis import AnalysisBatch, AnalysisImage
from app.services.inference.egg import InvalidImageError
from app.services.model_registry import ModelNotLoadedError

logger = logging.getLogger(__name__)

_T = TypeVar("_T")

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


async def unique_stem_in_batch(
    batch_id: UUID | None, stem: str, db: AsyncSession
) -> str:
    """Return ``stem``, suffixed ``_2``, ``_3``… if the batch already has it.

    Result files are keyed ``{batch_id}/{stem}_overlay.png``, so a second
    image with the same name — a common case when adding images to an existing
    batch, or uploading from two folders — would overwrite the first one's
    overlay and raw files.
    """
    if batch_id is None:
        return stem
    rows = (
        await db.execute(
            select(AnalysisImage.original_filename)
            .where(AnalysisImage.batch_id == batch_id)
            .where(AnalysisImage.original_filename.startswith(stem, autoescape=True))
        )
    ).scalars()
    taken = set(rows)
    if stem not in taken:
        return stem
    n = 2
    while f"{stem}_{n}" in taken:
        n += 1
    return f"{stem}_{n}"


def cached_file_response(
    request: Request,
    path,
    media_type: str,
    *,
    immutable: bool = False,
) -> Response:
    """Serve a file with an ETag, answering ``If-None-Match`` with 304.

    Result images are multi-megabyte and re-requested every time a viewer
    reopens them. ``immutable`` is for files that never change once written
    (the raw upload); everything else revalidates on each use, which costs
    one stat instead of a re-download.
    """
    stat = path.stat()
    etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
    headers = {
        "ETag": etag,
        "Cache-Control": (
            "private, max-age=31536000, immutable" if immutable else "private, no-cache"
        ),
        "Content-Disposition": f'inline; filename="{path.name}"',
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return FileResponse(path, media_type=media_type, headers=headers)


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


# nginx's "client closed request" — never delivered, but it labels the log line.
_CLIENT_CLOSED_REQUEST = 499


async def _client_gone(request: Request) -> None:
    """Return once the client has disconnected.

    The body is already read by the time a handler runs, so the only message
    left on the channel is the disconnect.
    """
    while True:
        message = await request.receive()
        if message["type"] == "http.disconnect":
            return


async def run_until_disconnect(
    request: Request, work: Callable[[threading.Event], Awaitable[_T]]
) -> _T:
    """Run ``work(cancel)`` and set ``cancel`` if the client hangs up first.

    An image with SAM refinement can take minutes. Without this, cancelling a
    run in the browser only drops the connection: the server keeps refining
    and holds the single inference worker, so the next request queues behind
    work nobody will read.
    """
    cancel = threading.Event()
    task = asyncio.ensure_future(work(cancel))
    watcher = asyncio.ensure_future(_client_gone(request))
    try:
        await asyncio.wait({task, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if not task.done():
            cancel.set()
        return await task
    except InferenceCancelledError as exc:
        logger.info(
            "Inference cancelled — client disconnected",
            extra={"context": {"path": request.url.path}},
        )
        raise HTTPException(
            status_code=_CLIENT_CLOSED_REQUEST, detail="Inference cancelled"
        ) from exc
    finally:
        # Also covers the server cancelling this handler outright.
        cancel.set()
        watcher.cancel()
