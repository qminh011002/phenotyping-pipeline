"""LarvaeMeasurementService — per-larva mm measurements from polygon + calibration.

Ports the centerline / width / volume math from
``phenotyping_pipeline/2_inference/process_larvae.py`` (``process_single_image``,
~lines 393–990) but re-organised into single-responsibility helpers that are
each well under 80 lines:

1. ``_warp_image`` — perspective-rectify the image using calibration corners
2. ``_warp_polygon`` — apply the same M to a polygon
3. ``_crop_to_polygon`` — crop the warped image to the polygon's bbox + padding
4. ``_clean_mask`` — fill polygon, morph close + open
5. ``extract_centerline`` (``centerline.py``) — medial-axis → Dijkstra → naive
6. ``_smooth_centerline`` — orientation-aware polynomial fit + width interp
7. ``_measure`` — convert px → mm, accumulate length/area/volume

The service has no DB or filesystem side effects; ``render_overlay`` is a pure
visualisation helper (centerline + width lines) that does **not** mutate the
measurement objects.
"""

from __future__ import annotations

import asyncio
import logging
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import cv2
import numpy as np
from scipy.interpolate import interp1d

from app.schemas.calibration import CalibrationCorners
from app.schemas.larvae import LarvaeMeasurement
from app.services.inference.centerline import (
    dijkstra_centerline,
    extract_centerline,
    fallback_centerline,
    hybrid_centerline,
)

if TYPE_CHECKING:
    from app.schemas.config import LarvaeConfig, PupaeConfig

logger = logging.getLogger(__name__)

_ROI_PADDING_PX: int = 100
_CROP_PADDING_PX: int = 5
_MIN_WARPED_AREA_PX: float = 20.0
_MIN_MASK_PIXELS: int = 5
_MIN_CENTERLINE_POINTS: int = 5
_FIT_NUM_SAMPLES: int = 50

# Pipeline parity: phenotyping_pipeline/2_inference/process_larvae.py skips
# every annotation with confidence < 0.5 before measuring. Caller passes the
# detection confidence; we mark the polygon as stale rather than measuring it.
_PIPELINE_MEASURE_MIN_CONFIDENCE: float = 0.5


@dataclass(frozen=True)
class _WarpResult:
    image: np.ndarray
    transform: np.ndarray | None  # 3×3 perspective matrix; None if warp skipped


# ── Helpers: calibration / warp ───────────────────────────────────────────────


def _resolve_corners(calibration: CalibrationCorners) -> np.ndarray | None:
    """Return the calibration corners as a (4, 2) float32 array, or ``None``.

    Edited corners take precedence over auto corners (operator override).
    """
    pts = calibration.edited_corners or calibration.auto_corners
    if pts is None or len(pts) != 4:
        return None
    return np.array(pts, dtype=np.float32)


