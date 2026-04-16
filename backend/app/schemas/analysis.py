"""Pydantic schemas for analysis batch CRUD operations and dashboard."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class AnalysisBatchCreate(BaseModel):
    """Payload for creating a new analysis batch (when the operator clicks 'Process')."""

    organism_type: str = Field(
        default="egg",
        description="Organism type (egg, larvae, pupae, neonate)",
    )
    mode: str = Field(
        default="upload",
        description="Analysis mode: 'upload' or 'camera'",
    )
    device: str = Field(
        default="cpu",
        description="Device used: 'cpu' or 'cuda:0' etc.",
    )
    config_snapshot: dict = Field(
        default_factory=dict,
        description="EggConfig snapshot at analysis time",
    )
    total_image_count: int = Field(ge=1, description="Number of images in this batch")


class AnalysisImageResult(BaseModel):
    """Data for recording a single image's inference result into the DB.

    Derived from the DetectionResult returned by EggInferenceService.
    """

    filename: str
    count: int
    avg_confidence: float
    elapsed_seconds: float
    annotations: list[dict] = Field(default_factory=list)
    overlay_url: str  # URL reference to the saved overlay file on disk
    original_width: int | None = None
    original_height: int | None = None
    file_size_bytes: int | None = None


class AnalysisImageSummary(BaseModel):
    """A single image result as returned in list/detail views."""

    id: UUID
    original_filename: str
    status: str
    count: int | None = None
    avg_confidence: float | None = None
    elapsed_secs: float | None = None
    overlay_path: str | None = None
    error_message: str | None = None
    created_at: datetime
    edited_annotations: list[dict] | None = None

    model_config = {"from_attributes": True}


class AnalysisImageDetail(AnalysisImageSummary):
    """Full detail for a single image — includes all fields including edited_annotations."""

    model_config = {"from_attributes": True}


class EditedAnnotationsUpdate(BaseModel):
    """Request body for PUT /analyses/{batch_id}/images/{image_id}/annotations."""

    edited_annotations: list[dict] = Field(
        default_factory=list,
        description=(
            "Full list of bounding boxes. Each entry is a superset of the base "
            "BBox shape: {label, bbox, confidence} plus optional {origin, edited_at}."
        ),
    )


class AnalysisBatchSummary(BaseModel):
    """Summary of a batch returned in list and dashboard views."""

    id: UUID
    created_at: datetime
    completed_at: datetime | None = None
    status: str
    organism_type: str
    mode: str
    device: str
    total_image_count: int
    total_count: int | None = None
    avg_confidence: float | None = None
    total_elapsed_secs: float | None = None

    model_config = {"from_attributes": True}


class AnalysisBatchDetail(AnalysisBatchSummary):
    """Full batch detail with config snapshot, notes, and all image results."""

    config_snapshot: dict = Field(default_factory=dict)
    notes: str | None = None
    images: list[AnalysisImageSummary] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class AnalysisListResponse(BaseModel):
    """Paginated list of analysis batches."""

    items: list[AnalysisBatchSummary]
    total: int
    page: int
    page_size: int


class DashboardStats(BaseModel):
    """Aggregate statistics for the dashboard home page."""

    total_analyses: int
    total_images_processed: int
    total_eggs_counted: int
    avg_confidence: float | None = None
    avg_processing_time: float | None = None
    recent_analyses: list[AnalysisBatchSummary] = Field(default_factory=list)
