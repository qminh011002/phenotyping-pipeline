"""SAM refinement of polygons that are already persisted.

Count-only runs skip SAM during inference: the count is final after dedup and
SAM only tightens outlines. When the operator later wants size measurements
they can refine the stored polygons first — this module does that.

Stored polygons live in the perspective-warped frame whenever calibration
produced corners. SAM is prompted on the raw image (as it is during
inference), so polygons are mapped warped → raw, refined, then mapped back.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analysis import AnalysisImage
from app.models.larvae import LarvaeMeasurement
from app.schemas.larvae import RefineResult
from app.services.image_artifacts import (
    mark_overlay_stale,
    raw_path_for,
    warped_path_for,
)
from app.services.inference.measurement import build_warp_matrix
from app.services.larvae_persistence import (
    list_detections_for_image,
    load_calibration,
)

if TYPE_CHECKING:
    from app.schemas.config import LarvaeConfig, PupaeConfig
    from app.services.inference.sam_refine import SamRefinementService

logger = logging.getLogger(__name__)


class RefineError(Exception):
    """The image's files are missing or unreadable."""


def _warp_for(
    overlay_path: Path, raw_shape: tuple[int, ...], corners: list | None
) -> tuple[np.ndarray, np.ndarray, tuple[int, int]] | None:
    """(H, H⁻¹, (warp_w, warp_h)) when stored polygons are in the warped frame."""
    if not warped_path_for(overlay_path).exists() or not corners or len(corners) != 4:
        return None
    built = build_warp_matrix(raw_shape, np.array(corners, dtype=np.float32))
    if built is None:
        return None
    matrix, size, _roi = built
    try:
        inverse = np.linalg.inv(matrix)
    except np.linalg.LinAlgError:
        return None
    return matrix, inverse, size


async def refine_stored_polygons(
    image: AnalysisImage,
    overlay_path: Path,
    sam_svc: SamRefinementService,
    cfg: LarvaeConfig | PupaeConfig,
    db: AsyncSession,
) -> RefineResult:
    """Refine the model polygons of one stored image with SAM.

    User-drawn detections and polygons the operator has edited are never
    touched. Detections SAM cannot improve keep their current polygon.
    Stages writes on ``db``; the caller commits.
    """
    raw_path = raw_path_for(overlay_path)
    if raw_path is None or not raw_path.exists():
        raise RefineError(f"Raw image not found near {overlay_path}")
    raw = await asyncio.to_thread(cv2.imread, str(raw_path))
    if raw is None:
        raise RefineError(f"Could not decode raw image at {raw_path}")

    detections = await list_detections_for_image(image.id, db)
    targets = [d for d in detections if d.origin != "user" and d.edited_polygon is None]
    untouched = len(detections) - len(targets)

    calibration = await load_calibration(image.id, db)
    corners = None
    if calibration is not None and calibration.detection_status != "failed":
        corners = calibration.edited_corners or calibration.auto_corners
    warp = _warp_for(overlay_path, raw.shape, corners)

    candidates: list[dict[str, Any]] = []
    for det in targets:
        pts = np.array(det.polygon, dtype=np.float32).reshape(-1, 1, 2)
        if warp is not None:
            pts = cv2.perspectiveTransform(pts, warp[1])
        poly = pts.reshape(-1, 2)
        confidence = float(det.confidence)
        candidates.append(
            {
                "polygon": poly,
                "bbox": (
                    int(poly[:, 0].min()),
                    int(poly[:, 1].min()),
                    int(poly[:, 0].max()),
                    int(poly[:, 1].max()),
                ),
                "area": float(cv2.contourArea(poly)),
                "confidence": confidence,
                "score": confidence,
            }
        )

    # The per-run override: refine even when the organism's config has SAM
    # switched off — the operator asked for it explicitly.
    sam_cfg = cfg.model_copy(
        update={"sam": cfg.sam.model_copy(update={"enabled": True})}
    )
    refined = await sam_svc.refine_candidates_async(raw, candidates, sam_cfg)

    threshold = float(sam_cfg.sam.confidence_threshold)
    n_refined = n_failed = n_below = 0
    refined_ids = []
    for det, before, after in zip(targets, candidates, refined, strict=True):
        if after is before:
            if before["confidence"] < threshold:
                n_below += 1
            else:
                n_failed += 1
            continue
        pts = np.asarray(after["polygon"], dtype=np.float32).reshape(-1, 1, 2)
        if warp is not None:
            pts = cv2.perspectiveTransform(pts, warp[0])
            pts[:, 0, 0] = np.clip(pts[:, 0, 0], 0, warp[2][0] - 1)
            pts[:, 0, 1] = np.clip(pts[:, 0, 1], 0, warp[2][1] - 1)
        poly_int = pts.reshape(-1, 2).astype(np.int32)
        if len(poly_int) < 3 or cv2.contourArea(poly_int) <= 0:
            n_failed += 1
            continue
        det.polygon = [[int(x), int(y)] for x, y in poly_int]
        det.bbox = {
            "x1": int(poly_int[:, 0].min()),
            "y1": int(poly_int[:, 1].min()),
            "x2": int(poly_int[:, 0].max()),
            "y2": int(poly_int[:, 1].max()),
        }
        det.area_px = int(cv2.contourArea(poly_int))
        refined_ids.append(det.id)
        n_refined += 1

    if refined_ids:
        await db.execute(
            update(LarvaeMeasurement)
            .where(LarvaeMeasurement.detection_id.in_(refined_ids))
            .values(is_stale=True)
        )
        mark_overlay_stale(overlay_path)
    image.sam_refined = True
    await db.flush()

    logger.info(
        "Refined stored polygons with SAM",
        extra={
            "context": {
                "image_id": str(image.id),
                "refined": n_refined,
                "failed": n_failed,
                "skipped": untouched + n_below,
            }
        },
    )
    return RefineResult(
        image_id=str(image.id),
        refined=n_refined,
        skipped=untouched + n_below,
        failed=n_failed,
        total=len(detections),
    )
