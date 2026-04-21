"""YOLO model singleton loaded once at startup via lifespan.

Loads and manages the egg detection model for inference.
Thread-safe: the model is read-only after loading.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import torch
from ultralytics import YOLO

if TYPE_CHECKING:
    from app.config import PipelineConfigManager

logger = logging.getLogger(__name__)


class ModelNotLoadedError(Exception):
    """Raised when model access is requested before it was loaded."""


class ModelRegistry:
    """Loads and holds the YOLO egg detection model once at startup.

    Handles CPU/GPU device selection with graceful fallback:
    - If CUDA is requested but unavailable, falls back to CPU and logs a WARNING.
    - Validates model.task == "detect" immediately after loading.
    - Optionally warm-ups with a dummy inference to trigger JIT compilation.

    Properties are safe to read from inference threads.
    """

    def __init__(self) -> None:
        self._model: YOLO | None = None
        self._neonate_model: YOLO | None = None
        self._neonate_device: str = "cpu"
        self._device: str = "cpu"
        self._cuda_available: bool = False
        self._loaded: bool = False
        self._start_time: float = time.time()
        self._executor: torch.utils._contextlib._IgnoredCass | None = None

    # ── Lifespan integration ──────────────────────────────────────────────────

    async def startup(self, pipeline_config: PipelineConfigManager) -> None:
        """Load the egg detection model at application startup.

        This is called from the FastAPI lifespan startup phase, before the
        server accepts any inference requests.
        """
        self._cuda_available = torch.cuda.is_available()

        # Resolve model path from config
        model_path = pipeline_config.get_model_path(organism="egg")
        egg_config = pipeline_config.get_egg_config()
        requested_device = egg_config.device

        # Device selection with fallback
        if requested_device.startswith("cuda"):
            if self._cuda_available:
                self._device = requested_device
            else:
                self._device = "cpu"
                logger.warning(
                    "CUDA device '%s' requested but no GPU found. "
                    "Falling back to CPU.",
                    requested_device,
                    extra={
                        "context": {
                            "requested_device": requested_device,
                            "fallback_device": "cpu",
                        }
                    },
                )
        else:
            self._device = "cpu"

        # CPU thread tuning — match the reference `infer_egg.py` script, which
        # leaves torch at its default (all physical cores). An env override is
        # exposed so operators can cap threads if they need to.
        if self._device == "cpu":
            override = os.environ.get("TORCH_NUM_THREADS")
            if override:
                try:
                    n_threads = max(1, int(override))
                    torch.set_num_threads(n_threads)
                    logger.info(
                        "CPU mode: torch.set_num_threads=%d (from TORCH_NUM_THREADS)",
                        n_threads,
                        extra={"context": {"n_threads": n_threads}},
                    )
                except ValueError:
                    logger.warning(
                        "Invalid TORCH_NUM_THREADS=%r — using torch default",
                        override,
                    )

        # Load YOLO model synchronously (blocking, 1-2s)
        logger.info(
            "Loading YOLO model from %s",
            model_path,
            extra={"context": {"model_path": str(model_path), "device": self._device}},
        )

        try:
            self._model = YOLO(str(model_path))
        except Exception as e:
            logger.error(
                "Failed to load YOLO model from %s",
                model_path,
                exc_info=True,
                extra={"context": {"model_path": str(model_path), "exception": str(e)}},
            )
            raise

        # Validate model task type
        if self._model.task != "detect":
            raise ValueError(
                f"Model at {model_path} is a '{self._model.task}' model, "
                f"but only 'detect' models are supported. "
                f"Expected a YOLO detection model."
            )

        # Move model to target device
        self._model.to(self._device)

        logger.info(
            "YOLO model loaded successfully",
            extra={
                "context": {
                    "model_path": str(model_path),
                    "model_task": self._model.task,
                    "device": self._device,
                    "cuda_available": self._cuda_available,
                }
            },
        )

        # Warm-up inference (trigger JIT / lazy loading)
        await self._warmup()

        # Load neonate model (best-effort — non-fatal if missing/invalid)
        await self._load_neonate(pipeline_config)

        self._loaded = True
        self._start_time = time.time()

    async def _load_neonate(self, pipeline_config: PipelineConfigManager) -> None:
        """Load the neonate detection model alongside the egg model.

        Uses the same CUDA-available fallback rule as egg. Failure is logged
        but does not abort startup — the neonate endpoints will return 503
        until the model is available.
        """
        try:
            neonate_cfg = pipeline_config.get_neonate_config()
            neonate_path = pipeline_config.get_model_path(organism="neonate")
        except Exception as e:
            logger.warning(
                "Neonate config missing or invalid; neonate inference disabled: %s",
                e,
            )
            return

        requested = neonate_cfg.device
        if requested.startswith("cuda") and not self._cuda_available:
            self._neonate_device = "cpu"
            logger.warning(
                "CUDA device '%s' requested for neonate but no GPU found. Falling back to CPU.",
                requested,
            )
        else:
            self._neonate_device = requested

        logger.info(
            "Loading neonate YOLO model from %s",
            neonate_path,
            extra={"context": {"model_path": str(neonate_path), "device": self._neonate_device}},
        )
        try:
            self._neonate_model = YOLO(str(neonate_path))
        except Exception as e:
            logger.error(
                "Failed to load neonate YOLO model from %s: %s",
                neonate_path,
                e,
                exc_info=True,
            )
            self._neonate_model = None
            return

        if self._neonate_model.task != "detect":
            logger.error(
                "Neonate model at %s is a '%s' model, expected 'detect'. Disabling.",
                neonate_path,
                self._neonate_model.task,
            )
            self._neonate_model = None
            return

        try:
            self._neonate_model.to(self._neonate_device)
        except Exception as e:
            logger.error(
                "Failed to move neonate model to device %s: %s",
                self._neonate_device,
                e,
                exc_info=True,
            )
            self._neonate_model = None
            return
        logger.info("Neonate YOLO model loaded successfully")

    async def _warmup(self) -> None:
        """Run a dummy inference on a tiny black image to warm up the model.

        This triggers JIT compilation on GPU and lazy loading on CPU so that
        the first real inference is fast.
        """
        logger.info("Warming up model with dummy inference...")
        # Create tiny 64x64 RGB image
        dummy = np.zeros((64, 64, 3), dtype=np.uint8)
        loop = __import__("asyncio").get_running_loop()

        def _infer() -> None:
            assert self._model is not None
            self._model(
                dummy,
                verbose=False,
                conf=0.25,
                device=self._device,
            )

        try:
            await loop.run_in_executor(None, _infer)
            logger.info("Model warm-up complete")
        except Exception as e:
            # Warm-up failure is non-fatal — log and continue
            logger.warning("Model warm-up failed (non-fatal): %s", e)

    async def shutdown(self) -> None:
        """Release model resources at application shutdown."""
        if self._model is not None:
            logger.info("Releasing YOLO model resources")
            del self._model
            self._model = None
            self._loaded = False
        if self._neonate_model is not None:
            logger.info("Releasing neonate YOLO model resources")
            del self._neonate_model
            self._neonate_model = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("ModelRegistry shutdown complete")

    # ── Public properties ─────────────────────────────────────────────────────

    @property
    def model(self) -> YOLO:
        """Return the loaded YOLO model instance.

        Raises:
            ModelNotLoadedError: if the model has not been loaded yet.
        """
        if self._model is None:
            raise ModelNotLoadedError(
                "Model not loaded. Call startup() before accessing the model."
            )
        return self._model

    @property
    def model_loaded(self) -> bool:
        """True if the model has been successfully loaded."""
        return self._loaded and self._model is not None

    @property
    def device(self) -> str:
        """The device the model is running on (e.g. 'cpu', 'cuda:0')."""
        return self._device

    @property
    def neonate_model(self) -> YOLO:
        """Return the loaded neonate YOLO model instance."""
        if self._neonate_model is None:
            raise ModelNotLoadedError(
                "Neonate model not loaded. Check the 'neonate' section of config.yaml "
                "and that the weights file exists."
            )
        return self._neonate_model

    @property
    def neonate_model_loaded(self) -> bool:
        """True if the neonate model has been successfully loaded."""
        return self._neonate_model is not None

    @property
    def neonate_device(self) -> str:
        """The device the neonate model is running on."""
        return self._neonate_device

    @property
    def cuda_available(self) -> bool:
        """True if CUDA (GPU) is available on this machine."""
        return self._cuda_available

    @property
    def uptime_seconds(self) -> float:
        """Seconds elapsed since the model was loaded."""
        return time.time() - self._start_time
