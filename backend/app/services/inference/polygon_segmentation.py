"""Shared YOLO-seg polygon inference core for larvae-like organisms."""

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
from app.services.inference.calibration import CalibrationService
from app.services.inference.egg import InvalidImageError
from app.services.inference.measurement import build_warp_matrix
from app.services.inference.sam_refine import SamRefinementService

if TYPE_CHECKING:
    from ultralytics import YOLO

    from app.services.model_registry import ModelRegistry

logger = logging.getLogger(__name__)

ConfigGetter = Callable[[PipelineConfigManager], Any]


class PolygonSegmentationService:
    """Tiled YOLO-seg inference shared by larvae and pupae wrappers."""

    def __init__(
        self,
        *,
        organism: str,
        label: str,
        overlay_color_bgr: tuple[int, int, int],
        annotation_schema: type[Any],
        result_schema: type[Any],
        batch_result_schema: type[Any],
        config_getter: ConfigGetter,
        model_registry: "ModelRegistry",
        pipeline_config: PipelineConfigManager,
        executor: ThreadPoolExecutor,
        calibration_service: CalibrationService,
        sam_service: SamRefinementService | None = None,
    ) -> None:
        self._organism = organism
        self._label = label
        self._overlay_color_bgr = overlay_color_bgr
        self._annotation_schema = annotation_schema
        self._result_schema = result_schema
        self._batch_result_schema = batch_result_schema
        self._config_getter = config_getter
        self._model_registry = model_registry
        self._pipeline_config = pipeline_config
        self._executor = executor
        self._calibration_svc = calibration_service
        self._sam_svc = sam_service

        device = model_registry.device_for(organism)
        max_concurrent = 1 if device == "cpu" else 2
        self._max_concurrent = max_concurrent
        self._semaphore = asyncio.Semaphore(max_concurrent)

    def _get_config(self) -> Any:
        return self._config_getter(self._pipeline_config)

    def _tile_image(
        self, image: np.ndarray, cfg: Any | None = None
    ) -> tuple[list[np.ndarray], list[tuple[int, int]]]:
        if cfg is None:
            cfg = self._get_config()
        tile_size = int(cfg.tile_size)
        stride = int(cfg.tile_size * (1 - cfg.overlap))
        h, w = image.shape[:2]

        tiles: list[np.ndarray] = []
        coords: list[tuple[int, int]] = []
        for y in range(0, h - tile_size + 1, stride):
            for x in range(0, w - tile_size + 1, stride):
                tiles.append(image[y : y + tile_size, x : x + tile_size])
                coords.append((y, x))
        return tiles, coords

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
        if x1_max <= x2_min or x2_max <= x1_min or y1_max <= y2_min or y2_max <= y1_min:
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
    def _polygon_iou_in_roi(poly1: np.ndarray, poly2: np.ndarray) -> float:
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
        if roi_w * roi_h > 500_000:
            return PolygonSegmentationService._bbox_overlap_ratio(bbox1, bbox2)

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
        n = len(candidates)
        if n == 0:
            return []
        if n == 1:
            return list(candidates)

        bbox_data: list[tuple[int, int, int, int]] = [
            tuple(c["bbox"]) for c in candidates
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
            if self._polygon_iou_in_roi(poly_a, poly_b) > overlap_threshold:
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
            chosen = remaining_list[int(np.argmax(qualities))]
            selected.append(chosen)
            remaining -= {chosen} | (neighbors[chosen] & remaining)

        return [candidates[i] for i in selected]

    def _stage(self, code: str, filename: str, batch_id: str) -> None:
        from app.services.stage_broker import emit_stage

        emit_stage(code, batch_id, filename, organism=self._organism)

    def _run_inference(
        self,
        image: np.ndarray,
        filename: str,
        batch_id: str,
        raw_image_data: bytes | None = None,
        raw_suffix: str = ".png",
    ) -> Any:
        cfg = self._get_config()
        model: "YOLO" = self._model_registry.model_for(self._organism)
        t_start = time.time()

        if image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        elif image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)

        tile_size = int(cfg.tile_size)
        edge_margin = int(cfg.edge_margin)
        min_mask_size = int(cfg.min_mask_size)

        self._stage("image.tile", filename, batch_id)
        tiles, coords = self._tile_image(image, cfg)

        self._stage("image.detect", filename, batch_id)
        candidates: list[dict[str, Any]] = []
        device_arg = self._model_registry.device_for(self._organism)
        for i in range(0, len(tiles), int(cfg.batch_size)):
            batch_tiles = tiles[i : i + int(cfg.batch_size)]
            batch_coords = coords[i : i + int(cfg.batch_size)]

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
                        score = (
                            conf_f
                            if cfg.mwis_score_metric == "confidence"
                            else conf_f * area
                        )
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
        selected = self._mwis_dedup(candidates, cfg.mwis_overlap_threshold)

        if self._sam_svc is not None and cfg.sam.enabled and selected:
            self._stage("image.refine", filename, batch_id)
            selected = self._sam_svc.refine_candidates(image, selected, cfg)

        calibration, corners_float = self._calibration_svc.detect_with_ordered(
            image, cfg
        )
        warp_matrix: np.ndarray | None = None
        warped_image: np.ndarray | None = None
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
        annotations: list[Any] = []
        for c in selected:
            poly_arr = c["polygon"]
            x1, y1, x2, y2 = c["bbox"]
            conf_v = float(c["confidence"])
            cv2.polylines(
                overlay, [poly_arr.astype(np.int32)], True, self._overlay_color_bgr, 2
            )
            polygon_points = [(int(p[0]), int(p[1])) for p in poly_arr]
            annotations.append(
                self._annotation_schema(
                    label=self._label,
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
            cv2.imwrite(
                str(batch_dir / f"{filename}_warped.png"), warped_image, png_params
            )

        if calibration is None:
            calibration = CalibrationCorners(
                detection_status="failed",
                calibration_object_w_mm=cfg.calibration_object_w_mm,
                calibration_object_h_mm=cfg.calibration_object_h_mm,
            )

        return self._result_schema(
            filename=filename,
            organism=self._organism,
            count=count,
            avg_confidence=round(avg_confidence, 4),
            elapsed_seconds=round(elapsed, 4),
            annotations=annotations,
            overlay_url=f"/inference/results/{batch_id}/{filename}/overlay.png",
            calibration=calibration,
        )

    async def process_single(
        self,
        image_data: bytes,
        filename: str,
        batch_id: str,
        raw_suffix: str = ".png",
    ) -> Any:
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
        device = self._model_registry.device_for(self._organism)

        async with self._semaphore:
            result = await loop.run_in_executor(
                self._executor,
                lambda: self._run_inference(
                    image, filename, batch_id, image_data, raw_suffix
                ),
            )

        logger.info(
            "Processed %s in %.1fs - %d %s",
            filename,
            result.elapsed_seconds,
            result.count,
            self._organism,
            extra={
                "filename": filename,
                "organism": self._organism,
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
    ) -> Any:
        total_start = time.time()
        total = len(images)
        completed = 0

        if self._max_concurrent <= 1 or total <= 1:
            results: list[Any] = []
            for item in images:
                image_data, fname, *rest = item
                raw_suffix = rest[0] if rest else ".png"
                results.append(
                    await self.process_single(image_data, fname, batch_id, raw_suffix)
                )
                completed += 1
                if on_progress is not None:
                    on_progress(completed, total)
        else:
            results_slots: list[Any | None] = [None] * total
            next_index = 0
            first_error: Exception | None = None

            async def _worker() -> None:
                nonlocal completed, first_error, next_index
                while first_error is None:
                    idx = next_index
                    next_index += 1
                    if idx >= total:
                        return
                    image_data, fname, *rest = images[idx]
                    raw_suffix = rest[0] if rest else ".png"
                    try:
                        results_slots[idx] = await self.process_single(
                            image_data, fname, batch_id, raw_suffix
                        )
                    except Exception as exc:
                        first_error = exc
                        return
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
        return self._batch_result_schema(
            results=results,
            total_count=total_count,
            total_elapsed_seconds=round(total_elapsed, 4),
        )

    def _get_storage_dir(self) -> Path:
        from app.deps import get_cached_storage_dir

        return Path(get_cached_storage_dir())
