"""Thumbnails, stale-overlay re-rendering, and SAM refinement of stored polygons."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import cv2
import numpy as np
import pytest

from app.models.analysis import AnalysisImage
from app.models.larvae import LarvaeDetection
from app.schemas.calibration import CalibrationCorners
from app.schemas.config import LarvaeConfig
from app.services import polygon_refine
from app.services.image_artifacts import (
    ensure_thumbnail,
    is_overlay_stale,
    mark_overlay_stale,
    render_polygon_overlay,
    snap_thumbnail_edge,
    thumbnail_path,
)
from app.services.inference.measurement import build_warp_matrix


def _write_image_set(tmp_path, *, warped: bool = False):
    """A raw upload + overlay (+ optional warped frame) under one stem."""
    raw = np.full((300, 400, 3), 40, np.uint8)
    overlay_path = tmp_path / "tray_overlay.png"
    cv2.imwrite(str(tmp_path / "tray_raw.jpg"), raw)
    cv2.imwrite(str(overlay_path), raw)
    if warped:
        cv2.imwrite(
            str(tmp_path / "tray_warped.png"), np.full((200, 300, 3), 90, np.uint8)
        )
    return overlay_path


# ── Thumbnails ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("requested", "edge"), [(32, 160), (160, 160), (161, 320), (320, 320), (1024, 640)]
)
def test_snap_thumbnail_edge(requested, edge):
    assert snap_thumbnail_edge(requested) == edge


def test_ensure_thumbnail_builds_scaled_jpeg_and_reuses_it(tmp_path):
    src = tmp_path / "big.png"
    cv2.imwrite(str(src), np.zeros((1200, 2000, 3), np.uint8))
    dst = tmp_path / "big_thumb.jpg"

    assert ensure_thumbnail(src, dst, 320) is True
    thumb = cv2.imread(str(dst))
    assert max(thumb.shape[:2]) == 320
    assert thumb.shape[1] / thumb.shape[0] == pytest.approx(2000 / 1200, rel=0.02)

    first_mtime = dst.stat().st_mtime_ns
    assert ensure_thumbnail(src, dst, 320) is True
    assert dst.stat().st_mtime_ns == first_mtime  # cached, not rebuilt


def test_ensure_thumbnail_never_upscales_small_sources(tmp_path):
    src = tmp_path / "small.png"
    cv2.imwrite(str(src), np.zeros((40, 60, 3), np.uint8))
    dst = tmp_path / "small_thumb.jpg"
    assert ensure_thumbnail(src, dst, 320) is True
    assert cv2.imread(str(dst)).shape[:2] == (40, 60)


def test_ensure_thumbnail_reports_unreadable_source(tmp_path):
    src = tmp_path / "broken.png"
    src.write_bytes(b"not an image")
    assert ensure_thumbnail(src, tmp_path / "out.jpg", 160) is False


# ── Stale overlays ────────────────────────────────────────────────────────────


def test_render_polygon_overlay_draws_on_warped_base_and_clears_stale_state(tmp_path):
    overlay_path = _write_image_set(tmp_path, warped=True)
    thumb = thumbnail_path(overlay_path, "overlay", 320)
    thumb.write_bytes(b"old")
    mark_overlay_stale(overlay_path)
    assert is_overlay_stale(overlay_path)

    polygon = np.array([[50, 50], [150, 50], [150, 120], [50, 120]], np.int32)
    assert render_polygon_overlay(
        overlay_path, [polygon.reshape(-1, 1, 2)], (255, 255, 0)
    )

    rendered = cv2.imread(str(overlay_path))
    assert rendered.shape[:2] == (200, 300)  # the warped frame, not the raw one
    assert tuple(rendered[50, 100]) == (255, 255, 0)  # stroke on the top edge
    assert tuple(rendered[85, 100]) == (90, 90, 90)  # interior untouched
    assert not is_overlay_stale(overlay_path)
    assert not thumb.exists()


def test_render_polygon_overlay_falls_back_to_raw_without_warp(tmp_path):
    overlay_path = _write_image_set(tmp_path, warped=False)
    assert render_polygon_overlay(overlay_path, [], (255, 255, 0))
    assert cv2.imread(str(overlay_path)).shape[:2] == (300, 400)


# ── SAM refinement of stored polygons ─────────────────────────────────────────


class _ShrinkingSam:
    """Stands in for SamRefinementService: insets every polygon it is asked
    to refine by 2px, and records what it was given."""

    def __init__(self):
        self.seen_polygons: list[np.ndarray] = []
        self.enabled_flags: list[bool] = []

    async def refine_candidates_async(self, image, candidates, cfg, should_stop=None):
        self.enabled_flags.append(cfg.sam.enabled)
        out = []
        for cand in candidates:
            self.seen_polygons.append(np.array(cand["polygon"]))
            if cand["confidence"] < cfg.sam.confidence_threshold:
                out.append(cand)
                continue
            poly = np.array(cand["polygon"], np.float32)
            centre = poly.mean(axis=0)
            refined = dict(cand)
            refined["polygon"] = poly + np.sign(centre - poly) * 2.0
            out.append(refined)
        return out


def _detection(polygon, *, confidence=0.9, origin="model", edited=None):
    return LarvaeDetection(
        id=uuid.uuid4(),
        image_id=uuid.uuid4(),
        polygon=polygon,
        bbox={"x1": 0, "y1": 0, "x2": 1, "y2": 1},
        confidence=confidence,
        area_px=1,
        origin=origin,
        edited_polygon=edited,
    )


def _larvae_cfg(**sam):
    return LarvaeConfig(
        tile_size=512,
        overlap=0.4,
        confidence_threshold=0.3,
        batch_size=8,
        sam={"enabled": False, "confidence_threshold": 0.3, **sam},
    )


@pytest.fixture
def refine_env(tmp_path, monkeypatch):
    """Patch the persistence lookups so refine runs without a database."""

    def _install(detections, calibration):
        monkeypatch.setattr(
            polygon_refine,
            "list_detections_for_image",
            AsyncMock(return_value=detections),
        )
        monkeypatch.setattr(
            polygon_refine, "load_calibration", AsyncMock(return_value=calibration)
        )
        db = MagicMock()
        db.execute = AsyncMock()
        db.flush = AsyncMock()
        return db

    return _install


@pytest.mark.asyncio
async def test_refine_skips_user_and_edited_polygons(tmp_path, refine_env):
    overlay_path = _write_image_set(tmp_path)
    square = [[100, 100], [160, 100], [160, 140], [100, 140]]
    model_det = _detection(square)
    user_det = _detection(square, origin="user")
    edited_det = _detection(square, edited=[[0, 0], [9, 0], [9, 9]])
    low_conf_det = _detection(square, confidence=0.1)
    db = refine_env([model_det, user_det, edited_det, low_conf_det], None)
    sam = _ShrinkingSam()
    image = AnalysisImage(id=uuid.uuid4(), sam_refined=False)

    result = await polygon_refine.refine_stored_polygons(
        image, overlay_path, sam, _larvae_cfg(), db
    )

    assert (result.refined, result.skipped, result.failed, result.total) == (1, 3, 0, 4)
    assert model_det.polygon == [[102, 102], [158, 102], [158, 138], [102, 138]]
    assert model_det.bbox == {"x1": 102, "y1": 102, "x2": 158, "y2": 138}
    assert model_det.area_px == 56 * 36
    assert user_det.polygon == square and edited_det.polygon == square
    assert low_conf_det.polygon == square
    assert sam.enabled_flags == [True]  # forced on despite sam.enabled=False
    assert image.sam_refined is True
    assert is_overlay_stale(overlay_path)


@pytest.mark.asyncio
async def test_refine_prompts_sam_in_raw_space_and_stores_warped(tmp_path, refine_env):
    """Stored polygons live in the warped frame; SAM must see raw coordinates
    and the result must land back in the warped frame."""
    overlay_path = _write_image_set(tmp_path, warped=True)
    corners = [(60, 40), (340, 50), (330, 260), (50, 250)]
    matrix, _size, _roi = build_warp_matrix(
        (300, 400, 3), np.array(corners, np.float32)
    )
    raw_square = np.array([[150, 110], [230, 110], [230, 170], [150, 170]], np.float32)
    warped_square = cv2.perspectiveTransform(raw_square.reshape(-1, 1, 2), matrix)
    stored = [[int(x), int(y)] for x, y in warped_square.reshape(-1, 2)]
    det = _detection(stored)
    calibration = CalibrationCorners(auto_corners=corners, detection_status="detected")
    db = refine_env([det], calibration)
    sam = _ShrinkingSam()

    result = await polygon_refine.refine_stored_polygons(
        AnalysisImage(id=uuid.uuid4(), sam_refined=False),
        overlay_path,
        sam,
        _larvae_cfg(),
        db,
    )

    assert result.refined == 1
    # SAM was prompted with (approximately) the raw-frame square.
    assert np.allclose(sam.seen_polygons[0], raw_square, atol=1.5)
    # The stored result is the 2px-inset square, expressed in warped coords.
    expected = cv2.perspectiveTransform(
        (raw_square + np.sign(raw_square.mean(axis=0) - raw_square) * 2.0).reshape(
            -1, 1, 2
        ),
        matrix,
    ).reshape(-1, 2)
    assert np.allclose(np.array(det.polygon), expected, atol=2.0)


@pytest.mark.asyncio
async def test_refine_raises_when_raw_image_is_missing(tmp_path, refine_env):
    overlay_path = tmp_path / "gone_overlay.png"
    db = refine_env([], None)
    with pytest.raises(polygon_refine.RefineError):
        await polygon_refine.refine_stored_polygons(
            AnalysisImage(id=uuid.uuid4()),
            overlay_path,
            _ShrinkingSam(),
            _larvae_cfg(),
            db,
        )
