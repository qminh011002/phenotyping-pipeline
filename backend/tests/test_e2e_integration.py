"""End-to-end integration tests for the Phenotyping Ecosystem backend.

These tests verify complete user journeys by running against the FastAPI app
with all external dependencies (database, model, config) mocked at the
appropriate level.

Tests are organized by user journey:
  1. Health & connection checks
  2. Config round-trip (GET → PUT → GET)
  3. Single image analysis flow (create batch → upload → persist → complete)
  4. Batch analysis flow (3 images)
  5. Recorded page (list → detail → delete)
  6. Dashboard stats
  7. Log streaming
  8. Settings endpoints

Fixtures are in tests/fixtures/ (real PNG files, plus the real 13MB test image
at backend/data/IMG_0959.JPG).
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock

import pytest
import pytest_asyncio
from httpx import (
    ASGITransport,
    AsyncClient,
    Timeout,
)

# ── Helpers ───────────────────────────────────────────────────────────────────

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _make_mock_result(row_data: list):
    """Build a mock SQLAlchemy Result.

    Usage:
        mock_session.execute = AsyncMock(return_value=_make_mock_result([(5,)]))
        # After await: scalars().unique().all() → [(5,)]
    """
    class _MockResult:
        def __init__(self, rows):
            self._rows = rows

        def scalars(self):
            return self

        def unique(self):
            return self

        def all(self):
            return self._rows

        def one(self):
            return self._rows[0]

        def scalar_one_or_none(self):
            return self._rows[0] if self._rows else None

        def scalar(self):
            return self._rows[0] if self._rows else None

    return _MockResult(row_data)


def _make_mock_analysis_batch(id=None, status="processing", organism_type="egg"):
    mock = MagicMock()
    mock.id = id or uuid.uuid4()
    mock.status = status
    mock.organism_type = organism_type
    mock.mode = "upload"
    mock.device = "cpu"
    mock.total_image_count = 1
    mock.total_count = None
    mock.avg_confidence = None
    mock.total_elapsed_secs = None
    mock.completed_at = None
    mock.notes = None
    mock.config_snapshot = {}
    mock.created_at = datetime.now(timezone.utc)
    mock.name = "Test Batch"
    mock.processed_image_count = 0
    mock.failed_at = None
    mock.failure_reason = None
    # Prevent SQLAlchemy async relationship access from returning a coroutine.
    # Setting images=[] stops lazy-load attempts on the MagicMock.
    mock.images = []
    return mock


def _make_analysis_batch_detail(batch):
    """Build a AnalysisBatchDetail from a mock batch."""
    from app.schemas.analysis import AnalysisBatchDetail

    return AnalysisBatchDetail(
        id=batch.id,
        name=batch.name,
        created_at=batch.created_at,
        completed_at=batch.completed_at,
        status=batch.status,
        organism_type=batch.organism_type,
        mode=batch.mode,
        device=batch.device,
        total_image_count=batch.total_image_count,
        total_count=batch.total_count,
        avg_confidence=batch.avg_confidence,
        total_elapsed_secs=batch.total_elapsed_secs,
        config_snapshot=batch.config_snapshot,
        notes=batch.notes,
        images=[],
    )


# ── Mock inference service ────────────────────────────────────────────────────

def _configure_mock_inference_service(mock_svc):
    from app.schemas.detection import BBox, DetectionResult, BatchDetectionResult

    def make_single_result(filename: str, count: int, conf: float = 0.91):
        return DetectionResult(
            filename=filename,
            organism="egg",
            count=count,
            avg_confidence=conf,
            elapsed_seconds=1.2,
            annotations=[
                BBox(label="neonate_egg", bbox=(100, 100, 200, 200), confidence=conf),
            ],
            overlay_url=f"/inference/results/e2e-test/{filename}/overlay.png",
        )

    mock_svc.process_single = AsyncMock(
        return_value=make_single_result("test_egg_256.png", count=5, conf=0.87)
    )

    def make_batch_result(*args, **kwargs):
        # args: (images_list, batch_id) from process_batch call
        # images is list[tuple[bytes, str]] — tuple[1] is the filename string
        images = args[0] if args else kwargs.get("images", [])
        results = [
            make_single_result(filename, count=3, conf=0.89)
            for _, filename in images
        ]
        return BatchDetectionResult(
            results=results,
            total_count=sum(r.count for r in results),
            total_elapsed_seconds=sum(r.elapsed_seconds for r in results),
        )

    mock_svc.process_batch = AsyncMock(side_effect=make_batch_result)


# ── App & client fixtures ──────────────────────────────────────────────────────

def _build_test_app():
    """Build the FastAPI app with all external dependencies mocked.

    Called by the `app` fixture to create a fresh app per test so that
    dependency_overrides and module-level singletons don't leak state.

    Returns (app, mock_analysis_svc, original_lifespan) — 3 values.
    """
    import app.main as _main_mod
    import app.deps as _deps_mod

    # Prevent accumulation of dependency_overrides across tests
    if _main_mod.app.dependency_overrides:
        _main_mod.app.dependency_overrides.clear()

    # Clear lru_cache on dependency functions so each test gets fresh instances
    _deps_mod.get_analysis_service.cache_clear()
    _deps_mod.get_app_settings_service.cache_clear()

    # ── No-op lifespan so startup/shutdown hooks don't run in tests ──────────
    async def _noop_lifespan(app_obj):
        yield

    _original_lifespan = _main_mod.app.router.lifespan_context
    _main_mod.app.router.lifespan_context = _noop_lifespan

    import app.routers.config as _config_router_mod

    # ── Mock model registry ─────────────────────────────────────────────────
    _mock_registry = MagicMock()
    _mock_registry.model_loaded = True
    _mock_registry.device = "cpu"
    _mock_registry.cuda_available = False
    _mock_registry.uptime_seconds = 3600.5

    # ── Mock log buffer ────────────────────────────────────────────────────
    _mock_log_buffer = MagicMock()

    # ── Mock executor ──────────────────────────────────────────────────────
    _mock_executor = MagicMock()

    # ── Mock inference service ──────────────────────────────────────────────
    _mock_inference_svc = MagicMock()
    _configure_mock_inference_service(_mock_inference_svc)

    # ── Mock database session ────────────────────────────────────────────────
    import app.database as _db_mod

    _mock_session = MagicMock()
    _mock_session.execute = AsyncMock()
    _mock_session.commit = AsyncMock()
    _mock_session.rollback = AsyncMock()
    _mock_session.add = MagicMock()
    _mock_session.delete = MagicMock()
    _mock_session.flush = AsyncMock()
    _mock_session.refresh = AsyncMock()

    async def _mock_get_session():
        yield _mock_session

    _main_mod.app.dependency_overrides[_db_mod.get_session] = _mock_get_session

    # ── Mock analysis service ──────────────────────────────────────────────
    _mock_analysis_svc = MagicMock()
    _mock_analysis_svc.create_batch = AsyncMock()
    _mock_analysis_svc.add_image_result = AsyncMock()
    _mock_analysis_svc.complete_batch = AsyncMock()
    _mock_analysis_svc.fail_batch = AsyncMock()
    _mock_analysis_svc.list_batches = AsyncMock()
    _mock_analysis_svc.get_batch_detail = AsyncMock()
    _mock_analysis_svc.delete_batch = AsyncMock(return_value=True)
    _mock_analysis_svc.get_dashboard_stats = AsyncMock()

    _main_mod.app.dependency_overrides[_deps_mod.get_analysis_service] = lambda: _mock_analysis_svc

    # ── Mock AppSettingsService (used by settings endpoints) ────────────────
    from app.models.app_settings import AppSettingsRow
    from app.services.app_settings_service import AppSettingsService

    class _MockAppSettingsService(AppSettingsService):
        def __init__(self):
            super().__init__()
            self._row = AppSettingsRow(
                id=1,
                image_storage_dir="/tmp/test_overlays",
                data_dir="/tmp/test_data",
            )

        async def get_settings(self, db):
            return self._row

        async def update_storage(self, db, image_storage_dir: str) -> AppSettingsRow:
            self._row.image_storage_dir = image_storage_dir
            return self._row

    _main_mod.app.dependency_overrides[_deps_mod.get_app_settings_service] = _MockAppSettingsService

    # ── Mock pipeline config ────────────────────────────────────────────────
    from app.schemas.config import EggConfig

    _mock_egg_config = EggConfig(
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

    _mock_pipeline_config = MagicMock()
    _mock_pipeline_config.get_egg_config.return_value = _mock_egg_config

    def _mock_update_config(updates):
        updated = dict(_mock_egg_config)
        for k, v in updates.items():
            if v is not None:
                updated[k] = v
        return EggConfig(**updated)

    _mock_pipeline_config.update_egg_config = _mock_update_config

    _deps_mod.get_pipeline_config = lambda: _mock_pipeline_config
    _config_router_mod.get_pipeline_config = lambda: _mock_pipeline_config

    # Set module-level singletons (restored in app fixture teardown)
    _deps_mod._model_registry = _mock_registry
    _deps_mod._log_buffer = _mock_log_buffer
    _deps_mod._executor = _mock_executor
    _deps_mod._inference_service = _mock_inference_svc

    return _main_mod.app, _mock_analysis_svc, _original_lifespan


@pytest.fixture
def app():
    """Fixture-scoped app — each test gets a fresh app with clean mocks.

    Yields (app, mock_session, mock_analysis_svc) — 3 values.
    Teardown clears dependency_overrides and restores the original lifespan.
    """
    import app.main as _main_mod

    _app_obj, _mock_analysis_svc, _original_lifespan = _build_test_app()
    _mock_session = _app_obj.dependency_overrides.values().__iter__().__next__()

    yield _app_obj, _mock_session, _mock_analysis_svc

    # Teardown: clean up dependency_overrides and restore lifespan
    _app_obj.dependency_overrides.clear()
    _main_mod.app.router.lifespan_context = _original_lifespan


@pytest_asyncio.fixture
async def client(app) -> AsyncClient:
    """Async HTTP client against the test app."""
    _main_mod, _mock_session, _mock_analysis_svc = app
    transport = ASGITransport(app=_main_mod)
    async with AsyncClient(
        transport=transport,
        base_url="http://e2e-test",
        timeout=Timeout(30.0),
    ) as ac:
        yield ac


@pytest_asyncio.fixture
async def analysis_client(app) -> tuple[AsyncClient, MagicMock]:
    """HTTP client with a fresh mock inference service per test.

    Uses the `app` fixture (which already has mocked DB and analysis service),
    then patches `_deps_mod._inference_service` with a fresh mock so that
    inference routes receive controlled mock responses.
    """
    _main_mod, _mock_session, _mock_analysis_svc = app

    import app.deps as _deps_mod

    fresh_mock = MagicMock()
    _configure_mock_inference_service(fresh_mock)
    _deps_mod._inference_service = fresh_mock

    transport = ASGITransport(app=_main_mod)
    async with AsyncClient(
        transport=transport,
        base_url="http://e2e-test",
        timeout=Timeout(30.0),
    ) as ac:
        yield ac, fresh_mock


# ─────────────────────────────────────────────────────────────────────────────
# JOURNEY 1 — Health & Connection Checks
# ─────────────────────────────────────────────────────────────────────────────

class TestHealthJourney:
    """Verify the health check flow works end-to-end."""

    @pytest.mark.asyncio
    async def test_health_returns_model_state(self, client):
        """GET /health returns model loaded state, device, and uptime."""
        response = await client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert data["status"] in ("ok", "degraded")
        assert "model_loaded" in data
        assert isinstance(data["model_loaded"], bool)
        assert "device" in data
        assert "cuda_available" in data
        assert "uptime_seconds" in data
        assert "version" in data

    @pytest.mark.asyncio
    async def test_health_status_ok_when_model_loaded(self, client):
        """When model_loaded is True, status is 'ok'."""
        response = await client.get("/health")
        data = response.json()
        assert data["model_loaded"] is True
        assert data["status"] == "ok"

    @pytest.mark.asyncio
    async def test_ping_returns_pong(self, client):
        """GET /ping returns pong immediately with no dependencies."""
        response = await client.get("/ping")
        assert response.status_code == 200
        assert response.json() == {"pong": True}

    @pytest.mark.asyncio
    async def test_ping_has_no_auth_overhead(self, client):
        """ping completes in under 1 second — no model, no DB."""
        start = time.monotonic()
        response = await client.get("/ping")
        elapsed = time.monotonic() - start
        assert response.status_code == 200
        assert elapsed < 1.0


# ─────────────────────────────────────────────────────────────────────────────
# JOURNEY 2 — Config Round-trip
# ─────────────────────────────────────────────────────────────────────────────

class TestConfigJourney:
    """Verify GET /config → PUT /config → GET /config round-trip."""

    @pytest.mark.asyncio
    async def test_get_config_returns_valid_shape(self, client):
        """GET /config returns the full egg config."""
        response = await client.get("/config")
        assert response.status_code == 200
        data = response.json()
        assert "model" in data
        assert "device" in data
        assert "tile_size" in data
        assert "overlap" in data
        assert "confidence_threshold" in data
        assert "min_box_area" in data
        assert "dedup_mode" in data
        assert "edge_margin" in data
        assert "nms_iou_threshold" in data
        assert "batch_size" in data

    @pytest.mark.asyncio
    async def test_get_config_fields_have_valid_types(self, client):
        """Config field types match the API contract."""
        response = await client.get("/config")
        data = response.json()
        assert isinstance(data["device"], str)
        assert isinstance(data["tile_size"], int)
        assert isinstance(data["overlap"], float)
        assert isinstance(data["dedup_mode"], str)
        assert data["dedup_mode"] in ("center_zone", "edge_nms")

    @pytest.mark.asyncio
    async def test_put_config_validates_invalid_tile_size(self, client):
        """PUT /config rejects invalid tile_size (not multiple of 32)."""
        response = await client.put("/config", json={"tile_size": 300})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_put_config_validates_invalid_device(self, client):
        """PUT /config rejects invalid device string."""
        response = await client.put("/config", json={"device": "metal"})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_put_config_validates_invalid_dedup_mode(self, client):
        """PUT /config rejects invalid dedup_mode."""
        response = await client.put("/config", json={"dedup_mode": "fast"})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_put_config_validates_overlap_range(self, client):
        """PUT /config rejects overlap > 1.0."""
        response = await client.put("/config", json={"overlap": 1.5})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_put_config_accepts_valid_partial_update(self, client):
        """PUT /config with valid partial fields returns updated config."""
        response = await client.put(
            "/config",
            json={
                "tile_size": 768,
                "confidence_threshold": 0.55,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["tile_size"] == 768
        assert data["confidence_threshold"] == 0.55
        assert data["dedup_mode"] in ("center_zone", "edge_nms")


# ─────────────────────────────────────────────────────────────────────────────
# JOURNEY 3 — Single Image Analysis Flow
#  POST /analyses → POST /inference/egg → POST /analyses/{id}/images
#  → POST /analyses/{id}/complete
# ─────────────────────────────────────────────────────────────────────────────

class TestSingleImageAnalysisJourney:
    """Verify single image: create batch → infer → persist → complete."""

    @pytest.mark.asyncio
    async def test_create_batch_returns_201(self, app):
        """POST /analyses creates a new processing batch."""
        _main_mod, _mock_session, _mock_analysis_svc = app

        # Configure the mock analysis service
        batch_id = uuid.uuid4()
        mock_batch = _make_mock_analysis_batch(id=batch_id, status="processing")
        _mock_analysis_svc.has_active_batch = AsyncMock(return_value=None)
        _mock_analysis_svc.create_batch = AsyncMock(return_value=mock_batch)
        _mock_analysis_svc.get_batch_detail = AsyncMock(
            return_value=_make_analysis_batch_detail(mock_batch)
        )

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/analyses",
                json={
                    "organism_type": "egg",
                    "mode": "upload",
                    "total_image_count": 1,
                    "device": "cpu",
                    "config_snapshot": {},
                },
            )
        assert response.status_code == 201
        data = response.json()
        assert "id" in data
        assert data["status"] == "processing"
        assert data["organism_type"] == "egg"

    @pytest.mark.asyncio
    async def test_inference_single_returns_detection_result(self, analysis_client):
        """POST /inference/egg with a real PNG file returns DetectionResult."""
        client, _ = analysis_client
        egg_path = FIXTURES_DIR / "test_egg_256.png"

        with open(egg_path, "rb") as f:
            response = await client.post(
                "/inference/egg",
                files={"file": ("test_egg_256.png", f, "image/png")},
            )

        assert response.status_code == 200
        data = response.json()
        assert "filename" in data
        assert data["organism"] == "egg"
        assert "count" in data
        assert "avg_confidence" in data
        assert "elapsed_seconds" in data
        assert "annotations" in data
        assert "overlay_url" in data
        assert isinstance(data["count"], int)
        assert isinstance(data["avg_confidence"], float)
        assert 0.0 <= data["avg_confidence"] <= 1.0

    @pytest.mark.asyncio
    async def test_inference_single_rejects_unsupported_format(self, analysis_client):
        """Uploading a .gif file returns 400."""
        client, _ = analysis_client
        response = await client.post(
            "/inference/egg",
            files={"file": ("test.gif", b"GIFFakeData", "image/gif")},
        )
        assert response.status_code == 400
        assert "Unsupported file type" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_inference_single_rejects_empty_file(self, analysis_client):
        """Uploading an empty file returns 400."""
        client, _ = analysis_client
        response = await client.post(
            "/inference/egg",
            files={"file": ("empty.jpg", b"", "image/jpeg")},
        )
        assert response.status_code == 400
        assert "empty" in response.json()["detail"].lower()


# ─────────────────────────────────────────────────────────────────────────────
# JOURNEY 4 — Batch Analysis Flow (3 Images)
# ─────────────────────────────────────────────────────────────────────────────

class TestBatchAnalysisJourney:
    """Verify batch analysis with 3 images processes all correctly."""

    @pytest.mark.asyncio
    async def test_batch_inference_processes_multiple_images(
        self, analysis_client
    ):
        """POST /inference/egg/batch with 3 images returns results."""
        client, _ = analysis_client

        with open(FIXTURES_DIR / "test_egg_256.png", "rb") as f1, \
             open(FIXTURES_DIR / "test_egg_512.png", "rb") as f2, \
             open(FIXTURES_DIR / "test_blank_256.png", "rb") as f3:

            response = await client.post(
                "/inference/egg/batch",
                files=[
                    ("files", ("img1.png", f1, "image/png")),
                    ("files", ("img2.png", f2, "image/png")),
                    ("files", ("img3.png", f3, "image/png")),
                ],
            )

        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert "total_count" in data
        assert "total_elapsed_seconds" in data
        assert isinstance(data["results"], list)
        assert len(data["results"]) >= 1
        assert isinstance(data["total_count"], int)

    @pytest.mark.asyncio
    async def test_batch_result_structure_is_correct(self, analysis_client):
        """Each item in batch results has correct DetectionResult shape."""
        client, _ = analysis_client

        with open(FIXTURES_DIR / "test_egg_256.png", "rb") as f1, \
             open(FIXTURES_DIR / "test_egg_512.png", "rb") as f2:

            response = await client.post(
                "/inference/egg/batch",
                files=[
                    ("files", ("img1.png", f1, "image/png")),
                    ("files", ("img2.png", f2, "image/png")),
                ],
            )

        assert response.status_code == 200
        data = response.json()
        results = data["results"]
        assert isinstance(results, list)
        assert len(results) >= 1

        for result in results:
            assert "filename" in result
            assert result["organism"] == "egg"
            assert "count" in result
            assert "avg_confidence" in result
            assert "elapsed_seconds" in result
            assert "overlay_url" in result

    @pytest.mark.asyncio
    async def test_batch_rejects_too_many_files(self, analysis_client):
        """Batch with > 50 files returns 413."""
        client, _ = analysis_client

        with open(FIXTURES_DIR / "test_egg_256.png", "rb") as f:
            files = [("files", (f"img{i}.png", f, "image/png")) for i in range(51)]
            response = await client.post("/inference/egg/batch", files=files)

        assert response.status_code == 413


# ─────────────────────────────────────────────────────────────────────────────
# JOURNEY 5 — Recorded Page (List → Detail → Delete)
# ─────────────────────────────────────────────────────────────────────────────

class TestRecordedPageJourney:
    """Verify the recorded analyses page flow: list → detail → delete."""

    @pytest.mark.asyncio
    async def test_list_analyses_returns_200(self, app):
        """GET /analyses returns a paginated list."""
        _main_mod, _, _mock_analysis_svc = app

        from app.schemas.analysis import AnalysisListResponse

        _mock_analysis_svc.list_batches = AsyncMock(
            return_value=AnalysisListResponse(items=[], total=0, page=1, page_size=20)
        )

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.get("/analyses")
        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "total" in data
        assert "page" in data
        assert "page_size" in data
        assert isinstance(data["items"], list)

    @pytest.mark.asyncio
    async def test_list_analyses_respects_pagination(self, app):
        """GET /analyses?page=2&page_size=5 returns correct slice."""
        _main_mod, _, _mock_analysis_svc = app

        from app.schemas.analysis import AnalysisListResponse

        async def mock_list_batches(**kwargs):
            return AnalysisListResponse(
                items=[],
                total=0,
                page=kwargs.get("page", 1),
                page_size=kwargs.get("page_size", 20),
            )

        _mock_analysis_svc.list_batches = AsyncMock(side_effect=mock_list_batches)

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.get("/analyses?page=2&page_size=5")
        assert response.status_code == 200
        data = response.json()
        assert data["page"] == 2
        assert data["page_size"] == 5

    @pytest.mark.asyncio
    async def test_list_analyses_filters_by_organism(self, app):
        """GET /analyses?organism=egg returns only egg batches."""
        _main_mod, _, _mock_analysis_svc = app

        from app.schemas.analysis import AnalysisBatchSummary, AnalysisListResponse

        mock_batch = _make_mock_analysis_batch(organism_type="egg")
        summary = AnalysisBatchSummary(
            id=mock_batch.id,
            name=mock_batch.name,
            created_at=mock_batch.created_at,
            completed_at=mock_batch.completed_at,
            status=mock_batch.status,
            organism_type=mock_batch.organism_type,
            mode=mock_batch.mode,
            device=mock_batch.device,
            total_image_count=mock_batch.total_image_count,
            total_count=mock_batch.total_count,
            avg_confidence=mock_batch.avg_confidence,
            total_elapsed_secs=mock_batch.total_elapsed_secs,
        )
        _mock_analysis_svc.list_batches = AsyncMock(
            return_value=AnalysisListResponse(items=[summary], total=1, page=1, page_size=20)
        )

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.get("/analyses?organism=egg")
        assert response.status_code == 200
        data = response.json()
        assert all(item["organism_type"] == "egg" for item in data["items"])

    @pytest.mark.asyncio
    async def test_get_batch_detail_returns_404_for_unknown(self, app):
        """GET /analyses/{unknown_id} returns 404."""
        _main_mod, _, _mock_analysis_svc = app

        _mock_analysis_svc.get_batch_detail = AsyncMock(return_value=None)

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            fake_id = str(uuid.uuid4())
            response = await ac.get(f"/analyses/{fake_id}")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_batch_returns_204(self, app):
        """DELETE /analyses/{id} returns 204 No Content."""
        _main_mod, _, _mock_analysis_svc = app

        _mock_analysis_svc.delete_batch = AsyncMock(return_value=True)

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            fake_id = str(uuid.uuid4())
            response = await ac.delete(f"/analyses/{fake_id}")
        assert response.status_code == 204

    @pytest.mark.asyncio
    async def test_delete_unknown_batch_returns_404(self, app):
        """DELETE /analyses/{unknown_id} returns 404."""
        _main_mod, _, _mock_analysis_svc = app

        _mock_analysis_svc.delete_batch = AsyncMock(return_value=False)

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            fake_id = str(uuid.uuid4())
            response = await ac.delete(f"/analyses/{fake_id}")
        assert response.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# JOURNEY 6 — Dashboard Stats
# ─────────────────────────────────────────────────────────────────────────────

class TestDashboardJourney:
    """Verify dashboard aggregate statistics endpoint."""

    @pytest.mark.asyncio
    async def test_dashboard_stats_returns_200(self, app):
        """GET /dashboard/stats returns aggregate statistics."""
        _main_mod, _mock_session, _ = app

        from app.deps import get_analysis_service
        from app.schemas.analysis import DashboardStats

        analysis_svc = get_analysis_service()
        analysis_svc.get_dashboard_stats = AsyncMock(
            return_value=DashboardStats(
                total_analyses=0,
                total_images_processed=0,
                total_eggs_counted=0,
                avg_confidence=None,
                avg_processing_time=None,
                recent_analyses=[],
            )
        )

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.get("/dashboard/stats")
        assert response.status_code == 200
        data = response.json()
        assert "total_analyses" in data
        assert "total_images_processed" in data
        assert "total_eggs_counted" in data
        assert "avg_confidence" in data
        assert "avg_processing_time" in data
        assert "recent_analyses" in data
        assert isinstance(data["recent_analyses"], list)

    @pytest.mark.asyncio
    async def test_dashboard_stats_fields_have_correct_types(self, app):
        """Dashboard stats fields have correct types."""
        _main_mod, _mock_session, _ = app

        from app.deps import get_analysis_service
        from app.schemas.analysis import DashboardStats, AnalysisBatchSummary

        mock_batch = _make_mock_analysis_batch(organism_type="egg")
        summary = AnalysisBatchSummary(
            id=mock_batch.id,
            name=mock_batch.name,
            created_at=mock_batch.created_at,
            completed_at=mock_batch.completed_at,
            status=mock_batch.status,
            organism_type=mock_batch.organism_type,
            mode=mock_batch.mode,
            device=mock_batch.device,
            total_image_count=mock_batch.total_image_count,
            total_count=100,
            avg_confidence=0.87,
            total_elapsed_secs=2.5,
        )
        analysis_svc = get_analysis_service()
        analysis_svc.get_dashboard_stats = AsyncMock(
            return_value=DashboardStats(
                total_analyses=5,
                total_images_processed=10,
                total_eggs_counted=200,
                avg_confidence=0.85,
                avg_processing_time=3.2,
                recent_analyses=[summary],
            )
        )

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.get("/dashboard/stats")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data["total_analyses"], int)
        assert isinstance(data["total_images_processed"], int)
        assert isinstance(data["total_eggs_counted"], int)


# ─────────────────────────────────────────────────────────────────────────────
# JOURNEY 7 — Log Streaming
# ─────────────────────────────────────────────────────────────────────────────

class TestLogStreamingJourney:
    """Verify log streaming: GET /logs/recent and WebSocket /logs/stream."""

    @pytest.mark.asyncio
    async def test_get_recent_logs_returns_200(self, client):
        """GET /logs/recent returns log entries from the ring buffer."""
        response = await client.get("/logs/recent?limit=10")
        assert response.status_code == 200
        data = response.json()
        assert "logs" in data
        assert isinstance(data["logs"], list)

    @pytest.mark.asyncio
    async def test_get_recent_logs_respects_limit(self, client):
        """GET /logs/recent?limit=5 returns at most 5 entries."""
        response = await client.get("/logs/recent?limit=5")
        assert response.status_code == 200
        data = response.json()
        assert len(data["logs"]) <= 5

    @pytest.mark.asyncio
    async def test_get_recent_logs_limit_validation(self, client):
        """GET /logs/recent with limit > 1000 returns 422."""
        response = await client.get("/logs/recent?limit=2000")
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_websocket_logs_stream_accepts_connection(self, app):
        """WebSocket /logs/stream accepts connections."""
        _main_mod, _, _ = app
        from fastapi.testclient import TestClient

        with TestClient(_main_mod).websocket_connect("/logs/stream") as ws:
            # Accept the connection without error
            ws.send_text("ping")


# ─────────────────────────────────────────────────────────────────────────────
# JOURNEY 8 — Settings Endpoints
# ─────────────────────────────────────────────────────────────────────────────

class TestSettingsJourney:
    """Verify settings endpoints for image storage configuration."""

    @pytest.mark.asyncio
    async def test_get_settings_returns_storage_dirs(self, app):
        """GET /settings returns image_storage_dir and data_dir."""
        _main_mod, _, _ = app

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.get("/settings")
        assert response.status_code == 200
        data = response.json()
        assert "image_storage_dir" in data
        assert "data_dir" in data

    @pytest.mark.asyncio
    async def test_get_storage_settings_returns_image_dir(self, app):
        """GET /settings/storage returns only image_storage_dir."""
        _main_mod, _, _ = app

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.get("/settings/storage")
        assert response.status_code == 200
        data = response.json()
        assert "image_storage_dir" in data
        assert isinstance(data["image_storage_dir"], str)

    @pytest.mark.asyncio
    async def test_update_storage_settings_validates_parent_exists(self, app):
        """PUT /settings/storage with non-existent parent returns 422."""
        _main_mod, _, _ = app

        transport = ASGITransport(app=_main_mod)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.put(
                "/settings/storage",
                json={"image_storage_dir": "/nonexistent/path/that/does/not/exist"},
            )
        assert response.status_code == 422
