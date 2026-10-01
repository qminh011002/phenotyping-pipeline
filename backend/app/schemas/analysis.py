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
    # Polygon organisms: auto-calibration output forwarded from inference so the
    # backend persists corners + mm/px in the same atomic write as detections.
    calibration: dict | None = None
    # Polygon organisms: whether SAM refined the polygons during inference.
    sam_refined: bool = False


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
    annotations: list[dict] | None = None
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


class AnalysisBatchAppend(BaseModel):
    """Payload for POST /analyses/{batch_id}/append — add images to an existing batch."""

    additional_image_count: int = Field(
        ge=1, description="Number of images about to be processed into the batch"
    )
    config_snapshot: dict = Field(
        default_factory=dict,
        description="Config for this run; merged over the batch's stored snapshot",
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
    user_id: UUID | None = None
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
    # When the run in flight began — the batch's creation for a new batch, the
    # append for images being added to an existing one. None unless processing.
    processing_started_at: datetime | None = None
    # First image of the batch — lets list views request a cover thumbnail
    # without fetching the batch detail. Populated by list endpoints only.
    cover_image_id: UUID | None = None

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


# ── Dashboard overview ────────────────────────────────────────────────────────


class DashboardKpis(BaseModel):
    """Headline totals for one period."""

    batches: int = 0
    images: int = 0
    detections: int = 0
    avg_count_per_image: float | None = None
    avg_confidence: float | None = None
    avg_secs_per_image: float | None = None


class DashboardTimePoint(BaseModel):
    """One time bucket for one organism."""

    bucket: datetime
    organism: str
    batches: int = 0
    images: int = 0
    detections: int = 0
    avg_secs_per_image: float | None = None


class DashboardOrganismRow(BaseModel):
    organism: str
    batches: int = 0
    images: int = 0
    detections: int = 0
    avg_count_per_image: float | None = None
    avg_confidence: float | None = None


class DashboardHistogramBin(BaseModel):
    start: float
    end: float
    count: int


class DashboardSizeStats(BaseModel):
    """Distribution of one measured metric (mm, mm², mg) for one organism."""

    organism: str
    metric: str
    unit: str
    n: int = 0
    mean: float | None = None
    median: float | None = None
    p5: float | None = None
    p95: float | None = None
    min: float | None = None
    max: float | None = None
    bins: list[DashboardHistogramBin] = Field(default_factory=list)


class DashboardBatchRow(BaseModel):
    """Per-batch comparison row (most recent batches in the period)."""

    id: UUID
    name: str
    organism: str
    status: str
    created_at: datetime
    images: int = 0
    total_count: int = 0
    mean_count: float | None = None
    min_count: int | None = None
    max_count: int | None = None
    avg_confidence: float | None = None
    mean_length_mm: float | None = None
    measured_objects: int = 0


class DashboardAttention(BaseModel):
    """Work the operator still has to do."""

    drafts: int = 0
    failed: int = 0
    needs_calibration: int = 0
    unmeasured_images: int = 0
    low_confidence_images: int = 0


class DashboardOverview(BaseModel):
    """Response for GET /dashboard/overview."""

    days: int
    bucket: str = Field(description="'day' | 'week' | 'month'")
    range_start: datetime | None = None
    range_end: datetime
    kpis: DashboardKpis
    previous: DashboardKpis | None = None
    buckets: list[datetime] = Field(
        default_factory=list,
        description="Start of every bucket in the window, including empty ones",
    )
    timeseries: list[DashboardTimePoint] = Field(default_factory=list)
    organisms: list[DashboardOrganismRow] = Field(default_factory=list)
    confidence_histogram: list[DashboardHistogramBin] = Field(default_factory=list)
    sizes: list[DashboardSizeStats] = Field(default_factory=list)
    batches: list[DashboardBatchRow] = Field(default_factory=list)
    attention: DashboardAttention = Field(default_factory=DashboardAttention)
    recent_analyses: list[AnalysisBatchSummary] = Field(default_factory=list)


# ── Batch analytics ───────────────────────────────────────────────────────────


class BatchAnalyticsImage(BaseModel):
    """One image of the batch, with what review and measurement did to it."""

    id: UUID
    filename: str
    status: str
    count: int | None = None
    avg_confidence: float | None = None
    elapsed_secs: float | None = None
    # Detections the model produced, before any review.
    model_count: int | None = None
    # Detections drawn by the operator that are still on the image.
    user_added: int = 0
    edited: bool = False
    # Polygon organisms only.
    measured: int = 0
    mean_length_mm: float | None = None


class BatchCountStats(BaseModel):
    """Spread of the per-image count across the completed images."""

    images: int = 0
    total: int = 0
    mean: float | None = None
    median: float | None = None
    sd: float | None = None
    cv: float | None = Field(default=None, description="sd / mean")
    min: int | None = None
    max: int | None = None


class BatchClassRow(BaseModel):
    label: str
    count: int


class BatchReviewStats(BaseModel):
    images_edited: int = 0
    model_detections: int = 0
    user_added: int = 0
    # Reviewed total minus what the model found (negative = net removals).
    net_change: int = 0
    low_confidence_detections: int = 0
    low_confidence_images: int = 0


class BatchAnalytics(BaseModel):
    """Response for GET /analyses/{batch_id}/analytics."""

    batch_id: UUID
    organism: str
    images: list[BatchAnalyticsImage] = Field(default_factory=list)
    counts: BatchCountStats = Field(default_factory=BatchCountStats)
    detection_confidence: list[DashboardHistogramBin] = Field(
        default_factory=list,
        description="Model detections per confidence band (operator-drawn excluded)",
    )
    classes: list[BatchClassRow] = Field(default_factory=list)
    review: BatchReviewStats = Field(default_factory=BatchReviewStats)
    sizes: list[DashboardSizeStats] = Field(default_factory=list)


class ActiveBatchResponse(BaseModel):
    """Response for GET /analyses/active."""

    active: bool
    batch: AnalysisBatchDetail | None = None


class FailBatchRequest(BaseModel):
    """Request body for POST /analyses/{id}/fail."""

    reason: str = Field(..., min_length=1, max_length=1000)


class BatchDownloadRequest(BaseModel):
    """Request body for POST /analyses/{id}/download.

    `image_ids` is the subset of images to include. If omitted or empty the
    server includes every completed image in the batch.
    """

    image_ids: list[UUID] | None = Field(
        default=None,
        max_length=1000,
        description="Subset of image IDs to include. None/empty means all.",
    )
