"""pytest configuration and shared fixtures for all backend tests."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch
import importlib

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Ensure the app package is on the path
sys.path.insert(0, str(Path(__file__).parent.parent))


# ── App fixture ────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def app():
    """Build the FastAPI app without running the real lifespan.

    The real lifespan (app/main.py) would:
      1. Load YOLO model via ModelRegistry
      2. Configure logging
      3. Create ThreadPoolExecutor
      4. Create EggInferenceService
      5. Initialize database

    We skip all of that by patching the lifespan to a no-op, then directly
    set the module-level singletons in app/deps.py so that dependency
    injection (Depends(...)) works correctly.
    """
    # Patch the lifespan so FastAPI doesn't try to load real resources at import time
    import app.main as _main_mod

    async def _noop_lifespan(app_obj):
        yield

    _original_lifespan = _main_mod.app.router.lifespan_context
    _main_mod.app.router.lifespan_context = _noop_lifespan

    # Set deps module-level singletons so get_model_registry(), etc. don't raise
    import app.deps as _deps_mod

    _mock_registry = MagicMock()
    _mock_registry.model_loaded = True
    _mock_registry.device = "cpu"
    _mock_registry.cuda_available = False
    _mock_registry.uptime_seconds = 3600.5

    _mock_log_buffer = MagicMock()

    _mock_executor = MagicMock()

    _mock_inference_svc = MagicMock()

    _deps_mod._model_registry = _mock_registry
    _deps_mod._log_buffer = _mock_log_buffer
    _deps_mod._executor = _mock_executor
    _deps_mod._inference_service = _mock_inference_svc

    yield _main_mod.app

    # Restore lifespan
    _main_mod.app.router.lifespan_context = _original_lifespan


@pytest_asyncio.fixture
async def client(app) -> AsyncClient:
    """Async HTTP client for testing endpoints without a running server."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


# ── Helpers to configure mock inference service ─────────────────────────────────

def make_mock_inference_result(filename="test.jpg", count=3, avg_conf=0.91):
    """Create a canned DetectionResult for mock inference services."""
    from app.schemas.detection import BBox, DetectionResult

    return DetectionResult(
        filename=filename,
        organism="egg",
        count=count,
        avg_confidence=avg_conf,
        elapsed_seconds=1.5,
        annotations=[
            BBox(label="neonate_egg", bbox=(100, 100, 200, 200), confidence=avg_conf),
        ],
        overlay_url=f"/inference/results/batch-001/{filename}/overlay.png",
    )


def make_mock_batch_result(results=None):
    """Create a canned BatchDetectionResult."""
    from app.schemas.detection import BatchDetectionResult

    results = results or [make_mock_inference_result()]
    total = sum(r.count for r in results)
    total_elapsed = sum(r.elapsed_seconds for r in results)
    return BatchDetectionResult(
        results=results,
        total_count=total,
        total_elapsed_seconds=total_elapsed,
    )


# ── Mock YOLO model ─────────────────────────────────────────────────────────

@pytest.fixture
def mock_yolo_model():
    """Return a mock YOLO model that returns predictable detection results."""
    import numpy as np

    model = MagicMock()
    model.task = "detect"

    result = MagicMock()
    result.boxes = MagicMock()
    result.boxes.xyxy.cpu.return_value.numpy.return_value = np.array(
        [[100.0, 100.0, 200.0, 200.0]], dtype=np.float32
    )
    result.boxes.conf.cpu.return_value.numpy.return_value = np.array(
        [0.92], dtype=np.float32
    )
    result.boxes.cls.cpu.return_value.numpy.return_value = np.array(
        [0], dtype=np.float32
    )
    model.return_value = [result]
    return model


# ── Small test images ─────────────────────────────────────────────────────

@pytest.fixture
def tiny_png_bytes():
    """Return the raw bytes of a minimal 32×32 PNG image.

    This avoids needing a real image file on disk.
    """
    import base64

    # A minimal 1×1 red PNG encoded in base64
    png_b64 = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8Dw"
        "HwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
    )
    return base64.b64decode(png_b64)


# ── Mock pipeline config ─────────────────────────────────────────────────

@pytest.fixture
def mock_pipeline_config():
    """Return a mock PipelineConfigManager that returns a fixed EggConfig."""
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
    mock.update_egg_config.return_value = cfg
    mock.get_model_path.return_value = Path("/fake/model.pt")
    return mock


# ── Mock analysis service ────────────────────────────────────────────────

@pytest.fixture
def mock_analysis_service():
    """Return a mock AnalysisService for router tests."""
    mock = MagicMock()
    mock.create_batch = AsyncMock()
    mock.add_image_result = AsyncMock()
    mock.complete_batch = AsyncMock()
    mock.fail_batch = AsyncMock()
    mock.list_batches = AsyncMock()
    mock.get_batch_detail = AsyncMock()
    mock.delete_batch = AsyncMock(return_value=True)
    mock.get_dashboard_stats = AsyncMock()
    return mock
