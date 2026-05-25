"""Larvae detection, calibration, and measurement schemas (Phase 8).

Polygon-based detection (vs. egg's bbox). Adds calibration + per-larva
mm measurements. Mirrors `larvae_detection`, `larvae_calibration`, and
`larvae_measurement` (INF-005).

See `.cursor/rules/api-contract.mdc` for canonical shapes.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.calibration import CalibrationCorners

# A single 2D point in image space (pixel coordinates).
Point2D = tuple[int, int]

# Polygon as a list of pixel-space (x, y) points; minimum 3 to enclose area.
LarvaePolygon = Annotated[
    list[Point2D],
    Field(min_length=3, description="≥3 (x, y) vertices, pixel space"),
]

DetectionOrigin = Literal["model", "user"]


class LarvaeAnnotation(BaseModel):
    """One detected larva — polygon + derived bbox + confidence.

    `edited_polygon` is the operator-corrected polygon; when present it
    supersedes `polygon` for downstream measurement and rendering.
    """

    label: Literal["larvae"] = "larvae"
    polygon: LarvaePolygon
    bbox: tuple[int, int, int, int] = Field(
        description="[x1, y1, x2, y2] derived from polygon"
    )
    confidence: float = Field(ge=0.0, le=1.0)
    area_px: int = Field(ge=0)
    origin: DetectionOrigin = "model"
    edited_polygon: LarvaePolygon | None = None
    edited_at: str | None = None  # ISO-8601 timestamp of last edit

    @model_validator(mode="after")
    def _check_bbox_order(self) -> "LarvaeAnnotation":
        x1, y1, x2, y2 = self.bbox
        if x2 < x1 or y2 < y1:
            raise ValueError(f"bbox must satisfy x1<=x2 and y1<=y2; got {self.bbox!r}")
        return self


class LarvaeDetectionResult(BaseModel):
    """Inference result for a single larvae image."""

    model_config = {"frozen": True}

    filename: str
    organism: Literal["larvae"] = "larvae"
    count: int = Field(ge=0)
    avg_confidence: float = Field(ge=0.0, le=1.0)
    elapsed_seconds: float = Field(ge=0.0)
    annotations: list[LarvaeAnnotation] = Field(default_factory=list)
    overlay_url: str = Field(
        description="URL to the locally saved overlay image, never base64"
    )
    calibration: CalibrationCorners | None = None


class LarvaeBatchDetectionResult(BaseModel):
    """Inference results for a batch of larvae images."""

    model_config = {"frozen": True}

    results: list[LarvaeDetectionResult] = Field(default_factory=list)
    total_count: int = Field(ge=0)
    total_elapsed_seconds: float = Field(ge=0.0)


class LarvaeMeasurement(BaseModel):
    """Per-larva size metrics derived from polygon + calibration.

    `centerline` and `widths` can be long (~50 entries) and are sent only on
    measurement endpoints, not on bulk detection responses.
    """

    detection_id: str
    length_mm: float | None = Field(default=None, ge=0.0)
    min_width_mm: float | None = Field(default=None, ge=0.0)
    max_width_mm: float | None = Field(default=None, ge=0.0)
    average_width_mm: float | None = Field(default=None, ge=0.0)
    area_mm2: float | None = Field(default=None, ge=0.0)
    volume_mm3: float | None = Field(default=None, ge=0.0)
    centerline: list[tuple[float, float]] | None = None
    widths: list[float] | None = None
    weight_mg: float | None = Field(default=None, ge=0.0)
    weight_area_ratio: float | None = Field(
        default=None,
        ge=0.0,
        description="weight_mg / area_mm2; computed on read, never stored.",
    )
    is_stale: bool = False
    measured_at: datetime | None = None

    @field_validator("widths")
    @classmethod
    def _widths_non_negative(cls, v: list[float] | None) -> list[float] | None:
        if v is None:
            return v
        for w in v:
            if w < 0:
                raise ValueError(f"widths entries must be ≥ 0; got {w}")
        return v


class LarvaeMeasurementResult(BaseModel):
    """All per-larva measurements for one image, plus the calibration used."""

    image_id: str
    calibration: CalibrationCorners | None
    measurements: list[LarvaeMeasurement] = Field(default_factory=list)
    generated_at: datetime


class StoredLarvaeAnnotation(LarvaeAnnotation):
    """Persisted detection — adds the row id used to address the polygon edit."""

    detection_id: str


class WeightStats(BaseModel):
    """Descriptive statistics for weight_mg across a batch (skips nulls)."""

    count: int = Field(ge=0)
    total_biomass_mg: float | None = None
    mean: float | None = None
    median: float | None = None
    min: float | None = None
    max: float | None = None
    std: float | None = None
    cv: float | None = None
    p5: float | None = None
    p25: float | None = None
    p75: float | None = None
    p95: float | None = None
    iqr: float | None = None
    skewness: float | None = None
    kurtosis: float | None = None
    avg_weight_area_ratio: float | None = None


class LarvaeImageDetail(BaseModel):
    """Combined per-image payload: image meta + detections + calibration + measurements."""

    image_id: str
    original_filename: str
    total_weight_mg: float | None = Field(default=None, ge=0.0)
    overlay_url: str | None = None
    # Warped raw (no marks) — backing image for the polygon editor SVG when
    # auto-calibration succeeded. Null on failed calibration; the editor then
    # falls back to ``raw_url`` until the operator marks corners manually.
    warped_url: str | None = None
    raw_url: str | None = None
    elapsed_secs: float | None = Field(
        default=None,
        ge=0.0,
        description="Per-image inference wall time, in seconds.",
    )
    detections: list[StoredLarvaeAnnotation] = Field(default_factory=list)
    calibration: CalibrationCorners | None = None
    measurements: list[LarvaeMeasurement] = Field(default_factory=list)


class LarvaeBatchDetail(BaseModel):
    """Full larvae batch payload returned by GET /analyses/{batch_id}/larvae."""

    batch_id: str
    name: str
    organism: Literal["larvae"] = "larvae"
    status: str
    total_image_count: int
    # Snapshotted at batch creation. Null on batches created before the
    # snapshot logic landed (legacy data).
    detection_model: str | None = None
    sam_model: str | None = None
    images: list[LarvaeImageDetail] = Field(default_factory=list)
    weight_stats: WeightStats | None = None


class MeasureLarvaeRequest(BaseModel):
    """Body for POST /measure/larvae?image_id=..."""

    polygon_overrides: list[LarvaePolygon] | None = Field(
        default=None,
        description=(
            "Optional polygons to measure instead of the stored ones. When "
            "supplied, length must equal the image's stored detection count."
        ),
    )


class PolygonEdit(BaseModel):
    """A single polygon edit — replaces the detection's polygon and marks any
    associated measurement as stale.
    """

    detection_id: str
    polygon: LarvaePolygon


class PolygonsUpdate(BaseModel):
    """Body for PUT /analyses/{batch_id}/images/{image_id}/polygons."""

    polygons: list[PolygonEdit] = Field(default_factory=list)
    deleted_detection_ids: list[str] = Field(default_factory=list)


class ImageTotalWeightUpdate(BaseModel):
    """Body for PUT /analyses/images/{image_id}/total-weight.

    ``null`` clears the per-image total and blanks each measurement's weight.
    """

    total_weight_mg: float | None = Field(default=None, ge=0.0)


class ImageTotalWeightResult(BaseModel):
    """Response after recomputing weight distribution for one image."""

    image_id: str
    total_weight_mg: float | None
    measurements_updated: int
