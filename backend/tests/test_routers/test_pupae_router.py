"""Contract tests for pupae-specific router/read behavior."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.analysis import AnalysisBatch, AnalysisImage
from app.models.larvae import LarvaeDetection
from app.services.larvae_persistence import load_batch_for_user


class _ScalarOneResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _ScalarsResult:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return self._values


@pytest.mark.asyncio
async def test_inference_pupae_503_when_model_missing(client, app, tiny_png_bytes):
    import app.deps as deps_mod

    deps_mod._model_registry.status = MagicMock(return_value="missing")

    resp = await client.post(
        "/inference/pupae",
        files={"file": ("a.png", tiny_png_bytes, "image/png")},
    )
    assert resp.status_code == 503

    deps_mod._model_registry.status = MagicMock(return_value="loaded")


@pytest.mark.asyncio
async def test_load_batch_for_user_pupae_uses_pupae_labels():
    user_id = uuid.uuid4()
    batch_id = uuid.uuid4()
    image_id = uuid.uuid4()
    detection_id = uuid.uuid4()

    image = AnalysisImage(
        id=image_id,
        batch_id=batch_id,
        original_filename="pupa.png",
        status="completed",
        count=1,
        avg_confidence=0.9,
        elapsed_secs=0.2,
        overlay_path=f"{batch_id}/pupa_overlay.png",
        created_at=datetime.now(timezone.utc),
    )
    batch = AnalysisBatch(
        id=batch_id,
        user_id=user_id,
        name="Pupae batch",
        status="draft",
        organism_type="pupae",
        total_image_count=1,
        config_snapshot={"detection_model": "pupae.pt", "sam_model": "sam.pt"},
    )
    batch.images = [image]
    detection = LarvaeDetection(
        id=detection_id,
        image_id=image_id,
        polygon=[[0, 0], [10, 0], [10, 5], [0, 5]],
        bbox={"x1": 0, "y1": 0, "x2": 10, "y2": 5},
        confidence=0.9,
        area_px=50,
        origin="model",
    )

    db = MagicMock()
    db.execute = AsyncMock(
        side_effect=[
            _ScalarOneResult(batch),
            _ScalarsResult([detection]),
            _ScalarsResult([]),
            _ScalarsResult([]),
        ]
    )

    detail = await load_batch_for_user(batch_id, user_id, db)

    assert detail is not None
    assert detail.organism == "pupae"
    assert detail.images[0].detections[0].label == "pupae"
