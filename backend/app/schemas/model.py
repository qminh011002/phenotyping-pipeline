"""Pydantic schemas for custom model upload and assignment endpoints."""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class CustomModelResponse(BaseModel):
    """Metadata for an uploaded custom model."""

    id: UUID
    organism: str
    original_filename: str
    file_size_bytes: int
    uploaded_at: datetime
    is_valid: bool

    model_config = {"from_attributes": True}


class CustomModelListResponse(BaseModel):
    """List of uploaded custom models."""

    models: list[CustomModelResponse]


class AssignModelRequest(BaseModel):
    """Request body for assigning a custom model to an organism slot."""

    custom_model_id: UUID | None = Field(
        default=None,
        description="UUID of the custom model to assign, or null to revert to default",
    )


class OrganismAssignment(BaseModel):
    """Current model assignment for a single organism."""

    organism: str
    is_default: bool
    has_default: bool = Field(
        default=False,
        description="True if at least one .pt file exists in <organism>/default/.",
    )
    model_filename: str | None = Field(
        default=None,
        description="Filename of the active model. None when neither default nor custom is installed.",
    )
    default_filename: str | None = Field(
        default=None,
        description="Filename of the default-folder model, if any.",
    )
    custom_model: CustomModelResponse | None = None


class AssignmentsResponse(BaseModel):
    """Current model assignments for all organisms."""

    assignments: dict[str, OrganismAssignment]


class AssignResultResponse(BaseModel):
    """Result of assigning or reverting a model."""

    organism: str
    custom_model_id: UUID | None
    model_filename: str | None = None
