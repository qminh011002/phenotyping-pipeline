"""Larvae HTTP endpoints (BE-034).

Single router exposing the seven larvae-flow operations:

  POST  /inference/larvae?batch_id=...
  POST  /calibration/detect?image_id=...
  PUT   /calibration/{image_id}
  POST  /measure/larvae?image_id=...
  GET   /analyses/{batch_id}/larvae
  GET   /analyses/{batch_id}/larvae/csv
  PUT   /analyses/{batch_id}/images/{image_id}/polygons

All endpoints require auth and filter by ``CurrentUser``; cross-user access
returns 404 (per BE-020/BE-021). CV work is awaited on the inference services
so the asyncio loop never blocks.
"""

from __future__ import annotations

import asyncio
import csv
import io
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, AsyncIterator
from uuid import UUID

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.database import AsyncSession, get_session
from app.deps import (
    AnnotatedCalibrationService,
    AnnotatedLarvaeInferenceService,
    AnnotatedLarvaeMeasurementService,
    AnnotatedSamRefinementService,
    CurrentUser,
    get_analysis_service,
    get_cached_storage_dir,
    get_model_registry,
    get_pipeline_config,
)
from app.models.analysis import AnalysisBatch, AnalysisImage
from app.models.larvae import LarvaeDetection, LarvaeMeasurement
from app.routers.inference_utils import (
    ensure_status_loaded,
    map_inference_error,
    parse_and_verify_optional_batch,
    read_image_upload,
    unique_stem_in_batch,
    validate_image_extension,
    verify_batch_owned,
)
from app.schemas.calibration import CalibrationCorners, CalibrationUpdate
from app.schemas.larvae import (
    ImageTotalWeightResult,
    ImageTotalWeightUpdate,
    LarvaeBatchDetail,
    LarvaeDetectionResult,
    LarvaeImageDetail,
    LarvaeMeasurementResult,
    MeasureLarvaeRequest,
    PolygonsUpdate,
    RefineResult,
)
from app.schemas.pupae import (
    MeasurePupaeRequest,
    PupaeBatchDetail,
    PupaeImageDetail,
    PupaeMeasurement,
    PupaeMeasurementResult,
)
from app.services.analysis_service import AnalysisService
from app.services.image_artifacts import mark_overlay_rendered, mark_overlay_stale
from app.services.inference.egg import InvalidImageError
from app.services.inference.measurement import build_warp_matrix
from app.services.larvae_persistence import (
    RestoredDetection,
    get_image_for_user,
    list_detections_for_image,
    load_batch_for_user,
    load_calibration,
    load_image_for_user,
    resolve_overlay_path,
    resolve_raw_path,
    resolve_warped_path,
    save_calibration,
    save_measurements,
    set_image_total_weight,
    sync_image_count,
    update_polygons,
)
from app.services.model_registry import ModelNotLoadedError
from app.services.polygon_refine import RefineError, refine_stored_polygons

logger = logging.getLogger(__name__)

router = APIRouter(tags=["larvae"])

# Cyan #00FFFF in BGR — matches the inference-time polygon stroke and the
# editor SVG. Centralised so re-render after manual calibration stays in sync.
_POLYGON_COLOR_BGR: tuple[int, int, int] = (255, 255, 0)
_POLYGON_COLORS_BGR: dict[str, tuple[int, int, int]] = {
    "larvae": (255, 255, 0),
    "pupae": (0, 255, 255),
}


