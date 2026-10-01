from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.larvae_persistence import RestoredDetection, update_polygons


class _ScalarResult:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return self._values


class _FakeDb:
    def __init__(self, valid_detection_ids):
        self.added = []
        self.execute = AsyncMock(return_value=_ScalarResult(valid_detection_ids))
        self.flush = AsyncMock()

    def add(self, row):
        self.added.append(row)


@pytest.mark.asyncio
async def test_update_polygons_creates_user_detection():
    db = _FakeDb([])

    touched, deleted = await update_polygons(
        uuid.uuid4(),
        [(None, [(0, 0), (4, 0), (0, 3)])],
        uuid.uuid4(),
        db,
    )

    assert touched == 1
    assert deleted == 0
    assert len(db.added) == 1
    row = db.added[0]
    assert row.origin == "user"
    assert row.confidence == 1.0
    assert row.area_px == 6
    assert row.bbox == {"x1": 0, "y1": 0, "x2": 4, "y2": 3}
    db.flush.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_polygons_deletes_existing_detection_for_image():
    det_id = uuid.uuid4()
    db = _FakeDb([det_id])
    db.execute = AsyncMock(
        side_effect=[
            _ScalarResult([det_id]),
            MagicMock(),
        ]
    )

    touched, deleted = await update_polygons(
        uuid.uuid4(),
        [],
        uuid.uuid4(),
        db,
        deleted_ids=[det_id],
    )

    assert touched == 0
    assert deleted == 1
    assert db.added == []
    assert db.execute.await_count == 2
    db.flush.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_polygons_restores_a_deleted_model_detection():
    """Undo of a saved delete re-creates the row as the model detection it was."""
    db = _FakeDb([])
    model_outline = [(0, 0), (4, 0), (0, 3)]
    edited_outline = [(0, 0), (6, 0), (0, 3)]

    touched, deleted = await update_polygons(
        uuid.uuid4(),
        [(None, edited_outline), (None, model_outline), (None, model_outline)],
        uuid.uuid4(),
        db,
        restored={
            0: RestoredDetection(confidence=0.83, baseline=model_outline),
            1: RestoredDetection(confidence=0.5, baseline=model_outline),
        },
    )

    assert (touched, deleted) == (3, 0)
    edited, untouched, drawn = db.added
    # Restored with operator edits: model outline kept, edit on top of it.
    assert edited.origin == "model"
    assert edited.confidence == 0.83
    assert edited.polygon == [[0, 0], [4, 0], [0, 3]]
    assert edited.edited_polygon == [[0, 0], [6, 0], [0, 3]]
    assert edited.area_px == 9
    # Restored unedited: no redundant edited_polygon.
    assert untouched.origin == "model"
    assert untouched.edited_polygon is None
    # No restore entry → still a hand-drawn detection.
    assert drawn.origin == "user"
    assert drawn.confidence == 1.0
