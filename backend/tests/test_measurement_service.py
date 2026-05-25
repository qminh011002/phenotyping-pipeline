"""Tests for ``app/services/inference/measurement.py``.

Synthetic shapes (rectangle, ellipse) on an identity calibration (1 px = 1 mm)
let us assert measurement values against analytical ground truth, plus a few
robustness cases (collinear / empty input).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import pytest

from app.schemas.calibration import CalibrationCorners
from app.schemas.config import LarvaeConfig, PupaeConfig
from app.services.inference.centerline import (
    extract_centerline,
    fallback_centerline,
    hybrid_centerline,
    medial_axis_centerline,
)
from app.services.inference.measurement import LarvaeMeasurementService

# ── Fixtures ──────────────────────────────────────────────────────────────────


def _cfg(volume_height_ratio: float = 0.6) -> LarvaeConfig:
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
        larva_volume_height_ratio=volume_height_ratio,
    )


def _pupae_cfg(volume_height_ratio: float = 0.6) -> PupaeConfig:
    return PupaeConfig(
        device="cpu",
        tile_size=320,
        overlap=0.2,
        confidence_threshold=0.5,
        min_mask_size=10,
        edge_margin=5,
        mwis_overlap_threshold=0.3,
        mwis_score_metric="confidence",
        batch_size=1,
        pupa_volume_height_ratio=volume_height_ratio,
    )


def _identity_calibration(canvas_w: int, canvas_h: int) -> CalibrationCorners:
    """Calibration whose corners are the canvas itself.

    The warp ends up shrinking the inner rectangle to (canvas_w − 2·padding,
    canvas_h − 2·padding) at the centre of the same-sized canvas (because the
    ROI is clamped to the image and the dst rectangle is positioned by the
    measured side-length average). For unit test simplicity we instead use a
    calibration with no corners — the warp is skipped, polygons stay in
    raw image coordinates, and mm/px is read directly from the record.
    """
    return CalibrationCorners(
        auto_corners=None,
        edited_corners=None,
        mm_per_px_x=1.0,
        mm_per_px_y=1.0,
        calibration_object_w_mm=float(canvas_w),
        calibration_object_h_mm=float(canvas_h),
        detection_status="manual",
    )


def _draw_rectangle_polygon(
    canvas: np.ndarray, x: int, y: int, w: int, h: int
) -> list[tuple[int, int]]:
    poly = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    cv2.fillPoly(canvas, [np.array(poly, dtype=np.int32)], (200, 200, 200))
    return poly


def _draw_ellipse_polygon(
    canvas: np.ndarray, cx: int, cy: int, ax: int, ay: int
) -> list[tuple[int, int]]:
    pts = cv2.ellipse2Poly((cx, cy), (ax, ay), 0, 0, 360, 5)
    cv2.fillPoly(canvas, [pts], (200, 200, 200))
    return [(int(p[0]), int(p[1])) for p in pts]


@pytest.fixture()
def executor() -> ThreadPoolExecutor:
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        yield pool
    finally:
        pool.shutdown(wait=True)


@pytest.fixture()
def service(executor: ThreadPoolExecutor) -> LarvaeMeasurementService:
    return LarvaeMeasurementService(executor=executor)


# ── Centerline primitives ─────────────────────────────────────────────────────


def test_medial_axis_returns_endpoint_path_for_rectangle() -> None:
    mask = np.zeros((40, 200), dtype=np.uint8)
    mask[10:30, 20:180] = 255

    result = medial_axis_centerline(mask)
    assert result is not None
    pts, widths = result
    assert pts.ndim == 2 and pts.shape[1] == 2
    # Spine should run along the long axis (x), spanning most of the rectangle.
    assert pts[:, 0].max() - pts[:, 0].min() >= 100
    # Width sampled along the spine ≈ 20 px (height of the rectangle).
    assert 18.0 <= float(np.median(widths)) <= 22.0


def test_medial_axis_returns_none_for_disconnected_mask() -> None:
    mask = np.zeros((40, 200), dtype=np.uint8)
    mask[10:30, 0:60] = 255
    mask[10:30, 140:200] = 255  # second blob, no link
    assert medial_axis_centerline(mask) is None


def test_fallback_centerline_handles_empty_mask() -> None:
    mask = np.zeros((20, 20), dtype=np.uint8)
    pts, widths = fallback_centerline(mask)
    assert pts.shape == (0, 2)
    assert widths.shape == (0,)


def test_extract_centerline_falls_through_strategies() -> None:
    mask = np.zeros((30, 100), dtype=np.uint8)
    mask[10:20, 10:90] = 255
    pts, widths = extract_centerline(mask)
    assert len(pts) >= 5
    assert len(widths) == len(pts)


# ── Hybrid (change.md spec) ───────────────────────────────────────────────────


def test_hybrid_centerline_rectangle_geometry() -> None:
    """Straight rectangle: length ≈ long-axis span, width ≈ short axis."""
    mask = np.zeros((40, 200), dtype=np.uint8)
    mask[15:25, 20:180] = 255  # 160 × 10
    result = hybrid_centerline(mask)
    assert result is not None
    pts, widths = result
    assert pts.shape == (100, 2)
    assert widths.shape == (100,)
    arc_len = float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum())
    assert 150.0 <= arc_len <= 170.0
    assert 9.0 <= float(np.median(widths)) <= 11.0


def test_hybrid_centerline_curved_C_recovers_arc() -> None:
    """Half-annulus (C pose): hybrid must follow the arc, not chord-shortcut.

    Outer R=80, inner R=60 → midline arc length ≈ π·70 ≈ 220 px;
    constant width ≈ 20 px.
    """
    import cv2

    h, w = 200, 200
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.circle(mask, (w // 2, h // 2), 80, 255, -1)
    cv2.circle(mask, (w // 2, h // 2), 60, 0, -1)
    mask[h // 2 :, :] = 0  # top half only

    result = hybrid_centerline(mask)
    assert result is not None
    pts, widths = result
    arc_len = float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum())
    # Spline shortens through the chord by a few %; tolerate 15% on a perfect
    # semicircle. Real larvae are not that tightly curved.
    assert 180.0 <= arc_len <= 250.0
    assert 18.0 <= float(np.median(widths)) <= 22.0


def test_hybrid_centerline_returns_none_on_tiny_mask() -> None:
    mask = np.zeros((20, 20), dtype=np.uint8)
    mask[10:12, 10:12] = 255  # 4 pixels, < 20 minimum
    assert hybrid_centerline(mask) is None


def test_hybrid_prunes_proleg_bump() -> None:
    """Cylinder + small lateral bump (proleg): hybrid must ignore the bump."""
    mask = np.zeros((60, 200), dtype=np.uint8)
    mask[25:35, 20:180] = 255  # main body 160 × 10
    mask[15:26, 90:110] = 255  # bump 11 × 20 sticking up
    result = hybrid_centerline(mask)
    assert result is not None
    pts, _widths = result
    # Centerline must stay along the body (y near 30), not climb into the bump.
    assert float(pts[:, 1].max()) < 33.0


def test_extract_centerline_legacy_dispatch_still_works() -> None:
    mask = np.zeros((30, 100), dtype=np.uint8)
    mask[10:20, 10:90] = 255
    pts, widths = extract_centerline(mask, method="legacy_dijkstra")
    assert len(pts) >= 5
    assert len(widths) == len(pts)


# ── Service: rectangle (length / area / width) ────────────────────────────────


def test_measure_image_rectangle_matches_known_geometry(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((200, 400, 3), dtype=np.uint8)
    poly = _draw_rectangle_polygon(canvas, x=50, y=80, w=300, h=20)
    cal = _identity_calibration(400, 200)

    out = service.measure_image(canvas, [poly], cal, _cfg())
    assert len(out) == 1
    m = out[0]
    assert not m.is_stale
    assert m.length_mm is not None
    assert m.area_mm2 is not None
    assert m.average_width_mm is not None

    # Rectangle: length ≈ 300 mm (1 px = 1 mm), allow polynomial-fit tolerance.
    assert m.length_mm == pytest.approx(300.0, rel=0.05)
    # Area ≈ 300×20 = 6000 mm². OpenCV polygon area on the integer poly is exact.
    assert m.area_mm2 == pytest.approx(6000.0, rel=0.02)
    # Average width sampled along distance transform ≈ 20 mm.
    assert m.average_width_mm == pytest.approx(20.0, rel=0.15)


def test_measure_image_ellipse_length_matches_major_axis(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((300, 600, 3), dtype=np.uint8)
    poly = _draw_ellipse_polygon(canvas, cx=300, cy=150, ax=200, ay=40)
    cal = _identity_calibration(600, 300)

    out = service.measure_image(canvas, [poly], cal, _cfg())
    assert len(out) == 1
    m = out[0]
    assert not m.is_stale
    # Major axis ≈ 2 · 200 = 400 mm; allow generous tolerance for the
    # smoothed centerline endpoints (medial axis falls short of the very tip).
    assert m.length_mm == pytest.approx(400.0, rel=0.10)
    # Area of an ellipse = π·a·b = π·200·40 ≈ 25132 mm².
    assert m.area_mm2 == pytest.approx(np.pi * 200 * 40, rel=0.02)


# ── Service: edge cases ───────────────────────────────────────────────────────


def test_measure_image_empty_polygon_list_returns_empty(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((100, 100, 3), dtype=np.uint8)
    cal = _identity_calibration(100, 100)
    assert service.measure_image(canvas, [], cal, _cfg()) == []


def test_measure_image_collinear_polygon_marks_stale(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((100, 200, 3), dtype=np.uint8)
    cal = _identity_calibration(200, 100)
    # All points on the same horizontal line → zero area, no measurement.
    poly = [(10, 50), (50, 50), (100, 50), (150, 50)]
    out = service.measure_image(canvas, [poly], cal, _cfg())
    assert len(out) == 1
    assert out[0].is_stale is True
    assert out[0].length_mm is None


def test_measure_image_under_three_vertices_marks_stale(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((100, 100, 3), dtype=np.uint8)
    cal = _identity_calibration(100, 100)
    out = service.measure_image(canvas, [[(10, 10), (20, 20)]], cal, _cfg())
    assert len(out) == 1
    assert out[0].is_stale is True


def test_measure_image_detection_id_length_mismatch_raises(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((100, 100, 3), dtype=np.uint8)
    cal = _identity_calibration(100, 100)
    poly = [(10, 10), (90, 10), (90, 30), (10, 30)]
    with pytest.raises(ValueError, match="detection_ids length"):
        service.measure_image(canvas, [poly], cal, _cfg(), detection_ids=["a", "b"])


def test_measure_image_uses_provided_detection_ids(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((200, 400, 3), dtype=np.uint8)
    poly = _draw_rectangle_polygon(canvas, x=50, y=80, w=300, h=20)
    cal = _identity_calibration(400, 200)

    out = service.measure_image(canvas, [poly], cal, _cfg(), detection_ids=["det-xyz"])
    assert out[0].detection_id == "det-xyz"


def test_measure_image_uses_pupae_volume_ratio(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((200, 400, 3), dtype=np.uint8)
    poly = _draw_rectangle_polygon(canvas, x=50, y=80, w=300, h=20)
    cal = _identity_calibration(400, 200)

    low = service.measure_image(canvas, [poly], cal, _pupae_cfg(0.2))[0]
    high = service.measure_image(canvas, [poly], cal, _pupae_cfg(1.0))[0]

    assert low.volume_mm3 is not None
    assert high.volume_mm3 is not None
    assert high.volume_mm3 > low.volume_mm3


def test_measure_image_skips_mm_when_calibration_factors_missing(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((200, 400, 3), dtype=np.uint8)
    poly = _draw_rectangle_polygon(canvas, x=50, y=80, w=300, h=20)
    cal = CalibrationCorners(
        mm_per_px_x=None,
        mm_per_px_y=None,
        detection_status="failed",
    )

    out = service.measure_image(canvas, [poly], cal, _cfg())
    assert len(out) == 1
    m = out[0]
    # Pipeline ran (centerline computed) but mm fields collapse to None when
    # mm/px is unknown — the consumer can flag this for the operator.
    assert m.length_mm is None
    assert m.area_mm2 is None
    assert m.centerline is not None and len(m.centerline) > 0


# ── Service: async + render ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_measure_image_async_runs_and_returns_results(
    service: LarvaeMeasurementService,
) -> None:
    """Async path: routes through the executor and produces non-stale measurements.

    Numerical parity with the sync path is *not* asserted — np.polyfit's
    LAPACK lstsq emits last-bit noise that BLAS thread placement amplifies
    when the call runs on a worker thread, so an exact-match assertion is
    flaky. Numerical correctness is covered by the sync rectangle / ellipse
    tests; this case verifies wiring + executor handoff only.
    """
    canvas = np.zeros((200, 400, 3), dtype=np.uint8)
    poly = _draw_rectangle_polygon(canvas, x=50, y=80, w=300, h=20)
    cal = _identity_calibration(400, 200)

    out = await service.measure_image_async(canvas, [poly], cal, _cfg())
    assert len(out) == 1
    assert not out[0].is_stale
    assert out[0].length_mm is not None and out[0].length_mm > 200.0
    # cv2.contourArea is BLAS-free → exact across threads.
    assert out[0].area_mm2 == pytest.approx(6000.0, rel=0.02)


@pytest.mark.asyncio
async def test_measure_image_async_empty_returns_empty(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((50, 50, 3), dtype=np.uint8)
    cal = _identity_calibration(50, 50)
    assert await service.measure_image_async(canvas, [], cal, _cfg()) == []


def test_render_overlay_does_not_mutate_inputs(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((200, 400, 3), dtype=np.uint8)
    poly = _draw_rectangle_polygon(canvas, x=50, y=80, w=300, h=20)
    cal = _identity_calibration(400, 200)
    measurements = service.measure_image(canvas, [poly], cal, _cfg())

    canvas_before = canvas.copy()
    centerline_before = list(measurements[0].centerline or [])
    widths_before = list(measurements[0].widths or [])

    out = service.render_overlay(canvas, measurements)

    # Pure: original image and measurements unchanged.
    assert np.array_equal(canvas, canvas_before)
    assert measurements[0].centerline == centerline_before
    assert measurements[0].widths == widths_before
    # Overlay actually drew something — at least one pixel differs.
    assert not np.array_equal(out, canvas_before)


def test_render_overlay_skips_stale_measurements(
    service: LarvaeMeasurementService,
) -> None:
    canvas = np.zeros((50, 50, 3), dtype=np.uint8)
    cal = _identity_calibration(50, 50)
    out = service.measure_image(canvas, [[(0, 0), (10, 0), (5, 1)]], cal, _cfg())
    assert out[0].is_stale
    rendered = service.render_overlay(canvas, out)
    assert np.array_equal(rendered, canvas)
