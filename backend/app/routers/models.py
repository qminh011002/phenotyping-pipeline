"""Custom model upload, assignment, and management endpoints."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.deps import get_settings
from app.schemas.model import (
    AssignmentsResponse,
    AssignModelRequest,
    AssignResultResponse,
    CustomModelListResponse,
    CustomModelResponse,
    OrganismAssignment,
)
from app.services.model_upload_service import (
    InvalidModelError,
    InvalidOrganismError,
    MAX_FILE_SIZE,
    ModelOrganismMismatchError,
    ModelNotFoundError,
    ModelUploadService,
    VALID_ORGANISMS,
)

router = APIRouter(prefix="/models", tags=["models"])


def _get_model_upload_service() -> ModelUploadService:
    settings = get_settings()
    return ModelUploadService(
        data_dir=settings.data_dir,
        pipeline_root=settings.pipeline_root,
    )


@router.post(
    "/{organism}/upload",
    response_model=CustomModelResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload a custom .pt model file",
    responses={
        400: {"description": "Only .pt files are accepted"},
        413: {"description": "File too large"},
        422: {"description": "Invalid YOLO detection model"},
    },
)
async def upload_model(
    organism: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_session),
    svc: ModelUploadService = Depends(_get_model_upload_service),
) -> CustomModelResponse:
    if organism not in VALID_ORGANISMS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid organism. Must be one of: {', '.join(VALID_ORGANISMS)}",
        )

    filename = file.filename or "unknown.pt"
    if not filename.lower().endswith(".pt"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .pt files are accepted",
        )

    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {MAX_FILE_SIZE // (1024 * 1024)}MB)",
        )

    try:
        record = await svc.save_uploaded_file(db, organism, filename, content)
    except (InvalidModelError, InvalidOrganismError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    return CustomModelResponse.model_validate(record)


@router.get(
    "/custom",
    response_model=CustomModelListResponse,
    summary="List all uploaded custom models",
)
async def list_custom_models(
    organism: str | None = None,
    db: AsyncSession = Depends(get_session),
    svc: ModelUploadService = Depends(_get_model_upload_service),
) -> CustomModelListResponse:
    if organism is not None and organism not in VALID_ORGANISMS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid organism. Must be one of: {', '.join(VALID_ORGANISMS)}",
        )

    models = await svc.list_custom_models(db, organism=organism)
    return CustomModelListResponse(
        models=[CustomModelResponse.model_validate(m) for m in models]
    )


@router.get(
    "/assignments",
    response_model=AssignmentsResponse,
    summary="Get current model assignments for all organisms",
)
async def get_assignments(
    db: AsyncSession = Depends(get_session),
    svc: ModelUploadService = Depends(_get_model_upload_service),
) -> AssignmentsResponse:
    raw = await svc.get_assignments(db)
    assignments = {}
    for organism, data in raw.items():
        custom_model = None
        if data["custom_model"] is not None:
            custom_model = CustomModelResponse.model_validate(data["custom_model"])
        assignments[organism] = OrganismAssignment(
            organism=data["organism"],
            is_default=data["is_default"],
            model_filename=data["model_filename"],
            custom_model=custom_model,
        )
    return AssignmentsResponse(assignments=assignments)


@router.put(
    "/{organism}/assign",
    response_model=AssignResultResponse,
    summary="Assign a custom model to an organism slot or revert to default",
    responses={
        404: {"description": "Custom model not found"},
        422: {"description": "Invalid organism"},
    },
)
async def assign_model(
    organism: str,
    body: AssignModelRequest,
    db: AsyncSession = Depends(get_session),
    svc: ModelUploadService = Depends(_get_model_upload_service),
) -> AssignResultResponse:
    if organism not in VALID_ORGANISMS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid organism. Must be one of: {', '.join(VALID_ORGANISMS)}",
        )

    try:
        result = await svc.assign_model(db, organism, body.custom_model_id)
    except ModelNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except (InvalidOrganismError, ModelOrganismMismatchError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    return AssignResultResponse(**result)


@router.delete(
    "/custom/{model_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an uploaded custom model",
    responses={
        404: {"description": "Model not found"},
        409: {"description": "Model is currently assigned"},
    },
)
async def delete_custom_model(
    model_id: UUID,
    db: AsyncSession = Depends(get_session),
    svc: ModelUploadService = Depends(_get_model_upload_service),
) -> None:
    model = await svc.get_custom_model(db, model_id)
    if model is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Model not found",
        )

    assigned_organism = await svc.delete_custom_model(db, model_id)
    if assigned_organism is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Model is currently assigned to: {assigned_organism}",
        )
