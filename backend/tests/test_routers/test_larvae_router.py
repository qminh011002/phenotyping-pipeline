"""Smoke / contract tests for the larvae router (BE-034).

These don't exercise the real DB — the conftest mocks the async session. They
confirm:
- The seven endpoints are routed and respond per the contract for happy and
  error paths driven by the mock session.
- Pydantic request validation accepts the documented request bodies.
- Cross-user 404s land for the read endpoints (the mocked session returns
  scalar_one_or_none() = None by default).
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


def _scalar_one_or_none(value):
    """Return a SQLAlchemy-result-like object yielding ``value`` from
    ``.scalar_one_or_none()``."""
    res = MagicMock()
    res.scalar_one_or_none = MagicMock(return_value=value)
    return res


@pytest.mark.asyncio
async def test_get_larvae_batch_404_when_missing(client, app):
    """GET /analyses/{id}/larvae returns 404 when no batch matches the user."""
    import app.database as db_mod

    sess = MagicMock()
    sess.execute = AsyncMock(return_value=_scalar_one_or_none(None))
    sess.commit = AsyncMock()

    async def _override_session():
        yield sess

    app.dependency_overrides[db_mod.get_session] = _override_session

    bid = uuid.uuid4()
    resp = await client.get(f"/analyses/{bid}/larvae")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_calibration_update_requires_corners_or_factors(client):
    """PUT /calibration/{image_id} 422s when neither branch is supplied."""
    iid = uuid.uuid4()
    resp = await client.put(f"/calibration/{iid}", json={})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_polygons_update_validates_polygon_min_length(client):
    """PUT /analyses/.../polygons rejects polygons shorter than 3 vertices."""
    bid = uuid.uuid4()
    iid = uuid.uuid4()
    det_id = uuid.uuid4()
    body = {
        "polygons": [
            {"detection_id": str(det_id), "polygon": [[0, 0], [1, 1]]},
        ]
    }
    resp = await client.put(
        f"/analyses/{bid}/images/{iid}/polygons", json=body
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_measure_larvae_404_when_image_missing(client, app):
    """POST /measure/larvae returns 404 when the image isn't owned by user."""
    import app.database as db_mod

    sess = MagicMock()
    sess.execute = AsyncMock(return_value=_scalar_one_or_none(None))
    sess.commit = AsyncMock()

    async def _override_session():
        yield sess

    app.dependency_overrides[db_mod.get_session] = _override_session

    iid = uuid.uuid4()
    resp = await client.post(f"/measure/larvae?image_id={iid}", json={})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_calibration_detect_404_when_image_missing(client, app):
    import app.database as db_mod

    sess = MagicMock()
    sess.execute = AsyncMock(return_value=_scalar_one_or_none(None))

    async def _override_session():
        yield sess

    app.dependency_overrides[db_mod.get_session] = _override_session

    iid = uuid.uuid4()
    resp = await client.post(f"/calibration/detect?image_id={iid}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_csv_export_404_when_batch_missing(client, app):
    import app.database as db_mod

    sess = MagicMock()
    sess.execute = AsyncMock(return_value=_scalar_one_or_none(None))

    async def _override_session():
        yield sess

    app.dependency_overrides[db_mod.get_session] = _override_session

    bid = uuid.uuid4()
    resp = await client.get(f"/analyses/{bid}/larvae/csv")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_inference_larvae_503_when_model_missing(client, app, tiny_png_bytes):
    """POST /inference/larvae returns 503 when the larvae model isn't loaded."""
    import app.deps as deps_mod

    deps_mod._model_registry.status = MagicMock(return_value="missing")

    resp = await client.post(
        "/inference/larvae",
        files={"file": ("a.png", tiny_png_bytes, "image/png")},
    )
    assert resp.status_code == 503

    # Restore for any later tests.
    deps_mod._model_registry.status = MagicMock(return_value="loaded")


# ── count_only → refine flag ──────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("query", "expected_refine"), [("?count_only=true", False), ("", None)]
)
async def test_larvae_inference_count_only_skips_sam(client, app, query, expected_refine):
    import base64

    import app.deps as deps_mod
    from app.schemas.larvae import LarvaeDetectionResult

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
    )
    result = LarvaeDetectionResult(
        filename="a",
        count=0,
        avg_confidence=0.0,
        elapsed_seconds=0.1,
        overlay_url="/inference/results/b/a/overlay.png",
    )
    deps_mod._model_registry.status = MagicMock(return_value="loaded")
    deps_mod._larvae_inference_service.process_single = AsyncMock(return_value=result)

    resp = await client.post(
        f"/inference/larvae{query}", files={"file": ("a.png", png, "image/png")}
    )

    assert resp.status_code == 200
    assert resp.json()["sam_refined"] is False
    kwargs = deps_mod._larvae_inference_service.process_single.await_args.kwargs
    assert kwargs["refine"] is expected_refine
