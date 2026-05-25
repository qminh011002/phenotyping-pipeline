"""Pupae inference wrapper over the shared polygon segmentation core."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING

from app.config import PipelineConfigManager
from app.schemas.pupae import (
    PupaeAnnotation,
    PupaeBatchDetectionResult,
    PupaeDetectionResult,
)
from app.services.inference.calibration import CalibrationService
from app.services.inference.polygon_segmentation import PolygonSegmentationService
from app.services.inference.sam_refine import SamRefinementService

if TYPE_CHECKING:
    from app.schemas.config import PupaeConfig
    from app.services.log_buffer import LogBuffer
    from app.services.model_registry import ModelRegistry


class PupaeInferenceService(PolygonSegmentationService):
    """Tiled YOLO-seg pupae detection with MWIS-over-polygon-IoU dedup."""

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
            organism="pupae",
            label="pupae",
            overlay_color_bgr=(0, 255, 255),
            annotation_schema=PupaeAnnotation,
            result_schema=PupaeDetectionResult,
            batch_result_schema=PupaeBatchDetectionResult,
            config_getter=lambda cfg: cfg.get_pupae_config(),
            model_registry=model_registry,
            pipeline_config=pipeline_config,
            executor=executor,
            calibration_service=calibration_service,
            sam_service=sam_service,
        )

    @property
    def _pupae_config(self) -> "PupaeConfig":
        return self._get_config()