def _warp_and_draw(
    raw_path: Path,
    overlay_path: Path,
    new_corners: list[tuple[int, int]],
    old_corners: list[tuple[int, int]] | None,
    source_polygons: list[list],
    polygon_color_bgr: tuple[int, int, int],
) -> list[np.ndarray] | None:
    """CV half of the calibration re-render (runs in a worker thread).

    Warps the raw image with ``new_corners``, maps every polygon into the new
    warped frame via ``H_new ∘ H_old⁻¹`` and rewrites ``_overlay.png`` /
    ``_warped.png``. Returns the re-warped polygons, or ``None`` when the raw
    image or the corner set is unusable.
    """
    img = cv2.imread(str(raw_path))
    if img is None:
        return None

    built_new = build_warp_matrix(img.shape, np.array(new_corners, dtype=np.float32))
    if built_new is None:
        return None
    matrix_new, (warp_w, warp_h), _ = built_new

    # ``old_corners is None`` ↔ polygons are still in raw-image space because
    # auto-calibration had failed.
    inv_old: np.ndarray | None = None
    if old_corners is not None:
        built_old = build_warp_matrix(
            img.shape, np.array(old_corners, dtype=np.float32)
        )
        if built_old is not None:
            try:
                inv_old = np.linalg.inv(built_old[0])
            except np.linalg.LinAlgError:
                inv_old = None

    new_polygons: list[np.ndarray] = []
    for src_poly in source_polygons:
        pts = np.array(src_poly, dtype=np.float32).reshape(-1, 1, 2)
        if inv_old is not None:
            pts = cv2.perspectiveTransform(pts, inv_old)
        warped_pts = cv2.perspectiveTransform(pts, matrix_new).reshape(-1, 2)
        warped_pts[:, 0] = np.clip(warped_pts[:, 0], 0, warp_w - 1)
        warped_pts[:, 1] = np.clip(warped_pts[:, 1], 0, warp_h - 1)
        new_polygons.append(warped_pts.astype(np.int32))

    try:
        warped_img = cv2.warpPerspective(img, matrix_new, (warp_w, warp_h))
    except cv2.error:
        return None

    overlay = warped_img.copy()
    for poly in new_polygons:
        cv2.polylines(overlay, [poly], True, polygon_color_bgr, 2)

    png_params = [cv2.IMWRITE_PNG_COMPRESSION, 1]
    cv2.imwrite(str(overlay_path), overlay, png_params)
    cv2.imwrite(str(resolve_warped_path(overlay_path)), warped_img, png_params)
    mark_overlay_rendered(overlay_path)
    return new_polygons


async def _rerender_after_calibration(
    image_id: UUID,
    overlay_path: Path,
    raw_path: Path,
    new_corners: list[tuple[int, int]],
    old_corners: list[tuple[int, int]] | None,
    db: AsyncSession,
    polygon_color_bgr: tuple[int, int, int] = _POLYGON_COLOR_BGR,
) -> None:
    """Warp the raw image with ``new_corners``, transform every persisted
    polygon into the new warped frame, and re-write ``_overlay.png`` /
    ``_warped.png`` so the editor reflects the operator's calibration choice.

    ``old_corners`` is the calibration the polygons are *currently* expressed
    in (None ↔ polygons are still in raw image coords because auto-detect had
    failed). Polygons keep their visual position on the larva.
    """
    detections = await list_detections_for_image(image_id, db)
    new_polygons = await asyncio.to_thread(
        _warp_and_draw,
        raw_path,
        overlay_path,
        new_corners,
        old_corners,
        [det.edited_polygon or det.polygon for det in detections],
        polygon_color_bgr,
    )
    if new_polygons is None:
        logger.warning(
            "Re-render skipped — raw image unreadable or corners degenerate",
            extra={"context": {"image_id": str(image_id), "raw_path": str(raw_path)}},
        )
        return

    # Persist the re-warped polygons so future reads see the right space.
    for det, warped_int in zip(detections, new_polygons, strict=True):
        det.polygon = [[int(x), int(y)] for x, y in warped_int]
        det.bbox = {
            "x1": int(warped_int[:, 0].min()),
            "y1": int(warped_int[:, 1].min()),
            "x2": int(warped_int[:, 0].max()),
            "y2": int(warped_int[:, 1].max()),
        }
        if det.edited_polygon is not None:
            det.edited_polygon = det.polygon
    await db.flush()


async def _image_organism(image: AnalysisImage, db: AsyncSession) -> str:
    organism = (
        await db.execute(
            select(AnalysisBatch.organism_type).where(
                AnalysisBatch.id == image.batch_id
            )
        )
    ).scalar_one_or_none()
    return organism if organism in ("larvae", "pupae") else "larvae"


