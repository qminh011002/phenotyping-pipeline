"""Calibration schemas — green calibration object corner detection + mm/px scale.

See `.cursor/rules/api-contract.mdc` for the canonical type definitions.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

CalibrationStatus = Literal["detected", "manual", "failed"]

# Four (x, y) image-space corners of the calibration object, ordered
# top-left, top-right, bottom-right, bottom-left.
CalibrationCornerList = Annotated[
    list[tuple[int, int]],
    Field(
        min_length=4, max_length=4, description="[(x, y) × 4] in TL, TR, BR, BL order"
    ),
]


class CalibrationUpdate(BaseModel):
    """Operator-supplied calibration override.

    Either ``corners`` (4 points → derives mm/px against the configured
    calibration object size) or an explicit ``mm_per_px_x`` + ``mm_per_px_y``
    pair must be provided. The payload becomes the image's ``edited_corners``
    record with ``detection_status='manual'``.
    """

    corners: CalibrationCornerList | None = None
    mm_per_px_x: float | None = Field(default=None, ge=0.0)
    mm_per_px_y: float | None = Field(default=None, ge=0.0)

    @model_validator(mode="after")
    def _require_one(self) -> "CalibrationUpdate":
        has_corners = self.corners is not None
        has_factors = self.mm_per_px_x is not None and self.mm_per_px_y is not None
        if not has_corners and not has_factors:
            raise ValueError(
                "CalibrationUpdate requires either 'corners' (4 points) or "
                "both 'mm_per_px_x' and 'mm_per_px_y'."
            )
        return self

    @field_validator("corners")
    @classmethod
    def _corners_non_negative(
        cls, v: list[tuple[int, int]] | None
    ) -> list[tuple[int, int]] | None:
        if v is None:
            return v
        for x, y in v:
            if x < 0 or y < 0:
                raise ValueError(
                    f"calibration corner coords must be ≥ 0; got ({x}, {y})"
                )
        return v


class CalibrationCorners(BaseModel):
    """Per-image calibration record.

    Mirrors `larvae_calibration` (INF-005). `auto_corners` is the model's
    detected corner set; `edited_corners` is the operator-corrected version
    when present and supersedes the auto value for measurement.
    """

    image_id: str | None = None
    auto_corners: CalibrationCornerList | None = None
    edited_corners: CalibrationCornerList | None = None
    mm_per_px_x: float | None = Field(default=None, ge=0.0)
    mm_per_px_y: float | None = Field(default=None, ge=0.0)
    calibration_object_w_mm: float | None = Field(default=None, ge=0.0)
    calibration_object_h_mm: float | None = Field(default=None, ge=0.0)
    detection_status: CalibrationStatus

    @field_validator("auto_corners", "edited_corners")
    @classmethod
    def _corners_non_negative(
        cls, v: list[tuple[int, int]] | None
    ) -> list[tuple[int, int]] | None:
        if v is None:
            return v
        for x, y in v:
            if x < 0 or y < 0:
                msg = f"calibration corner coords must be ≥ 0; got ({x}, {y})"
                raise ValueError(msg)
        return v
