"""Pydantic schemas for pipeline configuration (egg block of config.yaml)."""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

DedupMode = Literal["center_zone", "edge_nms"]
Device = Literal["cpu"] | str  # "cpu", "cuda", "cuda:0", "cuda:1", ...


class EggConfig(BaseModel):
    """Full egg inference configuration, validated against config.yaml shape."""

    model: str = Field(description="Path to the YOLO model weights")
    device: Device = "cpu"
    tile_size: int = Field(gt=0, description="Must be a multiple of 32")
    overlap: float = Field(ge=0.0, le=1.0)
    confidence_threshold: float = Field(ge=0.0, le=1.0)
    min_box_area: int = Field(ge=0)
    dedup_mode: DedupMode
    edge_margin: int = Field(ge=0)
    nms_iou_threshold: float = Field(ge=0.0, le=1.0)
    batch_size: int = Field(gt=0)

    @field_validator("tile_size")
    @classmethod
    def tile_size_multiple_of_32(cls, v: int) -> int:
        if v % 32 != 0:
            msg = f"tile_size must be a multiple of 32, got {v}"
            raise ValueError(msg)
        return v

    @field_validator("device")
    @classmethod
    def device_valid_format(cls, v: str) -> str:
        if v == "cpu":
            return v
        if re.match(r"^cuda(:\d+)?$", v):
            return v
        msg = f"device must be 'cpu' or 'cuda' or 'cuda:N', got {v!r}"
        raise ValueError(msg)


class NeonateConfig(BaseModel):
    """Full neonate inference configuration, validated against config.yaml shape."""

    model: str = Field(description="Path to the YOLO model weights")
    device: Device = "cpu"
    tile_size: int = Field(gt=0, description="Must be a multiple of 32")
    overlap: float = Field(ge=0.0, le=1.0)
    confidence_threshold: float = Field(ge=0.0, le=1.0)
    min_box_area: int = Field(ge=0)
    dedup_mode: DedupMode
    edge_margin: int = Field(ge=0)
    nms_iou_threshold: float = Field(ge=0.0, le=1.0)
    batch_size: int = Field(gt=0)

    @field_validator("tile_size")
    @classmethod
    def tile_size_multiple_of_32(cls, v: int) -> int:
        if v % 32 != 0:
            msg = f"tile_size must be a multiple of 32, got {v}"
            raise ValueError(msg)
        return v

    @field_validator("device")
    @classmethod
    def device_valid_format(cls, v: str) -> str:
        if v == "cpu":
            return v
        if re.match(r"^cuda(:\d+)?$", v):
            return v
        msg = f"device must be 'cpu' or 'cuda' or 'cuda:N', got {v!r}"
        raise ValueError(msg)


class ConfigUpdateRequest(BaseModel):
    """Partial config update — all fields optional."""

    model: str | None = None
    device: Device | None = None
    tile_size: int | None = Field(default=None, gt=0)
    overlap: float | None = Field(default=None, ge=0.0, le=1.0)
    confidence_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    min_box_area: int | None = Field(default=None, ge=0)
    dedup_mode: DedupMode | None = None
    edge_margin: int | None = Field(default=None, ge=0)
    nms_iou_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    batch_size: int | None = Field(default=None, gt=0)

    @field_validator("tile_size")
    @classmethod
    def tile_size_multiple_of_32(cls, v: int | None) -> int | None:
        if v is not None and v % 32 != 0:
            msg = f"tile_size must be a multiple of 32, got {v}"
            raise ValueError(msg)
        return v

    @field_validator("device")
    @classmethod
    def device_valid_format(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if v == "cpu":
            return v
        if re.match(r"^cuda(:\d+)?$", v):
            return v
        msg = f"device must be 'cpu' or 'cuda' or 'cuda:N', got {v!r}"
        raise ValueError(msg)
