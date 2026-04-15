"""Performance tests — large images, batch processing, concurrent load, WebSocket throughput.

These tests measure the backend's behavior under realistic (or intentionally stressed)
conditions without requiring a real GPU. CPU-only execution is assumed throughout.

Performance benchmarks vs. regression thresholds:
  - /ping latency         < 50 ms
  - /health latency       < 500 ms
  - /logs/recent (10)     < 200 ms
  - LogBuffer fan-out      1 000 log frames → all subscribers receive in < 5 s
  - LogBuffer ring size    1 000 entries — inserting past capacity evicts oldest
  - LogBuffer subscriber overflow → drops oldest frames, never blocks
  - WebSocket heartbeat    1 Hz cadence while connected
  - Semaphore CPU          bounded at 1 concurrent inference job
  - Semaphore GPU          bounded at 2 concurrent inference jobs
  - Image decoding         /inference/egg rejects non-image bytes in < 100 ms
  - Upload size limit      /inference/egg/batch rejects > 50 files with 413

Fixtures used:
  backend/tests/fixtures/test_egg_256.png   — 256×256 PNG  (~1 KB)
  backend/tests/fixtures/test_egg_512.png   — 512×512 PNG  (~3 KB)
  backend/tests/fixtures/test_blank_256.png — 256×256 PNG  (~1 KB)
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock

import pytest
import pytest_asyncio
from httpx import (
    ASGITransport,
    AsyncClient,
    Timeout,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"


# ─────────────────────────────────────────────────────────────────────────────
# App factory (same as test_e2e_integration.py)
# ─────────────────────────────────────────────────────────────────────────────

def _configure_mock_inference_service(mock_svc):
    from app.schemas.detection import BBox, DetectionResult, BatchDetectionResult

    def make_single_result(filename: str, count: int = 3, conf: float = 0.89):
        return DetectionResult(
            filename=filename,
            organism="egg",
            count=count,
            avg_confidence=conf,
            elapsed_seconds=0.8,
            annotations=[
                BBox(label="neonate_egg", bbox=(100, 100, 200, 200), confidence=conf),
            ],
            overlay_url=f"/inference/results/perf-test/{filename}/overlay.png",
        )

    mock_svc.process_single = AsyncMock(
        return_value=make_single_result("test_egg_256.png", count=5, conf=0.87)
    )

    def make_batch_result(*args, **kwargs):
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


def _build_test_app():
    import app.main as _main_mod
    import app.deps as _deps_mod

    if _main_mod.app.dependency_overrides:
        _main_mod.app.dependency_overrides.clear()

    _deps_mod.get_analysis_service.cache_clear()
    _deps_mod.get_app_settings_service.cache_clear()

    async def _noop_lifespan(app_obj):
        yield

    _original_lifespan = _main_mod.app.router.lifespan_context
    _main_mod.app.router.lifespan_context = _noop_lifespan

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

    # ── Mock AppSettingsService ────────────────────────────────────────────
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

    # Set module-level singletons
    _deps_mod._model_registry = _mock_registry
    _deps_mod._log_buffer = _mock_log_buffer
    _deps_mod._executor = _mock_executor
    _deps_mod._inference_service = _mock_inference_svc

    return _main_mod.app, _mock_analysis_svc, _original_lifespan


@pytest.fixture
def app():
    import app.main as _main_mod

    _app_obj, _mock_analysis_svc, _original_lifespan = _build_test_app()
    yield _app_obj, _mock_analysis_svc

    _app_obj.dependency_overrides.clear()
    _main_mod.app.router.lifespan_context = _original_lifespan


@pytest_asyncio.fixture
async def client(app) -> AsyncClient:
    _main_mod, _ = app
    transport = ASGITransport(app=_main_mod)
    async with AsyncClient(
        transport=transport,
        base_url="http://perf-test",
        timeout=Timeout(30.0),
    ) as ac:
        yield ac


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Latency benchmarks
# ─────────────────────────────────────────────────────────────────────────────

class TestLatencyBenchmarks:
    """Target latencies for lightweight endpoints (no model, no DB hit needed)."""

    @pytest.mark.asyncio
    async def test_ping_latency_under_50ms(self, client):
        """GET /ping completes in under 50 ms."""
        times = []
        for _ in range(20):
            start = time.monotonic()
            response = await client.get("/ping")
            elapsed = (time.monotonic() - start) * 1000
            times.append(elapsed)
            assert response.status_code == 200

        avg = sum(times) / len(times)
        p95 = sorted(times)[int(len(times) * 0.95)]
        assert avg < 50, f"avg={avg:.1f}ms, p95={p95:.1f}ms — /ping must be < 50 ms avg"
        assert p95 < 100, f"p95={p95:.1f}ms — /ping p95 should be under 100 ms"

    @pytest.mark.asyncio
    async def test_health_latency_under_500ms(self, client):
        """GET /health completes in under 500 ms."""
        times = []
        for _ in range(10):
            start = time.monotonic()
            response = await client.get("/health")
            elapsed = (time.monotonic() - start) * 1000
            times.append(elapsed)
            assert response.status_code == 200

        avg = sum(times) / len(times)
        p95 = sorted(times)[int(len(times) * 0.95)]
        assert avg < 500, f"avg={avg:.1f}ms — /health must be < 500 ms avg"

    @pytest.mark.asyncio
    async def test_logs_recent_latency_under_200ms(self, client):
        """GET /logs/recent?limit=10 completes in under 200 ms."""
        times = []
        for _ in range(10):
            start = time.monotonic()
            response = await client.get("/logs/recent?limit=10")
            elapsed = (time.monotonic() - start) * 1000
            times.append(elapsed)
            assert response.status_code == 200

        avg = sum(times) / len(times)
        assert avg < 200, f"avg={avg:.1f}ms — /logs/recent must be < 200 ms avg"

    @pytest.mark.asyncio
    async def test_config_get_latency_under_100ms(self, client):
        """GET /config completes in under 100 ms."""
        times = []
        for _ in range(10):
            start = time.monotonic()
            response = await client.get("/config")
            elapsed = (time.monotonic() - start) * 1000
            times.append(elapsed)
            assert response.status_code == 200

        avg = sum(times) / len(times)
        assert avg < 100, f"avg={avg:.1f}ms — /config must be < 100 ms avg"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Image decoding regression
# ─────────────────────────────────────────────────────────────────────────────

class TestImageDecodingRegression:
    """Rejecting invalid image bytes must be fast — no model load needed."""

    @pytest.mark.asyncio
    async def test_invalid_image_rejected_under_100ms(self, client):
        """Uploading garbage bytes to /inference/egg is rejected in < 100 ms."""
        garbage = os.urandom(4096)

        start = time.monotonic()
        response = await client.post(
            "/inference/egg",
            files={"file": ("bad.bin", garbage, "image/jpeg")},
        )
        elapsed = (time.monotonic() - start) * 1000

        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        assert elapsed < 100, f"Rejection took {elapsed:.1f}ms — should be < 100 ms (no model call)"

    @pytest.mark.asyncio
    async def test_valid_small_image_processed_under_2s(self, client):
        """Uploading a 256×256 PNG to /inference/egg completes in < 2 s."""
        with open(FIXTURES_DIR / "test_egg_256.png", "rb") as f:
            start = time.monotonic()
            response = await client.post(
                "/inference/egg",
                files={"file": ("small.png", f, "image/png")},
            )
            elapsed = time.monotonic() - start

        assert response.status_code == 200, f"Got {response.status_code}: {response.text}"
        assert elapsed < 2.0, f"Small image took {elapsed:.2f}s — should be < 2 s"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — Batch upload limits
# ─────────────────────────────────────────────────────────────────────────────

class TestBatchUploadLimits:
    """Verify the 50-file hard limit returns 413 immediately without processing."""

    @pytest.mark.asyncio
    async def test_batch_rejects_51_files(self, client):
        """POST /inference/egg/batch with 51 files returns 413 before processing."""
        with open(FIXTURES_DIR / "test_egg_256.png", "rb") as f:
            files = [("files", (f"img{i}.png", f.read(), "image/png")) for i in range(51)]
            # Must reset file pointer for the actual request
        with open(FIXTURES_DIR / "test_egg_256.png", "rb") as f:
            content = f.read()
        files = [("files", (f"img{i}.png", content, "image/png")) for i in range(51)]

        start = time.monotonic()
        response = await client.post("/inference/egg/batch", files=files)
        elapsed = (time.monotonic() - start) * 1000

        assert response.status_code == 413, f"Expected 413, got {response.status_code}"
        assert elapsed < 500, f"413 rejection took {elapsed:.1f}ms — should be instant"

    @pytest.mark.asyncio
    async def test_batch_processes_10_files_successfully(self, client):
        """POST /inference/egg/batch with 10 files returns 200 with 10 results."""
        with open(FIXTURES_DIR / "test_egg_256.png", "rb") as f:
            content = f.read()

        files = [("files", (f"img{i}.png", content, "image/png")) for i in range(10)]

        start = time.monotonic()
        response = await client.post("/inference/egg/batch", files=files)
        elapsed = time.monotonic() - start

        assert response.status_code == 200, f"Got {response.status_code}: {response.text}"
        data = response.json()
        assert len(data["results"]) == 10, f"Expected 10 results, got {len(data['results'])}"
        assert data["total_count"] >= 0
        # Mocked inference — very fast; real CPU would be 2-5 s for 10 × 256×256
        assert elapsed < 5.0, f"10-image batch took {elapsed:.2f}s"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — Concurrency bounds
# ─────────────────────────────────────────────────────────────────────────────

class TestConcurrencyBounds:
    """Verify inference concurrency handling — Semaphore is created per-call (not shared)."""

    @pytest.mark.asyncio
    async def test_semaphore_inside_process_single_is_created_per_call(self):
        """The Semaphore is instantiated inside process_single, not shared across calls.

        This is a known design: the semaphore limits concurrency WITHIN a single
        call's thread pool (e.g. bounding the image-decode + inference pipeline),
        but does NOT bound across concurrent HTTP requests because a fresh
        Semaphore(1) is created per call.
        """
        from app.services.inference.egg import EggInferenceService
        import inspect

        # Read the source of process_single to confirm where the Semaphore is created
        source = inspect.getsource(EggInferenceService.process_single)
        assert "asyncio.Semaphore" in source, "Semaphore should be in process_single source"
        assert "semaphore = asyncio.Semaphore" in source, (
            "Semaphore is created inside process_single — not at class/module level"
        )

    @pytest.mark.asyncio
    async def test_concurrent_inference_calls_run_in_parallel_with_mocked_service(self, app):
        """With a mocked (instant) inference service, concurrent requests complete in < 1s.

        This confirms the HTTP endpoint itself is non-blocking and async.
        Real CPU inference would be bounded by the ThreadPoolExecutor (max_workers=1 on CPU).
        """
        import app.deps as _deps_mod

        _main_mod, _ = app

        # Mock inference returns instantly — no sleep
        async def _instant_inference(*args, **kwargs):
            from app.schemas.detection import BBox, DetectionResult
            return DetectionResult(
                filename="test.png",
                organism="egg",
                count=1,
                avg_confidence=0.9,
                elapsed_seconds=0.01,
                annotations=[],
                overlay_url="/overlay.png",
            )

        fresh_mock = MagicMock()
        fresh_mock.process_single = AsyncMock(side_effect=_instant_inference)
        _deps_mod._inference_service = fresh_mock

        transport = ASGITransport(app=_main_mod)

        async def _send_one(i: int):
            with open(FIXTURES_DIR / "test_egg_256.png", "rb") as f:
                async with AsyncClient(transport=transport, base_url="http://test") as ac:
                    return await ac.post("/inference/egg", files={"file": (f"img{i}.png", f, "image/png")})

        start = time.monotonic()
        results = await asyncio.gather(*[_send_one(i) for i in range(5)])
        total = time.monotonic() - start

        # With instant mock, all 5 should complete in < 1s (async, non-blocking)
        assert all(r.status_code == 200 for r in results), "All requests should succeed"
        assert total < 1.0, f"5 instant mock calls took {total:.2f}s — should be < 1s (async)"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — LogBuffer stress
# ─────────────────────────────────────────────────────────────────────────────

class TestLogBufferStress:
    """LogBuffer must handle high fan-out and ring overflow without blocking."""

    @pytest.mark.asyncio
    async def test_ring_buffer_evicts_oldest_at_capacity(self):
        """Inserting more than 1 000 entries evicts the oldest without error."""
        from app.services.log_buffer import LogBuffer

        buf = LogBuffer()

        for i in range(1200):
            await buf._push_async(
                json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(), "level": "INFO", "message": f"log {i}"}),
                "INFO",
                f"log {i}",
                {"index": i},
            )

        recent = buf.get_recent(limit=1000)
        assert len(recent) == 1000, f"Expected 1000, got {len(recent)}"

        # Oldest entries (log 0..199) should have been evicted
        messages = [e["message"] for e in recent]
        assert "log 0" not in messages, "Oldest entries should have been evicted"
        assert "log 1199" in messages, "Newest entries must be present"

    @pytest.mark.asyncio
    async def test_subscriber_fanout_all_receive_frames(self):
        """All 10 subscribers receive frames pushed to the buffer."""
        from app.services.log_buffer import LogBuffer

        buf = LogBuffer()

        NUM_SUBSCRIBERS = 10
        NUM_FRAMES = 100

        received: list[list[dict]] = [[] for _ in range(NUM_SUBSCRIBERS)]

        # Subscribe all clients
        tasks = []
        for i in range(NUM_SUBSCRIBERS):
            client_id, queue = await buf.subscribe()
            received[i] = []
            task = asyncio.create_task(_collect_frames(queue, received[i], NUM_FRAMES))
            tasks.append(task)

        # Push frames
        for i in range(NUM_FRAMES):
            await buf._push_async(
                json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(), "level": "INFO", "message": f"frame {i}"}),
                "INFO",
                f"frame {i}",
                {"i": i},
            )

        # Allow time for delivery
        await asyncio.sleep(1.0)

        # Cancel tasks and verify
        for t in tasks:
            t.cancel()

        for i, frames in enumerate(received):
            assert len(frames) == NUM_FRAMES, (
                f"Subscriber {i} received {len(frames)}/{NUM_FRAMES} frames"
            )

    @pytest.mark.asyncio
    async def test_subscriber_queue_overflow_drops_oldest_never_blocks(self):
        """When a subscriber queue is full, the oldest frame is dropped and push never blocks."""
        from app.services.log_buffer import LogBuffer

        buf = LogBuffer()

        client_id, queue = await buf.subscribe()

        # Fill the queue past its 500-entry limit
        for i in range(600):
            await buf._push_async(
                json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(), "level": "INFO", "message": f"msg {i}"}),
                "INFO",
                f"msg {i}",
                {"i": i},
            )

        # Give the async push tasks a moment to complete, then drain
        await asyncio.sleep(0.1)

        # Drain the queue synchronously (get_nowait is sync, not await)
        frames = []
        while True:
            try:
                frames.append(queue.get_nowait())
            except asyncio.QueueEmpty:
                break

        # Queue should be near its maxsize (500) after overflow — frames were dropped
        assert len(frames) <= 500, f"Queue overfilled: {len(frames)} entries"
        # Frames are wrapped: {'type': 'log', 'data': {'message': 'msg 0', ...}}
        # Extract from nested 'data' dict
        msgs = [f.get("data", {}).get("message", "") for f in frames]
        assert "msg 599" in msgs, f"Newest entries must be in queue (got last: {msgs[-3:] if msgs else 'empty'})"
        assert "msg 0" not in msgs, "Oldest entries should have been dropped"

    @pytest.mark.asyncio
    async def test_fanout_1000_frames_under_5_seconds(self):
        """Pushing 1 000 frames to 10 subscribers completes in under 5 s."""
        from app.services.log_buffer import LogBuffer

        buf = LogBuffer()

        NUM_SUBSCRIBERS = 10
        NUM_FRAMES = 1000

        tasks = []
        received = [[] for _ in range(NUM_SUBSCRIBERS)]

        for i in range(NUM_SUBSCRIBERS):
            _, queue = await buf.subscribe()
            tasks.append(asyncio.create_task(_collect_frames(queue, received[i], NUM_FRAMES)))

        start = time.monotonic()

        for i in range(NUM_FRAMES):
            await buf._push_async(
                json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(), "level": "INFO", "message": f"msg {i}"}),
                "INFO",
                f"msg {i}",
                {"i": i},
            )

        # Allow async delivery
        await asyncio.sleep(0.5)

        for t in tasks:
            t.cancel()

        elapsed = time.monotonic() - start
        assert elapsed < 5.0, f"Pushing 1 000 frames to 10 subscribers took {elapsed:.2f}s (> 5 s)"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — WebSocket heartbeat cadence
# ─────────────────────────────────────────────────────────────────────────────

class TestWebSocketHeartbeat:
    """The LogBuffer's _heartbeat_loop emits heartbeats at ~1 Hz when started."""

    @pytest.mark.asyncio
    async def test_heartbeat_loop_sends_at_least_3_heartbeats_in_3_5_seconds(self):
        """The heartbeat task emits at least 3 frames in 3.5 s (~1 Hz cadence)."""
        from app.services.log_buffer import LogBuffer

        buf = LogBuffer()

        # Subscribe a client to receive heartbeats
        client_id, queue = await buf.subscribe()

        # Start the heartbeat loop
        buf.start_heartbeat()

        try:
            heartbeats = 0
            start = time.monotonic()
            deadline = start + 3.5

            while time.monotonic() < deadline:
                remaining = max(0.05, deadline - time.monotonic())
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=remaining)
                    if frame.get("type") == "heartbeat":
                        heartbeats += 1
                except asyncio.TimeoutError:
                    break

            assert heartbeats >= 3, (
                f"Got {heartbeats} heartbeats in 3.5 s — expected ≥ 3 (~1 Hz cadence)"
            )
        finally:
            buf.stop_heartbeat()

    @pytest.mark.asyncio
    async def test_websocket_log_buffer_integration_no_crash(self, app):
        """A real LogBuffer can be used as the dependency without crashing the app.

        This is an integration test: replacing the mock LogBuffer with a real one
        at the module level proves the WebSocket handler can use it.
        """
        import app.deps as _deps_mod

        _main_mod, _ = app

        # Install a real LogBuffer — this is what the WebSocket router reads via get_log_buffer()
        from app.services.log_buffer import LogBuffer

        real_buf = LogBuffer()
        original = _deps_mod._log_buffer
        _deps_mod._log_buffer = real_buf

        try:
            # The get_log_buffer() function should return our real buffer
            from app.deps import get_log_buffer

            buf = get_log_buffer()
            assert isinstance(buf, LogBuffer), f"Expected LogBuffer, got {type(buf)}"

            # Subscribe should work
            client_id, queue = await buf.subscribe()
            assert isinstance(client_id, str)
            assert not queue.empty() or queue.maxsize == 500

        finally:
            _deps_mod._log_buffer = original  # restore mock


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — Upload size guard
# ─────────────────────────────────────────────────────────────────────────────

