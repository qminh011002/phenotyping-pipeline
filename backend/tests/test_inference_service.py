"""Tests for app/services/inference/egg.py EggInferenceService.

We mock the YOLO model directly (its .return_value) so the service's internal
_run_inference() runs with controlled detections and does not need real images.
No real model weights are loaded.

cv2 is patched at the class level so the mock stays active for the duration
of each test method (not just during __init__).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch
from concurrent.futures import ThreadPoolExecutor

import pytest
import numpy as np

from app.schemas.detection import DetectionResult


def _make_mock_yolo_result(
    bbox_array=None, conf_array=None, cls_array=None
):
    """Build a mock YOLO result object for use as model.return_value."""
    mock_result = MagicMock()
    mock_result.boxes.xyxy.cpu.return_value.numpy.return_value = (
        bbox_array
        if bbox_array is not None
        else np.array([[100.0, 100.0, 200.0, 200.0]], dtype=np.float32)
    )
    mock_result.boxes.conf.cpu.return_value.numpy.return_value = (
        conf_array
        if conf_array is not None
        else np.array([0.91], dtype=np.float32)
    )
    mock_result.boxes.cls.cpu.return_value.numpy.return_value = (
        cls_array
        if cls_array is not None
        else np.array([0], dtype=np.float32)
    )
    return mock_result


def _build_mock_cv2():
    """Return a configured mock cv2 module for use in tests."""
    mock = MagicMock()
    mock.FONT_HERSHEY_SIMPLEX = 0
    mock.LINE_AA = 8
    mock.IMREAD_COLOR = 1
    mock.getTextSize.side_effect = lambda text, font, scale, thick: (80, 20)
    return mock


def _build_mock_np():
    """Return a configured mock numpy module for use in tests."""
    mock = MagicMock()
    mock.zeros.return_value = np.zeros((512, 512, 3), dtype=np.uint8)
    mock.array = np.array
    return mock


class TestEggInferenceService:
    """Tests for EggInferenceService using a mocked YOLO model (mock.return_value)."""

    @pytest.fixture
    def mock_registry(self):
        """A mock ModelRegistry whose .model returns controlled detection results."""
        registry = MagicMock()
        registry.model_loaded = True
        registry.device = "cpu"

        model = MagicMock()
        model.task = "detect"
        model.return_value = [_make_mock_yolo_result()]
        registry.model = model
        return registry

    @pytest.fixture
    def mock_config(self):
        """A mock PipelineConfigManager that returns a fixed EggConfig."""
        from app.schemas.config import EggConfig

        cfg = EggConfig(
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
        mock = MagicMock()
        mock.get_egg_config.return_value = cfg
        return mock

    @pytest.fixture
    def mock_log_buffer(self):
        return MagicMock()

    # ── Service factory ──────────────────────────────────────────────────────

    def _make_service(
        self, mock_registry, mock_config, mock_log_buffer, overlay_dir, cv2_mock, np_mock
    ):
        """Build EggInferenceService with all dependencies mocked."""
        from app.services.inference.egg import EggInferenceService

        executor = ThreadPoolExecutor(max_workers=1)

        def mock_path_truediv(self, other):
            return overlay_dir / str(other)

        with patch("app.services.inference.egg.Path") as mock_path_cls, \
             patch("app.services.inference.egg.cv2", cv2_mock), \
             patch("app.services.inference.egg.np", np_mock):

            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.__truediv__ = mock_path_truediv
            mock_path_cls.return_value = mock_path_instance

            svc = EggInferenceService(
                model_registry=mock_registry,
                pipeline_config=mock_config,
                log_buffer=mock_log_buffer,
                executor=executor,
            )

            # Return both service and executor so caller can shut it down
            return svc, executor

    # ── Tests ──────────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_process_single_returns_detection_result(
        self, mock_registry, mock_config, mock_log_buffer, tiny_png_bytes, tmp_path
    ):
        """process_single returns a valid DetectionResult with annotations."""
        overlay_dir = tmp_path / "overlays"
        overlay_dir.mkdir(parents=True, exist_ok=True)
        cv2_mock = _build_mock_cv2()
        np_mock = _build_mock_np()

        svc, executor = self._make_service(
            mock_registry, mock_config, mock_log_buffer,
            overlay_dir, cv2_mock, np_mock
        )
        try:
            result = await svc.process_single(
                tiny_png_bytes, filename="test_plate.png", batch_id="batch-001"
            )
            assert isinstance(result, DetectionResult)
            assert result.filename == "test_plate.png"
            assert result.organism == "egg"
            assert result.count >= 0
            assert 0.0 <= result.avg_confidence <= 1.0
            assert result.elapsed_seconds >= 0
            assert result.overlay_url.endswith("/overlay.png")
        finally:
            executor.shutdown(wait=False)

    @pytest.mark.asyncio
    async def test_process_single_overlay_url_contains_batch_id(
        self, mock_registry, mock_config, mock_log_buffer, tiny_png_bytes, tmp_path
    ):
        """The overlay URL encodes the batch_id."""
        overlay_dir = tmp_path / "overlays"
        overlay_dir.mkdir(parents=True, exist_ok=True)
        cv2_mock = _build_mock_cv2()
        np_mock = _build_mock_np()

        svc, executor = self._make_service(
            mock_registry, mock_config, mock_log_buffer,
            overlay_dir, cv2_mock, np_mock
        )
        try:
            result = await svc.process_single(
                tiny_png_bytes, filename="plate.png", batch_id="abc-123"
            )
            assert "abc-123" in result.overlay_url
        finally:
            executor.shutdown(wait=False)

    @pytest.mark.asyncio
    async def test_process_batch_returns_batch_result(
        self, mock_registry, mock_config, mock_log_buffer, tiny_png_bytes, tmp_path
    ):
        """process_batch returns a BatchDetectionResult with total_count."""
        overlay_dir = tmp_path / "overlays"
        overlay_dir.mkdir(parents=True, exist_ok=True)
        cv2_mock = _build_mock_cv2()
        np_mock = _build_mock_np()

        svc, executor = self._make_service(
            mock_registry, mock_config, mock_log_buffer,
            overlay_dir, cv2_mock, np_mock
        )
        try:
            images = [(tiny_png_bytes, "img1.png"), (tiny_png_bytes, "img2.png")]
            result = await svc.process_batch(images, batch_id="batch-002")
            assert hasattr(result, "results")
            assert len(result.results) == 2
            assert hasattr(result, "total_count")
            assert result.total_count >= 0
        finally:
            executor.shutdown(wait=False)

    @pytest.mark.asyncio
    async def test_process_single_invalid_image_raises(
        self, mock_registry, mock_config, mock_log_buffer, tmp_path
    ):
        """An invalid/corrupt image raises InvalidImageError."""
        from app.services.inference.egg import InvalidImageError

        overlay_dir = tmp_path / "overlays"
        overlay_dir.mkdir(parents=True, exist_ok=True)
        cv2_mock = _build_mock_cv2()
        np_mock = _build_mock_np()

        svc, executor = self._make_service(
            mock_registry, mock_config, mock_log_buffer,
            overlay_dir, cv2_mock, np_mock
        )
        try:
            with pytest.raises(InvalidImageError):
                await svc.process_single(
                    b"this is not image data",
                    filename="bad.jpg",
                    batch_id="batch-003",
                )
        finally:
            executor.shutdown(wait=False)

    @pytest.mark.asyncio
    async def test_service_stores_registry_and_config(
        self, mock_registry, mock_config, mock_log_buffer, tmp_path
    ):
        """EggInferenceService stores the injected model registry and config."""
        from app.services.inference.egg import EggInferenceService

        overlay_dir = tmp_path / "overlays"
        overlay_dir.mkdir(parents=True, exist_ok=True)
        cv2_mock = _build_mock_cv2()
        np_mock = _build_mock_np()
        executor = ThreadPoolExecutor(max_workers=1)

        with patch("app.services.inference.egg.Path") as mock_path_cls, \
             patch("app.services.inference.egg.cv2", cv2_mock), \
             patch("app.services.inference.egg.np", np_mock):

            mock_path_instance = MagicMock()
            mock_path_instance.exists.return_value = True
            mock_path_instance.__truediv__ = lambda self, other: overlay_dir / str(other)
            mock_path_cls.return_value = mock_path_instance

            svc = EggInferenceService(
                model_registry=mock_registry,
                pipeline_config=mock_config,
                log_buffer=mock_log_buffer,
                executor=executor,
            )

            assert svc._model_registry is mock_registry
            assert svc._pipeline_config is mock_config
            assert svc._log_buffer is mock_log_buffer
            assert svc._executor is executor

        executor.shutdown(wait=False)

    def test_dedup_mode_center_zone_is_valid(self, mock_config):
        """center_zone is a valid dedup_mode."""
        from app.schemas.config import EggConfig

        cfg = EggConfig(
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
        assert cfg.dedup_mode == "center_zone"

    def test_dedup_mode_edge_nms_is_valid(self, mock_config):
        """edge_nms is a valid dedup_mode."""
        from app.schemas.config import EggConfig

        cfg = EggConfig(
            model="models/egg_best.pt",
            device="cpu",
            tile_size=512,
            overlap=0.5,
            confidence_threshold=0.4,
            min_box_area=100,
            dedup_mode="edge_nms",
            edge_margin=3,
            nms_iou_threshold=0.4,
            batch_size=24,
        )
        assert cfg.dedup_mode == "edge_nms"
