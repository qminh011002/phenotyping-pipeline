"""CalibrationService — green calibration rectangle detection + mm/px factors.

Ports `detect_green_squares`, `is_roughly_rectangular`, `fit_rectangle_to_contour`,
`order_points`, and `side_lengths` from
``phenotyping_pipeline/2_inference/process_larvae.py``. Unlike the reference
pipeline, this service:

- Returns ``None`` from the synchronous ``detect`` core on failure (no exception)
- Wraps the public path in ``CalibrationCorners`` so callers can choose whether
  to block on a failure or queue the image for manual fix
- Runs the OpenCV work in a shared ThreadPoolExecutor
- Reads calibration object dimensions from ``LarvaeConfig`` (no hard-coded mm)

Measurement logic (perspective warp, length/area in mm) lives in BE-033 and is
explicitly out of scope here.
"""

from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING

import cv2
import numpy as np

from app.schemas.calibration import CalibrationCorners

if TYPE_CHECKING:
    from app.schemas.config import LarvaeConfig

logger = logging.getLogger(__name__)


# Tuned to the reference camera setup; promote to LarvaeConfig if other rigs
# need different values. Defaults preserve behaviour parity with the pipeline.
_MIN_CONTOUR_AREA: int = 5000
_RECT_FIT_MIN_AREA: int = 20000
_GOOD_ENOUGH_AREA: int = 50000
_MAX_CONTOURS: int = 15
_APPROX_FACTORS: tuple[float, ...] = (
    0.005,
    0.01,
    0.015,
    0.02,
    0.025,
    0.03,
    0.04,
    0.05,
)
_HSV_RANGES: tuple[tuple[tuple[int, int, int], tuple[int, int, int]], ...] = (
    ((25, 30, 30), (80, 255, 255)),
)


def _order_points(pts: np.ndarray) -> np.ndarray:
    """Return points ordered TL, TR, BR, BL (float32 4×2)."""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def _side_lengths(pts: np.ndarray) -> list[float]:
    """Lengths of the four sides in TL→TR, TR→BR, BR→BL, BL→TL order."""
    return [
        float(np.linalg.norm(pts[0] - pts[1])),
        float(np.linalg.norm(pts[1] - pts[2])),
        float(np.linalg.norm(pts[2] - pts[3])),
        float(np.linalg.norm(pts[3] - pts[0])),
    ]


def _is_roughly_rectangular(approx: np.ndarray) -> bool:
    if len(approx) != 4:
        return False
    pts = approx.reshape(4, 2)
    sides = sorted(float(np.linalg.norm(pts[(i + 1) % 4] - pts[i])) for i in range(4))
    if sides[1] <= 0 or sides[3] <= 0 or sides[0] <= 0:
        return False
    ratio1 = sides[0] / sides[1]
    ratio2 = sides[2] / sides[3]
    if ratio1 <= 0.6 or ratio2 <= 0.6:
        return False
    aspect_ratio = sides[3] / sides[0]
    return 0.3 < aspect_ratio < 3.0


def _fit_rectangle_to_contour(contour: np.ndarray) -> np.ndarray | None:
    try:
        rect = cv2.minAreaRect(contour)
        box = cv2.boxPoints(rect)
        box = np.array(box, dtype=np.int32)
        return box.reshape(-1, 1, 2)
    except cv2.error:
        return None


def _detect_green_rectangle(image: np.ndarray) -> np.ndarray | None:
    """Auto-detect the calibration rectangle. Returns the contour (4×1×2 int32)
    or ``None`` on failure — no exceptions on a clean miss."""
    blurred = cv2.GaussianBlur(image, (7, 7), 0)
    hsv = cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)
    kernel = np.ones((3, 3), np.uint8)

    best_square: np.ndarray | None = None
    best_area: float = 0.0

    for lower, upper in _HSV_RANGES:
        mask = cv2.inRange(hsv, np.array(lower), np.array(upper))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnts = sorted(cnts, key=cv2.contourArea, reverse=True)

        for cnt in cnts[:_MAX_CONTOURS]:
            area = float(cv2.contourArea(cnt))
            if area < _MIN_CONTOUR_AREA:
                continue

            peri = cv2.arcLength(cnt, True)
            found = False
            for factor in _APPROX_FACTORS:
                approx = cv2.approxPolyDP(cnt, factor * peri, True)
                if len(approx) == 4 and _is_roughly_rectangular(approx):
                    if area > best_area:
                        best_square = approx
                        best_area = area
                    found = True
                    break

            if not found and area > _RECT_FIT_MIN_AREA:
                rect_approx = _fit_rectangle_to_contour(cnt)
                if rect_approx is not None and _is_roughly_rectangular(rect_approx):
                    if area > best_area:
                        best_square = rect_approx
                        best_area = area

        if best_square is not None and best_area > _GOOD_ENOUGH_AREA:
            break

    return best_square


def _corners_to_list(pts: np.ndarray) -> list[tuple[int, int]]:
    """Convert a 4×2 float array (already TL/TR/BR/BL ordered) to int tuples."""
    return [(int(round(p[0])), int(round(p[1]))) for p in pts]


def _compute_factors_from_ordered(
    ordered: np.ndarray, real_w_mm: float, real_h_mm: float
) -> tuple[float, float] | None:
    """Average opposing sides → mm-per-pixel in X and Y. Returns ``None`` on a
    degenerate (zero-area) rectangle."""
    sides = _side_lengths(ordered)
    w_px = (sides[0] + sides[2]) / 2.0
    h_px = (sides[1] + sides[3]) / 2.0
    if w_px <= 0 or h_px <= 0:
        return None
    return real_w_mm / w_px, real_h_mm / h_px


