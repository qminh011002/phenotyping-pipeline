"""Tests for GET /health and GET /ping endpoints."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient


class TestHealthEndpoint:
    @pytest.mark.asyncio
    async def test_health_returns_200(self, client):
        """GET /health returns 200 with the health response shape."""
        response = await client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert "model_loaded" in data
        assert "device" in data
        assert "cuda_available" in data
        assert "uptime_seconds" in data
        assert "version" in data

    @pytest.mark.asyncio
    async def test_health_status_is_ok_or_degraded(self, client):
        """status is either 'ok' or 'degraded'."""
        response = await client.get("/health")
        data = response.json()
        assert data["status"] in ("ok", "degraded")

    @pytest.mark.asyncio
    async def test_health_model_loaded_is_bool(self, client):
        """model_loaded is a boolean."""
        response = await client.get("/health")
        data = response.json()
        assert isinstance(data["model_loaded"], bool)

    @pytest.mark.asyncio
    async def test_health_uptime_non_negative(self, client):
        """uptime_seconds is a non-negative number."""
        response = await client.get("/health")
        data = response.json()
        assert isinstance(data["uptime_seconds"], (int, float))
        assert data["uptime_seconds"] >= 0

    @pytest.mark.asyncio
    async def test_health_version_is_string(self, client):
        """version is a non-empty string."""
        response = await client.get("/health")
        data = response.json()
        assert isinstance(data["version"], str)
        assert len(data["version"]) > 0


class TestPingEndpoint:
    @pytest.mark.asyncio
    async def test_ping_returns_200(self, client):
        """GET /ping returns 200 with pong: true."""
        response = await client.get("/ping")
        assert response.status_code == 200
        data = response.json()
        assert data == {"pong": True}

    @pytest.mark.asyncio
    async def test_ping_no_auth_required(self, client):
        """ping works without any headers or authentication."""
        response = await client.get("/ping")
        assert response.status_code == 200
