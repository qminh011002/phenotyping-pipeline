from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest

from app.services.larvae_persistence import (
    _compute_weight_stats,
    set_image_total_weight,
)


class _ScalarResult:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return self._values


class _FakeMeasurement:
    def __init__(self, area_mm2: float | None):
        self.area_mm2 = area_mm2
        self.weight_mg: float | None = None


class _FakeDb:
    def __init__(self, measurements):
        self._measurements = measurements
        self.execute = AsyncMock(
            side_effect=[
                None,  # UPDATE total_weight_mg
                _ScalarResult(list(measurements)),  # SELECT measurements
            ]
        )
        self.flush = AsyncMock()


@pytest.mark.asyncio
async def test_set_total_weight_distributes_proportional_to_area():
    ms = [_FakeMeasurement(10.0), _FakeMeasurement(30.0), _FakeMeasurement(10.0)]
    db = _FakeDb(ms)

    updated = await set_image_total_weight(uuid.uuid4(), 100.0, db)

    assert updated == 3
    assert ms[0].weight_mg == pytest.approx(20.0)
    assert ms[1].weight_mg == pytest.approx(60.0)
    assert ms[2].weight_mg == pytest.approx(20.0)


@pytest.mark.asyncio
async def test_set_total_weight_null_clears_weights():
    ms = [_FakeMeasurement(10.0), _FakeMeasurement(30.0)]
    for m in ms:
        m.weight_mg = 5.0
    db = _FakeDb(ms)

    updated = await set_image_total_weight(uuid.uuid4(), None, db)

    assert updated == 2
    assert all(m.weight_mg is None for m in ms)


@pytest.mark.asyncio
async def test_set_total_weight_zero_total_area_assigns_zero():
    ms = [_FakeMeasurement(0.0), _FakeMeasurement(None)]
    db = _FakeDb(ms)

    updated = await set_image_total_weight(uuid.uuid4(), 50.0, db)

    assert updated == 2
    assert ms[0].weight_mg == 0.0
    assert ms[1].weight_mg == 0.0


@pytest.mark.asyncio
async def test_set_total_weight_no_measurements_is_noop():
    db = _FakeDb([])
    updated = await set_image_total_weight(uuid.uuid4(), 100.0, db)
    assert updated == 0


def test_compute_weight_stats_empty():
    stats = _compute_weight_stats([])
    assert stats.count == 0
    assert stats.mean is None


def test_compute_weight_stats_basic():
    pairs = [(10.0, 5.0), (20.0, 10.0), (30.0, 15.0), (40.0, 20.0)]
    stats = _compute_weight_stats(pairs)
    assert stats.count == 4
    assert stats.total_biomass_mg == 100.0
    assert stats.mean == pytest.approx(25.0)
    assert stats.median == pytest.approx(25.0)
    assert stats.min == 10.0
    assert stats.max == 40.0
    # weight/area ratio is constant 2.0
    assert stats.avg_weight_area_ratio == pytest.approx(2.0)
    # std (population) of [10,20,30,40] is sqrt(125) ≈ 11.180
    assert stats.std == pytest.approx(11.18033988749895)
    assert stats.cv == pytest.approx(stats.std / 25.0)
    assert stats.p25 == pytest.approx(17.5)
    assert stats.p75 == pytest.approx(32.5)
    assert stats.iqr == pytest.approx(15.0)


def test_compute_weight_stats_skips_zero_area_in_ratio():
    pairs = [(10.0, 0.0), (20.0, 10.0)]
    stats = _compute_weight_stats(pairs)
    assert stats.count == 2
    assert stats.avg_weight_area_ratio == pytest.approx(2.0)
