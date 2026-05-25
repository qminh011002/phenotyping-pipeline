"""SAM model management endpoints — list, upload, activate, delete."""

from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.deps import (
    CurrentUser,
    get_pipeline_config,
    get_sam_refinement_service,
)
from app.schemas.sam_model import (
    SamModelActivateRequest,
    SamModelListResponse,
    SamModelResponse,
)
from app.services.sam_model_service import (
    MAX_SAM_FILE_SIZE,
    SamModelNotFoundError,
    SamModelService,
)

logger = logging.getLogger(__name__)

_UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024

router = APIRouter(prefix="/sam-models", tags=["sam-models"])


def _service() -> SamModelService:
    sam_svc = get_sam_refinement_service()
    return SamModelService(
        weights_dir=sam_svc.weights_dir,
        config=get_pipeline_config(),
    )


def _stream_to_tempfile(src, max_bytes: int) -> tuple[Path, int]:
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pt")
    total = 0
    try:
        while True:
            chunk = src.read(_UPLOAD_CHUNK_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("size_exceeded")
            tmp.write(chunk)
    finally:
        tmp.close()
    return Path(tmp.name), total


def _invalidate_loaded_sam() -> None:
    """Drop the cached SAM model so the next refine loads the new weights."""
    get_sam_refinement_service().invalidate_cached_model()


@router.get(
    "", response_model=SamModelListResponse, summary="List available SAM models"
)
async def list_sam_models(user: CurrentUser) -> SamModelListResponse:
    del user  # auth-only
    svc = _service()
    entries = svc.list_models()
    active = next((e.filename for e in entries if e.is_active), None)
    return SamModelListResponse(
        models=[SamModelResponse.from_entry(e) for e in entries],
        active_filename=active,
    )


@router.post(
    "/upload",
    response_model=SamModelResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload a SAM .pt weight file",
    responses={
        400: {"description": "Only .pt files are accepted"},
        413: {"description": "File too large"},
    },
)
async def upload_sam_model(
    user: CurrentUser,
    file: UploadFile = File(...),
) -> SamModelResponse:
    del user
    filename = file.filename or "model.pt"
    if not filename.lower().endswith(".pt"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .pt files are accepted",
        )

    declared = getattr(file, "size", None)
    if declared is not None and declared > MAX_SAM_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {MAX_SAM_FILE_SIZE // (1024 * 1024)}MB)",
        )

    try:
        tmp_path, _total = await asyncio.to_thread(
            _stream_to_tempfile, file.file, MAX_SAM_FILE_SIZE
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {MAX_SAM_FILE_SIZE // (1024 * 1024)}MB)",
        ) from None

    svc = _service()
    try:
        entry = await svc.save_uploaded(filename, tmp_path)
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass

    # If the user is overwriting the active file, drop the cached model so
    # subsequent refines pick up the new bytes.
    if entry.is_active:
        _invalidate_loaded_sam()

    return SamModelResponse.from_entry(entry)


@router.put(
    "/activate",
    response_model=SamModelResponse,
    summary="Set the active SAM model",
    responses={404: {"description": "SAM model not found"}},
)
async def activate_sam_model(
    user: CurrentUser,
    body: SamModelActivateRequest,
) -> SamModelResponse:
    del user
    svc = _service()
    try:
        entry = svc.set_active(body.filename)
    except SamModelNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc

    _invalidate_loaded_sam()
    return SamModelResponse.from_entry(entry)


@router.delete(
    "/{filename}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a SAM weight file (non-builtin, non-active only)",
    responses={
        404: {"description": "SAM model not found"},
        409: {"description": "Model is builtin or currently active"},
    },
)
async def delete_sam_model(user: CurrentUser, filename: str) -> None:
    del user
    svc = _service()
    try:
        svc.delete(filename)
    except SamModelNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(exc)
        ) from exc
