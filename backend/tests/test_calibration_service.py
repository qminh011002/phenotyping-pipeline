"""Tests for app/services/inference/calibration.py CalibrationService.

Three status paths are exercised against synthetic fixtures:
    - ``detected`` — auto-detect on an image with a clear green rectangle
    - ``failed``   — auto-detect on a blank image (no green at all)
    - ``manual``   — apply user-supplied corners

mm/px factors are checked against the known fixture geometry within 0.5%.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import pytest

from app.schemas.config import LarvaeConfig
from app.services.inference.calibration import CalibrationService


def _make_cfg(w_mm: float = 405.0, h_mm: float = 317.0) -> LarvaeConfig:
    return LarvaeConfig(
        device="cpu",
        tile_size=320,
        overlap=0.2,
        confidence_threshold=0.5,
        min_mask_size=10,
        edge_margin=5,
        mwis_overlap_threshold=0.3,
        mwis_score_metric="confidence",
        batch_size=1,
        calibration_object_w_mm=w_mm,
        calibration_object_h_mm=h_mm,
    )


def _green_rect_image(
    width_px: int = 405,
    height_px: int = 317,
    canvas_h: int = 600,
    canvas_w: int = 700,
    x0: int = 100,
    y0: int = 100,
) -> np.ndarray:
    img = np.zeros((canvas_h, canvas_w, 3), dtype=np.uint8)
    cv2.rectangle(
        img, (x0, y0), (x0 + width_px, y0 + height_px), (40, 200, 80), thickness=-1
    )
    return img


@pytest.fixture()
def executor() -> ThreadPoolExecutor:
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        yield pool
    finally:
        pool.shutdown(wait=True)


@pytest.fixture()
def service(executor: ThreadPoolExecutor) -> CalibrationService:
    return CalibrationService(executor=executor)


@pytest.mark.asyncio
async def test_detect_async_returns_detected_on_clear_green_rectangle(
    service: CalibrationService,
) -> None:
    cfg = _make_cfg()
    img = _green_rect_image()

    result = await service.detect_async(img, cfg)

    assert result.detection_status == "detected"
    assert result.auto_corners is not None
    assert len(result.auto_corners) == 4
    # Fixture uses 1 px = 1 mm, expect factors very close to 1.0.
    assert result.mm_per_px_x is not None
    assert result.mm_per_px_y is not None
    assert abs(result.mm_per_px_x - 1.0) < 0.005
    assert abs(result.mm_per_px_y - 1.0) < 0.005
    assert result.calibration_object_w_mm == 405.0
    assert result.calibration_object_h_mm == 317.0


@pytest.mark.asyncio
async def test_detect_async_returns_failed_on_blank_image(
    service: CalibrationService,
) -> None:
    cfg = _make_cfg()
    blank = np.zeros((600, 700, 3), dtype=np.uint8)

    result = await service.detect_async(blank, cfg)

    assert result.detection_status == "failed"
    assert result.auto_corners is None
    assert result.mm_per_px_x is None
    assert result.mm_per_px_y is None
    assert result.calibration_object_w_mm == 405.0
    assert result.calibration_object_h_mm == 317.0


def test_apply_manual_corners_produces_manual_status_and_factors(
    service: CalibrationService,
) -> None:
    cfg = _make_cfg()
    # Same 405×317 px rectangle → mm/px factors should be exactly 1.0.
    corners = [(100, 100), (505, 100), (505, 417), (100, 417)]

    result = service.apply_manual_corners(corners, cfg)

    assert result.detection_status == "manual"
    assert result.edited_corners is not None
    assert len(result.edited_corners) == 4
    assert result.mm_per_px_x == pytest.approx(1.0, abs=1e-6)
    assert result.mm_per_px_y == pytest.approx(1.0, abs=1e-6)


def test_apply_manual_corners_rejects_wrong_count(
    service: CalibrationService,
) -> None:
    cfg = _make_cfg()
    with pytest.raises(ValueError, match="exactly 4 corners"):
        service.apply_manual_corners([(0, 0), (1, 1), (2, 2)], cfg)


def test_apply_manual_corners_rejects_degenerate_rectangle(
    service: CalibrationService,
) -> None:
    cfg = _make_cfg()
    with pytest.raises(ValueError, match="degenerate"):
        service.apply_manual_corners([(0, 0), (0, 0), (0, 0), (0, 0)], cfg)


def test_compute_factors_static_helper_matches_known_geometry() -> None:
    corners = np.array(
        [[100, 100], [505, 100], [505, 417], [100, 417]], dtype=np.float32
    )
    fx, fy = CalibrationService.compute_factors(corners, 405.0, 317.0)
    assert fx == pytest.approx(1.0, abs=1e-6)
    assert fy == pytest.approx(1.0, abs=1e-6)


def test_compute_factors_rejects_bad_shape() -> None:
    with pytest.raises(ValueError, match="4x2"):
        CalibrationService.compute_factors(
            np.zeros((3, 2), dtype=np.float32), 405.0, 317.0
        )


def test_compute_factors_rejects_degenerate() -> None:
    corners = np.array([[0, 0], [0, 0], [0, 0], [0, 0]], dtype=np.float32)
    with pytest.raises(ValueError, match="degenerate"):
        CalibrationService.compute_factors(corners, 405.0, 317.0)


def test_detect_sync_returns_none_on_blank_image(service: CalibrationService) -> None:
    cfg = _make_cfg()
    blank = np.zeros((600, 700, 3), dtype=np.uint8)
    assert service.detect(blank, cfg) is None


def test_detect_uses_configured_object_size(service: CalibrationService) -> None:
    """A different mm size should scale factors proportionally for the same image."""
    img = _green_rect_image()

    cfg_a = _make_cfg(w_mm=405.0, h_mm=317.0)
    cfg_b = _make_cfg(w_mm=810.0, h_mm=634.0)

    res_a = service.detect(img, cfg_a)
    res_b = service.detect(img, cfg_b)

    assert res_a is not None and res_b is not None
    assert res_b.mm_per_px_x == pytest.approx(2 * res_a.mm_per_px_x, rel=1e-6)
    assert res_b.mm_per_px_y == pytest.approx(2 * res_a.mm_per_px_y, rel=1e-6)
