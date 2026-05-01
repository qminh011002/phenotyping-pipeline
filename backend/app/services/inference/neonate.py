"""NeonateInferenceService — tiled YOLO inference for neonate detection.

Mirrors EggInferenceService. Copied and adapted from
`phenotyping_pipeline/2_inference/infer_neonate.py`. No runtime dependency on
the pipeline repo. All inference runs in a ThreadPoolExecutor.
"""

from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING, Callable

import cv2
import numpy as np

from app.config import PipelineConfigManager
from app.schemas.detection import BatchDetectionResult, BBox, DetectionResult
from app.services.inference.egg import InvalidImageError

if TYPE_CHECKING:
    from ultralytics import YOLO

    from app.services.log_buffer import LogBuffer
    from app.services.model_registry import ModelRegistry

logger = logging.getLogger(__name__)


class NeonateInferenceService:
    """Tiled YOLO neonate detection with center_zone / edge_nms deduplication."""

    def __init__(
        self,
        model_registry: ModelRegistry,
        pipeline_config: PipelineConfigManager,
        log_buffer: LogBuffer,
        executor: ThreadPoolExecutor,
    ) -> None:
        self._model_registry = model_registry
        self._pipeline_config = pipeline_config
        self._log_buffer = log_buffer
        self._executor = executor
        self._config = None
        self._stride: int | None = None

        max_concurrent = 1 if model_registry.neonate_device == "cpu" else 2
        self._semaphore = asyncio.Semaphore(max_concurrent)

    # ── Config ────────────────────────────────────────────────────────────────

    @property
    def _neonate_config(self):
        return self._pipeline_config.get_neonate_config()

    @property
    def _computed_stride(self) -> int:
        cfg = self._neonate_config
        return int(cfg.tile_size * (1 - cfg.overlap))

    # ── Tile / dedup helpers ──────────────────────────────────────────────────

    def _tile_image(
        self, image: np.ndarray, cfg=None
    ) -> tuple[list[np.ndarray], list[tuple[int, int]]]:
        if cfg is None:
            cfg = self._neonate_config
        tile_size = cfg.tile_size
        stride = int(cfg.tile_size * (1 - cfg.overlap))
        h, w = image.shape[:2]

        ys = list(range(0, h - tile_size + 1, stride))
        xs = list(range(0, w - tile_size + 1, stride))

        if len(ys) == 0 or ys[-1] + tile_size < h:
            ys.append(max(0, h - tile_size))
        if len(xs) == 0 or xs[-1] + tile_size < w:
            xs.append(max(0, w - tile_size))

        ys = sorted(set(ys))
        xs = sorted(set(xs))

        # Pad once; tiles are zero-copy views into the padded array.
        max_y = max(ys, default=0)
        max_x = max(xs, default=0)
        pad_h = max(h, max_y + tile_size)
        pad_w = max(w, max_x + tile_size)
        if pad_h != h or pad_w != w:
            padded = np.zeros((pad_h, pad_w, 3), dtype=image.dtype)
            padded[:h, :w] = image
        else:
            padded = image

        tiles: list[np.ndarray] = [
            padded[y : y + tile_size, x : x + tile_size] for y in ys for x in xs
        ]
        coords: list[tuple[int, int]] = [(y, x) for y in ys for x in xs]

        return tiles, coords

    def _is_in_valid_zone(
        self, cx: float, cy: float, x_off: int, y_off: int, img_w: int, img_h: int
    ) -> bool:
        cfg = self._neonate_config
        stride = self._computed_stride
        tile_size = cfg.tile_size
        half = stride // 2

        valid_x_min = x_off + (half if x_off > 0 else 0)
        valid_x_max = (x_off + half + stride) if (x_off + tile_size < img_w) else img_w
        valid_y_min = y_off + (half if y_off > 0 else 0)
        valid_y_max = (y_off + half + stride) if (y_off + tile_size < img_h) else img_h

        return valid_x_min <= cx < valid_x_max and valid_y_min <= cy < valid_y_max

    def _is_box_touching_edge(self, x1: float, y1: float, x2: float, y2: float) -> bool:
        cfg = self._neonate_config
        tile_size = cfg.tile_size
        edge_margin = cfg.edge_margin
        return (
            x1 <= edge_margin
            or y1 <= edge_margin
            or x2 >= tile_size - edge_margin
            or y2 >= tile_size - edge_margin
        )

    @staticmethod
    def _nms_boxes(
        boxes: np.ndarray, scores: np.ndarray, iou_threshold: float
    ) -> np.ndarray:
        if len(boxes) == 0:
            return np.array([], dtype=int)

        areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
        order = scores.argsort()[::-1]

        keep: list[int] = []
        while order.size > 0:
            i = order[0]
            keep.append(int(i))
            if order.size == 1:
                break
            xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
            yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
            xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
            yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
            inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
            iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
            remaining = np.where(iou <= iou_threshold)[0]
            order = order[remaining + 1]

        return np.array(keep, dtype=int)

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

    # ── Synchronous inference ────────────────────────────────────────────────

    def _stage(self, code: str, filename: str, batch_id: str) -> None:
        """Emit a stage event to the /ws/stages broker from any worker thread."""
        from app.services.stage_broker import emit_stage

        emit_stage(code, batch_id, filename, organism="neonate")

    def _run_inference(
        self,
        image: np.ndarray,
        filename: str,
        batch_id: str,
        raw_image_data: bytes | None = None,
        raw_suffix: str = ".png",
    ) -> DetectionResult:
        cfg = self._neonate_config
        model: "YOLO" = self._model_registry.neonate_model
        # device intentionally not passed to model() per call — see egg.py.
        t_start = time.time()

        if image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        elif image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)

        h, w = image.shape[:2]
        self._stage("image.tile", filename, batch_id)
        tiles, coords = self._tile_image(image, cfg)

        self._stage("image.detect", filename, batch_id)
        all_boxes: list[np.ndarray] = []
        all_scores: list[np.ndarray] = []
        all_cls_ids: list[np.ndarray] = []
        skipped = 0

        # Class-name lookup driven by the loaded checkpoint, not a hardcoded literal.
        names_map = getattr(model, "names", None) or {}
        default_label = (
            next(iter(names_map.values()), "neonate") if names_map else "neonate"
        )

        stride = self._computed_stride
        half = stride // 2
        tile_size = cfg.tile_size
        edge_margin = cfg.edge_margin

        for i in range(0, len(tiles), cfg.batch_size):
            batch_tiles = tiles[i : i + cfg.batch_size]
            batch_coords = coords[i : i + cfg.batch_size]

            results = model(
                batch_tiles,
                verbose=False,
                conf=cfg.confidence_threshold,
            )

            # Batch the GPU→CPU sync — see egg.py for the rationale.
            batch_xyxy_t = []
            batch_confs_t = []
            batch_cls_t = []
            slice_lengths: list[int] = []
            for res in results:
                if res.boxes is None or len(res.boxes) == 0:
                    slice_lengths.append(0)
                    continue
                n = len(res.boxes)
                slice_lengths.append(n)
                batch_xyxy_t.append(res.boxes.xyxy)
                batch_confs_t.append(res.boxes.conf)
                cls_attr = getattr(res.boxes, "cls", None)
                if cls_attr is not None:
                    batch_cls_t.append(cls_attr)
                else:
                    import torch

                    batch_cls_t.append(
                        torch.zeros(n, dtype=torch.int32, device=res.boxes.xyxy.device)
                    )

            if batch_xyxy_t:
                import torch

                cat_xyxy = torch.cat(batch_xyxy_t, dim=0).cpu().numpy()
                cat_confs = torch.cat(batch_confs_t, dim=0).cpu().numpy()
                cat_cls = (
                    torch.cat(batch_cls_t, dim=0).cpu().numpy().astype(np.int32)
                )
            else:
                cat_xyxy = np.empty((0, 4), dtype=np.float32)
                cat_confs = np.empty(0, dtype=np.float32)
                cat_cls = np.empty(0, dtype=np.int32)

            cursor = 0
            for n, (y_off, x_off) in zip(slice_lengths, batch_coords):
                if n == 0:
                    continue
                xyxy = cat_xyxy[cursor : cursor + n]
                confs = cat_confs[cursor : cursor + n]
                cls_ids = cat_cls[cursor : cursor + n]
                cursor += n
                if xyxy.size == 0:
                    continue

                offset = np.array([x_off, y_off, x_off, y_off], dtype=xyxy.dtype)
                g = xyxy + offset
                np.clip(g[:, 0::2], 0, w, out=g[:, 0::2])
                np.clip(g[:, 1::2], 0, h, out=g[:, 1::2])

                if cfg.dedup_mode == "center_zone":
                    cx = (g[:, 0] + g[:, 2]) * 0.5
                    cy = (g[:, 1] + g[:, 3]) * 0.5
                    valid_x_min = x_off + (half if x_off > 0 else 0)
                    valid_x_max = (
                        (x_off + half + stride) if (x_off + tile_size < w) else w
                    )
                    valid_y_min = y_off + (half if y_off > 0 else 0)
                    valid_y_max = (
                        (y_off + half + stride) if (y_off + tile_size < h) else h
                    )
                    mask = (
                        (cx >= valid_x_min)
                        & (cx < valid_x_max)
                        & (cy >= valid_y_min)
                        & (cy < valid_y_max)
                    )
                elif cfg.dedup_mode == "edge_nms":
                    mask = ~(
                        (xyxy[:, 0] <= edge_margin)
                        | (xyxy[:, 1] <= edge_margin)
                        | (xyxy[:, 2] >= tile_size - edge_margin)
                        | (xyxy[:, 3] >= tile_size - edge_margin)
                    )
                else:
                    mask = np.ones(len(g), dtype=bool)

                kept = int(mask.sum())
                skipped += len(g) - kept
                if kept == 0:
                    continue
                all_boxes.append(g[mask].astype(np.float32, copy=False))
                all_scores.append(confs[mask].astype(np.float32, copy=False))
                all_cls_ids.append(cls_ids[mask])

        self._stage("image.dedup", filename, batch_id)
        if all_boxes:
            boxes_arr = np.concatenate(all_boxes, axis=0)
            scores_arr = np.concatenate(all_scores, axis=0)
            cls_ids_arr = np.concatenate(all_cls_ids, axis=0)

            if cfg.min_box_area > 0:
                areas = (boxes_arr[:, 2] - boxes_arr[:, 0]) * (
                    boxes_arr[:, 3] - boxes_arr[:, 1]
                )
                mask = areas >= cfg.min_box_area
                boxes_arr = boxes_arr[mask]
                scores_arr = scores_arr[mask]
                cls_ids_arr = cls_ids_arr[mask]

            if cfg.dedup_mode == "edge_nms" and len(boxes_arr) > 0:
                keep = self._nms_boxes(boxes_arr, scores_arr, cfg.nms_iou_threshold)
                boxes_arr = boxes_arr[keep]
                scores_arr = scores_arr[keep]
                cls_ids_arr = cls_ids_arr[keep]
        else:
            boxes_arr = np.empty((0, 4), dtype=np.float32)
            scores_arr = np.empty(0, dtype=np.float32)
            cls_ids_arr = np.empty(0, dtype=np.int32)

        neonate_count = len(boxes_arr)

        self._stage("image.draw", filename, batch_id)
        overlay = image.copy()
        annotations: list[BBox] = []

        for box, conf, cls_id in zip(boxes_arr, scores_arr, cls_ids_arr):
            x1_i, y1_i, x2_i, y2_i = box.astype(int).tolist()
            label = str(names_map.get(int(cls_id), default_label))
            cv2.rectangle(overlay, (x1_i, y1_i), (x2_i, y2_i), (0, 255, 0), 1)
            cv2.putText(
                overlay,
                f"{conf:.2f}",
                (x1_i, y1_i - 5),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.4,
                (0, 255, 0),
                1,
            )
            annotations.append(
                BBox(
                    label=label,
                    bbox=(x1_i, y1_i, x2_i, y2_i),
                    confidence=round(float(conf), 4),
                )
            )

        avg_confidence = float(scores_arr.mean()) if len(scores_arr) else 0.0
        elapsed = time.time() - t_start

        model_name = self._model_registry.active_filename("neonate")
        config_lines: list[str] = [
            "[ Configuration ]",
            f"  model       : {model_name}",
            f"  tile_size   : {cfg.tile_size}",
            f"  overlap     : {cfg.overlap}",
            f"  conf_thres  : {cfg.confidence_threshold}",
            f"  dedup_mode  : {cfg.dedup_mode}",
            f"  min_box_area: {cfg.min_box_area}",
            f"  batch_size  : {cfg.batch_size}",
        ]
        if cfg.dedup_mode == "edge_nms":
            config_lines += [
                f"  edge_margin : {cfg.edge_margin}",
                f"  nms_iou     : {cfg.nms_iou_threshold}",
            ]

        board_x = 10
        board_y = 10
        bottom = self._draw_board(overlay, config_lines, board_x, board_y)

        result_lines: list[str] = [
            "[ Result ]",
            f"  Time        : {elapsed:.1f}s",
            f"  Count       : {neonate_count}",
            f"  Avg conf    : {avg_confidence:.3f}",
        ]
        self._draw_board(overlay, result_lines, board_x, bottom + 10)

        self._stage("image.save", filename, batch_id)
        batch_dir = self._get_storage_dir() / batch_id
        batch_dir.mkdir(parents=True, exist_ok=True)

        png_params = [cv2.IMWRITE_PNG_COMPRESSION, 1]

        overlay_filename = f"{filename}_overlay.png"
        overlay_path = batch_dir / overlay_filename
        cv2.imwrite(str(overlay_path), overlay, png_params)

        raw_path = batch_dir / f"{filename}_raw{raw_suffix}"
        if raw_image_data is not None:
            raw_path.write_bytes(raw_image_data)
        else:
            cv2.imwrite(str(raw_path), image, png_params)

        overlay_url = f"/inference/results/{batch_id}/{filename}/overlay.png"

        return DetectionResult(
            filename=filename,
            organism="neonate",
            count=neonate_count,
            avg_confidence=round(avg_confidence, 4),
            elapsed_seconds=round(elapsed, 4),
            annotations=annotations,
            overlay_url=overlay_url,
        )

    # ── Public async API ──────────────────────────────────────────────────────

    async def process_single(
        self,
        image_data: bytes,
        filename: str,
        batch_id: str,
        raw_suffix: str = ".png",
    ) -> DetectionResult:
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

        device = self._model_registry.neonate_device

        async with self._semaphore:
            result = await loop.run_in_executor(
                self._executor,
                lambda: self._run_inference(
                    image, filename, batch_id, image_data, raw_suffix
                ),
            )

        logger.info(
            "Processed %s in %.1fs — %d neonates",
            filename,
            result.elapsed_seconds,
            result.count,
            extra={
                "filename": filename,
                "organism": "neonate",
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
    ) -> BatchDetectionResult:
        total_start = time.time()
        total = len(images)
        completed = 0

        # Sequential processing — the inference semaphore already serializes,
        # so eager gather just held every decoded ndarray in RAM.
        results: list[DetectionResult] = []
        for item in images:
            image_data, fname, *rest = item  # type: ignore[misc]
            raw_suffix = rest[0] if rest else ".png"
            r = await self.process_single(image_data, fname, batch_id, raw_suffix)
            results.append(r)
            completed += 1
            if on_progress is not None:
                on_progress(completed, total)

        total_elapsed = time.time() - total_start
        total_count = sum(r.count for r in results)

        return BatchDetectionResult(
            results=results,
            total_count=total_count,
            total_elapsed_seconds=round(total_elapsed, 4),
        )

    def _get_storage_dir(self) -> Path:
        from app.deps import get_cached_storage_dir

        return Path(get_cached_storage_dir())
