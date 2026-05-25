"""Persistence helpers for larvae detection / calibration / measurement (BE-034).

All functions take an ``AsyncSession`` and stage SQL writes inside a single
transaction — the caller commits. None of these helpers commit on their own,
so a router can compose multiple writes (e.g. save_detections + save_calibration)
into one atomic unit.

`load_batch_for_user` is the read path that powers ``GET /analyses/{id}/larvae``.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.analysis import AnalysisBatch, AnalysisImage
from app.models.larvae import LarvaeCalibration, LarvaeDetection, LarvaeMeasurement
from app.schemas.calibration import CalibrationCorners
from app.schemas.larvae import (
    LarvaeAnnotation,
    LarvaeBatchDetail,
    LarvaeImageDetail,
    LarvaeMeasurement as LarvaeMeasurementSchema,
    StoredLarvaeAnnotation,
)

logger = logging.getLogger(__name__)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _bbox_dict(bbox: tuple[int, int, int, int]) -> dict[str, int]:
    x1, y1, x2, y2 = bbox
    return {"x1": int(x1), "y1": int(y1), "x2": int(x2), "y2": int(y2)}


def _polygon_jsonb(polygon: list[tuple[int, int]]) -> list[list[int]]:
    return [[int(x), int(y)] for x, y in polygon]


def _polygon_bbox_and_area(polygon: list[tuple[int, int]]) -> tuple[dict[str, int], int]:
    xs = [int(x) for x, _ in polygon]
    ys = [int(y) for _, y in polygon]
    bbox = {
        "x1": min(xs),
        "y1": min(ys),
        "x2": max(xs),
        "y2": max(ys),
    }
    twice_area = 0
    for idx, (x1, y1) in enumerate(polygon):
        x2, y2 = polygon[(idx + 1) % len(polygon)]
        twice_area += int(x1) * int(y2) - int(x2) * int(y1)
    return bbox, int(abs(twice_area) / 2)


# ── Detections ────────────────────────────────────────────────────────────────


async def save_detections(
    image_id: UUID,
    annotations: list[LarvaeAnnotation],
    model_version: str | None,
    db: AsyncSession,
) -> list[LarvaeDetection]:
    """Replace all existing detections for ``image_id`` with the supplied set.

    The replace semantics keep the per-image detection set in lockstep with the
    most recent inference run; if a polygon disappears between runs we don't
    leave an orphan row.
    """
    await db.execute(
        delete(LarvaeDetection).where(LarvaeDetection.image_id == image_id)
    )

    rows: list[LarvaeDetection] = []
    for ann in annotations:
        row = LarvaeDetection(
            id=uuid.uuid4(),
            image_id=image_id,
            polygon=_polygon_jsonb(list(ann.polygon)),
            bbox=_bbox_dict(ann.bbox),
            confidence=float(ann.confidence),
            area_px=int(ann.area_px),
            model_version=model_version,
            origin=ann.origin,
        )
        db.add(row)
        rows.append(row)
    await db.flush()
    logger.info(
        "Saved %d larvae detections", len(rows),
        extra={"context": {"image_id": str(image_id), "count": len(rows)}},
    )
    return rows


# ── Calibration ───────────────────────────────────────────────────────────────


async def save_calibration(
    image_id: UUID,
    corners: CalibrationCorners,
    db: AsyncSession,
) -> LarvaeCalibration:
    """Upsert the calibration row for ``image_id``.

    A single row exists per image (UNIQUE on image_id). The status flows
    ``detected`` → ``manual`` (or ``failed``) as the operator iterates.
    """
    existing = (
        await db.execute(
            select(LarvaeCalibration).where(LarvaeCalibration.image_id == image_id)
        )
    ).scalar_one_or_none()

    auto = list(corners.auto_corners) if corners.auto_corners else None
    edited = list(corners.edited_corners) if corners.edited_corners else None

    if existing is None:
        row = LarvaeCalibration(
            id=uuid.uuid4(),
            image_id=image_id,
            auto_corners=[list(p) for p in auto] if auto else None,
            edited_corners=[list(p) for p in edited] if edited else None,
            mm_per_px_x=corners.mm_per_px_x,
            mm_per_px_y=corners.mm_per_px_y,
            calibration_object_w_mm=corners.calibration_object_w_mm,
            calibration_object_h_mm=corners.calibration_object_h_mm,
            detection_status=corners.detection_status,
        )
        db.add(row)
    else:
        if auto is not None:
            existing.auto_corners = [list(p) for p in auto]
        if edited is not None:
            existing.edited_corners = [list(p) for p in edited]
        existing.mm_per_px_x = corners.mm_per_px_x
        existing.mm_per_px_y = corners.mm_per_px_y
        existing.calibration_object_w_mm = corners.calibration_object_w_mm
        existing.calibration_object_h_mm = corners.calibration_object_h_mm
        existing.detection_status = corners.detection_status
        existing.updated_at = _now_utc()
        row = existing

    # If calibration changed, all measurements for this image become stale.
    await db.execute(
        update(LarvaeMeasurement)
        .where(
            LarvaeMeasurement.detection_id.in_(
                select(LarvaeDetection.id).where(
                    LarvaeDetection.image_id == image_id
                )
            )
        )
        .values(is_stale=True)
    )

    await db.flush()
    return row


async def load_calibration(
    image_id: UUID, db: AsyncSession
) -> CalibrationCorners | None:
    row = (
        await db.execute(
            select(LarvaeCalibration).where(LarvaeCalibration.image_id == image_id)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    return _calibration_to_schema(row)


def _calibration_to_schema(row: LarvaeCalibration) -> CalibrationCorners:
    auto = (
        [(int(p[0]), int(p[1])) for p in row.auto_corners]
        if row.auto_corners
        else None
    )
    edited = (
        [(int(p[0]), int(p[1])) for p in row.edited_corners]
        if row.edited_corners
        else None
    )
    return CalibrationCorners(
        image_id=str(row.image_id),
        auto_corners=auto,
        edited_corners=edited,
        mm_per_px_x=row.mm_per_px_x,
        mm_per_px_y=row.mm_per_px_y,
        calibration_object_w_mm=row.calibration_object_w_mm,
        calibration_object_h_mm=row.calibration_object_h_mm,
        detection_status=row.detection_status,
    )


# ── Measurements ──────────────────────────────────────────────────────────────


async def save_measurements(
    image_id: UUID,
    measurements: list[tuple[UUID, LarvaeMeasurementSchema]],
    db: AsyncSession,
) -> list[LarvaeMeasurement]:
    """Replace all measurements for the image's detections.

    Each ``(detection_id, measurement)`` pair becomes one row. Existing
    measurements for any detection in this image are deleted first to keep
    the call idempotent — running ``POST /measure/larvae`` twice yields one
    row per detection, never two.
    """
    detection_ids = [
        d
        for d in (
            await db.execute(
                select(LarvaeDetection.id).where(
                    LarvaeDetection.image_id == image_id
                )
            )
        ).scalars()
    ]
    if detection_ids:
        await db.execute(
            delete(LarvaeMeasurement).where(
                LarvaeMeasurement.detection_id.in_(detection_ids)
            )
        )

    rows: list[LarvaeMeasurement] = []
    for det_id, m in measurements:
        row = LarvaeMeasurement(
            id=uuid.uuid4(),
            detection_id=det_id,
            length_mm=m.length_mm,
            min_width_mm=m.min_width_mm,
            max_width_mm=m.max_width_mm,
            average_width_mm=m.average_width_mm,
            area_mm2=m.area_mm2,
            volume_mm3=m.volume_mm3,
            centerline=(
                [[float(p[0]), float(p[1])] for p in m.centerline]
                if m.centerline
                else None
            ),
            widths=[float(w) for w in m.widths] if m.widths else None,
            weight_mg=m.weight_mg,
            is_stale=False,
            measured_at=m.measured_at or _now_utc(),
        )
        db.add(row)
        rows.append(row)
    await db.flush()
    return rows


# ── Polygon edits ─────────────────────────────────────────────────────────────


async def update_polygons(
    image_id: UUID,
    edits: list[tuple[UUID | None, list[tuple[int, int]]]],
    user_id: UUID,
    db: AsyncSession,
    deleted_ids: list[UUID] | None = None,
) -> tuple[int, int]:
    """Apply user polygon edits.

    For each ``(detection_id, polygon)``:
      - ``detection_id is None`` creates a new user-origin detection
      - Existing ids set ``edited_polygon`` on the detection
      - ``deleted_ids`` removes existing detections from the image
      - Stamps ``edited_at`` and ``edited_by``
      - Flips the matching ``larvae_measurement`` row to ``is_stale=True``

    Returns ``(updated_or_created, deleted)``. Existing detections that don't
    belong to ``image_id`` are silently ignored — the caller has already
    verified the image's batch ownership.
    """
    deleted_ids = deleted_ids or []
    if not edits and not deleted_ids:
        return 0, 0

    valid_ids = {
        det_id
        for det_id in (
            await db.execute(
                select(LarvaeDetection.id).where(
                    LarvaeDetection.image_id == image_id
                )
            )
        ).scalars()
    }

    delete_set = {det_id for det_id in deleted_ids if det_id in valid_ids}
    if delete_set:
        await db.execute(
            delete(LarvaeDetection).where(LarvaeDetection.id.in_(delete_set))
        )
        valid_ids.difference_update(delete_set)

    now = _now_utc()
    touched = 0
    for det_id, polygon in edits:
        if det_id is None:
            bbox, area_px = _polygon_bbox_and_area(polygon)
            row = LarvaeDetection(
                id=uuid.uuid4(),
                image_id=image_id,
                polygon=_polygon_jsonb(polygon),
                bbox=bbox,
                confidence=1.0,
                area_px=area_px,
                model_version=None,
                edited_at=now,
                edited_by=user_id,
                origin="user",
            )
            db.add(row)
            touched += 1
            continue

        if det_id not in valid_ids:
            continue
        await db.execute(
            update(LarvaeDetection)
            .where(LarvaeDetection.id == det_id)
            .values(
                edited_polygon=_polygon_jsonb(polygon),
                edited_at=now,
                edited_by=user_id,
            )
        )
        touched += 1

    edited_ids = [det_id for det_id, _ in edits if det_id in valid_ids]
    if edited_ids:
        # Mark every measurement linked to one of the edited detections as stale.
        await db.execute(
            update(LarvaeMeasurement)
            .where(LarvaeMeasurement.detection_id.in_(edited_ids))
            .values(is_stale=True)
        )

    await db.flush()
    return touched, len(delete_set)


# ── Read path ────────────────────────────────────────────────────────────────


async def load_batch_for_user(
    batch_id: UUID, user_id: UUID, db: AsyncSession
) -> LarvaeBatchDetail | None:
    """Joined load: batch + images + detections + calibration + measurements.

    Returns ``None`` if the batch does not exist for this user (404).
    """
    batch = (
        await db.execute(
            select(AnalysisBatch)
            .options(selectinload(AnalysisBatch.images))
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
    ).scalar_one_or_none()
    if batch is None:
        return None

    image_ids = [img.id for img in batch.images]
    detections_by_image: dict[UUID, list[LarvaeDetection]] = {
        i: [] for i in image_ids
    }
    if image_ids:
        for det in (
            await db.execute(
                select(LarvaeDetection).where(
                    LarvaeDetection.image_id.in_(image_ids)
                )
            )
        ).scalars():
            detections_by_image.setdefault(det.image_id, []).append(det)

    calibrations_by_image: dict[UUID, LarvaeCalibration] = {}
    if image_ids:
        for cal in (
            await db.execute(
                select(LarvaeCalibration).where(
                    LarvaeCalibration.image_id.in_(image_ids)
                )
            )
        ).scalars():
            calibrations_by_image[cal.image_id] = cal

    measurements_by_detection: dict[UUID, LarvaeMeasurement] = {}
    all_det_ids = [d.id for dets in detections_by_image.values() for d in dets]
    if all_det_ids:
        for m in (
            await db.execute(
                select(LarvaeMeasurement).where(
                    LarvaeMeasurement.detection_id.in_(all_det_ids)
                )
            )
        ).scalars():
            measurements_by_detection[m.detection_id] = m

    images: list[LarvaeImageDetail] = []
    for img in batch.images:
        dets = detections_by_image.get(img.id, [])
        cal_row = calibrations_by_image.get(img.id)

        stored_anns = [_detection_to_stored_schema(d) for d in dets]
        m_rows = [
            _measurement_to_schema(measurements_by_detection[d.id])
            for d in dets
            if d.id in measurements_by_detection
        ]

        # Build URLs for the editor + ruler flow. ``overlay_path`` in the DB
        # is the relative ``{batch_id}/{stem}_overlay.png`` token; turn it into
        # the API routes the frontend already knows how to fetch with auth.
        overlay_url: str | None = None
        warped_url: str | None = None
        raw_url: str | None = None
        if img.overlay_path:
            stem = Path(img.overlay_path).name.removesuffix("_overlay.png")
            overlay_url = f"/inference/results/{batch.id}/{stem}/overlay.png"
            warped_url = f"/inference/results/{batch.id}/{stem}/warped.png"
            raw_url = f"/analyses/{batch.id}/images/{img.id}/raw"

        images.append(
            LarvaeImageDetail(
                image_id=str(img.id),
                original_filename=img.original_filename,
                overlay_url=overlay_url,
                warped_url=warped_url,
                raw_url=raw_url,
                elapsed_secs=img.elapsed_secs,
                detections=stored_anns,
                calibration=_calibration_to_schema(cal_row) if cal_row else None,
                measurements=m_rows,
            )
        )

    snapshot = batch.config_snapshot or {}
    return LarvaeBatchDetail(
        batch_id=str(batch.id),
        name=batch.name,
        organism="larvae",
        status=batch.status,
        total_image_count=batch.total_image_count,
        detection_model=snapshot.get("detection_model"),
        sam_model=snapshot.get("sam_model"),
        images=images,
    )


def _detection_to_stored_schema(d: LarvaeDetection) -> StoredLarvaeAnnotation:
    bbox = d.bbox
    if isinstance(bbox, dict):
        bbox_t = (
            int(bbox.get("x1", 0)),
            int(bbox.get("y1", 0)),
            int(bbox.get("x2", 0)),
            int(bbox.get("y2", 0)),
        )
    else:
        bbox_t = tuple(int(v) for v in bbox)  # type: ignore[assignment]

    polygon = [(int(p[0]), int(p[1])) for p in d.polygon]
    edited_polygon = (
        [(int(p[0]), int(p[1])) for p in d.edited_polygon]
        if d.edited_polygon
        else None
    )
    return StoredLarvaeAnnotation(
        detection_id=str(d.id),
        label="larvae",
        polygon=polygon,
        bbox=bbox_t,  # type: ignore[arg-type]
        confidence=float(d.confidence),
        area_px=int(d.area_px or 0),
        origin=d.origin or "model",
        edited_polygon=edited_polygon,
        edited_at=d.edited_at.isoformat() if d.edited_at else None,
    )


def _measurement_to_schema(m: LarvaeMeasurement) -> LarvaeMeasurementSchema:
    centerline = (
        [(float(p[0]), float(p[1])) for p in m.centerline]
        if m.centerline
        else None
    )
    widths = [float(w) for w in m.widths] if m.widths else None
    return LarvaeMeasurementSchema(
        detection_id=str(m.detection_id),
        length_mm=m.length_mm,
        min_width_mm=m.min_width_mm,
        max_width_mm=m.max_width_mm,
        average_width_mm=m.average_width_mm,
        area_mm2=m.area_mm2,
        volume_mm3=m.volume_mm3,
        centerline=centerline,
        widths=widths,
        weight_mg=m.weight_mg,
        is_stale=bool(m.is_stale),
        measured_at=m.measured_at,
    )


# ── Image lookup helpers (router uses these) ──────────────────────────────────


async def get_image_for_user(
    image_id: UUID, user_id: UUID, db: AsyncSession
) -> AnalysisImage | None:
    """Return the AnalysisImage row if it belongs to one of the user's batches."""
    stmt = (
        select(AnalysisImage)
        .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
        .where(AnalysisImage.id == image_id)
        .where(AnalysisBatch.user_id == user_id)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


def resolve_overlay_path(image: AnalysisImage, storage_dir: Path) -> Path | None:
    """Resolve the on-disk overlay PNG path for an AnalysisImage row.

    Returns ``None`` if the image hasn't been processed yet. The corresponding
    raw upload sits next to it under the same prefix with ``_raw.<ext>``.
    """
    if not image.overlay_path:
        return None
    p = Path(image.overlay_path)
    if not p.is_absolute():
        p = storage_dir / p
    return p


def resolve_raw_path(overlay_path: Path) -> Path | None:
    """Find the raw image file written alongside the overlay (same stem)."""
    raw_stem = overlay_path.name.replace("_overlay.png", "_raw")
    candidates = sorted(overlay_path.parent.glob(f"{raw_stem}.*"))
    return candidates[0] if candidates else None


def resolve_warped_path(overlay_path: Path) -> Path:
    """Path to the warped raw PNG (no marks) sitting next to the overlay.

    Written by ``LarvaeInferenceService`` only when auto-calibration succeeds.
    Callers must ``.exists()``-check the result.
    """
    return overlay_path.parent / overlay_path.name.replace(
        "_overlay.png", "_warped.png"
    )


async def list_detections_for_image(
    image_id: UUID, db: AsyncSession
) -> list[LarvaeDetection]:
    return list(
        (
            await db.execute(
                select(LarvaeDetection)
                .where(LarvaeDetection.image_id == image_id)
                .order_by(LarvaeDetection.created_at)
            )
        ).scalars()
    )
