"""EggInferenceService — tiled YOLO inference with deduplication and overlay generation.

Copies and adapts the inference logic from `phenotyping_pipeline/2_inference/infer_egg.py`.
The service owns the tiling, deduplication, and overlay logic — no runtime dependency on the
pipeline repo. All inference runs in a ThreadPoolExecutor so it never blocks the asyncio event
loop.
"""

from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Callable

import cv2
import numpy as np

from pathlib import Path

from app.config import PipelineConfigManager
from app.schemas.detection import BatchDetectionResult, BBox, DetectionResult

if TYPE_CHECKING:
    from ultralytics import YOLO

    from app.services.log_buffer import LogBuffer
    from app.services.model_registry import ModelRegistry

logger = logging.getLogger(__name__)


class InvalidImageError(Exception):
    """Raised when uploaded bytes cannot be decoded as an image."""


class EggInferenceService:
    """Tiled YOLO egg detection with center_zone / edge_nms deduplication.

    The service is thread-safe: all config is held on the instance, the model is
    read-only after loading, and inference runs in a bounded thread pool.

    Parameters
    ----------
    model_registry
        Injected from ModelRegistry (already loaded at startup).
    pipeline_config
        Injected from PipelineConfigManager (reads config.yaml on every call).
    log_buffer
        Injected from LogBuffer (used to emit structured log entries).
    executor
        Shared ThreadPoolExecutor sized by device (1 on CPU, 2 on GPU).
    """

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

        # Lazily resolved on first inference call
        self._config: "EggConfig | None" = None
        self._stride: int | None = None

    # ── Config resolution ─────────────────────────────────────────────────────

    @property
    def _egg_config(self) -> "EggConfig":
        """Lazily load and cache the egg config (read-only after first access)."""
        if self._config is None:
            self._config = self._pipeline_config.get_egg_config()
        return self._config

    @property
    def _computed_stride(self) -> int:
        """STRIDE = int(tile_size * (1 - overlap)), cached on first access."""
        if self._stride is None:
            cfg = self._egg_config
            self._stride = int(cfg.tile_size * (1 - cfg.overlap))
        return self._stride

    # ── Tile & dedup helpers ───────────────────────────────────────────────────

    def _tile_image(
        self, image: np.ndarray
    ) -> tuple[list[np.ndarray], list[tuple[int, int]]]:
        """Cut image into overlapping tiles with edge coverage.

        Adapted from `infer_egg.tile_image()`.
        Edge tiles are always included so the bottom/right border is never missed.
        If the image is smaller than tile_size, the tile is zero-padded.

        Returns
        -------
        tiles
            List of (tile_size, tile_size, 3) uint8 arrays.
        coords
            List of (y, x) offsets for each tile, in global image coordinates.
        """
        cfg = self._egg_config
        tile_size = cfg.tile_size
        stride = self._computed_stride
        h, w = image.shape[:2]

        ys = list(range(0, h - tile_size + 1, stride))
        xs = list(range(0, w - tile_size + 1, stride))

        # Add edge tiles so the bottom/right border is always covered
        if len(ys) == 0 or ys[-1] + tile_size < h:
            ys.append(max(0, h - tile_size))
        if len(xs) == 0 or xs[-1] + tile_size < w:
            xs.append(max(0, w - tile_size))

        ys = sorted(set(ys))
        xs = sorted(set(xs))

        tiles: list[np.ndarray] = []
        coords: list[tuple[int, int]] = []

        for y in ys:
            for x in xs:
                tile = image[y : y + tile_size, x : x + tile_size]
                if tile.shape[0] != tile_size or tile.shape[1] != tile_size:
                    padded = np.zeros((tile_size, tile_size, 3), dtype=image.dtype)
                    padded[: tile.shape[0], : tile.shape[1]] = tile
                    tile = padded
                tiles.append(tile)
                coords.append((y, x))

        return tiles, coords

    def _is_in_valid_zone(
        self,
        cx: float,
        cy: float,
        x_off: int,
        y_off: int,
        img_w: int,
        img_h: int,
    ) -> bool:
        """Check if detection center (cx, cy) falls in this tile's valid zone.

        Adapted from `infer_egg.is_in_valid_zone()`.
        Each pixel belongs to exactly one tile's valid zone, so no duplicates occur.
        This is the ``center_zone`` dedup mode — O(N), no NMS needed.
        """
        cfg = self._egg_config
        stride = self._computed_stride
        tile_size = cfg.tile_size
        half = stride // 2

        valid_x_min = x_off + (half if x_off > 0 else 0)
        valid_x_max = (x_off + half + stride) if (x_off + tile_size < img_w) else img_w

        valid_y_min = y_off + (half if y_off > 0 else 0)
        valid_y_max = (y_off + half + stride) if (y_off + tile_size < img_h) else img_h

        return valid_x_min <= cx < valid_x_max and valid_y_min <= cy < valid_y_max

    def _is_box_touching_edge(
        self, x1: float, y1: float, x2: float, y2: float
    ) -> bool:
        """Check if a detection box touches the tile edge (within edge_margin pixels).

        Adapted from `infer_egg.is_box_touching_edge()`.
        This is the ``edge_nms`` dedup mode: detections near the tile border are skipped
        because they are likely partial detections (the full object appears in an adjacent tile).
        """
        cfg = self._egg_config
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
        """Non-maximum suppression on (N, 4) array of [x1, y1, x2, y2] boxes.

        Adapted from `infer_egg.nms_boxes()`.
        Returns indices to keep. Used as a safety net after edge filtering (edge_nms mode).

        Parameters
        ----------
        boxes
            (N, 4) float32 array.
        scores
            (N,) float32 array of confidence scores.
        iou_threshold
            IoU threshold above which boxes are suppressed.

        Returns
        -------
        np.ndarray
            Indices of boxes to keep.
        """
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
    def _draw_board(
        overlay: np.ndarray, lines: list[str], x: int, y: int
    ) -> int:
        """Draw a black-background green-text board at (x, y).

        Adapted from `infer_egg.draw_board()`.
        Lines are rendered top-to-bottom in green on a black rectangle.
        Returns the y coordinate just below the board.

        Parameters
        ----------
        overlay
            Image array (modified in-place).
        lines
            List of text lines to render.
        x, y
            Top-left corner of the board.

        Returns
        -------
        int
            The bottom y coordinate of the drawn board.
        """
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 1.4
        thickness = 2
        pad = 14
        line_gap = 10

        sizes = [cv2.getTextSize(l, font, font_scale, thickness)[0] for l in lines]
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

    # ── Synchronous inference (runs in ThreadPoolExecutor) ─────────────────────

    def _run_inference(
        self, image: np.ndarray, filename: str, batch_id: str
    ) -> DetectionResult:
        """Run tiled detection on one image and save the overlay to disk.

        This is the synchronous, CPU/GPU-bound core — it runs in the ThreadPoolExecutor
        and must NOT be called directly from async code.

        Pipeline (identical to `infer_egg.process_image()`):
          1. Handle grayscale / BGRA conversion
          2. Tile the image
          3. Batch-inference with YOLO
          4. Convert tile-local coords → global, clip to image bounds
          5. Apply dedup: center_zone (valid zone) or edge_nms (edge skip + NMS)
          6. Post-filter: min_box_area, then NMS only for edge_nms
          7. Draw bounding boxes on overlay
          8. Draw config board and result board
          9. Save overlay PNG to image_storage_dir/{batch_id}/{filename}_overlay.png
         10. Return DetectionResult with overlay_url

        Parameters
        ----------
        image
            Decoded BGR image as a numpy array (HxWx3).
        filename
            Original upload filename (without extension).
        batch_id
            UUID string identifying the processing batch.

        Returns
        -------
        DetectionResult
            Canonical inference result with count, confidence, annotations, overlay_url.
        """
        cfg = self._egg_config
        model: "YOLO" = self._model_registry.model
        device = self._model_registry.device
        t_start = time.time()

        # ── 1. Ensure BGR 3-channel ──────────────────────────────────────────
        if image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        elif image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)

        h, w = image.shape[:2]

        # ── 2. Tile ───────────────────────────────────────────────────────────
        tiles, coords = self._tile_image(image)

        # ── 3. Batch inference ────────────────────────────────────────────────
        all_boxes: list[np.ndarray] = []
        all_scores: list[float] = []
        skipped = 0

        for i in range(0, len(tiles), cfg.batch_size):
            batch_tiles = tiles[i : i + cfg.batch_size]
            batch_coords = coords[i : i + cfg.batch_size]

            results = model(
                batch_tiles,
                verbose=False,
                conf=cfg.confidence_threshold,
                device=device,
            )

            for res, (y_off, x_off) in zip(results, batch_coords):
                if res.boxes is None or len(res.boxes) == 0:
                    continue
                for box, conf in zip(
                    res.boxes.xyxy.cpu().numpy(),
                    res.boxes.conf.cpu().numpy(),
                ):
                    x1, y1, x2, y2 = box

                    # Convert tile-local → global
                    gx1 = x1 + x_off
                    gy1 = y1 + y_off
                    gx2 = x2 + x_off
                    gy2 = y2 + y_off

                    # Clip to image bounds
                    gx1_clipped = max(0.0, min(gx1, float(w)))
                    gy1_clipped = max(0.0, min(gy1, float(h)))
                    gx2_clipped = max(0.0, min(gx2, float(w)))
                    gy2_clipped = max(0.0, min(gy2, float(h)))

                    # ── 4. Dedup ─────────────────────────────────────────────
                    if cfg.dedup_mode == "center_zone":
                        cx = (gx1_clipped + gx2_clipped) / 2
                        cy = (gy1_clipped + gy2_clipped) / 2
                        if not self._is_in_valid_zone(cx, cy, x_off, y_off, w, h):
                            skipped += 1
                            continue
                    elif cfg.dedup_mode == "edge_nms":
                        if self._is_box_touching_edge(x1, y1, x2, y2):
                            skipped += 1
                            continue

                    all_boxes.append(np.array([gx1_clipped, gy1_clipped, gx2_clipped, gy2_clipped], dtype=np.float32))
                    all_scores.append(float(conf))

        # ── 5. Post-filter ────────────────────────────────────────────────────
        if all_boxes:
            boxes_arr = np.stack(all_boxes, axis=0)
            scores_arr = np.array(all_scores, dtype=np.float32)

            if cfg.min_box_area > 0:
                areas = (boxes_arr[:, 2] - boxes_arr[:, 0]) * (boxes_arr[:, 3] - boxes_arr[:, 1])
                mask = areas >= cfg.min_box_area
                boxes_arr = boxes_arr[mask]
                scores_arr = scores_arr[mask]

            if cfg.dedup_mode == "edge_nms" and len(boxes_arr) > 0:
                keep = self._nms_boxes(boxes_arr, scores_arr, cfg.nms_iou_threshold)
                boxes_arr = boxes_arr[keep]
                scores_arr = scores_arr[keep]
        else:
            boxes_arr = np.empty((0, 4), dtype=np.float32)
            scores_arr = np.empty(0, dtype=np.float32)

        egg_count = len(boxes_arr)

        # ── 6. Draw overlay ──────────────────────────────────────────────────
        overlay = image.copy()
        annotations: list[BBox] = []

        for box, conf in zip(boxes_arr, scores_arr):
            x1_i, y1_i, x2_i, y2_i = box.astype(int).tolist()
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
                    label="neonate_egg",
                    bbox=(x1_i, y1_i, x2_i, y2_i),
                    confidence=round(float(conf), 4),
                )
            )

        avg_confidence = float(scores_arr.mean()) if len(scores_arr) else 0.0
        elapsed = time.time() - t_start

        # ── 7. Config board ──────────────────────────────────────────────────
        model_name = cfg.model.split("/")[-1] if "/" in cfg.model else cfg.model
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

        # ── 8. Result board ───────────────────────────────────────────────────
        result_lines: list[str] = [
            "[ Result ]",
            f"  Time        : {elapsed:.1f}s",
            f"  Count       : {egg_count}",
            f"  Avg conf    : {avg_confidence:.3f}",
        ]
        self._draw_board(overlay, result_lines, board_x, bottom + 10)

        # ── 9. Save overlay + raw image to disk ──────────────────────────────
        batch_dir = self._get_storage_dir() / batch_id
        batch_dir.mkdir(parents=True, exist_ok=True)

        overlay_filename = f"{filename}_overlay.png"
        overlay_path = batch_dir / overlay_filename
        cv2.imwrite(str(overlay_path), overlay)

        # Persist the un-annotated source image so the frontend can render its
        # own bbox overlays on top of it. `image` is the normalized BGR array
        # (pre-drawing), and `overlay = image.copy()` above means drawing on
        # `overlay` never mutates `image`.
        raw_filename = f"{filename}_raw.png"
        raw_path = batch_dir / raw_filename
        cv2.imwrite(str(raw_path), image)

        # ── 10. Build result ─────────────────────────────────────────────────
        overlay_url = f"/inference/results/{batch_id}/{filename}/overlay.png"

        return DetectionResult(
            filename=filename,
            organism="egg",
            count=egg_count,
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
    ) -> DetectionResult:
        """Run inference on a single image.

        Decodes the image bytes, acquires the concurrency semaphore, runs the
        synchronous inference in the ThreadPoolExecutor, logs the result, and
        returns a ``DetectionResult``.

        Parameters
        ----------
        image_data
            Raw bytes of the uploaded image file.
        filename
            Original filename (used as the overlay filename stem).
        batch_id
            UUID string identifying the processing batch.

        Returns
        -------
        DetectionResult
            Inference result with count, confidence, annotations, and overlay_url.

        Raises
        ------
        InvalidImageError
            If the bytes cannot be decoded as an image.
        """
        # Decode image bytes (CPU-bound, runs in executor)
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

        # Get semaphore bound and device info
        device = self._model_registry.device
        max_concurrent = 1 if device == "cpu" else 2
        semaphore = asyncio.Semaphore(max_concurrent)

        async with semaphore:
            result = await loop.run_in_executor(
                self._executor,
                lambda: self._run_inference(image, filename, batch_id),
            )

        # Structured log — see logging.mdc "What to log" table
        logger.info(
            "Processed %s in %.1fs — %d eggs",
            filename,
            result.elapsed_seconds,
            result.count,
            extra={
                "filename": filename,
                "organism": "egg",
                "device": device,
                "elapsed_seconds": round(result.elapsed_seconds, 4),
                "count": result.count,
                "avg_confidence": round(result.avg_confidence, 4),
            },
        )

        return result

    async def process_batch(
        self,
        images: list[tuple[bytes, str]],
        batch_id: str,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> BatchDetectionResult:
        """Run inference on multiple images sequentially.

        Each image is processed via ``process_single()``. Results are aggregated
        into a ``BatchDetectionResult``.

        Parameters
        ----------
        images
            List of (image_data, filename) tuples.
        batch_id
            UUID string identifying this batch.
        on_progress
            Optional callback ``(completed, total)`` called after each image.

        Returns
        -------
        BatchDetectionResult
            Aggregated results for all images.
        """
        results: list[DetectionResult] = []
        total_start = time.time()

        for idx, (image_data, fname) in enumerate(images, start=1):
            result = await self.process_single(image_data, fname, batch_id)
            results.append(result)
            if on_progress is not None:
                on_progress(idx, len(images))

        total_elapsed = time.time() - total_start
        total_count = sum(r.count for r in results)

        return BatchDetectionResult(
            results=results,
            total_count=total_count,
            total_elapsed_seconds=round(total_elapsed, 4),
        )

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _get_storage_dir(self) -> Path:
        """Return the current image storage directory from the DB-backed cache.

        Reads the latest path from the DB cache (invalidated on PUT /settings/storage),
        falling back to the env default if the DB is unavailable.
        """
        from app.deps import get_cached_storage_dir
        return Path(get_cached_storage_dir())