def _polygon_config_for(organism: str):
    cfg_mgr = get_pipeline_config()
    if organism == "pupae":
        return cfg_mgr.get_pupae_config()
    return cfg_mgr.get_larvae_config()


def _measurement_response_schema(organism: str):
    return PupaeMeasurementResult if organism == "pupae" else LarvaeMeasurementResult


# ─────────────────────────────────────────────────────────────────────────────
# POST /inference/larvae
# ─────────────────────────────────────────────────────────────────────────────


@router.post(
    "/inference/larvae",
    response_model=LarvaeDetectionResult,
    status_code=status.HTTP_200_OK,
    summary="Run larvae segmentation on a single image",
)
async def run_larvae_inference(
    inference_svc: AnnotatedLarvaeInferenceService,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
    file: Annotated[UploadFile, File(description="Image file (JPG, PNG, TIFF, BMP)")],
    batch_id: Annotated[
        str | None,
        Query(description="Persist results into this batch (must be owned by caller)"),
    ] = None,
    count_only: Annotated[
        bool,
        Query(
            description=(
                "Skip SAM polygon refinement. The count is unaffected; outlines "
                "stay at YOLO precision and can be refined later via "
                "POST /analyses/{batch_id}/images/{image_id}/refine."
            )
        ),
    ] = False,
) -> LarvaeDetectionResult:
    stem, suffix = validate_image_extension(file.filename or "unknown")
    bid = await parse_and_verify_optional_batch(batch_id, db, user.id)
    stem = await unique_stem_in_batch(bid, stem, db)

    registry = get_model_registry()
    ensure_status_loaded(registry, "larvae", "Larvae")
    data = await read_image_upload(file)

    resolved_batch_id = batch_id or str(uuid.uuid4())

    # The router accepts ad-hoc inference (no batch_id) for parity with the
    # egg flow. Either way no DB row is written here — the caller registers
    # the image via POST /analyses/{batch_id}/images using this result.
    try:
        return await inference_svc.process_single(
            data,
            stem,
            resolved_batch_id,
            raw_suffix=suffix,
            refine=False if count_only else None,
        )
    except (InvalidImageError, ModelNotLoadedError) as exc:
        raise map_inference_error(exc) from exc


# ─────────────────────────────────────────────────────────────────────────────
# POST /calibration/detect
# ─────────────────────────────────────────────────────────────────────────────


@router.post(
    "/calibration/detect",
    response_model=CalibrationCorners,
    status_code=status.HTTP_200_OK,
    summary="Re-run auto-calibration on a stored image",
)
async def detect_calibration(
    calibration_svc: AnnotatedCalibrationService,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
    image_id: Annotated[UUID, Query(description="Stored analysis_image.id")],
) -> CalibrationCorners:
    image = await get_image_for_user(image_id, user.id, db)
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} not found.",
        )

    storage_dir = Path(get_cached_storage_dir())
    overlay_path = resolve_overlay_path(image, storage_dir)
    if overlay_path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} has no completed result.",
        )
    raw_path = resolve_raw_path(overlay_path)
    if raw_path is None or not raw_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Raw image not found near {overlay_path}",
        )

    img = await asyncio.to_thread(cv2.imread, str(raw_path))
    if img is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Could not decode raw image at {raw_path}",
        )

    organism = await _image_organism(image, db)
    cfg = _polygon_config_for(organism)
    corners = await calibration_svc.detect_async(img, cfg)
    corners = corners.model_copy(update={"image_id": str(image_id)})

    await save_calibration(image_id, corners, db)
    await db.commit()
    return corners


# ─────────────────────────────────────────────────────────────────────────────
# PUT /calibration/{image_id}
# ─────────────────────────────────────────────────────────────────────────────


