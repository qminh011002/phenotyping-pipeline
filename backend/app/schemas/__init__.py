"""All Pydantic schemas re-exported for convenient imports."""

from __future__ import annotations

from app.schemas.calibration import (
    CalibrationCorners,
    CalibrationStatus,
    CalibrationUpdate,
)
from app.schemas.config import (
    ConfigUpdateRequest,
    DedupMode,
    Device,
    EggConfig,
    LarvaeConfig,
    MwisScoreMetric,
    NeonateConfig,
    PupaeConfig,
    PupaeSamConfig,
)
from app.schemas.detection import BatchDetectionResult, BBox, DetectionResult, Organism
from app.schemas.health import (
    AppSettingsResponse,
    AppSettingsUpdate,
    HealthResponse,
    StorageSettingsResponse,
    StorageSettingsUpdate,
)
from app.schemas.larvae import (
    DetectionOrigin,
    LarvaeAnnotation,
    LarvaeBatchDetail,
    LarvaeBatchDetectionResult,
    LarvaeDetectionResult,
    LarvaeImageDetail,
    LarvaeMeasurement,
    LarvaeMeasurementResult,
    LarvaePolygon,
    MeasureLarvaeRequest,
    PolygonEdit,
    PolygonsUpdate,
    StoredLarvaeAnnotation,
)
from app.schemas.log import LogEntry, LogLevel, LogStreamMessage
from app.schemas.pupae import (
    MeasurePupaeRequest,
    PupaeAnnotation,
    PupaeBatchDetail,
    PupaeBatchDetectionResult,
    PupaeDetectionResult,
    PupaeImageDetail,
    PupaeMeasurement,
    PupaeMeasurementResult,
    PupaePolygon,
    PupaePolygonEdit,
    PupaePolygonsUpdate,
    StoredPupaeAnnotation,
)

__all__ = [
    # Detection
    "BBox",
    "DetectionResult",
    "BatchDetectionResult",
    "Organism",
    # Larvae
    "LarvaeAnnotation",
    "LarvaeDetectionResult",
    "LarvaeBatchDetectionResult",
    "LarvaeMeasurement",
    "LarvaeMeasurementResult",
    "LarvaePolygon",
    "DetectionOrigin",
    "LarvaeImageDetail",
    "LarvaeBatchDetail",
    "MeasureLarvaeRequest",
    "PolygonEdit",
    "PolygonsUpdate",
    "StoredLarvaeAnnotation",
    # Pupae
    "PupaeAnnotation",
    "PupaeDetectionResult",
    "PupaeBatchDetectionResult",
    "PupaeMeasurement",
    "PupaeMeasurementResult",
    "PupaePolygon",
    "PupaeImageDetail",
    "PupaeBatchDetail",
    "MeasurePupaeRequest",
    "PupaePolygonEdit",
    "PupaePolygonsUpdate",
    "StoredPupaeAnnotation",
    # Calibration
    "CalibrationCorners",
    "CalibrationStatus",
    "CalibrationUpdate",
    # Config
    "EggConfig",
    "LarvaeConfig",
    "NeonateConfig",
    "PupaeConfig",
    "PupaeSamConfig",
    "ConfigUpdateRequest",
    "DedupMode",
    "Device",
    "MwisScoreMetric",
    # Log
    "LogEntry",
    "LogLevel",
    "LogStreamMessage",
    # Health / Settings
    "HealthResponse",
    "AppSettingsResponse",
    "AppSettingsUpdate",
    "StorageSettingsResponse",
    "StorageSettingsUpdate",
]