def build_warp_matrix(
    image_shape: tuple[int, int],
    corners: np.ndarray,
) -> tuple[np.ndarray, tuple[int, int], tuple[int, int]] | None:
    """Compute (M, (warp_w, warp_h), (roi_x, roi_y)) for the perspective warp."""
    sides = (
        float(np.linalg.norm(corners[0] - corners[1])),
        float(np.linalg.norm(corners[1] - corners[2])),
        float(np.linalg.norm(corners[2] - corners[3])),
        float(np.linalg.norm(corners[3] - corners[0])),
    )
    target_w = int((sides[0] + sides[2]) / 2.0)
    target_h = int((sides[1] + sides[3]) / 2.0)
    if target_w <= 0 or target_h <= 0:
        return None

    min_x, min_y = corners.min(axis=0)
    max_x, max_y = corners.max(axis=0)
    h_img, w_img = image_shape[:2]
    roi_x1 = max(0, int(min_x - _ROI_PADDING_PX))
    roi_y1 = max(0, int(min_y - _ROI_PADDING_PX))
    roi_x2 = min(w_img, int(max_x + _ROI_PADDING_PX))
    roi_y2 = min(h_img, int(max_y + _ROI_PADDING_PX))
    warp_w = roi_x2 - roi_x1
    warp_h = roi_y2 - roi_y1
    if warp_w <= 0 or warp_h <= 0:
        return None

    cx = warp_w // 2
    cy = warp_h // 2
    dst = np.array(
        [
            [cx - target_w // 2, cy - target_h // 2],
            [cx + target_w // 2, cy - target_h // 2],
            [cx + target_w // 2, cy + target_h // 2],
            [cx - target_w // 2, cy + target_h // 2],
        ],
        dtype=np.float32,
    )
    try:
        matrix = cv2.getPerspectiveTransform(corners, dst)
    except cv2.error:
        return None
    return matrix, (warp_w, warp_h), (roi_x1, roi_y1)


def _warp_image(image: np.ndarray, calibration: CalibrationCorners) -> _WarpResult:
    """Perspective-rectify the image to the calibration rectangle.

    Falls back to the identity (no warp) if calibration is missing or
    degenerate — measurement still proceeds in raw image coords, and the mm
    conversion is governed by ``calibration.mm_per_px_*`` regardless.
    """
    corners = _resolve_corners(calibration)
    if corners is None:
        return _WarpResult(image=image, transform=None)
    built = build_warp_matrix(image.shape, corners)
    if built is None:
        return _WarpResult(image=image, transform=None)
    matrix, (warp_w, warp_h), _roi = built
    try:
        warped = cv2.warpPerspective(image, matrix, (warp_w, warp_h))
    except cv2.error:
        return _WarpResult(image=image, transform=None)
    return _WarpResult(image=warped, transform=matrix)


def _warp_polygon(
    polygon: list[tuple[int, int]], matrix: np.ndarray | None
) -> np.ndarray:
    """Apply the warp matrix to a polygon. Returns an (N, 1, 2) int32 contour."""
    pts = np.array(polygon, dtype=np.float32).reshape(-1, 1, 2)
    if matrix is not None:
        pts = cv2.perspectiveTransform(pts, matrix)
    return pts.astype(np.int32)


# ── Helpers: per-polygon pipeline ─────────────────────────────────────────────


def _crop_to_polygon(
    image: np.ndarray, contour: np.ndarray
) -> tuple[np.ndarray, np.ndarray, int, int] | None:
    """Crop the image to the polygon bbox + small padding.

    Returns ``(crop, contour_local, x_start, y_start)`` or ``None`` if the
    contour is degenerate (zero area / outside image).
    """
    if cv2.contourArea(contour) < _MIN_WARPED_AREA_PX:
        return None
    x, y, w, h = cv2.boundingRect(contour)
    if w <= 0 or h <= 0:
        return None
    x1 = max(0, x - _CROP_PADDING_PX)
    y1 = max(0, y - _CROP_PADDING_PX)
    x2 = min(image.shape[1], x + w + _CROP_PADDING_PX)
    y2 = min(image.shape[0], y + h + _CROP_PADDING_PX)
    if x2 <= x1 or y2 <= y1:
        return None
    crop = image[y1:y2, x1:x2]
    local = contour.copy()
    local[:, 0, 0] -= x1
    local[:, 0, 1] -= y1
    return crop, local, x1, y1


def _fill_mask(crop_shape: tuple[int, int], contour_local: np.ndarray) -> np.ndarray:
    """Fill the polygon — no morphology. Returns a uint8 0/255 mask.

    Pipeline parity: phenotyping_pipeline/process_larvae.py uses the *unmorphed*
    mask (``mask_crop``) for: (a) the ``len(xs) < 5`` gate, (b) the scan-line
    ``fallback_centerline_extraction``. Morphology is applied separately to
    produce ``mask_clean`` for the distance transform / Dijkstra graph.
    """
    h, w = crop_shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    if contour_local.size == 0 or h == 0 or w == 0:
        return mask
    cv2.drawContours(mask, [contour_local], -1, 255, thickness=cv2.FILLED)
    return mask


def _morph_clean(mask_crop: np.ndarray) -> np.ndarray:
    """Close → open the filled mask. Mirrors mask_clean in process_larvae.py."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask_crop, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    return mask


def _clean_mask(crop_shape: tuple[int, int], contour_local: np.ndarray) -> np.ndarray:
    """Backwards-compat wrapper kept for tests — fill + morph in one call."""
    return _morph_clean(_fill_mask(crop_shape, contour_local))


def _fit_polynomial(
    x_center: np.ndarray, y_center: np.ndarray
) -> tuple[np.ndarray, np.ndarray] | None:
    """Orientation-aware polynomial fit. Returns ``(x_fit, y_fit)`` or ``None``.

    Pipeline parity: keep float64 throughout. ``np.linspace`` and
    ``np.polyfit`` default to float64; downcasting to float32 here would
    accumulate ~1e-4 px error across the 50 segments of the centerline.
    """
    n = len(x_center)
    if n < 2:
        return None
    if n < 10:
        degree = 1
    elif n < 20:
        degree = 2
    else:
        degree = min(3, n - 1)

    x_range = float(np.ptp(x_center))
    y_range = float(np.ptp(y_center))
    samples = min(_FIT_NUM_SAMPLES, n)
    try:
        if x_range >= y_range:
            coeffs = np.polyfit(x_center, y_center, degree)
            x_fit = np.linspace(x_center.min(), x_center.max(), samples)
            y_fit = np.poly1d(coeffs)(x_fit)
        else:
            coeffs = np.polyfit(y_center, x_center, degree)
            y_fit = np.linspace(y_center.min(), y_center.max(), samples)
            x_fit = np.poly1d(coeffs)(y_fit)
    except (np.linalg.LinAlgError, ValueError):
        return None
    return np.asarray(x_fit, dtype=np.float64), np.asarray(y_fit, dtype=np.float64)


def _interp_widths(
    x_center: np.ndarray,
    y_center: np.ndarray,
    widths: np.ndarray,
    x_fit: np.ndarray,
    y_fit: np.ndarray,
) -> np.ndarray:
    """Interpolate widths along arc length onto the fitted centerline.

    Line-for-line port of phenotyping_pipeline/2_inference/process_larvae.py:
    fallback constant on length mismatch is 1.0 (not the mean), to match the
    reference pipeline byte-for-byte.
    """
    if len(widths) != len(x_center) or len(widths) < 2:
        return np.maximum(np.full(len(x_fit), 1.0, dtype=np.float64), 0.1)
    src_d = np.cumsum(np.sqrt(np.diff(x_center) ** 2 + np.diff(y_center) ** 2))
    src_d = np.insert(src_d, 0, 0.0)
    if len(np.unique(src_d)) <= 1:
        return np.maximum(
            np.full(len(x_fit), float(np.mean(widths)), dtype=np.float64), 0.1
        )
    dst_d = np.cumsum(np.sqrt(np.diff(x_fit) ** 2 + np.diff(y_fit) ** 2))
    dst_d = np.insert(dst_d, 0, 0.0)
    try:
        f = interp1d(src_d, widths, bounds_error=False, fill_value="extrapolate")
        out = f(dst_d)
    except ValueError:
        return np.maximum(
            np.full(len(x_fit), float(np.mean(widths)), dtype=np.float64), 0.1
        )
    return np.maximum(np.asarray(out, dtype=np.float64), 0.1)


def _smooth_centerline(
    points: np.ndarray, widths: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Smooth raw centerline + widths. Returns ``(x_fit, y_fit, widths_fit)``."""
    if len(points) < _MIN_CENTERLINE_POINTS:
        return None
    x_center = points[:, 0]
    y_center = points[:, 1]
    fit = _fit_polynomial(x_center, y_center)
    if fit is None:
        return points[:, 0], points[:, 1], widths
    x_fit, y_fit = fit
    widths_fit = _interp_widths(x_center, y_center, widths, x_fit, y_fit)
    return x_fit, y_fit, widths_fit


def _arc_volume(chord: float, height_ratio: float, segment_length: float) -> float:
    """Volume of a circular-segment arc cross-section over ``segment_length``."""
    if chord <= 0 or height_ratio <= 0 or segment_length <= 0:
        return 0.0
    height = chord * height_ratio
    if height <= 0:
        return 0.0
    radius = (height / 2.0) + (chord**2 / (8.0 * height))
    if radius <= 0 or chord > 2.0 * radius:
        return 0.0
    theta = 2.0 * math.asin(min(1.0, chord / (2.0 * radius)))
    area = 0.5 * radius**2 * (theta - math.sin(theta))
    return area * segment_length


def _measure(
    contour_local: np.ndarray,
    x_fit: np.ndarray,
    y_fit: np.ndarray,
    widths_fit: np.ndarray,
    cfg: "LarvaeConfig | PupaeConfig",
    calibration: CalibrationCorners,
) -> tuple[float, float, float, float, float, float]:
    """Return (length_px, min_w_px, max_w_px, avg_w_px, area_px2, volume_px3)."""
    dx = np.diff(x_fit)
    dy = np.diff(y_fit)
    seg_lengths = np.sqrt(dx**2 + dy**2)
    length_px = float(seg_lengths.sum())

    # Volume using the per-segment chord ratio. Per the reference we use
    # widths_fit[i] (not widths_fit[:-1]) to match its iteration.
    height_ratio = float(
        getattr(
            cfg,
            "larva_volume_height_ratio",
            getattr(cfg, "pupa_volume_height_ratio", 0.6),
        )
    )
    volume_px3 = float(
        sum(
            _arc_volume(float(widths_fit[i]), height_ratio, float(seg_lengths[i]))
            for i in range(len(seg_lengths))
        )
    )

    if widths_fit.size == 0:
        min_w = max_w = avg_w = 0.0
    else:
        min_w = float(widths_fit.min())
        max_w = float(widths_fit.max())
        avg_w = float(widths_fit.mean())

    area_px2 = float(cv2.contourArea(contour_local))
    return length_px, min_w, max_w, avg_w, area_px2, volume_px3


def _to_mm(value_px: float, mm_per_px: float | None, exponent: int = 1) -> float | None:
    if mm_per_px is None:
        return None
    return value_px * (mm_per_px**exponent)


def _measure_one_polygon(
    warped_image: np.ndarray,
    matrix: np.ndarray | None,
    polygon: list[tuple[int, int]],
    calibration: CalibrationCorners,
    cfg: "LarvaeConfig | PupaeConfig",
    detection_id: str,
) -> LarvaeMeasurement:
    """Run the whole pipeline for a single polygon.

    Always returns a ``LarvaeMeasurement`` — pipeline failures produce a
    stale record with ``is_stale=True`` rather than raising, so a single bad
    polygon doesn't kill the batch.
    """
    stale = LarvaeMeasurement(
        detection_id=detection_id,
        is_stale=True,
        measured_at=datetime.now(timezone.utc),
    )
    if len(polygon) < 3:
        return stale

    warped_contour = _warp_polygon(polygon, matrix)
    cropped = _crop_to_polygon(warped_image, warped_contour)
    if cropped is None:
        return stale
    _crop, contour_local, x_start, y_start = cropped

    crop_h, crop_w = _crop.shape[:2]
    # Pipeline parity: build BOTH the unmorphed mask_crop (for the
    # `len(xs) < 5` gate + the scan-line fallback) AND the morphed mask_clean
    # (for distanceTransform + Dijkstra graph). process_larvae.py keeps them
    # distinct; smoothing the mask before the scan-line fallback would shave
    # pixels from the larva's silhouette and slightly shrink the measurement.
    mask_crop = _fill_mask((crop_h, crop_w), contour_local)
    if int((mask_crop > 0).sum()) < _MIN_MASK_PIXELS:
        return stale
    mask_clean = _morph_clean(mask_crop)

    # Hybrid path: spline smoothing + dt*2 widths happen inside the
    # centerline routine, so we skip the legacy polynomial fit on success.
    # On failure we fall back through dijkstra → naive and re-smooth.
    if cfg.centerline_method == "pipeline_compat":
        # Line-for-line port of phenotyping_pipeline/process_larvae.py:
        # distance-ridge Dijkstra over `mask_clean` → polyfit smoothing.
        # On any dijkstra failure, the pipeline falls THROUGH directly to the
        # scan-line `fallback_centerline_extraction(mask_crop, xs, ys)` — using
        # the *unmorphed* mask, NOT mask_clean. Mirror that here exactly.
        dij = dijkstra_centerline(mask_clean)
        if dij is not None and len(dij[0]) >= _MIN_CENTERLINE_POINTS:
            points, widths = dij
        else:
            points, widths = fallback_centerline(mask_crop)
            if len(points) < _MIN_CENTERLINE_POINTS:
                return stale
        smoothed = _smooth_centerline(points, widths)
        if smoothed is None:
            return stale
        x_fit, y_fit, widths_fit = smoothed
    elif cfg.centerline_method == "hybrid":
        hybrid = hybrid_centerline(
            mask_clean,
            n_output_points=cfg.centerline_n_output_points,
            min_branch_ratio=cfg.centerline_min_branch_ratio,
            smoothness=cfg.centerline_smoothness,
        )
        if hybrid is not None and len(hybrid[0]) >= _MIN_CENTERLINE_POINTS:
            pts_h, widths_h = hybrid
            x_fit = pts_h[:, 0].astype(np.float64)
            y_fit = pts_h[:, 1].astype(np.float64)
            widths_fit = widths_h.astype(np.float64)
        else:
            points, widths = extract_centerline(mask_clean, method="legacy_dijkstra")
            if len(points) < _MIN_CENTERLINE_POINTS:
                return stale
            smoothed = _smooth_centerline(points, widths)
            if smoothed is None:
                return stale
            x_fit, y_fit, widths_fit = smoothed
    else:
        points, widths = extract_centerline(mask_clean, method="legacy_dijkstra")
        if len(points) < _MIN_CENTERLINE_POINTS:
            return stale
        smoothed = _smooth_centerline(points, widths)
        if smoothed is None:
            return stale
        x_fit, y_fit, widths_fit = smoothed

    length_px, min_w_px, max_w_px, avg_w_px, area_px2, volume_px3 = _measure(
        contour_local, x_fit, y_fit, widths_fit, cfg, calibration
    )

    mm_per_px_x = calibration.mm_per_px_x
    mm_per_px_y = calibration.mm_per_px_y
    mm_per_px = (
        (mm_per_px_x + mm_per_px_y) / 2.0
        if mm_per_px_x is not None and mm_per_px_y is not None
        else None
    )

    centerline_world = [
        (float(x_fit[i] + x_start), float(y_fit[i] + y_start))
        for i in range(len(x_fit))
    ]
    widths_world: list[float] = [float(w) for w in widths_fit]

    return LarvaeMeasurement(
        detection_id=detection_id,
        length_mm=_to_mm(length_px, mm_per_px),
        min_width_mm=_to_mm(min_w_px, mm_per_px),
        max_width_mm=_to_mm(max_w_px, mm_per_px),
        average_width_mm=_to_mm(avg_w_px, mm_per_px),
        area_mm2=_to_mm(area_px2, mm_per_px, exponent=2),
        volume_mm3=_to_mm(volume_px3, mm_per_px, exponent=3),
        centerline=centerline_world,
        widths=widths_world,
        weight_mg=None,  # enable_weight path deferred to v2
        is_stale=False,
        measured_at=datetime.now(timezone.utc),
    )


# ── Visualisation (pure render) ───────────────────────────────────────────────


def _draw_centerline_and_widths(canvas: np.ndarray, m: LarvaeMeasurement) -> None:
    if not m.centerline or not m.widths:
        return
    pts = np.array(m.centerline, dtype=np.float32)
    widths = np.array(m.widths, dtype=np.float32)
    if len(pts) < 2:
        return

    # Centerline as a connected blue polyline.
    polyline = pts.astype(np.int32).reshape(-1, 1, 2)
    cv2.polylines(canvas, [polyline], False, (255, 0, 0), 2)

    # Width lines every 3rd point, perpendicular to the local tangent.
    for i in range(1, len(pts) - 1):
        if i % 3 != 0:
            continue
        dx = pts[i + 1, 0] - pts[i - 1, 0]
        dy = pts[i + 1, 1] - pts[i - 1, 1]
        length = math.hypot(dx, dy)
        if length <= 0:
            continue
        nx = -dy / length
        ny = dx / length
        half = float(widths[i]) / 2.0
        x0 = int(pts[i, 0] + nx * half)
        y0 = int(pts[i, 1] + ny * half)
        x1 = int(pts[i, 0] - nx * half)
        y1 = int(pts[i, 1] - ny * half)
        cv2.line(canvas, (x0, y0), (x1, y1), (0, 255, 0), 2)


# ── Service ───────────────────────────────────────────────────────────────────


class LarvaeMeasurementService:
    """Compute and visualise per-larva mm measurements.

    Stateless apart from the executor reference; safe to share across
    requests. All CV/numerical work runs in the supplied
    ``ThreadPoolExecutor`` so the asyncio event loop stays free.
    """

    def __init__(self, executor: ThreadPoolExecutor) -> None:
        self._executor = executor

    def measure_image(
        self,
        image: np.ndarray,
        polygons: list[list[tuple[int, int]]],
        calibration: CalibrationCorners,
        cfg: "LarvaeConfig | PupaeConfig",
        *,
        detection_ids: list[str] | None = None,
        polygons_already_warped: bool = False,
        confidences: list[float] | None = None,
    ) -> list[LarvaeMeasurement]:
        """Measure every polygon on a single image (synchronous).

        ``detection_ids`` is one ID per polygon; defaults to a stable
        positional id (``"larva-0"``, ``"larva-1"``, ...) when not supplied.
        ``confidences`` (optional, one per polygon) makes us skip detections
        below 0.5 — matching phenotyping_pipeline/process_larvae.py exactly.
        Empty ``polygons`` returns ``[]`` without ever invoking OpenCV.
        """
        if not polygons:
            return []
        if detection_ids is None:
            detection_ids = [f"larva-{i}" for i in range(len(polygons))]
        elif len(detection_ids) != len(polygons):
            raise ValueError(
                f"detection_ids length ({len(detection_ids)}) must match "
                f"polygons length ({len(polygons)})"
            )
        if confidences is not None and len(confidences) != len(polygons):
            raise ValueError(
                f"confidences length ({len(confidences)}) must match "
                f"polygons length ({len(polygons)})"
            )

        if polygons_already_warped:
            # ``image`` is the warped frame and polygons are in its coords;
            # skip the homography step entirely (transform=None is a no-op
            # inside ``_measure_one_polygon``).
            warp = _WarpResult(image=image, transform=None)
        else:
            warp = _warp_image(image, calibration)
        results: list[LarvaeMeasurement] = []
        for idx, (poly, det_id) in enumerate(zip(polygons, detection_ids)):
            # Pipeline parity: skip low-confidence detections at measurement
            # time, mirroring process_larvae.py's `if confidence < 0.5: continue`.
            if (
                confidences is not None
                and float(confidences[idx]) < _PIPELINE_MEASURE_MIN_CONFIDENCE
            ):
                results.append(
                    LarvaeMeasurement(
                        detection_id=det_id,
                        is_stale=True,
                        measured_at=datetime.now(timezone.utc),
                    )
                )
                continue
            try:
                results.append(
                    _measure_one_polygon(
                        warp.image, warp.transform, poly, calibration, cfg, det_id
                    )
                )
            except (cv2.error, ValueError, np.linalg.LinAlgError) as exc:
                logger.warning(
                    "Larvae measurement failed for one polygon",
                    extra={
                        "context": {
                            "detection_id": det_id,
                            "vertices": len(poly),
                            "error": str(exc),
                        }
                    },
                )
                results.append(
                    LarvaeMeasurement(
                        detection_id=det_id,
                        is_stale=True,
                        measured_at=datetime.now(timezone.utc),
                    )
                )
        return results

    async def measure_image_async(
        self,
        image: np.ndarray,
        polygons: list[list[tuple[int, int]]],
        calibration: CalibrationCorners,
        cfg: "LarvaeConfig | PupaeConfig",
        *,
        detection_ids: list[str] | None = None,
        polygons_already_warped: bool = False,
        confidences: list[float] | None = None,
    ) -> list[LarvaeMeasurement]:
        """Async wrapper — runs the loop in the inference executor."""
        if not polygons:
            return []
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            lambda: self.measure_image(
                image,
                polygons,
                calibration,
                cfg,
                detection_ids=detection_ids,
                polygons_already_warped=polygons_already_warped,
                confidences=confidences,
            ),
        )

    def render_overlay(
        self,
        image: np.ndarray,
        measurements: list[LarvaeMeasurement],
    ) -> np.ndarray:
        """Draw centerlines + width lines onto a copy of ``image``.

        Pure: never mutates either argument; never alters the measurements.
        """
        canvas = image.copy()
        for m in measurements:
            if m.is_stale:
                continue
            _draw_centerline_and_widths(canvas, m)
        return canvas
