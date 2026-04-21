"""Pydantic schemas for analysis batch CRUD operations and dashboard."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


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
    name: str | None = Field(
        default=None,
        max_length=200,
        description="Optional operator-supplied name; server generates a default when absent",
    )
    classes: list[str] = Field(
        default_factory=list,
        description=(
            "Class names defined on the Analyze page, frozen for the batch. "
            "First entry is the default label for user-drawn boxes."
        ),
    )

    @field_validator("classes")
    @classmethod
    def _normalize_classes(cls, v: list[str]) -> list[str]:
        # Strip + drop empties + de-dup case-insensitively while preserving order.
        seen: set[str] = set()
        out: list[str] = []
        for raw in v:
            name = raw.strip()
            if not name:
                continue
            key = name.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(name)
        return out


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


class AnalysisBatchUpdate(BaseModel):
    """Partial-update payload for PATCH /analyses/{batch_id}.

    Only ``name`` is supported today; shaped as a partial-update object so that
    additional fields slot in without breaking existing clients.
    """

    name: str = Field(..., min_length=1, max_length=200)

    @field_validator("name")
    @classmethod
    def _strip_and_check(cls, v: str) -> str:
        stripped = v.strip()
        if not (1 <= len(stripped) <= 200):
            raise ValueError("name must be 1–200 characters after trimming")
        return stripped


class AnalysisBatchSummary(BaseModel):
    """Summary of a batch returned in list and dashboard views."""

    id: UUID
    name: str
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
    processed_image_count: int = 0
    failed_at: datetime | None = None
    failure_reason: str | None = None
    classes: list[str] = Field(default_factory=list)

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


class ActiveBatchResponse(BaseModel):
    """Response for GET /analyses/active."""

    active: bool
    batch: AnalysisBatchDetail | None = None


class FailBatchRequest(BaseModel):
    """Request body for POST /analyses/{id}/fail."""

    reason: str = Field(..., min_length=1, max_length=1000)
