"""Schema validation tests — all Pydantic models."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.detection import (
    BBox,
    BatchDetectionResult,
    DetectionResult,
)
from app.schemas.config import (
    ConfigUpdateRequest,
    DedupMode,
    Device,
    EggConfig,
)
from app.schemas.health import (
    AppSettingsResponse,
    AppSettingsUpdate,
    HealthResponse,
    StorageSettingsResponse,
    StorageSettingsUpdate,
)
from app.schemas.log import LogEntry, LogLevel, LogStreamMessage
from app.schemas.analysis import (
    AnalysisBatchCreate,
    AnalysisBatchDetail,
    AnalysisBatchSummary,
    AnalysisImageResult,
    AnalysisImageSummary,
    AnalysisListResponse,
    DashboardStats,
)


# ── detection.py ─────────────────────────────────────────────────────────────

class TestBBox:
    def test_valid(self):
        bbox = BBox(label="neonate_egg", bbox=(10, 20, 100, 200), confidence=0.85)
        assert bbox.label == "neonate_egg"
        assert bbox.bbox == (10, 20, 100, 200)
        assert bbox.confidence == 0.85

    def test_confidence_clamped_to_valid_range(self):
        bbox = BBox(label="egg", bbox=(0, 0, 10, 10), confidence=1.0)
        assert bbox.confidence == 1.0

    def test_confidence_at_zero_boundary(self):
        bbox = BBox(label="egg", bbox=(0, 0, 10, 10), confidence=0.0)
        assert bbox.confidence == 0.0

    def test_confidence_out_of_range_raises(self):
        with pytest.raises(ValidationError):
            BBox(label="egg", bbox=(0, 0, 10, 10), confidence=1.5)
        with pytest.raises(ValidationError):
            BBox(label="egg", bbox=(0, 0, 10, 10), confidence=-0.1)

    def test_bbox_must_be_tuple_of_four_ints(self):
        bbox = BBox(label="egg", bbox=(1, 2, 3, 4), confidence=0.5)
        assert isinstance(bbox.bbox[0], int)

    def test_empty_label(self):
        bbox = BBox(label="", bbox=(0, 0, 10, 10), confidence=0.5)
        assert bbox.label == ""


class TestDetectionResult:
    def test_valid_minimal(self):
        result = DetectionResult(
            filename="img.jpg",
            organism="egg",
            count=0,
            avg_confidence=0.0,
            elapsed_seconds=1.5,
            annotations=[],
            overlay_url="/inference/results/batch-1/img.jpg/overlay.png",
        )
        assert result.count == 0
        assert result.organism == "egg"

    def test_valid_full(self):
        result = DetectionResult(
            filename="plate_001.png",
            organism="egg",
            count=142,
            avg_confidence=0.8714,
            elapsed_seconds=3.21,
            annotations=[
                BBox(label="neonate_egg", bbox=(120, 340, 180, 400), confidence=0.91),
            ],
            overlay_url="/inference/results/batch-001/plate_001.png/overlay.png",
        )
        assert result.count == 142
        assert len(result.annotations) == 1
        assert result.annotations[0].confidence == 0.91

    def test_count_must_be_non_negative(self):
        with pytest.raises(ValidationError):
            DetectionResult(
                filename="img.jpg",
                organism="egg",
                count=-1,
                avg_confidence=0.5,
                elapsed_seconds=1.0,
                annotations=[],
                overlay_url="/foo",
            )

    def test_avg_confidence_clamped(self):
        result = DetectionResult(
            filename="img.jpg",
            organism="egg",
            count=0,
            avg_confidence=1.0,
            elapsed_seconds=1.0,
            annotations=[],
            overlay_url="/foo",
        )
        assert result.avg_confidence == 1.0

    def test_avg_confidence_out_of_range(self):
        with pytest.raises(ValidationError):
            DetectionResult(
                filename="img.jpg",
                organism="egg",
                count=0,
                avg_confidence=1.01,
                elapsed_seconds=1.0,
                annotations=[],
                overlay_url="/foo",
            )

    def test_elapsed_seconds_must_be_non_negative(self):
        with pytest.raises(ValidationError):
            DetectionResult(
                filename="img.jpg",
                organism="egg",
                count=0,
                avg_confidence=0.5,
                elapsed_seconds=-0.5,
                annotations=[],
                overlay_url="/foo",
            )

    def test_organism_literal_valid(self):
        for org in ("egg", "larvae", "pupae", "neonate"):
            result = DetectionResult(
                filename="img.jpg",
                organism=org,
                count=0,
                avg_confidence=0.5,
                elapsed_seconds=1.0,
                annotations=[],
                overlay_url="/foo",
            )
            assert result.organism == org

    def test_organism_invalid_raises(self):
        with pytest.raises(ValidationError):
            DetectionResult(
                filename="img.jpg",
                organism="invalid",
                count=0,
                avg_confidence=0.5,
                elapsed_seconds=1.0,
                annotations=[],
                overlay_url="/foo",
            )


class TestBatchDetectionResult:
    def test_valid(self):
        result = BatchDetectionResult(
            results=[],
            total_count=0,
            total_elapsed_seconds=0.0,
        )
        assert result.total_count == 0

    def test_with_results(self):
        inner = DetectionResult(
            filename="img.jpg",
            organism="egg",
            count=10,
            avg_confidence=0.8,
            elapsed_seconds=2.0,
            annotations=[],
            overlay_url="/foo",
        )
        result = BatchDetectionResult(
            results=[inner],
            total_count=10,
            total_elapsed_seconds=2.0,
        )
        assert len(result.results) == 1


# ── config.py ────────────────────────────────────────────────────────────────

class TestEggConfig:
    def _minimal(self, **overrides):
        defaults = dict(
            model="models/egg_best.pt",
            device="cpu",
            tile_size=512,
            overlap=0.5,
            confidence_threshold=0.4,
            min_box_area=100,
            dedup_mode="center_zone",
            edge_margin=3,
            nms_iou_threshold=0.4,
            batch_size=24,
        )
        return {**defaults, **overrides}

    def test_valid(self):
        cfg = EggConfig(**self._minimal())
        assert cfg.tile_size == 512
        assert cfg.dedup_mode == "center_zone"

    def test_tile_size_must_be_multiple_of_32(self):
        with pytest.raises(ValidationError) as exc_info:
            EggConfig(**self._minimal(tile_size=500))
        assert "multiple of 32" in str(exc_info.value)

    def test_tile_size_boundary_values(self):
        EggConfig(**self._minimal(tile_size=32))
        EggConfig(**self._minimal(tile_size=64))
        with pytest.raises(ValidationError):
            EggConfig(**self._minimal(tile_size=0))

    def test_overlap_valid_range(self):
        EggConfig(**self._minimal(overlap=0.0))
        EggConfig(**self._minimal(overlap=0.9))
        with pytest.raises(ValidationError):
            EggConfig(**self._minimal(overlap=-0.1))
        with pytest.raises(ValidationError):
            EggConfig(**self._minimal(overlap=1.5))

    def test_confidence_threshold_range(self):
        EggConfig(**self._minimal(confidence_threshold=0.0))
        EggConfig(**self._minimal(confidence_threshold=1.0))
        with pytest.raises(ValidationError):
            EggConfig(**self._minimal(confidence_threshold=-0.01))
        with pytest.raises(ValidationError):
            EggConfig(**self._minimal(confidence_threshold=1.01))

    def test_min_box_area_non_negative(self):
        EggConfig(**self._minimal(min_box_area=0))
        with pytest.raises(ValidationError):
            EggConfig(**self._minimal(min_box_area=-1))

    def test_device_valid_cpu(self):
        cfg = EggConfig(**self._minimal(device="cpu"))
        assert cfg.device == "cpu"

    def test_device_valid_cuda(self):
        cfg = EggConfig(**self._minimal(device="cuda"))
        assert cfg.device == "cuda"

    def test_device_valid_cuda_with_index(self):
        cfg = EggConfig(**self._minimal(device="cuda:0"))
        assert cfg.device == "cuda:0"
        cfg2 = EggConfig(**self._minimal(device="cuda:3"))
        assert cfg2.device == "cuda:3"

    def test_device_invalid(self):
        with pytest.raises(ValidationError):
            EggConfig(**self._minimal(device="v100"))
        with pytest.raises(ValidationError):
            EggConfig(**self._minimal(device="hip"))


class TestConfigUpdateRequest:
    def _defaults(self, **overrides):
        defaults = dict(
            model=None,
            device=None,
            tile_size=None,
            overlap=None,
            confidence_threshold=None,
            min_box_area=None,
            dedup_mode=None,
            edge_margin=None,
            nms_iou_threshold=None,
            batch_size=None,
        )
        return {**defaults, **overrides}

    def test_empty_update_valid(self):
        update = ConfigUpdateRequest()
        assert update.model is None

    def test_partial_update(self):
        update = ConfigUpdateRequest(
            tile_size=256,
            confidence_threshold=0.5,
        )
        assert update.tile_size == 256
        assert update.confidence_threshold == 0.5
        assert update.model is None

    def test_partial_tile_size_validated(self):
        with pytest.raises(ValidationError):
            ConfigUpdateRequest(tile_size=100)

    def test_partial_device_validated(self):
        with pytest.raises(ValidationError):
            ConfigUpdateRequest(device="invalid")


# ── health.py ────────────────────────────────────────────────────────────────

class TestHealthResponse:
    def test_valid(self):
        r = HealthResponse(
            status="ok",
            model_loaded=True,
            device="cpu",
            cuda_available=False,
            uptime_seconds=3600.0,
            version="0.1.0",
        )
        assert r.status == "ok"
        assert r.uptime_seconds == 3600.0

    def test_status_literal(self):
        r = HealthResponse(
            status="degraded",
            model_loaded=False,
            device="unknown",
            cuda_available=False,
            uptime_seconds=0.0,
            version="0.1.0",
        )
        assert r.status == "degraded"

    def test_uptime_non_negative(self):
        with pytest.raises(ValidationError):
            HealthResponse(
                status="ok",
                model_loaded=True,
                device="cpu",
                cuda_available=False,
                uptime_seconds=-1.0,
                version="0.1.0",
            )


class TestAppSettingsResponse:
    def test_valid(self):
        r = AppSettingsResponse(
            image_storage_dir="/data/overlays",
            data_dir="/data",
        )
        assert r.data_dir == "/data"


class TestStorageSettingsResponse:
    def test_valid(self):
        r = StorageSettingsResponse(image_storage_dir="/custom/path")
        assert r.image_storage_dir == "/custom/path"


class TestStorageSettingsUpdate:
    def test_valid(self):
        r = StorageSettingsUpdate(image_storage_dir="/new/path")
        assert r.image_storage_dir == "/new/path"

    def test_empty_string_rejected(self):
        with pytest.raises(ValidationError):
            StorageSettingsUpdate(image_storage_dir="")


class TestAppSettingsUpdate:
    def test_valid(self):
        r = AppSettingsUpdate(image_storage_dir="/another/path")
        assert r.image_storage_dir == "/another/path"


# ── log.py ─────────────────────────────────────────────────────────────────

class TestLogEntry:
    def test_valid(self):
        entry = LogEntry(
            timestamp="2026-04-11T15:42:01.123Z",
            level="INFO",
            message="Model loaded",
            context={"model_path": "/models/egg.pt"},
        )
        assert entry.level == "INFO"
        assert entry.context["model_path"] == "/models/egg.pt"

    def test_level_literal(self):
        for level in ("DEBUG", "INFO", "WARNING", "ERROR"):
            entry = LogEntry(
                timestamp="2026-01-01T00:00:00.000Z",
                level=level,
                message="test",
            )
            assert entry.level == level

    def test_invalid_level_raises(self):
        with pytest.raises(ValidationError):
            LogEntry(
                timestamp="2026-01-01T00:00:00.000Z",
                level="TRACE",
                message="test",
            )

    def test_context_default_empty(self):
        entry = LogEntry(
            timestamp="2026-01-01T00:00:00.000Z",
            level="INFO",
            message="test",
        )
        assert entry.context == {}


class TestLogStreamMessage:
    def test_log_frame(self):
        msg = LogStreamMessage(
            type="log",
            data=LogEntry(
                timestamp="2026-01-01T00:00:00.000Z",
                level="INFO",
                message="test",
            ),
        )
        assert msg.type == "log"
        assert msg.data is not None

    def test_heartbeat_frame(self):
        msg = LogStreamMessage(type="heartbeat", data=None)
        assert msg.type == "heartbeat"
        assert msg.data is None

    def test_invalid_type_raises(self):
        with pytest.raises(ValidationError):
            LogStreamMessage(type="debug", data=None)


# ── analysis.py ────────────────────────────────────────────────────────────────

class TestAnalysisBatchCreate:
    def test_defaults(self):
        batch = AnalysisBatchCreate(total_image_count=5)
        assert batch.organism_type == "egg"
        assert batch.mode == "upload"
        assert batch.device == "cpu"
        assert batch.total_image_count == 5
        assert batch.config_snapshot == {}

    def test_custom_fields(self):
        batch = AnalysisBatchCreate(
            organism_type="larvae",
            mode="camera",
            device="cuda:0",
            total_image_count=10,
            config_snapshot={"tile_size": 512},
        )
        assert batch.organism_type == "larvae"
        assert batch.device == "cuda:0"

    def test_total_image_count_must_be_at_least_1(self):
        with pytest.raises(ValidationError):
            AnalysisBatchCreate(total_image_count=0)


class TestAnalysisImageResult:
    def test_required_fields(self):
        r = AnalysisImageResult(
            filename="img001.jpg",
            count=42,
            avg_confidence=0.87,
            elapsed_seconds=2.5,
            annotations=[],
            overlay_url="/inference/results/b001/img001.jpg/overlay.png",
        )
        assert r.count == 42

    def test_optional_metadata(self):
        r = AnalysisImageResult(
            filename="img001.jpg",
            count=42,
            avg_confidence=0.87,
            elapsed_seconds=2.5,
            annotations=[],
            overlay_url="/foo",
            original_width=6000,
            original_height=4000,
            file_size_bytes=4_200_000,
        )
        assert r.original_width == 6000
        assert r.file_size_bytes == 4_200_000

    def test_annotations_default_empty_list(self):
        r = AnalysisImageResult(
            filename="img001.jpg",
            count=0,
            avg_confidence=0.0,
            elapsed_seconds=1.0,
            annotations=[],
            overlay_url="/foo",
        )
        assert r.annotations == []
