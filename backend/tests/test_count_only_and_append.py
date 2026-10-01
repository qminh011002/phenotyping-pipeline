"""MWIS dedup parity, unique stems, and append bookkeeping."""

from __future__ import annotations

import random
import uuid
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest

from app.models.analysis import AnalysisBatch
from app.routers.inference_utils import unique_stem_in_batch
from app.schemas.config import LarvaeConfigUpdateRequest
from app.services.analysis_service import (
    _ACTIVE_SINCE_KEY,
    _RESUME_STATUS_KEY,
    AnalysisService,
)
from app.services.dashboard_service import bucket_for_days
from app.services.inference.polygon_segmentation import PolygonSegmentationService

# ── MWIS dedup ────────────────────────────────────────────────────────────────


def _reference_greedy(scores: list[float], neighbors: dict[int, set[int]]) -> list[int]:
    """The pre-optimisation selection loop, kept verbatim as the oracle."""
    remaining: set[int] = set(range(len(scores)))
    selected: list[int] = []
    while remaining:
        remaining_list = list(remaining)
        conflict_counts = np.array(
            [len(neighbors[i] & remaining) for i in remaining_list], dtype=np.float64
        )
        s = np.array([scores[i] for i in remaining_list], dtype=np.float64)
        qualities = s / (1.0 + conflict_counts)
        chosen = remaining_list[int(np.argmax(qualities))]
        selected.append(chosen)
        remaining -= {chosen} | (neighbors[chosen] & remaining)
    return selected


def _square(x: int, y: int, size: int) -> np.ndarray:
    return np.array(
        [[x, y], [x + size, y], [x + size, y + size], [x, y + size]], dtype=np.int32
    )


@pytest.mark.parametrize("seed", range(8))
def test_mwis_dedup_matches_reference_selection(seed):
    """The incremental greedy must pick the same detections, in the same order."""
    rng = random.Random(seed)
    candidates = []
    for _ in range(rng.randint(2, 70)):
        # Dense placement on a small canvas → plenty of overlapping squares.
        x, y, size = rng.randint(0, 220), rng.randint(0, 220), rng.randint(30, 70)
        poly = _square(x, y, size)
        # Coarse scores so ties actually occur and tie-breaking is exercised.
        candidates.append(
            {
                "polygon": poly,
                "bbox": (x, y, x + size, y + size),
                "area": size * size,
                "confidence": 0.9,
                "score": float(rng.choice([1, 2, 3, 4])),
            }
        )

    svc = PolygonSegmentationService.__new__(PolygonSegmentationService)
    threshold = 0.3
    result = svc._mwis_dedup(candidates, threshold)

    n = len(candidates)
    neighbors: dict[int, set[int]] = {i: set() for i in range(n)}
    for a in range(n):
        for b in range(a + 1, n):
            if (
                svc._bbox_overlap_ratio(candidates[a]["bbox"], candidates[b]["bbox"])
                < 0.1
            ):
                continue
            iou = svc._polygon_iou_in_roi(
                candidates[a]["polygon"], candidates[b]["polygon"]
            )
            if iou > threshold:
                neighbors[a].add(b)
                neighbors[b].add(a)
    expected = _reference_greedy([c["score"] for c in candidates], neighbors)

    assert [id(c) for c in result] == [id(candidates[i]) for i in expected]
    # No two survivors conflict.
    chosen = set(expected)
    assert all(not (neighbors[i] & chosen) for i in chosen)


# ── Unique stems ──────────────────────────────────────────────────────────────


class _Scalars:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return iter(self._values)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("existing", "expected"),
    [
        ([], "tray"),
        (["tray_old"], "tray"),
        (["tray"], "tray_2"),
        (["tray", "tray_2", "tray_3"], "tray_4"),
    ],
)
async def test_unique_stem_in_batch(existing, expected):
    db = MagicMock()
    db.execute = AsyncMock(return_value=_Scalars(existing))
    assert await unique_stem_in_batch(uuid.uuid4(), "tray", db) == expected


@pytest.mark.asyncio
async def test_unique_stem_without_batch_skips_lookup():
    db = MagicMock()
    db.execute = AsyncMock()
    assert await unique_stem_in_batch(None, "tray", db) == "tray"
    db.execute.assert_not_awaited()


# ── Append bookkeeping ────────────────────────────────────────────────────────


def test_pop_append_markers_returns_resume_status_and_cleans_snapshot():
    batch = AnalysisBatch(
        config_snapshot={
            "tile_size": 512,
            _RESUME_STATUS_KEY: "completed",
            _ACTIVE_SINCE_KEY: "2026-10-01T00:00:00+00:00",
        }
    )
    assert AnalysisService._pop_append_markers(batch) == "completed"
    assert batch.config_snapshot == {"tile_size": 512}


def test_pop_append_markers_leaves_plain_batch_untouched():
    snapshot = {"tile_size": 512}
    batch = AnalysisBatch(config_snapshot=snapshot)
    assert AnalysisService._pop_append_markers(batch) is None
    assert batch.config_snapshot is snapshot


def test_public_snapshot_hides_append_markers():
    public = AnalysisService._public_snapshot(
        {"count_only": True, _RESUME_STATUS_KEY: "draft", _ACTIVE_SINCE_KEY: "x"}
    )
    assert public == {"count_only": True}


@pytest.mark.asyncio
async def test_fail_batch_during_append_restores_previous_status():
    """Cancelling an append must not mark a saved batch as failed."""
    batch = AnalysisBatch(
        id=uuid.uuid4(),
        status="processing",
        total_image_count=9,
        processed_image_count=6,
        config_snapshot={_RESUME_STATUS_KEY: "completed", _ACTIVE_SINCE_KEY: "x"},
    )

    def _result(**kw):
        res = MagicMock()
        for name, value in kw.items():
            getattr(res, name).return_value = value
        return res

    aggregates = MagicMock(total_count=120, conf_weighted=96.0, total_elapsed=30.0)
    db = MagicMock()
    db.execute = AsyncMock(
        side_effect=[
            _result(scalar_one_or_none=batch),  # fail_batch lookup
            _result(scalar=7),  # images actually in the batch
            _result(one=aggregates),  # recomputed aggregates
        ]
    )
    db.flush = AsyncMock()
    db.refresh = AsyncMock()

    out = await AnalysisService().fail_batch(
        batch.id, "User cancelled", db, uuid.uuid4()
    )

    assert out is batch
    assert batch.status == "completed"
    assert batch.failed_at is None and batch.failure_reason is None
    assert (batch.total_image_count, batch.processed_image_count) == (7, 7)
    assert batch.total_count == 120
    assert batch.avg_confidence == pytest.approx(0.8)
    assert _RESUME_STATUS_KEY not in batch.config_snapshot


# ── Small pure helpers ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("days", "bucket"),
    [
        (7, "day"),
        (31, "day"),
        (32, "week"),
        (120, "week"),
        (121, "month"),
        (0, "month"),
    ],
)
def test_bucket_for_days(days, bucket):
    assert bucket_for_days(days) == bucket


def test_polygon_config_update_rejects_zero_stride_overlap():
    with pytest.raises(ValueError):
        LarvaeConfigUpdateRequest(overlap=1.0)
    with pytest.raises(ValueError):
        LarvaeConfigUpdateRequest(tile_size=500)
    assert LarvaeConfigUpdateRequest(overlap=0.9, tile_size=640).tile_size == 640