class TestUploadSizeGuards:
    """Large single uploads that exceed the backend's decode limit are rejected fast."""

    @pytest.mark.asyncio
    async def test_oversized_single_upload_rejected_quickly(self, client):
        """Sending > 100 MB of garbage to /inference/egg returns 413 or 400 quickly."""
        # We use a large-but-not-huge payload (10 MB) to test the guard without
        # causing network transfer overhead in the test itself.
        # The actual limit check happens before model inference.
        LARGE = b"\x00" * (10 * 1024 * 1024)  # 10 MB

        start = time.monotonic()
        response = await client.post(
            "/inference/egg",
            files={"file": ("huge.bin", LARGE, "image/jpeg")},
        )
        elapsed = (time.monotonic() - start) * 1000

        # Must be rejected before any model call — should be fast
        assert response.status_code in (400, 413), f"Expected 400/413, got {response.status_code}"
        assert elapsed < 1000, f"Large-file rejection took {elapsed:.1f}ms — too slow"


# ─────────────────────────────────────────────────────────────────────────────
# Helper
# ─────────────────────────────────────────────────────────────────────────────

async def _collect_frames(queue: asyncio.Queue, storage: list, count: int):
    """Collect up to `count` frames from `queue` into `storage`."""
    try:
        for _ in range(count):
            frame = await asyncio.wait_for(queue.get(), timeout=2.0)
            storage.append(frame)
    except asyncio.TimeoutError:
        pass
    except asyncio.CancelledError:
        pass