@router.put(
    "/calibration/{image_id}",
    response_model=CalibrationCorners,
    status_code=status.HTTP_200_OK,
    summary="Save operator-supplied calibration corners or factors",
)
async def update_calibration(
    image_id: UUID,
    payload: CalibrationUpdate,
    calibration_svc: AnnotatedCalibrationService,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> CalibrationCorners:
    image = await get_image_for_user(image_id, user.id, db)
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} not found.",
        )

    organism = await _image_organism(image, db)
    cfg = _polygon_config_for(organism)

    # Snapshot the corner set the persisted polygons are currently in, before
    # save_calibration overwrites it. Used to compose H_new ∘ H_old⁻¹ during
    # re-render so existing polygons land in the new warped frame.
    existing_cal = await load_calibration(image_id, db)
    old_corners: list[tuple[int, int]] | None = None
    if existing_cal is not None and existing_cal.detection_status != "failed":
        old_corners = list(existing_cal.edited_corners or existing_cal.auto_corners or [])  # type: ignore[arg-type]
        if len(old_corners) != 4:
            old_corners = None

    if payload.corners is not None:
        try:
            corners = calibration_svc.apply_manual_corners(list(payload.corners), cfg)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
            ) from exc
    else:
        corners = CalibrationCorners(
            image_id=str(image_id),
            edited_corners=None,
            mm_per_px_x=payload.mm_per_px_x,
            mm_per_px_y=payload.mm_per_px_y,
            calibration_object_w_mm=cfg.calibration_object_w_mm,
            calibration_object_h_mm=cfg.calibration_object_h_mm,
            detection_status="manual",
        )

    corners = corners.model_copy(update={"image_id": str(image_id)})
    await save_calibration(image_id, corners, db)

    # Re-render only when the operator gave us 4 corners — a mm/px-only update
    # has nothing to warp against and the previous overlay stays valid.
    if payload.corners is not None and corners.edited_corners is not None:
        storage_dir = Path(get_cached_storage_dir())
        overlay_path = resolve_overlay_path(image, storage_dir)
        if overlay_path is not None:
            raw_path = resolve_raw_path(overlay_path)
            if raw_path is not None and raw_path.exists():
                await _rerender_after_calibration(
                    image_id=image_id,
                    overlay_path=overlay_path,
                    raw_path=raw_path,
                    new_corners=[
                        (int(p[0]), int(p[1])) for p in corners.edited_corners
                    ],
                    old_corners=old_corners,
                    db=db,
                    polygon_color_bgr=_POLYGON_COLORS_BGR.get(
                        organism, _POLYGON_COLOR_BGR
                    ),
                )

    await db.commit()
    return corners


# ─────────────────────────────────────────────────────────────────────────────
# POST /measure/larvae
# ─────────────────────────────────────────────────────────────────────────────


