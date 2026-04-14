"""Tests for POST /inference/egg and POST /inference/egg/batch endpoints."""

from __future__ import annotations

import base64
from unittest.mock import MagicMock, AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


# Minimal 32x32 red PNG (base64-encoded) — avoids needing real files on disk
_TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8Dw"
    "HwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
)


@pytest.fixture
def tiny_png_bytes():
    return base64.b64decode(_TINY_PNG_B64)


def _configure_mock_inference_service(mock_svc, batch_size=2):
    """Configure mock_svc (set on app.deps._inference_service by conftest) to return
    canned results. Call this in tests that need the inference endpoint."""
    from app.schemas.detection import BBox, DetectionResult, BatchDetectionResult

    result = DetectionResult(
        filename="test.jpg",
        organism="egg",
        count=3,
        avg_confidence=0.91,
        elapsed_seconds=1.5,
        annotations=[
            BBox(label="neonate_egg", bbox=(100, 100, 200, 200), confidence=0.91),
        ],
        overlay_url="/inference/results/batch-001/test.jpg/overlay.png",
    )
    mock_svc.process_single = AsyncMock(return_value=result)

    batch_results = [
        DetectionResult(
            filename=f"img{i}.jpg",
            organism="egg",
            count=3,
            avg_confidence=0.91,
            elapsed_seconds=1.5,
            annotations=[],
            overlay_url=f"/inference/results/batch-001/img{i}.jpg/overlay.png",
        )
        for i in range(1, batch_size + 1)
    ]
    mock_svc.process_batch = AsyncMock(
        return_value=BatchDetectionResult(
            results=batch_results,
            total_count=sum(r.count for r in batch_results),
            total_elapsed_seconds=sum(r.elapsed_seconds for r in batch_results),
        )
    )


@pytest_asyncio.fixture
async def inference_client(app):
    """HTTP client with a configured mock inference service."""
    import app.deps as _deps_mod

    # Configure the mock inference service injected into the app
    _configure_mock_inference_service(_deps_mod._inference_service, batch_size=2)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


class TestSingleInference:
    @pytest.mark.asyncio
    async def test_upload_valid_image_returns_200(self, inference_client, tiny_png_bytes):
        """POST /inference/egg with a valid PNG returns 200 with DetectionResult."""
        response = await inference_client.post(
            "/inference/egg",
            files={"file": ("test.jpg", tiny_png_bytes, "image/jpeg")},
        )
        assert response.status_code == 200
        data = response.json()
        assert "filename" in data
        assert "organism" in data
        assert "count" in data
        assert "avg_confidence" in data
        assert "elapsed_seconds" in data
        assert "overlay_url" in data
        assert data["organism"] == "egg"

    @pytest.mark.asyncio
    async def test_upload_with_batch_id_query_param(self, inference_client, tiny_png_bytes):
        """batch_id query param is accepted without error."""
        response = await inference_client.post(
            "/inference/egg?batch_id=abc-123",
            files={"file": ("plate.png", tiny_png_bytes, "image/png")},
        )
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_upload_unsupported_extension_returns_400(self, inference_client):
        """Uploading a .gif file returns 400 with a clear error message."""
        response = await inference_client.post(
            "/inference/egg",
            files={"file": ("test.gif", b"GIFFakeData", "image/gif")},
        )
        assert response.status_code == 400
        assert "Unsupported file type" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_upload_empty_file_returns_400(self, inference_client):
        """Uploading an empty file returns 400."""
        response = await inference_client.post(
            "/inference/egg",
            files={"file": ("empty.jpg", b"", "image/jpeg")},
        )
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_upload_no_file_returns_422(self, inference_client):
        """Omitting the file field returns 422."""
        response = await inference_client.post("/inference/egg")
        assert response.status_code == 422


class TestBatchInference:
    @pytest.mark.asyncio
    async def test_batch_upload_returns_200(self, inference_client, tiny_png_bytes):
        """POST /inference/egg/batch with valid images returns 200."""
        response = await inference_client.post(
            "/inference/egg/batch",
            files=[
                ("files", ("img1.jpg", tiny_png_bytes, "image/jpeg")),
                ("files", ("img2.jpg", tiny_png_bytes, "image/jpeg")),
            ],
        )
        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert "total_count" in data
        assert "total_elapsed_seconds" in data
        assert isinstance(data["results"], list)

    @pytest.mark.asyncio
    async def test_batch_result_has_correct_structure(self, inference_client, tiny_png_bytes):
        """Batch result contains results array with DetectionResult shapes."""
        response = await inference_client.post(
            "/inference/egg/batch",
            files=[
                ("files", ("img1.jpg", tiny_png_bytes, "image/jpeg")),
            ],
        )
        assert response.status_code == 200
        data = response.json()
        # The mock is configured with batch_size=2; 1 file is sent → returns 2 mock results
        assert isinstance(data["results"], list)
        assert len(data["results"]) == 2
        result = data["results"][0]
        assert "filename" in result
        assert "count" in result
        assert "avg_confidence" in result

    @pytest.mark.asyncio
    async def test_batch_no_files_returns_422(self, inference_client):
        """Batch with no files returns 422 — FastAPI requires at least one file in multipart."""
        response = await inference_client.post("/inference/egg/batch")
        # FastAPI's multipart parser raises a validation error when the file list is empty
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_batch_too_many_files_returns_413(self, inference_client, tiny_png_bytes):
        """Batch exceeding MAX_BATCH_SIZE (50) returns 413."""
        files = [
            ("files", (f"img{i}.jpg", tiny_png_bytes, "image/jpeg"))
            for i in range(51)
        ]
        response = await inference_client.post("/inference/egg/batch", files=files)
        assert response.status_code == 413
