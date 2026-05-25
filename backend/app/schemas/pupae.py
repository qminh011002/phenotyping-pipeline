"""Pupae detection, calibration, and measurement schemas.

Mirrors `app.schemas.larvae` since pupae uses the same polygon + MWIS + SAM
pipeline as larvae. The only label difference is ``label="pupae"`` and the
public schema names — DB tables (``larvae_detection`` etc.) are still shared.

See `.cursor/rules/api-contract.mdc` for canonical shapes.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.calibration import CalibrationCorners
from app.schemas.larvae import WeightStats

Point2D = tuple[int, int]

PupaePolygon = Annotated[
    list[Point2D],
    Field(min_length=3, description="≥3 (x, y) vertices, pixel space"),
]

DetectionOrigin = Literal["model", "user"]


class PupaeAnnotation(BaseModel):
    """One detected pupa — polygon + derived bbox + confidence."""

    label: Literal["pupae"] = "pupae"
    polygon: PupaePolygon
    bbox: tuple[int, int, int, int] = Field(
        description="[x1, y1, x2, y2] derived from polygon"
    )
    confidence: float = Field(ge=0.0, le=1.0)
    area_px: int = Field(ge=0)
    origin: DetectionOrigin = "model"
    edited_polygon: PupaePolygon | None = None
    edited_at: str | None = None

    @model_validator(mode="after")
    def _check_bbox_order(self) -> "PupaeAnnotation":
        x1, y1, x2, y2 = self.bbox
        if x2 < x1 or y2 < y1:
            raise ValueError(f"bbox must satisfy x1<=x2 and y1<=y2; got {self.bbox!r}")
        return self


class PupaeDetectionResult(BaseModel):
    """Inference result for a single pupae image."""

    model_config = {"frozen": True}

    filename: str
    organism: Literal["pupae"] = "pupae"
    count: int = Field(ge=0)
    avg_confidence: float = Field(ge=0.0, le=1.0)
    elapsed_seconds: float = Field(ge=0.0)
    annotations: list[PupaeAnnotation] = Field(default_factory=list)
    overlay_url: str = Field(
        description="URL to the locally saved overlay image, never base64"
    )
    calibration: CalibrationCorners | None = None


class PupaeBatchDetectionResult(BaseModel):
    """Inference results for a batch of pupae images."""

    model_config = {"frozen": True}

    results: list[PupaeDetectionResult] = Field(default_factory=list)
    total_count: int = Field(ge=0)
    total_elapsed_seconds: float = Field(ge=0.0)


class PupaeMeasurement(BaseModel):
    """Per-pupa size metrics — identical shape to LarvaeMeasurement."""

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
    weight_area_ratio: float | None = Field(default=None, ge=0.0)
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


class PupaeMeasurementResult(BaseModel):
    """All per-pupa measurements for one image, plus the calibration used."""

    image_id: str
    calibration: CalibrationCorners | None
    measurements: list[PupaeMeasurement] = Field(default_factory=list)
    generated_at: datetime


class StoredPupaeAnnotation(PupaeAnnotation):
    detection_id: str


class PupaeImageDetail(BaseModel):
    image_id: str
    original_filename: str
    total_weight_mg: float | None = Field(default=None, ge=0.0)
    overlay_url: str | None = None
    warped_url: str | None = None
    raw_url: str | None = None
    elapsed_secs: float | None = Field(default=None, ge=0.0)
    detections: list[StoredPupaeAnnotation] = Field(default_factory=list)
    calibration: CalibrationCorners | None = None
    measurements: list[PupaeMeasurement] = Field(default_factory=list)


class PupaeBatchDetail(BaseModel):
    batch_id: str
    name: str
    organism: Literal["pupae"] = "pupae"
    status: str
    total_image_count: int
    detection_model: str | None = None
    sam_model: str | None = None
    images: list[PupaeImageDetail] = Field(default_factory=list)
    weight_stats: WeightStats | None = None


class MeasurePupaeRequest(BaseModel):
    polygon_overrides: list[PupaePolygon] | None = Field(
        default=None,
        description=(
            "Optional polygons to measure instead of the stored ones. When "
            "supplied, length must equal the image's stored detection count."
        ),
    )


class PupaePolygonEdit(BaseModel):
    detection_id: str
    polygon: PupaePolygon


class PupaePolygonsUpdate(BaseModel):
    polygons: list[PupaePolygonEdit] = Field(default_factory=list)
    deleted_detection_ids: list[str] = Field(default_factory=list)
