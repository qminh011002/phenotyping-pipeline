"""SamRefinementService — refine YOLO larvae polygons with SAM.

Ports the per-crop, bbox-prompted refinement from
``phenotyping_pipeline/2_inference/refine_larvae_sam.py``. For each YOLO
detection above ``confidence_threshold`` we crop a small region of the source
image around the bbox (with ``crop_padding`` of context), feed the crop and
local bbox to SAM, and lift the resulting mask back to image coordinates as
a float-precision polygon.

The service is stateful only in that it lazy-loads the SAM weights on first
call. Once loaded the model is reused across requests. All heavy work runs
inside the supplied ``ThreadPoolExecutor`` so the asyncio loop stays free.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

if TYPE_CHECKING:
    from ultralytics import SAM as _SAMType  # noqa: N811

    from app.schemas.config import (
        LarvaeConfig,
        LarvaeSamConfig,
        PupaeConfig,
        PupaeSamConfig,
    )

logger = logging.getLogger(__name__)


def _auto_device(preferred: str | None) -> str:
    """Resolve a SAM device choice.

    ``preferred`` may be: a concrete string ("cpu", "cuda", "cuda:0"), or
    ``None`` meaning "pick cuda if available else cpu". CUDA fall-through to
    CPU is logged (per the project's CUDA-fallback hard rule).
    """
    if preferred and preferred != "cpu":
        try:
            import torch

            if not torch.cuda.is_available():
                logger.warning(
                    "SAM requested device=%s but CUDA is not available — using CPU",
                    preferred,
                )
                return "cpu"
        except ImportError:
            return "cpu"
        return preferred
    if preferred == "cpu":
        return "cpu"
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


def _polygon_iou(poly_a: np.ndarray, poly_b: np.ndarray) -> float:
    """Compute IoU over the combined polygon ROI."""
    a = np.asarray(poly_a, dtype=np.float32).reshape(-1, 2)
    b = np.asarray(poly_b, dtype=np.float32).reshape(-1, 2)
    if len(a) < 3 or len(b) < 3:
        return 0.0

    x_min = int(np.floor(min(a[:, 0].min(), b[:, 0].min()))) - 5
    y_min = int(np.floor(min(a[:, 1].min(), b[:, 1].min()))) - 5
    x_max = int(np.ceil(max(a[:, 0].max(), b[:, 0].max()))) + 5
    y_max = int(np.ceil(max(a[:, 1].max(), b[:, 1].max()))) + 5
    roi_w = x_max - x_min + 1
    roi_h = y_max - y_min + 1
    if roi_w <= 0 or roi_h <= 0:
        return 0.0

    # Extremely large prompt failures should not allocate huge masks. Bbox IoU
    # is conservative enough for rejecting obviously shifted SAM masks.
    if roi_w * roi_h > 500_000:
        ax1, ay1 = float(a[:, 0].min()), float(a[:, 1].min())
        ax2, ay2 = float(a[:, 0].max()), float(a[:, 1].max())
        bx1, by1 = float(b[:, 0].min()), float(b[:, 1].min())
        bx2, by2 = float(b[:, 0].max()), float(b[:, 1].max())
        inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
        inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
        inter = inter_w * inter_h
        area_a = max(0.0, (ax2 - ax1) * (ay2 - ay1))
        area_b = max(0.0, (bx2 - bx1) * (by2 - by1))
        union = area_a + area_b - inter
        return inter / union if union > 0 else 0.0

    offset = np.array([x_min, y_min], dtype=np.float32)
    mask_a = np.zeros((roi_h, roi_w), dtype=np.uint8)
    mask_b = np.zeros((roi_h, roi_w), dtype=np.uint8)
    cv2.fillPoly(mask_a, [(a - offset).astype(np.int32)], 1)
    cv2.fillPoly(mask_b, [(b - offset).astype(np.int32)], 1)
    inter = int(np.logical_and(mask_a, mask_b).sum())
    union = int(np.logical_or(mask_a, mask_b).sum())
    return inter / union if union > 0 else 0.0


class SamRefinementService:
    """Lazy-loaded SAM refiner. One model instance, thread-safe load."""

    def __init__(
        self,
        executor: ThreadPoolExecutor,
        weights_dir: Path,
    ) -> None:
        self._executor = executor
        self._weights_dir = weights_dir
        self._model: "_SAMType | None" = None
        self._loaded_signature: tuple[str, str] | None = None  # (weights_path, device)
        self._device_cache: dict[str, str] = {}
        self._load_lock = threading.Lock()
        self._refine_lock = threading.Lock()
        # Bounded concurrency — SAM models are heavy; one at a time on CPU,
        # one at a time on GPU (Ultralytics SAM is not batch-safe for our
        # per-crop loop). Override here if profiling later suggests more.
        self._semaphore = asyncio.Semaphore(1)

    @property
    def weights_dir(self) -> Path:
        return self._weights_dir

    def invalidate_cached_model(self) -> None:
        """Drop the loaded model so the next refine call reloads from disk."""
        self._model = None
        self._loaded_signature = None

    # ── Model lifecycle ─────────────────────────────────────────────────────

    def _resolve_weights(self, model_name: str) -> Path:
        candidate = self._weights_dir / model_name
        if candidate.is_file():
            return candidate
        # Allow absolute paths (or paths relative to cwd) for power users.
        raw = Path(model_name)
        if raw.is_file():
            return raw
        # Final fallback: let Ultralytics resolve / download by short name.
        return Path(model_name)

    def _ensure_model(
        self,
        sam_cfg: "LarvaeSamConfig | PupaeSamConfig",
        larvae_device: str,
    ) -> "_SAMType":
        preferred = sam_cfg.device or larvae_device
        device = self._device_cache.get(preferred)
        if device is None:
            device = _auto_device(preferred)
            self._device_cache[preferred] = device
        weights = self._resolve_weights(sam_cfg.model)
        sig = (str(weights), device)

        with self._load_lock:
            if self._model is not None and self._loaded_signature == sig:
                return self._model
            from ultralytics import SAM

            logger.info(
                "Loading SAM model weights=%s device=%s",
                weights,
                device,
                extra={"context": {"sam_weights": str(weights), "device": device}},
            )
            model = SAM(str(weights))
            try:
                model.to(device)
            except (RuntimeError, AssertionError) as exc:
                logger.warning(
                    "SAM .to(%s) failed (%s) — falling back to CPU",
                    device,
                    exc,
                )
                device = "cpu"
                self._device_cache[preferred] = device
                model.to("cpu")
            inner_model = getattr(model, "model", None)
            if inner_model is not None and hasattr(inner_model, "eval"):
                inner_model.eval()
            self._model = model
            self._loaded_signature = (str(weights), device)
            return model

    # ── Core refinement (sync) ──────────────────────────────────────────────

    def _refine_one(
        self,
        model: "_SAMType",
        image: np.ndarray,
        candidate: dict[str, Any],
        padding: int,
        min_area_ratio: float = 0.6,
        max_area_ratio: float = 1.3,
        min_iou_vs_yolo: float = 0.5,
    ) -> dict[str, Any] | None:
        """Return a new candidate with refined polygon, or None on failure."""
        x_min, y_min, x_max, y_max = candidate["bbox"]
        h, w = image.shape[:2]
        cx1 = max(0, int(x_min) - padding)
        cy1 = max(0, int(y_min) - padding)
        cx2 = min(w, int(x_max) + padding)
        cy2 = min(h, int(y_max) + padding)
        if cx2 - cx1 < 4 or cy2 - cy1 < 4:
            return None

        crop = image[cy1:cy2, cx1:cx2]
        local_bbox = [
            float(x_min - cx1),
            float(y_min - cy1),
            float(x_max - cx1),
            float(y_max - cy1),
        ]

        try:
            # Pipeline parity: force FP32. Ultralytics SAM defaults to FP16 on
            # CUDA which gives slight per-pixel mask jitter — disabled here so
            # the refined polygon points are byte-identical to the reference
            # pipeline output.
            try:
                import torch

                with torch.inference_mode():
                    results = model(
                        crop, bboxes=[local_bbox], verbose=False, half=False
                    )
            except ImportError:
                results = model(crop, bboxes=[local_bbox], verbose=False, half=False)
        except (RuntimeError, ValueError) as exc:
            logger.debug("SAM inference error: %s", exc)
            return None

        if not results or results[0].masks is None or len(results[0].masks.data) == 0:
            return None

        mask = results[0].masks.data[0].cpu().numpy()
        mask = (mask > 0.5).astype(np.uint8)
        if mask.shape != crop.shape[:2]:
            mask = cv2.resize(
                mask, (crop.shape[1], crop.shape[0]), interpolation=cv2.INTER_NEAREST
            )

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None
        main_contour = max(contours, key=cv2.contourArea)
        if len(main_contour) < 3:
            return None

        # Match phenotyping_pipeline/refine_larvae_sam.py: keep SAM polygon in
        # float precision until the later perspective-warp measurement step.
        poly_local = main_contour.squeeze(axis=1).astype(np.float32)
        poly_arr = poly_local + np.array([cx1, cy1], dtype=np.float32)
        new_area = float(cv2.contourArea(poly_arr))
        old_poly = np.asarray(candidate.get("polygon"), dtype=np.float32).reshape(-1, 2)
        old_area = float(candidate.get("area") or cv2.contourArea(old_poly))
        if old_area <= 0:
            return None
        area_ratio = new_area / old_area
        if area_ratio < min_area_ratio or area_ratio > max_area_ratio:
            logger.debug(
                "Rejecting SAM mask by area ratio %.3f outside [%.3f, %.3f]",
                area_ratio,
                min_area_ratio,
                max_area_ratio,
            )
            return None
        iou_vs_yolo = _polygon_iou(old_poly, poly_arr)
        if iou_vs_yolo < min_iou_vs_yolo:
            logger.debug(
                "Rejecting SAM mask by IoU %.3f below %.3f",
                iou_vs_yolo,
                min_iou_vs_yolo,
            )
            return None

        x1 = int(poly_arr[:, 0].min())
        y1 = int(poly_arr[:, 1].min())
        x2 = int(poly_arr[:, 0].max())
        y2 = int(poly_arr[:, 1].max())

        refined = dict(candidate)
        refined["polygon"] = poly_arr
        refined["bbox"] = (x1, y1, x2, y2)
        refined["area"] = new_area
        return refined

    def refine_candidates(
        self,
        image: np.ndarray,
        candidates: list[dict[str, Any]],
        cfg: "LarvaeConfig | PupaeConfig",
    ) -> list[dict[str, Any]]:
        """Refine every candidate polygon in-place (returns a new list).

        Candidates below ``sam.confidence_threshold`` are passed through
        unchanged. Failures (SAM error, empty mask, ...) also pass through
        unchanged — refinement is best-effort and must never lose detections.
        """
        sam_cfg = cfg.sam
        if not sam_cfg.enabled or not candidates:
            return candidates

        thresh = float(sam_cfg.confidence_threshold)
        needs_refine = [
            idx
            for idx, cand in enumerate(candidates)
            if float(cand.get("confidence", 1.0)) >= thresh
        ]
        if not needs_refine:
            logger.info(
                "SAM refine: 0 refined / %d skipped / 0 failed (%d total) in 0.00s",
                len(candidates),
                len(candidates),
                extra={
                    "context": {
                        "refined": 0,
                        "skipped": len(candidates),
                        "failed": 0,
                        "total": len(candidates),
                    }
                },
            )
            return candidates

        model = self._ensure_model(sam_cfg, cfg.device)
        padding = int(sam_cfg.crop_padding)
        min_ratio = float(sam_cfg.min_area_ratio)
        max_ratio = float(sam_cfg.max_area_ratio)
        min_iou = float(sam_cfg.min_iou_vs_yolo)

        refined: list[dict[str, Any]] = list(candidates)
        n_refined = 0
        n_skipped = len(candidates) - len(needs_refine)
        n_failed = 0
        t0 = time.time()
        with self._refine_lock:
            for idx in needs_refine:
                cand = candidates[idx]
                new = self._refine_one(
                    model,
                    image,
                    cand,
                    padding,
                    min_area_ratio=min_ratio,
                    max_area_ratio=max_ratio,
                    min_iou_vs_yolo=min_iou,
                )
                if new is None:
                    n_failed += 1
                    continue
                refined[idx] = new
                n_refined += 1

        logger.info(
            "SAM refine: %d refined / %d skipped / %d failed (%d total) in %.2fs",
            n_refined,
            n_skipped,
            n_failed,
            len(candidates),
            time.time() - t0,
            extra={
                "context": {
                    "refined": n_refined,
                    "skipped": n_skipped,
                    "failed": n_failed,
                    "total": len(candidates),
                }
            },
        )
        return refined

    # ── Async wrapper ───────────────────────────────────────────────────────

    async def refine_candidates_async(
        self,
        image: np.ndarray,
        candidates: list[dict[str, Any]],
        cfg: "LarvaeConfig | PupaeConfig",
    ) -> list[dict[str, Any]]:
        if not cfg.sam.enabled or not candidates:
            return candidates
        loop = asyncio.get_running_loop()
        async with self._semaphore:
            return await loop.run_in_executor(
                self._executor,
                lambda: self.refine_candidates(image, candidates, cfg),
            )
