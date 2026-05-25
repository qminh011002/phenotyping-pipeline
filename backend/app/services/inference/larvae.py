"""LarvaeInferenceService — tiled YOLO-seg inference with MWIS deduplication.

Copies and adapts the segmentation logic from
`phenotyping_pipeline/2_inference/infer_larvae.py`. The service owns tiling,
mask→polygon conversion, MWIS deduplication, and overlay rendering. There is
no runtime dependency on the pipeline repo and no multiprocessing — inference
runs in the shared ThreadPoolExecutor and concurrency is bounded by an
``asyncio.Semaphore`` sized by device.
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
from app.schemas.larvae import (
    LarvaeAnnotation,
    LarvaeBatchDetectionResult,
    LarvaeDetectionResult,
)
from app.services.inference.calibration import CalibrationService
from app.services.inference.egg import InvalidImageError
from app.services.inference.measurement import build_warp_matrix
from app.services.inference.sam_refine import SamRefinementService

if TYPE_CHECKING:
    from ultralytics import YOLO

    from app.schemas.config import LarvaeConfig
    from app.services.log_buffer import LogBuffer
    from app.services.model_registry import ModelRegistry


# Cyan #00FFFF in OpenCV's native BGR layout — matches the editor SVG stroke.
_POLYGON_COLOR_BGR: tuple[int, int, int] = (255, 255, 0)

logger = logging.getLogger(__name__)


class LarvaeInferenceService:
    """Tiled YOLO-seg larvae detection with MWIS-over-polygon-IoU dedup."""

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

        device = model_registry.device_for("larvae")
        max_concurrent = 1 if device == "cpu" else 2
        self._max_concurrent = max_concurrent
        self._semaphore = asyncio.Semaphore(max_concurrent)

    # ── Config ────────────────────────────────────────────────────────────────

    @property
    def _larvae_config(self) -> "LarvaeConfig":
        return self._pipeline_config.get_larvae_config()

    @property
    def _computed_stride(self) -> int:
        cfg = self._larvae_config
        return int(cfg.tile_size * (1 - cfg.overlap))

    # ── Tiling (port of egg fix: edge tiles always covered) ──────────────────

    def _tile_image(
        self, image: np.ndarray, cfg: "LarvaeConfig | None" = None
    ) -> tuple[list[np.ndarray], list[tuple[int, int]]]:
        # Line-for-line port of phenotyping_pipeline/2_inference/infer_larvae.py
        # `tile_image`: only full tiles inside the image, no edge tiles, no
        # padding. Required for output parity with the reference pipeline.
        if cfg is None:
            cfg = self._larvae_config
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

    # ── Mask helpers (port from infer_larvae.py) ─────────────────────────────

    @staticmethod
    def _is_touching_edge(mask: np.ndarray, margin: int) -> bool:
        if margin <= 0:
            return False
        return bool(
            np.any(mask[:margin, :])
            or np.any(mask[-margin:, :])
            or np.any(mask[:, :margin])
            or np.any(mask[:, -margin:])
        )

    @staticmethod
    def _bbox_overlap_ratio(
        bbox1: tuple[int, int, int, int], bbox2: tuple[int, int, int, int]
    ) -> float:
        x1_min, y1_min, x1_max, y1_max = bbox1
        x2_min, y2_min, x2_max, y2_max = bbox2
        if (
            x1_max <= x2_min
            or x2_max <= x1_min
            or y1_max <= y2_min
            or y2_max <= y1_min
        ):
            return 0.0
        x_overlap = min(x1_max, x2_max) - max(x1_min, x2_min)
        y_overlap = min(y1_max, y2_max) - max(y1_min, y2_min)
        intersection = x_overlap * y_overlap
        area1 = (x1_max - x1_min) * (y1_max - y1_min)
        area2 = (x2_max - x2_min) * (y2_max - y2_min)
        smaller = min(area1, area2)
        if smaller <= 0:
            return 0.0
        return intersection / smaller

    @staticmethod
    def _polygon_iou_in_roi(
        poly1: np.ndarray, poly2: np.ndarray
    ) -> float:
        """IoU between two polygons computed only over their intersection ROI."""
        bbox1 = (
            int(poly1[:, 0].min()),
            int(poly1[:, 1].min()),
            int(poly1[:, 0].max()),
            int(poly1[:, 1].max()),
        )
        bbox2 = (
            int(poly2[:, 0].min()),
            int(poly2[:, 1].min()),
            int(poly2[:, 0].max()),
            int(poly2[:, 1].max()),
        )

        x_min = max(bbox1[0], bbox2[0])
        y_min = max(bbox1[1], bbox2[1])
        x_max = min(bbox1[2], bbox2[2])
        y_max = min(bbox1[3], bbox2[3])
        if x_min >= x_max or y_min >= y_max:
            return 0.0

        roi_w = int(x_max - x_min) + 10
        roi_h = int(y_max - y_min) + 10

        # Bound ROI memory: fall back to bbox-only overlap on enormous ROIs.
        if roi_w * roi_h > 500_000:
            return LarvaeInferenceService._bbox_overlap_ratio(bbox1, bbox2)

        offset = np.array([x_min - 5, y_min - 5], dtype=poly1.dtype)
        poly1_roi = (poly1 - offset).astype(np.int32)
        poly2_roi = (poly2 - offset).astype(np.int32)

        mask1 = np.zeros((roi_h, roi_w), dtype=np.uint8)
        mask2 = np.zeros((roi_h, roi_w), dtype=np.uint8)
        cv2.fillPoly(mask1, [poly1_roi], 1)
        cv2.fillPoly(mask2, [poly2_roi], 1)

        inter = int(np.logical_and(mask1, mask2).sum())
        union = int(np.logical_or(mask1, mask2).sum())
        if union == 0:
            return 0.0
        return inter / union

    def _mwis_dedup(
        self, candidates: list[dict[str, Any]], overlap_threshold: float
    ) -> list[dict[str, Any]]:
        """Greedy MWIS over polygon-IoU conflicts, accelerated by a spatial grid."""
        n = len(candidates)
        if n == 0:
            return []
        if n == 1:
            return list(candidates)

        bbox_data: list[tuple[int, int, int, int]] = [
            tuple(c["bbox"]) for c in candidates  # type: ignore[misc]
        ]

        avg_bbox_size = float(
            np.mean([(b[2] - b[0]) + (b[3] - b[1]) for b in bbox_data]) / 2.0
        )
        grid_size = max(int(avg_bbox_size * 1.5), 100)

        min_x = min(b[0] for b in bbox_data)
        min_y = min(b[1] for b in bbox_data)

        grid: dict[tuple[int, int], list[int]] = {}
        for idx, b in enumerate(bbox_data):
            x_min, y_min, x_max, y_max = b
            start_col = max(0, (x_min - min_x) // grid_size)
            end_col = (x_max - min_x) // grid_size
            start_row = max(0, (y_min - min_y) // grid_size)
            end_row = (y_max - min_y) // grid_size
            for row in range(start_row, end_row + 1):
                for col in range(start_col, end_col + 1):
                    grid.setdefault((row, col), []).append(idx)

        potential: list[tuple[int, int]] = []
        checked: set[tuple[int, int]] = set()
        for cell_indices in grid.values():
            if len(cell_indices) < 2:
                continue
            for i in range(len(cell_indices)):
                for j in range(i + 1, len(cell_indices)):
                    a, b = cell_indices[i], cell_indices[j]
                    pair = (min(a, b), max(a, b))
                    if pair in checked:
                        continue
                    checked.add(pair)
                    if self._bbox_overlap_ratio(bbox_data[a], bbox_data[b]) >= 0.1:
                        potential.append(pair)

        conflicts: set[tuple[int, int]] = set()
        for a, b in potential:
            poly_a = np.asarray(candidates[a]["polygon"], dtype=np.int32)
            poly_b = np.asarray(candidates[b]["polygon"], dtype=np.int32)
            iou = self._polygon_iou_in_roi(poly_a, poly_b)
            if iou > overlap_threshold:
                conflicts.add((a, b))

        neighbors: dict[int, set[int]] = {i: set() for i in range(n)}
        for a, b in conflicts:
            neighbors[a].add(b)
            neighbors[b].add(a)

        remaining: set[int] = set(range(n))
        selected: list[int] = []
        while remaining:
            remaining_list = list(remaining)
            conflict_counts = np.array(
                [len(neighbors[i] & remaining) for i in remaining_list],
                dtype=np.float64,
            )
            scores = np.array(
                [candidates[i]["score"] for i in remaining_list], dtype=np.float64
            )
            qualities = scores / (1.0 + conflict_counts)
            best = int(np.argmax(qualities))
            chosen = remaining_list[best]
            selected.append(chosen)
            to_remove = {chosen} | (neighbors[chosen] & remaining)
            remaining -= to_remove

        return [candidates[i] for i in selected]

    @staticmethod
    def _draw_board(overlay: np.ndarray, lines: list[str], x: int, y: int) -> int:
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 1.4
        thickness = 2
        pad = 14
        line_gap = 10

        sizes = [
            cv2.getTextSize(line, font, font_scale, thickness)[0] for line in lines
        ]
        board_w = max(w for w, _ in sizes) + pad * 2
        board_h = sum(h for _, h in sizes) + line_gap * (len(lines) - 1) + pad * 2

        cv2.rectangle(overlay, (x, y), (x + board_w, y + board_h), (0, 0, 0), -1)
        cursor_y = y + pad
        for line, (_, h) in zip(lines, sizes):
            cursor_y += h
            cv2.putText(
                overlay,
                line,
                (x + pad, cursor_y),
                font,
                font_scale,
                (0, 255, 0),
                thickness,
            )
            cursor_y += line_gap
        return y + board_h

    # ── Stage emit ───────────────────────────────────────────────────────────

    def _stage(self, code: str, filename: str, batch_id: str) -> None:
        from app.services.stage_broker import emit_stage

        emit_stage(code, batch_id, filename, organism="larvae")

    # ── Synchronous core (runs in ThreadPoolExecutor) ────────────────────────

    def _run_inference(
        self,
        image: np.ndarray,
        filename: str,
        batch_id: str,
        raw_image_data: bytes | None = None,
        raw_suffix: str = ".png",
    ) -> LarvaeDetectionResult:
        cfg = self._larvae_config
        model: "YOLO" = self._model_registry.model_for("larvae")
        t_start = time.time()

        if image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        elif image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)

        h, w = image.shape[:2]
        tile_size = cfg.tile_size
        edge_margin = cfg.edge_margin
        min_mask_size = cfg.min_mask_size

        # ── 1. Tile ────────────────────────────────────────────────────────
        self._stage("image.tile", filename, batch_id)
        tiles, coords = self._tile_image(image, cfg)

        # ── 2. Batch inference + mask→polygon conversion ──────────────────
        self._stage("image.detect", filename, batch_id)
        candidates: list[dict[str, Any]] = []

        # Pipeline parity: phenotyping_pipeline/infer_larvae.py passes `device`
        # per-call when set. The model is already `.to(device)`'d at startup but
        # we mirror the exact call signature to rule out any subtle Ultralytics
        # behaviour differences.
        #
        # ``half=False`` forces FP32 inference on CUDA. Ultralytics auto-enables
        # FP16 on GPU when it thinks the box checks out — that gives ~5% speed
        # but slight per-pixel mask differences vs the reference pipeline. Since
        # we need byte-for-byte parity with phenotyping_pipeline output, we
        # disable FP16 across the board.
        device_arg = self._model_registry.device_for("larvae")
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
                    if self._is_touching_edge(bin_mask, edge_margin):
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

        # ── 3. MWIS dedup ──────────────────────────────────────────────────
        self._stage("image.dedup", filename, batch_id)
        selected = self._mwis_dedup(candidates, cfg.mwis_overlap_threshold)

        # ── 3b. SAM polygon refinement (per-crop, bbox-prompted) ───────────
        # Refines polygons in the raw image coordinate frame; the warp step
        # below transforms refined polygons into the rectified frame.
        if (
            self._sam_svc is not None
            and cfg.sam.enabled
            and selected
        ):
            self._stage("image.refine", filename, batch_id)
            selected = self._sam_svc.refine_candidates(image, selected, cfg)

        # ── 4. Auto-calibration + perspective warp ─────────────────────────
        # Run green-rectangle detection on the raw image. On success we warp
        # the image and transform every polygon into the warped frame so the
        # editor (and downstream measurement) work in the rectified space.
        #
        # IMPORTANT: build the warp matrix from the FLOAT-precision ordered
        # corners (corners_float), not from calibration.auto_corners. The
        # latter is rounded to int for the API/DB contract, and any 0-1 px
        # corner drift propagates into M → warped polygons → measurements,
        # causing the ~0.2% drift vs phenotyping_pipeline. The reference
        # pipeline uses the float corners directly here.
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
                # Pipeline parity: phenotyping_pipeline/process_larvae.py does
                # NOT clip warped polygon coords. `cv2.boundingRect` handles
                # out-of-bounds vertices fine and the per-larva crop is clipped
                # to image bounds separately. Clipping here would shrink any
                # larva sitting on the edge of the calibration rectangle and
                # corrupt its measurements.
                c["polygon"] = pts_w
                c["bbox"] = (
                    int(pts_w[:, 0].min()),
                    int(pts_w[:, 1].min()),
                    int(pts_w[:, 0].max()),
                    int(pts_w[:, 1].max()),
                )
                c["area"] = int(cv2.contourArea(pts_w))

        # ── 5. Build annotations + overlay (cyan on warped/raw) ────────────
        self._stage("image.draw", filename, batch_id)
        display_image = warped_image if warped_image is not None else image
        overlay = display_image.copy()
        annotations: list[LarvaeAnnotation] = []

        for c in selected:
            poly_arr = c["polygon"]
            x1, y1, x2, y2 = c["bbox"]
            conf_v = float(c["confidence"])

            cv2.polylines(overlay, [poly_arr], True, _POLYGON_COLOR_BGR, 2)

            polygon_points: list[tuple[int, int]] = [
                (int(p[0]), int(p[1])) for p in poly_arr
            ]
            annotations.append(
                LarvaeAnnotation(
                    label="larvae",
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

        # ── 6. Save overlay + raw + warped raw ─────────────────────────────
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

        # Warped raw (no marks) — backing image for the polygon editor SVG.
        if warped_image is not None:
            warped_raw_path = batch_dir / f"{filename}_warped.png"
            cv2.imwrite(str(warped_raw_path), warped_image, png_params)

        overlay_url = f"/inference/results/{batch_id}/{filename}/overlay.png"

        # On a clean miss, still attach a calibration record so downstream
        # consumers see ``detection_status='failed'`` and can prompt the user.
        if calibration is None:
            calibration = CalibrationCorners(
                detection_status="failed",
                calibration_object_w_mm=cfg.calibration_object_w_mm,
                calibration_object_h_mm=cfg.calibration_object_h_mm,
            )

        return LarvaeDetectionResult(
            filename=filename,
            organism="larvae",
            count=count,
            avg_confidence=round(avg_confidence, 4),
            elapsed_seconds=round(elapsed, 4),
            annotations=annotations,
            overlay_url=overlay_url,
            calibration=calibration,
        )

    # ── Public async API ─────────────────────────────────────────────────────

    async def process_single(
        self,
        image_data: bytes,
        filename: str,
        batch_id: str,
        raw_suffix: str = ".png",
    ) -> LarvaeDetectionResult:
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

        device = self._model_registry.device_for("larvae")

        async with self._semaphore:
            result = await loop.run_in_executor(
                self._executor,
                lambda: self._run_inference(
                    image, filename, batch_id, image_data, raw_suffix
                ),
            )

        logger.info(
            "Processed %s in %.1fs — %d larvae",
            filename,
            result.elapsed_seconds,
            result.count,
            extra={
                "filename": filename,
                "organism": "larvae",
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
    ) -> LarvaeBatchDetectionResult:
        total_start = time.time()
        total = len(images)
        completed = 0

        if self._max_concurrent <= 1 or total <= 1:
            results: list[LarvaeDetectionResult] = []
            for item in images:
                image_data, fname, *rest = item  # type: ignore[misc]
                raw_suffix = rest[0] if rest else ".png"
                r = await self.process_single(image_data, fname, batch_id, raw_suffix)
                results.append(r)
                completed += 1
                if on_progress is not None:
                    on_progress(completed, total)
        else:
            results_slots: list[LarvaeDetectionResult | None] = [None] * total
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

        return LarvaeBatchDetectionResult(
            results=results,
            total_count=total_count,
            total_elapsed_seconds=round(total_elapsed, 4),
        )

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _get_storage_dir(self) -> Path:
        from app.deps import get_cached_storage_dir

        return Path(get_cached_storage_dir())
