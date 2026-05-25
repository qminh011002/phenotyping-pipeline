"""Pydantic schemas for pipeline configuration (egg block of config.yaml)."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

DedupMode = Literal["center_zone", "edge_nms"]
Device = Literal["cpu"] | str  # "cpu", "cuda", "cuda:0", "cuda:1", ...


class EggConfig(BaseModel):
    """Full egg inference configuration, validated against config.yaml shape.

    ``model`` is retained for backwards-compatibility with legacy YAML files
    that still carry ``egg.model: models/egg_best.pt``. The runtime no longer
    consults this field — the active weight file is resolved by ``ModelStorage``
    from ``data/models/<organism>/{default,custom}/``.
    """

    model: str | None = Field(
        default=None,
        description="Legacy YAML field, no longer used. Source of truth is data/models/<organism>/.",
    )
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


MwisScoreMetric = Literal["confidence_x_area", "confidence"]
CenterlineMethod = Literal["pipeline_compat", "hybrid", "legacy_dijkstra"]


class LarvaeSamConfig(BaseModel):
    """SAM polygon-refinement block.

    Ports `phenotyping_pipeline/2_inference/refine_larvae_sam.py`. Each YOLO
    bbox is cropped (with `crop_padding`), pushed through SAM with the bbox
    as prompt; the resulting mask gives a sub-pixel polygon translated back
    to full-image coordinates.

    ``device=None`` means "inherit from larvae.device, then auto-pick cuda if
    available else cpu" — set explicitly to "cuda" / "cpu" to override.
    """

    enabled: bool = True
    model: str = "mobile_sam.pt"
    crop_padding: int = Field(default=50, ge=0)
    confidence_threshold: float = Field(default=0.3, ge=0.0, le=1.0)
    device: Device | None = None

    # Sanity bounds on SAM output. If the refined polygon's area divided by
    # the YOLO area falls outside [min_area_ratio, max_area_ratio] we reject
    # the SAM mask and keep the original YOLO polygon — protects against
    # SAM "bleeding" into a touching neighbour when bbox prompts are
    # ambiguous on overlapping detections.
    min_area_ratio: float = Field(default=0.6, gt=0.0, le=1.0)
    max_area_ratio: float = Field(default=1.3, ge=1.0, le=5.0)
    # Minimum IoU between the SAM polygon and the YOLO polygon. Catches the
    # case where SAM stays similar in size but shifts to a neighbour (so the
    # area ratio looks OK while the mask is on the wrong larva).
    min_iou_vs_yolo: float = Field(default=0.5, ge=0.0, le=1.0)

    @field_validator("device")
    @classmethod
    def device_valid_format(cls, v: str | None) -> str | None:
        if v is None or v == "cpu":
            return v
        if re.match(r"^cuda(:\d+)?$", v):
            return v
        msg = f"device must be null, 'cpu', or 'cuda'/'cuda:N', got {v!r}"
        raise ValueError(msg)


class LarvaeConfig(BaseModel):
    """Larvae inference configuration.

    Larvae uses polygon (segmentation) outputs and a different dedup strategy
    than egg/neonate — Maximum-Weight Independent Set over mask overlap
    (``mwis_*``) instead of bbox NMS. App-only extras at the bottom carry the
    calibration object dimensions (a green rectangle of known mm size used to
    derive mm/px) and the optional weight-prediction toggle.
    """

    model: str | None = Field(
        default=None,
        description="Legacy YAML field, no longer used. See EggConfig.model.",
    )
    device: Device = "cpu"
    tile_size: int = Field(gt=0, description="Must be a multiple of 32")
    overlap: float = Field(ge=0.0, le=1.0)
    confidence_threshold: float = Field(ge=0.0, le=1.0)
    min_mask_size: int = Field(
        ge=0, description="Minimum mask area in pixels; smaller masks are discarded"
    )
    edge_margin: int = Field(
        default=5,
        ge=0,
        description="Pixels from a tile edge — masks touching this margin are dropped",
    )
    mwis_overlap_threshold: float = Field(
        gt=0.0, lt=1.0, description="IoU above which two masks compete in MWIS"
    )
    mwis_score_metric: MwisScoreMetric = "confidence_x_area"
    batch_size: int = Field(gt=0)

    # ── App-only extras (not in pipeline config.yaml) ─────────────────────────
    calibration_object_w_mm: float = Field(default=405.0, ge=0.0)
    calibration_object_h_mm: float = Field(default=317.0, ge=0.0)
    enable_weight: bool = False
    larva_volume_height_ratio: float = Field(
        default=0.6,
        gt=0.0,
        le=2.0,
        description="Arc-segment height / chord ratio used to estimate per-segment volume",
    )

    # ── Centerline extraction (BE-034 hybrid) ─────────────────────────────────
    centerline_method: CenterlineMethod = Field(
        default="pipeline_compat",
        description=(
            "'pipeline_compat' = distance-ridge Dijkstra over the mask + "
            "polynomial fit smoothing (50 samples) — line-for-line port of "
            "phenotyping_pipeline/process_larvae.py, reproduces its length "
            "numbers. 'hybrid' = medial axis + 2-pass geodesic + B-spline "
            "(smoother but length contracts ~15%). 'legacy_dijkstra' = "
            "medial-axis longest path with Dijkstra/naive fallback chain."
        ),
    )
    centerline_min_branch_ratio: float = Field(
        default=0.15,
        gt=0.0,
        lt=1.0,
        description="Hybrid prune threshold: branch length / total skeleton length.",
    )
    centerline_n_output_points: int = Field(
        default=100,
        ge=10,
        le=500,
        description="Number of resampled points along the centerline (hybrid only).",
    )
    centerline_smoothness: float | None = Field(
        default=None,
        ge=0.0,
        description=(
            "B-spline smoothing factor (scipy splprep 's'). null = scipy default "
            "(s = N). Larger = smoother."
        ),
    )

    # ── SAM polygon refinement (BE-035) ──────────────────────────────────────
    sam: LarvaeSamConfig = Field(default_factory=LarvaeSamConfig)

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


class PupaeSamConfig(BaseModel):
    """SAM polygon-refinement block for pupae — mirrors ``LarvaeSamConfig``."""

    enabled: bool = True
    model: str = "mobile_sam.pt"
    crop_padding: int = Field(default=50, ge=0)
    confidence_threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    device: Device | None = None
    min_area_ratio: float = Field(default=0.6, gt=0.0, le=1.0)
    max_area_ratio: float = Field(default=1.3, ge=1.0, le=5.0)
    min_iou_vs_yolo: float = Field(default=0.5, ge=0.0, le=1.0)

    @field_validator("device")
    @classmethod
    def device_valid_format(cls, v: str | None) -> str | None:
        if v is None or v == "cpu":
            return v
        if re.match(r"^cuda(:\d+)?$", v):
            return v
        msg = f"device must be null, 'cpu', or 'cuda'/'cuda:N', got {v!r}"
        raise ValueError(msg)


class PupaeConfig(BaseModel):
    """Pupae inference configuration — polygon segmentation + MWIS dedup.

    Mirrors ``LarvaeConfig`` since both use YOLO-seg + Maximum-Weight Independent
    Set dedup over mask overlap. Defaults follow the pupae section of
    ``phenotyping_pipeline/config.yaml``: ``tile_size=1024``, ``overlap=0.5``,
    ``confidence_threshold=0.7``, ``min_mask_size=1500``.
    """

    model: str | None = Field(
        default=None,
        description="Legacy YAML field, no longer used. See EggConfig.model.",
    )
    device: Device = "cpu"
    tile_size: int = Field(default=1024, gt=0, description="Must be a multiple of 32")
    overlap: float = Field(default=0.5, ge=0.0, le=1.0)
    confidence_threshold: float = Field(default=0.7, ge=0.0, le=1.0)
    min_mask_size: int = Field(
        default=1500,
        ge=0,
        description="Minimum mask area in pixels; smaller masks are discarded",
    )
    edge_margin: int = Field(
        default=5,
        ge=0,
        description="Pixels from a tile edge — masks touching this margin are dropped",
    )
    mwis_overlap_threshold: float = Field(
        default=0.3,
        gt=0.0,
        lt=1.0,
        description="IoU above which two masks compete in MWIS",
    )
    mwis_score_metric: MwisScoreMetric = "confidence_x_area"
    batch_size: int = Field(default=24, gt=0)

    calibration_object_w_mm: float = Field(default=405.0, ge=0.0)
    calibration_object_h_mm: float = Field(default=317.0, ge=0.0)
    pupa_volume_height_ratio: float = Field(
        default=0.6,
        gt=0.0,
        le=2.0,
        description="Arc-segment height / chord ratio for per-segment volume",
    )

    centerline_method: CenterlineMethod = Field(
        default="pipeline_compat",
        description="Same as LarvaeConfig.centerline_method.",
    )
    centerline_min_branch_ratio: float = Field(default=0.15, gt=0.0, lt=1.0)
    centerline_n_output_points: int = Field(default=100, ge=10, le=500)
    centerline_smoothness: float | None = Field(default=None, ge=0.0)

    sam: PupaeSamConfig = Field(default_factory=PupaeSamConfig)

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

    model: str | None = Field(
        default=None,
        description="Legacy YAML field, no longer used. See EggConfig.model.",
    )
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


class LarvaeConfigUpdateRequest(BaseModel):
    """Partial update for the ``larvae`` block of inference_config.yaml.

    Only the runtime-relevant knobs are exposed; the rest stay in YAML for
    power users.
    """

    centerline_method: CenterlineMethod | None = None
    sam_enabled: bool | None = None


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
