"""Pydantic schemas for inference detection results.

See `.cursor/rules/api-contract.mdc` for the canonical type definitions.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

Organism = Literal["egg", "larvae", "pupae", "neonate"]


class BBox(BaseModel):
    """A single bounding box detection from the model."""

    label: str
    bbox: Annotated[tuple[int, int, int, int], Field(description="[x1, y1, x2, y2]")]
    confidence: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _check_bbox_order(self) -> "BBox":
        # Permit equal coordinates (degenerate boxes) — only reject inverted order
        # so user-drawn rubber-bands at click-without-drag don't 422 mid-edit.
        x1, y1, x2, y2 = self.bbox
        if x2 < x1 or y2 < y1:
            raise ValueError(
                f"bbox must satisfy x1<=x2 and y1<=y2; got {self.bbox!r}"
            )
        return self


class DetectionResult(BaseModel):
    """Inference result for a single image."""

    model_config = {"frozen": True}

    filename: str
    organism: Organism
    count: int = Field(ge=0)
    avg_confidence: float = Field(ge=0.0, le=1.0)
    elapsed_seconds: float = Field(ge=0.0)
    annotations: list[BBox] = Field(default_factory=list)
    overlay_url: str = Field(
        description="URL to the locally saved overlay image, never base64"
    )


class BatchDetectionResult(BaseModel):
    """Inference results for a batch of images."""

    model_config = {"frozen": True}

    results: list[DetectionResult] = Field(default_factory=list)
    total_count: int = Field(ge=0)
    total_elapsed_seconds: float = Field(ge=0.0)