async def _measure_polygon_image(
    organism_filter: str | None,
    measurement_svc: AnnotatedLarvaeMeasurementService,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
    image_id: UUID,
    body: MeasureLarvaeRequest | MeasurePupaeRequest | None = None,
) -> LarvaeMeasurementResult | PupaeMeasurementResult:
    image = await get_image_for_user(image_id, user.id, db)
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} not found.",
        )
    organism = await _image_organism(image, db)
    if organism_filter is not None and organism != organism_filter:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} is not a {organism_filter} image.",
        )
    response_schema = _measurement_response_schema(organism)

    detections = await list_detections_for_image(image_id, db)
    if not detections:
        return response_schema(
            image_id=str(image_id),
            calibration=await load_calibration(image_id, db),
            measurements=[],
            generated_at=datetime.now(timezone.utc),
        )

    polygons: list[list[tuple[int, int]]]
    if body is not None and body.polygon_overrides is not None:
        if len(body.polygon_overrides) != len(detections):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"polygon_overrides length ({len(body.polygon_overrides)}) "
                    f"must match detection count ({len(detections)})."
                ),
            )
        polygons = [
            [(int(x), int(y)) for x, y in poly] for poly in body.polygon_overrides
        ]
    else:
        polygons = [
            [(int(p[0]), int(p[1])) for p in (d.edited_polygon or d.polygon)]
            for d in detections
        ]

    calibration = await load_calibration(image_id, db)
    if calibration is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "No calibration available for this image — "
                "call /calibration/detect or PUT /calibration/{image_id} first."
            ),
        )

    storage_dir = Path(get_cached_storage_dir())
    overlay_path = resolve_overlay_path(image, storage_dir)
    if overlay_path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} has no overlay on disk.",
        )

    # When auto- or manual-calibration produced corners we read the cached
    # warped frame and skip a second warp; polygons are already in its space.
    polygons_already_warped = (
        calibration.detection_status != "failed"
        and (calibration.edited_corners or calibration.auto_corners) is not None
    )
    warped_path = resolve_warped_path(overlay_path)
    if polygons_already_warped and warped_path.exists():
        img = await asyncio.to_thread(cv2.imread, str(warped_path))
        if img is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Could not decode warped image at {warped_path}",
            )
    else:
        raw_path = resolve_raw_path(overlay_path)
        if raw_path is None or not raw_path.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Raw image not found near {overlay_path}",
            )
        img = await asyncio.to_thread(cv2.imread, str(raw_path))
        if img is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Could not decode raw image at {raw_path}",
            )
        polygons_already_warped = False

    cfg = _polygon_config_for(organism)
    # Keep polygon measurements numerically compatible with
    # phenotyping_pipeline/2_inference/process_larvae.py. Older batches may
    # carry a config_snapshot with "hybrid"; do not let that override the
    # reference Dijkstra + polynomial-fit path.
    cfg = cfg.model_copy(update={"centerline_method": "pipeline_compat"})
    detection_ids = [str(d.id) for d in detections]
    confidences = [float(d.confidence) for d in detections]
    measurements = await measurement_svc.measure_image_async(
        img,
        polygons,
        calibration,
        cfg,
        detection_ids=detection_ids,
        polygons_already_warped=polygons_already_warped,
        confidences=confidences,
    )

    pairs = list(zip([d.id for d in detections], measurements, strict=True))
    await save_measurements(image_id, pairs, db)

    # Re-measure replaces all rows with weight_mg=None; if the user previously
    # set a per-image total weight, redistribute it across the fresh rows so
    # per-object weight survives subsequent re-measures.
    if image.total_weight_mg is not None:
        await set_image_total_weight(image_id, image.total_weight_mg, db)
        total_area = sum(m.area_mm2 or 0.0 for m in measurements)
        for m in measurements:
            if total_area > 0 and m.area_mm2:
                m.weight_mg = (m.area_mm2 / total_area) * image.total_weight_mg
                m.weight_area_ratio = m.weight_mg / m.area_mm2
            else:
                m.weight_mg = 0.0

    await db.commit()

    # Measurement-viz PNG (centerlines + width ticks) next to the overlay.
    # Encoding a full-resolution PNG takes about as long as the measurement
    # itself, so it is written in the background instead of holding up the
    # response (and the event loop).
    def _write_viz() -> None:
        try:
            viz = measurement_svc.render_overlay(img, measurements)
            viz_path = overlay_path.parent / overlay_path.name.replace(
                "_overlay.png", "_measure.png"
            )
            cv2.imwrite(str(viz_path), viz, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        except (cv2.error, OSError) as exc:
            logger.warning(
                "Could not write measurement viz: %s",
                exc,
                extra={"context": {"image_id": str(image_id)}},
            )

    asyncio.get_running_loop().run_in_executor(None, _write_viz)

    # measurement_svc always returns LarvaeMeasurement (schema); when the image
    # belongs to a pupae batch the response model expects PupaeMeasurement.
    # Shapes are identical, so re-validate via model_dump().
    if response_schema is PupaeMeasurementResult:
        response_measurements = [
            PupaeMeasurement.model_validate(m.model_dump()) for m in measurements
        ]
    else:
        response_measurements = measurements

    return response_schema(
        image_id=str(image_id),
        calibration=calibration,
        measurements=response_measurements,
        generated_at=datetime.now(timezone.utc),
    )


@router.post(
    "/measure/larvae",
    response_model=LarvaeMeasurementResult | PupaeMeasurementResult,
    status_code=status.HTTP_200_OK,
    summary="Compute per-larva measurements on a stored image",
)
async def measure_larvae(
    measurement_svc: AnnotatedLarvaeMeasurementService,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
    image_id: Annotated[UUID, Query(description="Stored analysis_image.id")],
    body: MeasureLarvaeRequest | None = None,
) -> LarvaeMeasurementResult | PupaeMeasurementResult:
    return await _measure_polygon_image(None, measurement_svc, user, db, image_id, body)


@router.post(
    "/measure/pupae",
    response_model=PupaeMeasurementResult,
    status_code=status.HTTP_200_OK,
    summary="Compute per-pupa measurements on a stored image",
)
async def measure_pupae(
    measurement_svc: AnnotatedLarvaeMeasurementService,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
    image_id: Annotated[UUID, Query(description="Stored analysis_image.id")],
    body: MeasurePupaeRequest | None = None,
) -> PupaeMeasurementResult:
    return await _measure_polygon_image(
        "pupae", measurement_svc, user, db, image_id, body
    )


# ─────────────────────────────────────────────────────────────────────────────
# GET /analyses/{batch_id}/larvae
# ─────────────────────────────────────────────────────────────────────────────


@router.get(
    "/analyses/{batch_id}/larvae",
    response_model=LarvaeBatchDetail | PupaeBatchDetail,
    status_code=status.HTTP_200_OK,
    summary="Full polygon batch payload (detections + calibration + measurements)",
)
async def get_larvae_batch(
    batch_id: UUID,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
    summary: Annotated[
        bool,
        Query(
            description=(
                "Omit per-image detections and measurements; per-image "
                "``*_count`` fields are still filled. Pair with "
                "GET /analyses/{batch_id}/larvae/images/{image_id}."
            )
        ),
    ] = False,
) -> LarvaeBatchDetail | PupaeBatchDetail:
    detail = await load_batch_for_user(batch_id, user.id, db, summary=summary)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )
    return detail


