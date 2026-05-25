"""PupaeInferenceService — tiled YOLO-seg inference with MWIS deduplication.

Copies and adapts the segmentation logic from
``phenotyping_pipeline/2_inference/infer_pupae.py``. Mirrors
``LarvaeInferenceService`` (same tiling, MWIS dedup, calibration warp, SAM
refinement) but uses the pupae model + ``PupaeConfig`` and emits ``label="pupae"``
annotations.
"""

from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

import cv2
import numpy as np

from app.config import PipelineConfigManager
from app.schemas.calibration import CalibrationCorners
from app.schemas.pupae import (
    PupaeAnnotation,
    PupaeBatchDetectionResult,
    PupaeDetectionResult,
)
from app.services.inference.calibration import CalibrationService
from app.services.inference.egg import InvalidImageError
from app.services.inference.larvae import LarvaeInferenceService
from app.services.inference.measurement import build_warp_matrix
from app.services.inference.sam_refine import SamRefinementService

if TYPE_CHECKING:
    from ultralytics import YOLO

    from app.schemas.config import PupaeConfig
    from app.services.log_buffer import LogBuffer
    from app.services.model_registry import ModelRegistry


# Yellow #FFFF00 in OpenCV BGR — distinct from larvae's cyan so operators can
# tell the two organism overlays apart at a glance.
_POLYGON_COLOR_BGR: tuple[int, int, int] = (0, 255, 255)

logger = logging.getLogger(__name__)


