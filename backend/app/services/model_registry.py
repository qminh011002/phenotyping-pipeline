"""YOLO model registry — best-effort load of all organism slots at startup.

Resolution per organism (delegated to ``ModelStorage``):

1. Active assignment from the DB → custom model file.
2. First ``.pt`` in ``data/models/<organism>/default/``.
3. Else: organism unavailable; ``models_status[organism] == "missing"``.

Startup never crashes because of a missing weight file. Failures are logged and
the affected organism's endpoints return 503. The frontend reads
``models_status`` from ``/health`` and disables the corresponding "Project Type"
card with a "Model not installed" hint.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import TYPE_CHECKING, Literal

import numpy as np
import torch
from ultralytics import YOLO

from app.services.model_storage import VALID_ORGANISMS, ModelStorage, ResolvedModel

if TYPE_CHECKING:
    from app.config import PipelineConfigManager

logger = logging.getLogger(__name__)

ModelStatus = Literal["loaded", "missing", "error"]


class ModelNotLoadedError(Exception):
    """Raised when model access is requested before it was loaded (or it failed)."""


class ModelRegistry:
    """Holds at-most-one YOLO instance per organism, loaded best-effort at startup."""

    def __init__(self, storage: ModelStorage) -> None:
        self._storage = storage
        self._models: dict[str, YOLO] = {}
        self._devices: dict[str, str] = {}
        self._statuses: dict[str, ModelStatus] = {o: "missing" for o in VALID_ORGANISMS}
        self._active_paths: dict[str, Path] = {}
        self._cuda_available: bool = False
        self._start_time: float = time.time()

    # ── Lifespan integration ──────────────────────────────────────────────────

    async def startup(
        self,
        pipeline_config: "PipelineConfigManager",
        custom_assignments: dict[str, Path] | None = None,
    ) -> None:
        """Load every organism's active weights best-effort.

        Parameters
        ----------
        pipeline_config
            Used solely for per-organism device preferences (``cpu`` / ``cuda:N``).
        custom_assignments
            Optional ``{organism: custom_stored_path}`` map from the DB. If the
            file exists it overrides the default-folder lookup. Missing files
            silently fall back to defaults.
        """
        self._cuda_available = torch.cuda.is_available()
        custom_assignments = custom_assignments or {}

        # CPU thread tuning honors TORCH_NUM_THREADS for ops who need to cap.
        override = os.environ.get("TORCH_NUM_THREADS")
        if override:
            try:
                n_threads = max(1, int(override))
                torch.set_num_threads(n_threads)
                logger.info(
                    "torch.set_num_threads=%d (from TORCH_NUM_THREADS)", n_threads
                )
            except ValueError:
                logger.warning("Invalid TORCH_NUM_THREADS=%r — using torch default", override)

        for organism in VALID_ORGANISMS:
            await self._load_one(
                organism=organism,
                pipeline_config=pipeline_config,
                custom_path=custom_assignments.get(organism),
            )

        if self._statuses.get("egg") == "loaded":
            await self._warmup("egg")

        self._start_time = time.time()
        logger.info(
            "Model registry startup complete",
            extra={"context": {"models_status": dict(self._statuses)}},
        )

    async def _load_one(
        self,
        organism: str,
        pipeline_config: "PipelineConfigManager",
        custom_path: Path | None,
    ) -> None:
        """Resolve + load a single organism's weights. Never raises."""
        resolved: ResolvedModel | None = self._storage.resolve_active(
            organism=organism, custom_path=custom_path
        )
        if resolved is None:
            self._statuses[organism] = "missing"
            logger.info(
                "No %s model installed (drop a .pt into %s)",
                organism,
                self._storage.default_dir(organism),
                extra={"context": {"organism": organism, "status": "missing"}},
            )
            return

        try:
            cfg = pipeline_config.get_inference_config(organism)
            requested = cfg.device
        except Exception as exc:
            logger.warning("%s config invalid; defaulting to cpu: %s", organism, exc)
            requested = "cpu"

        if requested.startswith("cuda") and not self._cuda_available:
            device = "cpu"
            logger.warning(
                "CUDA requested for %s but no GPU found — falling back to cpu",
                organism,
            )
        else:
            device = requested

        try:
            model = YOLO(str(resolved.path))
        except Exception as exc:
            self._statuses[organism] = "error"
            logger.error(
                "Failed to load %s model from %s: %s",
                organism,
                resolved.path,
                exc,
                exc_info=True,
                extra={"context": {"organism": organism, "model_path": str(resolved.path)}},
            )
            return

        if model.task != "detect":
            self._statuses[organism] = "error"
            logger.error(
                "Model at %s is a %r model, expected 'detect' — disabling %s",
                resolved.path,
                model.task,
                organism,
            )
            return

        try:
            model.to(device)
        except Exception as exc:
            self._statuses[organism] = "error"
            logger.error("Failed to move %s model to %s: %s", organism, device, exc)
            return

        self._models[organism] = model
        self._devices[organism] = device
        self._statuses[organism] = "loaded"
        self._active_paths[organism] = resolved.path
        logger.info(
            "%s model loaded",
            organism,
            extra={
                "context": {
                    "organism": organism,
                    "model_path": str(resolved.path),
                    "is_default": resolved.is_default,
                    "device": device,
                }
            },
        )

    async def reload(
        self,
        organism: str,
        pipeline_config: "PipelineConfigManager",
        custom_path: Path | None,
    ) -> ModelStatus:
        """Reload one organism's weights (called after assignment changes)."""
        old = self._models.pop(organism, None)
        if old is not None:
            try:
                old.to("cpu")
            except Exception:
                pass
            del old
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        self._statuses[organism] = "missing"
        self._active_paths.pop(organism, None)
        await self._load_one(
            organism=organism,
            pipeline_config=pipeline_config,
            custom_path=custom_path,
        )
        return self._statuses[organism]

    async def _warmup(self, organism: str) -> None:
        """Tiny dummy inference to trigger JIT / lazy load."""
        model = self._models.get(organism)
        if model is None:
            return
        device = self._devices.get(organism, "cpu")
        dummy = np.zeros((64, 64, 3), dtype=np.uint8)

        def _run() -> None:
            model(dummy, verbose=False, conf=0.25, device=device)

        try:
            await asyncio.get_running_loop().run_in_executor(None, _run)
            logger.debug("%s warm-up complete", organism)
        except Exception as exc:
            logger.warning("%s warm-up failed (non-fatal): %s", organism, exc)

    async def shutdown(self) -> None:
        """Release every loaded model's resources."""
        for organism in list(self._models.keys()):
            m = self._models.pop(organism)
            try:
                m.to("cpu")
            except Exception:
                pass
            del m
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        self._statuses = {o: "missing" for o in VALID_ORGANISMS}
        self._active_paths.clear()
        logger.info("ModelRegistry shutdown complete")

    # ── Public API ────────────────────────────────────────────────────────────

    def status(self, organism: str) -> ModelStatus:
        return self._statuses.get(organism, "missing")

    @property
    def models_status(self) -> dict[str, ModelStatus]:
        return dict(self._statuses)

    @property
    def cuda_available(self) -> bool:
        return self._cuda_available

    @property
    def uptime_seconds(self) -> float:
        return time.time() - self._start_time

    def model_for(self, organism: str) -> YOLO:
        m = self._models.get(organism)
        if m is None:
            raise ModelNotLoadedError(
                f"{organism} model not loaded — drop a .pt into "
                f"{self._storage.default_dir(organism)} and restart, "
                f"or upload one via POST /models/{organism}/upload."
            )
        return m

    def device_for(self, organism: str) -> str:
        return self._devices.get(organism, "cpu")

    def active_filename(self, organism: str) -> str:
        p = self._active_paths.get(organism)
        return p.name if p is not None else "unknown.pt"

    # ── Backwards-compatible shims for existing inference services ─────────────

    @property
    def model(self) -> YOLO:
        """Egg model — preserved for the existing EggInferenceService."""
        return self.model_for("egg")

    @property
    def neonate_model(self) -> YOLO:
        return self.model_for("neonate")

    @property
    def model_loaded(self) -> bool:
        return self.status("egg") == "loaded"

    @property
    def neonate_model_loaded(self) -> bool:
        return self.status("neonate") == "loaded"

    @property
    def device(self) -> str:
        """Egg device — preserved for executor sizing and the inference service."""
        return self.device_for("egg")

    @property
    def neonate_device(self) -> str:
        return self.device_for("neonate")