@router.get(
    "/analyses/{batch_id}/larvae/images/{image_id}",
    response_model=LarvaeImageDetail | PupaeImageDetail,
    status_code=status.HTTP_200_OK,
    summary="One image's detections, calibration and measurements",
)
async def get_larvae_image(
    batch_id: UUID,
    image_id: UUID,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> LarvaeImageDetail | PupaeImageDetail:
    detail = await load_image_for_user(batch_id, image_id, user.id, db)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} in batch {batch_id} not found.",
        )
    return detail


# ─────────────────────────────────────────────────────────────────────────────
# POST /analyses/{batch_id}/images/{image_id}/refine
# ─────────────────────────────────────────────────────────────────────────────


@router.post(
    "/analyses/{batch_id}/images/{image_id}/refine",
    response_model=RefineResult,
    status_code=status.HTTP_200_OK,
    summary="Refine a stored image's model polygons with SAM",
    responses={
        404: {"description": "Batch, image, or image files not found"},
        503: {"description": "SAM model could not be loaded"},
    },
)
async def refine_image_polygons(
    batch_id: UUID,
    image_id: UUID,
    sam_svc: AnnotatedSamRefinementService,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> RefineResult:
    """Run SAM over the detections of an image that was processed count-only.

    Operator-edited and user-drawn polygons are left alone. Measurements of
    refined detections flip to stale — re-run POST /measure/{organism}.
    """
    await verify_batch_owned(batch_id, db, user.id)
    image = (
        await db.execute(
            select(AnalysisImage)
            .where(AnalysisImage.id == image_id)
            .where(AnalysisImage.batch_id == batch_id)
        )
    ).scalar_one_or_none()
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} in batch {batch_id} not found.",
        )
    overlay_path = resolve_overlay_path(image, Path(get_cached_storage_dir()))
    if overlay_path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} has no completed result.",
        )

    organism = await _image_organism(image, db)
    try:
        result = await refine_stored_polygons(
            image, overlay_path, sam_svc, _polygon_config_for(organism), db
        )
    except RefineError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc
    except (FileNotFoundError, ModuleNotFoundError) as exc:
        # SAM weights missing / ultralytics unavailable.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"SAM model unavailable: {exc}",
        ) from exc
    await db.commit()
    return result