class PupaeInferenceService:
    """Tiled YOLO-seg pupae detection with MWIS-over-polygon-IoU dedup."""

    def __init__(
        self,
        model_registry: ModelRegistry,
        pipeline_config: PipelineConfigManager,
        log_buffer: LogBuffer,
        executor: ThreadPoolExecutor,
        calibration_service: CalibrationService,
        sam_service: SamRefinementService | None = None,
    ) -> None:
        self._model_registry = model_registry
        self._pipeline_config = pipeline_config
        self._log_buffer = log_buffer
        self._executor = executor
        self._calibration_svc = calibration_service
        self._sam_svc = sam_service

        device = model_registry.device_for("pupae")
        max_concurrent = 1 if device == "cpu" else 2
        self._max_concurrent = max_concurrent
        self._semaphore = asyncio.Semaphore(max_concurrent)

    @property
    def _pupae_config(self) -> "PupaeConfig":
        return self._pipeline_config.get_pupae_config()

    def _tile_image(
        self, image: np.ndarray, cfg: "PupaeConfig"
    ) -> tuple[list[np.ndarray], list[tuple[int, int]]]:
        tile_size = cfg.tile_size
        stride = int(cfg.tile_size * (1 - cfg.overlap))
        h, w = image.shape[:2]

        tiles: list[np.ndarray] = []
        coords: list[tuple[int, int]] = []
        for y in range(0, h - tile_size + 1, stride):
            for x in range(0, w - tile_size + 1, stride):
                tiles.append(image[y : y + tile_size, x : x + tile_size])
                coords.append((y, x))
        return tiles, coords

    def _stage(self, code: str, filename: str, batch_id: str) -> None:
        from app.services.stage_broker import emit_stage

        emit_stage(code, batch_id, filename, organism="pupae")

    def _run_inference(
        self,
        image: np.ndarray,
        filename: str,
        batch_id: str,
        raw_image_data: bytes | None = None,
        raw_suffix: str = ".png",
    ) -> PupaeDetectionResult:
        cfg = self._pupae_config
        model: "YOLO" = self._model_registry.model_for("pupae")
        t_start = time.time()

        if image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        elif image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)

        h, w = image.shape[:2]
        tile_size = cfg.tile_size
        edge_margin = cfg.edge_margin
        min_mask_size = cfg.min_mask_size

        self._stage("image.tile", filename, batch_id)
        tiles, coords = self._tile_image(image, cfg)

        self._stage("image.detect", filename, batch_id)
        candidates: list[dict[str, Any]] = []

        device_arg = self._model_registry.device_for("pupae")
        for i in range(0, len(tiles), cfg.batch_size):
            batch_tiles = tiles[i : i + cfg.batch_size]
            batch_coords = coords[i : i + cfg.batch_size]

            model_kwargs: dict[str, Any] = {
                "verbose": False,
                "conf": cfg.confidence_threshold,
                "half": False,
            }
            if device_arg:
                model_kwargs["device"] = device_arg
            results = model(batch_tiles, **model_kwargs)

            for res, (y_off, x_off) in zip(results, batch_coords):
                if res.masks is None or res.boxes is None:
                    continue
                masks_np = res.masks.data.cpu().numpy()
                confs_np = res.boxes.conf.cpu().numpy()
                for seg, conf in zip(masks_np, confs_np):
                    bin_mask = (seg > 0.5).astype(np.uint8)
                    if bin_mask.shape != (tile_size, tile_size):
                        bin_mask = cv2.resize(
                            bin_mask,
                            (tile_size, tile_size),
                            interpolation=cv2.INTER_NEAREST,
                        )
                    if LarvaeInferenceService._is_touching_edge(bin_mask, edge_margin):
                        continue
                    if int(bin_mask.sum()) < min_mask_size:
                        continue

                    contours, _ = cv2.findContours(
                        bin_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
                    )
                    for contour in contours:
                        if len(contour) < 3:
                            continue
                        contour = contour.squeeze()
                        if contour.ndim != 2 or contour.shape[0] < 3:
                            continue

                        global_contour = contour + np.array(
                            [x_off, y_off], dtype=contour.dtype
                        )

                        area = int(cv2.contourArea(global_contour.astype(np.int32)))
                        if area < min_mask_size:
                            continue

                        x_min = int(global_contour[:, 0].min())
                        y_min = int(global_contour[:, 1].min())
                        x_max = int(global_contour[:, 0].max())
                        y_max = int(global_contour[:, 1].max())

                        conf_f = float(conf)
                        if cfg.mwis_score_metric == "confidence":
                            score = conf_f
                        else:
                            score = conf_f * area

                        candidates.append(
                            {
                                "polygon": global_contour.astype(np.int32),
                                "bbox": (x_min, y_min, x_max, y_max),
                                "area": area,
                                "confidence": conf_f,
                                "score": score,
                            }
                        )

        self._stage("image.dedup", filename, batch_id)
        # Reuse the same MWIS implementation as larvae — the dedup logic is
        # identical (polygon-IoU graph, greedy score / (1 + conflicts)).
        # Instantiate a throwaway helper so we can call the bound method.
        selected = self._mwis_dedup(candidates, cfg.mwis_overlap_threshold)

        if self._sam_svc is not None and cfg.sam.enabled and selected:
            self._stage("image.refine", filename, batch_id)
            selected = self._sam_svc.refine_candidates(image, selected, cfg)

        calibration, corners_float = self._calibration_svc.detect_with_ordered(
            image, cfg
        )
        warp_matrix: np.ndarray | None = None
        warped_image: np.ndarray | None = None
        warp_w = warp_h = 0
        if calibration is not None and corners_float is not None:
            built = build_warp_matrix(image.shape, corners_float)
            if built is not None:
                warp_matrix, (warp_w, warp_h), _ = built
                try:
                    warped_image = cv2.warpPerspective(
                        image, warp_matrix, (warp_w, warp_h)
                    )
                except cv2.error:
                    warped_image = None
                    warp_matrix = None

        if warp_matrix is not None and warped_image is not None:
            for c in selected:
                pts = c["polygon"].astype(np.float32).reshape(-1, 1, 2)
                pts_w = (
                    cv2.perspectiveTransform(pts, warp_matrix)
                    .reshape(-1, 2)
                    .astype(np.int32)
                )
                c["polygon"] = pts_w
                c["bbox"] = (
                    int(pts_w[:, 0].min()),
                    int(pts_w[:, 1].min()),
                    int(pts_w[:, 0].max()),
                    int(pts_w[:, 1].max()),
                )
                c["area"] = int(cv2.contourArea(pts_w))

        self._stage("image.draw", filename, batch_id)
        display_image = warped_image if warped_image is not None else image
        overlay = display_image.copy()
        annotations: list[PupaeAnnotation] = []

        for c in selected:
            poly_arr = c["polygon"]
            x1, y1, x2, y2 = c["bbox"]
            conf_v = float(c["confidence"])

            cv2.polylines(overlay, [poly_arr], True, _POLYGON_COLOR_BGR, 2)

            polygon_points: list[tuple[int, int]] = [
                (int(p[0]), int(p[1])) for p in poly_arr
            ]
            annotations.append(
                PupaeAnnotation(
                    label="pupae",
                    polygon=polygon_points,
                    bbox=(x1, y1, x2, y2),
                    confidence=round(conf_v, 4),
                    area_px=int(c["area"]),
                    origin="model",
                )
            )

        count = len(annotations)
        avg_confidence = (
            float(np.mean([a.confidence for a in annotations])) if count else 0.0
        )
        elapsed = time.time() - t_start

        self._stage("image.save", filename, batch_id)
        batch_dir = self._get_storage_dir() / batch_id
        batch_dir.mkdir(parents=True, exist_ok=True)
        png_params = [cv2.IMWRITE_PNG_COMPRESSION, 1]

        overlay_path = batch_dir / f"{filename}_overlay.png"
        cv2.imwrite(str(overlay_path), overlay, png_params)

        raw_path = batch_dir / f"{filename}_raw{raw_suffix}"
        if raw_image_data is not None:
            raw_path.write_bytes(raw_image_data)
        else:
            cv2.imwrite(str(raw_path), image, png_params)

        if warped_image is not None:
            warped_raw_path = batch_dir / f"{filename}_warped.png"
            cv2.imwrite(str(warped_raw_path), warped_image, png_params)

        overlay_url = f"/inference/results/{batch_id}/{filename}/overlay.png"

        if calibration is None:
            calibration = CalibrationCorners(
                detection_status="failed",
                calibration_object_w_mm=cfg.calibration_object_w_mm,
                calibration_object_h_mm=cfg.calibration_object_h_mm,
            )

        return PupaeDetectionResult(
            filename=filename,
            organism="pupae",
            count=count,
            avg_confidence=round(avg_confidence, 4),
            elapsed_seconds=round(elapsed, 4),
            annotations=annotations,
            overlay_url=overlay_url,
            calibration=calibration,
        )

    # ── MWIS dedup — reuses the larvae implementation verbatim ──────────────

    def _mwis_dedup(
        self, candidates: list[dict[str, Any]], overlap_threshold: float
    ) -> list[dict[str, Any]]:
        """Delegate to LarvaeInferenceService._mwis_dedup — identical logic.

        The dedup is pure-functional over (polygon, bbox, score, confidence) so
        a stateless static call would do, but the larvae implementation is a
        bound method. Use a temporary helper that exposes only what _mwis_dedup
        needs (the staticmethod helpers it calls).
        """
        # Direct call works because _mwis_dedup only reads self via static
        # method dispatch to _bbox_overlap_ratio / _polygon_iou_in_roi.
        return LarvaeInferenceService._mwis_dedup(self, candidates, overlap_threshold)  # type: ignore[arg-type]

    # ── Public async API ────────────────────────────────────────────────────

    async def process_single(
        self,
        image_data: bytes,
        filename: str,
        batch_id: str,
        raw_suffix: str = ".png",
    ) -> PupaeDetectionResult:
        self._stage("image.decode", filename, batch_id)

        def _decode() -> np.ndarray:
            arr = np.frombuffer(image_data, np.uint8)
            image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if image is None:
                raise InvalidImageError(
                    f"Cannot decode image: {filename!r}. "
                    "Ensure the file is a valid JPEG, PNG, TIFF, BMP, or TIF image."
                )
            return image

        loop = asyncio.get_running_loop()
        image = await loop.run_in_executor(self._executor, _decode)

        device = self._model_registry.device_for("pupae")

        async with self._semaphore:
            result = await loop.run_in_executor(
                self._executor,
                lambda: self._run_inference(
                    image, filename, batch_id, image_data, raw_suffix
                ),
            )

        logger.info(
            "Processed %s in %.1fs — %d pupae",
            filename,
            result.elapsed_seconds,
            result.count,
            extra={
                "filename": filename,
                "organism": "pupae",
                "device": device,
                "elapsed_seconds": round(result.elapsed_seconds, 4),
                "count": result.count,
                "avg_confidence": round(result.avg_confidence, 4),
            },
        )
        return result

    async def process_batch(
        self,
        images: list[tuple[bytes, str]] | list[tuple[bytes, str, str]],
        batch_id: str,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> PupaeBatchDetectionResult:
        total_start = time.time()
        total = len(images)
        completed = 0

        if self._max_concurrent <= 1 or total <= 1:
            results: list[PupaeDetectionResult] = []
            for item in images:
                image_data, fname, *rest = item  # type: ignore[misc]
                raw_suffix = rest[0] if rest else ".png"
                r = await self.process_single(image_data, fname, batch_id, raw_suffix)
                results.append(r)
                completed += 1
                if on_progress is not None:
                    on_progress(completed, total)
        else:
            results_slots: list[PupaeDetectionResult | None] = [None] * total
            next_index = 0
            first_error: Exception | None = None

            async def _worker() -> None:
                nonlocal completed, first_error, next_index
                while first_error is None:
                    idx = next_index
                    next_index += 1
                    if idx >= total:
                        return
                    image_data, fname, *rest = images[idx]  # type: ignore[misc]
                    raw_suffix = rest[0] if rest else ".png"
                    try:
                        result = await self.process_single(
                            image_data, fname, batch_id, raw_suffix
                        )
                    except Exception as exc:
                        first_error = exc
                        return
                    results_slots[idx] = result
                    completed += 1
                    if on_progress is not None:
                        on_progress(completed, total)

            workers = [
                asyncio.create_task(_worker())
                for _ in range(min(self._max_concurrent, total))
            ]
            await asyncio.gather(*workers)
            if first_error is not None:
                raise first_error
            results = [r for r in results_slots if r is not None]

        total_elapsed = time.time() - total_start
        total_count = sum(r.count for r in results)

        return PupaeBatchDetectionResult(
            results=results,
            total_count=total_count,
            total_elapsed_seconds=round(total_elapsed, 4),
        )

    def _get_storage_dir(self) -> Path:
        from app.deps import get_cached_storage_dir

        return Path(get_cached_storage_dir())
