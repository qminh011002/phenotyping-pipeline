"""Larvae inference wrapper over the shared polygon segmentation core."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING

from app.config import PipelineConfigManager
from app.schemas.larvae import (
    LarvaeAnnotation,
    LarvaeBatchDetectionResult,
    LarvaeDetectionResult,
)
from app.services.inference.calibration import CalibrationService
from app.services.inference.polygon_segmentation import PolygonSegmentationService
from app.services.inference.sam_refine import SamRefinementService

if TYPE_CHECKING:
    from app.schemas.config import LarvaeConfig
    from app.services.log_buffer import LogBuffer
    from app.services.model_registry import ModelRegistry


class LarvaeInferenceService(PolygonSegmentationService):
    """Tiled YOLO-seg larvae detection with MWIS-over-polygon-IoU dedup."""

    def __init__(
        self,
        model_registry: "ModelRegistry",
        pipeline_config: PipelineConfigManager,
        log_buffer: "LogBuffer",
        executor: ThreadPoolExecutor,
        calibration_service: CalibrationService,
        sam_service: SamRefinementService | None = None,
    ) -> None:
        del log_buffer
        super().__init__(
            organism="larvae",
            label="larvae",
            overlay_color_bgr=(255, 255, 0),
            annotation_schema=LarvaeAnnotation,
            result_schema=LarvaeDetectionResult,
            batch_result_schema=LarvaeBatchDetectionResult,
            config_getter=lambda cfg: cfg.get_larvae_config(),
            model_registry=model_registry,
            pipeline_config=pipeline_config,
            executor=executor,
            calibration_service=calibration_service,
            sam_service=sam_service,
        )

    @property
    def _larvae_config(self) -> "LarvaeConfig":
        return self._get_config()