class CalibrationService:
    """Detect the green calibration rectangle and produce mm/px factors.

    The service is stateless apart from the executor reference; safe to share
    across requests. Auto detection is offloaded to the shared
    ``ThreadPoolExecutor`` so OpenCV work never blocks the event loop.
    """

    def __init__(self, executor: ThreadPoolExecutor) -> None:
        self._executor = executor

    # ── Public API ────────────────────────────────────────────────────────────

    def detect_with_ordered(
        self, image: np.ndarray, cfg: "LarvaeConfig"
    ) -> tuple[CalibrationCorners | None, np.ndarray | None]:
        """Detect once, return both the API-shape record AND the float corners.

        The float-precision ordered corners are required by callers that
        compute the perspective-warp matrix M — the reference pipeline uses
        full float precision, while ``CalibrationCorners.auto_corners`` is
        rounded to int for the DB / API contract. Returning both avoids
        running detection twice and keeps the warp matrix byte-identical to
        ``phenotyping_pipeline/2_inference/process_larvae.py``.
        """
        contour = _detect_green_rectangle(image)
        if contour is None:
            return None, None

        ordered = _order_points(contour.reshape(4, 2).astype(np.float32))
        factors = _compute_factors_from_ordered(
            ordered, cfg.calibration_object_w_mm, cfg.calibration_object_h_mm
        )
        if factors is None:
            return None, None
        mm_per_px_x, mm_per_px_y = factors

        record = CalibrationCorners(
            auto_corners=_corners_to_list(ordered),
            mm_per_px_x=mm_per_px_x,
            mm_per_px_y=mm_per_px_y,
            calibration_object_w_mm=cfg.calibration_object_w_mm,
            calibration_object_h_mm=cfg.calibration_object_h_mm,
            detection_status="detected",
        )
        return record, ordered

    def detect(
        self, image: np.ndarray, cfg: "LarvaeConfig"
    ) -> CalibrationCorners | None:
        """Synchronous auto-detect entry point used by tests and the async wrapper.

        Returns ``None`` if no calibration rectangle was found. On a successful
        detection the returned ``CalibrationCorners`` has ``detection_status =
        'detected'`` plus mm/px factors computed against the configured
        calibration object size.
        """
        record, _ = self.detect_with_ordered(image, cfg)
        return record

    async def detect_async(
        self, image: np.ndarray, cfg: "LarvaeConfig"
    ) -> CalibrationCorners:
        """Auto-detect in the executor; return a ``failed`` record on a clean miss.

        Never raises for "no rectangle found"; only true exceptional errors
        (e.g. an invalid input image array) propagate.
        """
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            self._executor, lambda: self.detect(image, cfg)
        )
        if result is not None:
            return result

        logger.info(
            "Calibration auto-detect found no green rectangle",
            extra={
                "context": {
                    "calibration_object_w_mm": cfg.calibration_object_w_mm,
                    "calibration_object_h_mm": cfg.calibration_object_h_mm,
                }
            },
        )
        return CalibrationCorners(
            auto_corners=None,
            mm_per_px_x=None,
            mm_per_px_y=None,
            calibration_object_w_mm=cfg.calibration_object_w_mm,
            calibration_object_h_mm=cfg.calibration_object_h_mm,
            detection_status="failed",
        )

    def apply_manual_corners(
        self, corners: list[tuple[int, int]], cfg: "LarvaeConfig"
    ) -> CalibrationCorners:
        """Build a ``manual`` calibration record from 4 user-supplied points."""
        if len(corners) != 4:
            raise ValueError(
                f"apply_manual_corners requires exactly 4 corners, got {len(corners)}"
            )

        pts = np.array(corners, dtype=np.float32)
        ordered = _order_points(pts)
        factors = _compute_factors_from_ordered(
            ordered, cfg.calibration_object_w_mm, cfg.calibration_object_h_mm
        )
        if factors is None:
            raise ValueError(
                "Manual calibration corners are degenerate (zero width or height)."
            )
        mm_per_px_x, mm_per_px_y = factors

        return CalibrationCorners(
            edited_corners=_corners_to_list(ordered),
            mm_per_px_x=mm_per_px_x,
            mm_per_px_y=mm_per_px_y,
            calibration_object_w_mm=cfg.calibration_object_w_mm,
            calibration_object_h_mm=cfg.calibration_object_h_mm,
            detection_status="manual",
        )

    @staticmethod
    def compute_factors(
        corners: np.ndarray, real_w_mm: float, real_h_mm: float
    ) -> tuple[float, float]:
        """Compute (mm_per_px_x, mm_per_px_y) from an ordered 4×2 corner array.

        Raises ``ValueError`` for a degenerate rectangle so callers don't silently
        produce zero/inf factors. Use the service's higher-level methods for the
        non-raising path.
        """
        if corners.shape != (4, 2):
            raise ValueError(
                f"corners must be a 4x2 array of (x, y) points, got shape {corners.shape}"
            )
        ordered = _order_points(corners.astype(np.float32))
        factors = _compute_factors_from_ordered(ordered, real_w_mm, real_h_mm)
        if factors is None:
            raise ValueError(
                "Calibration rectangle is degenerate (zero width or height)."
            )
        return factors