@router.get(
    "/analyses/{batch_id}/pupae",
    response_model=PupaeBatchDetail,
    status_code=status.HTTP_200_OK,
    summary="Full pupae batch payload (detections + calibration + measurements)",
)
async def get_pupae_batch(
    batch_id: UUID,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> PupaeBatchDetail:
    detail = await load_batch_for_user(batch_id, user.id, db)
    if detail is None or detail.organism != "pupae":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis batch {batch_id} not found.",
        )
    return detail


# ─────────────────────────────────────────────────────────────────────────────
# GET /analyses/{batch_id}/larvae/csv
# ─────────────────────────────────────────────────────────────────────────────


_CSV_FIELDS = (
    "batch_id",
    "image_id",
    "image_filename",
    "detection_id",
    "length_mm",
    "min_width_mm",
    "max_width_mm",
    "average_width_mm",
    "area_mm2",
    "volume_mm3",
    "total_weight_mg",
    "weight_mg",
    "weight_area_ratio",
    "is_stale",
    "measured_at",
)


@router.get(
    "/analyses/{batch_id}/larvae/csv",
    summary="Stream a CSV of every measurement in the batch",
    responses={
        200: {
            "content": {"text/csv": {}},
            "description": "CSV stream — one row per larva.",
        },
        404: {"description": "Batch not found"},
    },
)
async def export_larvae_csv(
    batch_id: UUID,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> StreamingResponse:
    batch = await verify_batch_owned(batch_id, db, user.id)

    # Pull rows in one streaming-friendly join. We use server-side iteration
    # with a moderate page size so a 10K-larva export does not buffer the
    # whole result set in memory.
    stmt = (
        select(
            AnalysisImage.id.label("image_id"),
            AnalysisImage.original_filename.label("filename"),
            AnalysisImage.total_weight_mg.label("total_weight_mg"),
            LarvaeDetection.id.label("detection_id"),
            LarvaeMeasurement.length_mm,
            LarvaeMeasurement.min_width_mm,
            LarvaeMeasurement.max_width_mm,
            LarvaeMeasurement.average_width_mm,
            LarvaeMeasurement.area_mm2,
            LarvaeMeasurement.volume_mm3,
            LarvaeMeasurement.weight_mg,
            LarvaeMeasurement.is_stale,
            LarvaeMeasurement.measured_at,
        )
        .select_from(AnalysisImage)
        .join(LarvaeDetection, LarvaeDetection.image_id == AnalysisImage.id)
        .join(
            LarvaeMeasurement,
            LarvaeMeasurement.detection_id == LarvaeDetection.id,
            isouter=True,
        )
        .where(AnalysisImage.batch_id == batch.id)
        .order_by(AnalysisImage.created_at, LarvaeDetection.created_at)
    )

    async def _iter_csv() -> AsyncIterator[bytes]:
        # Header
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(_CSV_FIELDS)
        yield buf.getvalue().encode("utf-8")

        result = await db.stream(stmt)
        async for chunk in result.partitions(500):
            buf = io.StringIO()
            writer = csv.writer(buf)
            for row in chunk:
                writer.writerow(
                    [
                        str(batch.id),
                        str(row.image_id),
                        row.filename,
                        str(row.detection_id),
                        row.length_mm if row.length_mm is not None else "",
                        row.min_width_mm if row.min_width_mm is not None else "",
                        row.max_width_mm if row.max_width_mm is not None else "",
                        (
                            row.average_width_mm
                            if row.average_width_mm is not None
                            else ""
                        ),
                        row.area_mm2 if row.area_mm2 is not None else "",
                        row.volume_mm3 if row.volume_mm3 is not None else "",
                        (
                            row.total_weight_mg
                            if row.total_weight_mg is not None
                            else ""
                        ),
                        row.weight_mg if row.weight_mg is not None else "",
                        (
                            row.weight_mg / row.area_mm2
                            if row.weight_mg is not None
                            and row.area_mm2 is not None
                            and row.area_mm2 > 0
                            else ""
                        ),
                        bool(row.is_stale) if row.is_stale is not None else "",
                        (
                            row.measured_at.isoformat()
                            if row.measured_at is not None
                            else ""
                        ),
                    ]
                )
            yield buf.getvalue().encode("utf-8")

    filename = f"larvae_{batch.id}.csv"
    return StreamingResponse(
        _iter_csv(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─────────────────────────────────────────────────────────────────────────────
# PUT /analyses/{batch_id}/images/{image_id}/polygons
# ─────────────────────────────────────────────────────────────────────────────


@router.put(
    "/analyses/{batch_id}/images/{image_id}/polygons",
    status_code=status.HTTP_200_OK,
    summary="Save edited polygons; flips matching measurements stale",
)
async def save_polygon_edits(
    batch_id: UUID,
    image_id: UUID,
    payload: PolygonsUpdate,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> dict[str, int | str]:
    await verify_batch_owned(batch_id, db, user.id)

    image = (
        await db.execute(
            select(AnalysisImage)
            .where(AnalysisImage.id == image_id)
            .where(AnalysisImage.batch_id == batch_id)
        )
    ).scalar_one_or_none()
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} in batch {batch_id} not found.",
        )

    deleted_ids: list[UUID] = []
    for raw_id in payload.deleted_detection_ids:
        try:
            deleted_ids.append(UUID(raw_id))
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid deleted detection_id: {raw_id}",
            ) from exc

    edits: list[tuple[UUID | None, list[tuple[int, int]]]] = []
    edited_existing_ids: list[UUID] = []
    restored: dict[int, RestoredDetection] = {}
    for entry in payload.polygons:
        if entry.detection_id.startswith("new:"):
            det_id = None
            if entry.origin == "model":
                restored[len(edits)] = RestoredDetection(
                    confidence=(
                        entry.confidence if entry.confidence is not None else 1.0
                    ),
                    baseline=(
                        [(int(x), int(y)) for x, y in entry.baseline]
                        if entry.baseline
                        else None
                    ),
                )
        else:
            try:
                det_id = UUID(entry.detection_id)
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid detection_id: {entry.detection_id}",
                ) from exc
            edited_existing_ids.append(det_id)
        edits.append((det_id, [(int(x), int(y)) for x, y in entry.polygon]))

    conflicting_ids = set(edited_existing_ids).intersection(deleted_ids)
    if conflicting_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A detection cannot be edited and deleted in the same request.",
        )

    touched, deleted = await update_polygons(
        image_id, edits, user.id, db, deleted_ids, restored
    )
    count = image.count or 0
    if touched or deleted:
        # Adding / deleting polygons is how the operator corrects the count;
        # carry it through to the image row and the batch totals.
        count = await sync_image_count(image_id, db)
        await analysis_svc.refresh_batch_aggregates(batch_id, db)
        overlay_path = resolve_overlay_path(image, Path(get_cached_storage_dir()))
        if overlay_path is not None:
            mark_overlay_stale(overlay_path)
    await db.commit()

    return {
        "status": "ok",
        "image_id": str(image_id),
        "updated": touched,
        "deleted": deleted,
        "count": count,
    }


# ─────────────────────────────────────────────────────────────────────────────
# PUT /analyses/images/{image_id}/total-weight
# ─────────────────────────────────────────────────────────────────────────────


@router.put(
    "/analyses/images/{image_id}/total-weight",
    response_model=ImageTotalWeightResult,
    status_code=status.HTTP_200_OK,
    summary="Set the per-image total weight; redistributes weight_mg across measurements",
)
async def set_image_total_weight_endpoint(
    image_id: UUID,
    payload: ImageTotalWeightUpdate,
    user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> ImageTotalWeightResult:
    image = await get_image_for_user(image_id, user.id, db)
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Image {image_id} not found.",
        )

    updated = await set_image_total_weight(image_id, payload.total_weight_mg, db)
    await db.commit()
    return ImageTotalWeightResult(
        image_id=str(image_id),
        total_weight_mg=payload.total_weight_mg,
        measurements_updated=updated,
    )
