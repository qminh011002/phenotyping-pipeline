"""Tests for GET /config and PUT /config endpoints."""

from __future__ import annotations

import yaml

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def temp_pipeline_config(tmp_path):
    """A real PipelineConfigManager backed by a temporary config.yaml.

    This lets PUT /config actually write to disk without touching the real
    phenotyping_pipeline directory.
    """
    from app.config import PipelineConfigManager

    config_dir = tmp_path / "pipeline"
    config_dir.mkdir()
    config_path = config_dir / "config.yaml"

    initial = {
        "egg": {
            "model": "models/egg_best.pt",
            "device": "cpu",
            "tile_size": 512,
            "overlap": 0.5,
            "confidence_threshold": 0.4,
            "min_box_area": 100,
            "dedup_mode": "center_zone",
            "edge_margin": 3,
            "nms_iou_threshold": 0.4,
            "batch_size": 24,
        }
    }
    config_path.write_text(yaml.safe_dump(initial))

    return PipelineConfigManager(pipeline_root=config_dir)


@pytest_asyncio.fixture
async def config_client(temp_pipeline_config, app):
    """HTTP client that uses a real PipelineConfigManager pointing to a temp file.

    We inject the real manager into the config router's closure so that
    PUT /config can persist updates without affecting the real config.yaml.
    """
    # The config router imported `get_pipeline_config` at module load time.
    # The only way to redirect it to our temp-backed manager is to replace
    # the binding in the router module itself.
    from app.routers import config as config_router

    # Save the real dep getter and replace it with our manager
    _original = config_router.get_pipeline_config
    config_router.get_pipeline_config = lambda: temp_pipeline_config

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    # Restore so later tests are not affected
    config_router.get_pipeline_config = _original


class TestGetConfig:
    @pytest.mark.asyncio
    async def test_get_config_returns_200(self, config_client):
        """GET /config returns 200 with full egg config."""
        response = await config_client.get("/config")
        assert response.status_code == 200
        data = response.json()
        assert data["tile_size"] == 512
        assert data["dedup_mode"] == "center_zone"
        assert data["device"] == "cpu"

    @pytest.mark.asyncio
    async def test_get_config_returns_all_fields(self, config_client):
        """GET /config returns all required EggConfig fields."""
        response = await config_client.get("/config")
        data = response.json()
        required = [
            "model", "device", "tile_size", "overlap", "confidence_threshold",
            "min_box_area", "dedup_mode", "edge_margin", "nms_iou_threshold", "batch_size",
        ]
        for field in required:
            assert field in data, f"Missing field: {field}"

    @pytest.mark.asyncio
    async def test_get_config_tile_size_is_int(self, config_client):
        """tile_size is returned as an integer."""
        response = await config_client.get("/config")
        data = response.json()
        assert isinstance(data["tile_size"], int)

    @pytest.mark.asyncio
    async def test_get_config_dedup_mode_literal(self, config_client):
        """dedup_mode is one of the expected literals."""
        response = await config_client.get("/config")
        data = response.json()
        assert data["dedup_mode"] in ("center_zone", "edge_nms")


class TestPutConfig:
    @pytest.mark.asyncio
    async def test_update_confidence_threshold(self, config_client):
        """PUT /config with confidence_threshold update returns updated config."""
        response = await config_client.put(
            "/config",
            json={"confidence_threshold": 0.6},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["confidence_threshold"] == 0.6

    @pytest.mark.asyncio
    async def test_update_multiple_fields(self, config_client):
        """PUT /config can update multiple fields at once."""
        response = await config_client.put(
            "/config",
            json={
                "tile_size": 768,
                "dedup_mode": "edge_nms",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["tile_size"] == 768
        assert data["dedup_mode"] == "edge_nms"
        # Unchanged fields stay the same
        assert data["device"] == "cpu"

    @pytest.mark.asyncio
    async def test_update_invalid_tile_size_returns_422(self, config_client):
        """PUT /config with tile_size not a multiple of 32 returns 422."""
        response = await config_client.put(
            "/config",
            json={"tile_size": 300},
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_invalid_device_returns_422(self, config_client):
        """PUT /config with an invalid device string returns 422."""
        response = await config_client.put(
            "/config",
            json={"device": "metal"},
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_confidence_out_of_range_returns_422(self, config_client):
        """PUT /config with confidence_threshold > 1.0 returns 422."""
        response = await config_client.put(
            "/config",
            json={"confidence_threshold": 1.5},
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_empty_body_returns_unchanged(self, config_client):
        """PUT /config with empty body returns current config unchanged."""
        response = await config_client.put("/config", json={})
        assert response.status_code == 200
        data = response.json()
        assert data["tile_size"] == 512
