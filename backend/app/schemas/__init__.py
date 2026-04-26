"""All Pydantic schemas re-exported for convenient imports."""

from __future__ import annotations

from app.schemas.config import (
    ConfigUpdateRequest,
    DedupMode,
    Device,
    EggConfig,
)
from app.schemas.detection import (
    BatchDetectionResult,
    BBox,
    DetectionResult,
    Organism,
)
from app.schemas.health import (
    AppSettingsResponse,
    AppSettingsUpdate,
    HealthResponse,
    StorageSettingsResponse,
    StorageSettingsUpdate,
)
from app.schemas.log import LogEntry, LogLevel, LogStreamMessage

__all__ = [
    # Detection
    "BBox",
    "DetectionResult",
    "BatchDetectionResult",
    "Organism",
    # Config
    "EggConfig",
    "ConfigUpdateRequest",
    "DedupMode",
    "Device",
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
