"""Application settings and inference configuration management.

- AppSettings: environment-based configuration via pydantic-settings.
- PipelineConfigManager: loads/persists ``data/inference_config.yaml`` (cloned
  from ``phenotyping_pipeline/config.yaml`` on first run, then owned entirely
  by the backend). The file holds inference parameters per organism — the
  ``model:`` field is intentionally not used at runtime; the active weight file
  is resolved by ``ModelStorage`` from ``data/models/<organism>/{default,custom}/``.
"""

from __future__ import annotations

import logging
import shutil
import threading
from pathlib import Path
from typing import Any

import yaml
from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.schemas.config import (
    ConfigUpdateRequest,
    EggConfig,
    LarvaeConfig,
    NeonateConfig,
    PupaeConfig,
    PupaeConfigUpdateRequest,
)

logger = logging.getLogger(__name__)

BACKEND_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


class AppSettings(BaseSettings):
    """Application-wide settings loaded from environment variables and .env file."""

    model_config = SettingsConfigDict(
        env_file=BACKEND_ENV_FILE,
        env_file_encoding="utf-8",
        env_prefix="",
        extra="ignore",
    )

    backend_host: str = "0.0.0.0"
    backend_port: int = 8000
    pipeline_root: Path = Field(
        default=Path("../phenotyping_pipeline"),
        description=(
            "Reference repository (read-only). Used only as a one-time seed source "
            "for ``data/inference_config.yaml`` when the backend has no local copy yet."
        ),
    )
    database_url: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/phenotyping"
    )
    data_dir: Path = Path("./data")
    image_storage_dir: Path = Field(
        default=Path("./data/overlays"),
        description=(
            "Directory where processed overlay images are saved to disk. "
            "Structure: image_storage_dir/{batch_id}/{filename}_overlay.png"
        ),
    )
    log_level: str = "INFO"
    version: str = "0.1.0"

    # ── Auth (BE-020) ──────────────────────────────────────────────────────────
    # Secrets MUST be set in .env in any non-trivial deployment. The defaults
    # below exist only so dev startup doesn't crash for someone who hasn't
    # touched the env yet — main.py refuses to start in production-like mode
    # without explicit values. Treat both as credentials.
    jwt_access_secret: str = "dev-only-access-secret-change-me"
    jwt_refresh_secret: str = "dev-only-refresh-secret-change-me"
    jwt_algorithm: str = "HS256"
    jwt_access_ttl_min: float = 15.0
    jwt_refresh_ttl_days: float = 30.0

    def model_post_init(self, __context: Any) -> None:
        if not self.pipeline_root.is_absolute():
            self.pipeline_root = (Path.cwd() / self.pipeline_root).resolve()
        if not self.data_dir.is_absolute():
            self.data_dir = (Path.cwd() / self.data_dir).resolve()


# Built-in fallback used when neither the backend's nor the pipeline's config.yaml
# is available — keeps the server up so the frontend can render a proper
# "model not installed" UI instead of crashing.
_BBOX_FALLBACK: dict[str, Any] = {
    "device": "cpu",
    "tile_size": 512,
    "overlap": 0.5,
    "confidence_threshold": 0.4,
    "min_box_area": 100,
    "dedup_mode": "center_zone",
    "edge_margin": 3,
    "nms_iou_threshold": 0.4,
    "batch_size": 24,
}

_LARVAE_FALLBACK: dict[str, Any] = {
    "device": "cpu",
    "tile_size": 512,
    "overlap": 0.5,
    "confidence_threshold": 0.4,
    "min_mask_size": 100,
    "edge_margin": 5,
    # Pipeline parity: phenotyping_pipeline/infer_larvae.py hardcodes
    # `solve_maximum_weight_independent_set(..., overlap_threshold=0.3)` and
    # ignores its own YAML `overlap_threshold` value. To reproduce the
    # pipeline's actual dedup behaviour we use 0.3 here.
    "mwis_overlap_threshold": 0.3,
    "mwis_score_metric": "confidence_x_area",
    "batch_size": 24,
    "calibration_object_w_mm": 405.0,
    "calibration_object_h_mm": 317.0,
    "enable_weight": False,
    "sam": {
        "enabled": True,
        "model": "mobile_sam.pt",
        "crop_padding": 50,
        "confidence_threshold": 0.3,
        "device": None,
        "min_area_ratio": 0.6,
        "max_area_ratio": 1.3,
        "min_iou_vs_yolo": 0.5,
    },
}

_PUPAE_FALLBACK: dict[str, Any] = {
    "device": "cpu",
    "tile_size": 1024,
    "overlap": 0.5,
    "confidence_threshold": 0.7,
    "min_mask_size": 1500,
    "edge_margin": 5,
    "mwis_overlap_threshold": 0.3,
    "mwis_score_metric": "confidence_x_area",
    "batch_size": 24,
    "calibration_object_w_mm": 405.0,
    "calibration_object_h_mm": 317.0,
    "sam": {
        "enabled": True,
        "model": "mobile_sam.pt",
        "crop_padding": 50,
        "confidence_threshold": 0.5,
        "device": None,
        "min_area_ratio": 0.6,
        "max_area_ratio": 1.3,
        "min_iou_vs_yolo": 0.5,
    },
}

_BUILTIN_FALLBACK: dict[str, Any] = {
    "egg": dict(_BBOX_FALLBACK),
    "larvae": dict(_LARVAE_FALLBACK),
    "pupae": dict(_PUPAE_FALLBACK),
    "neonate": dict(_BBOX_FALLBACK),
}


class PipelineConfigManager:
    """Owns ``data/inference_config.yaml``.

    On first run the file is seeded from ``phenotyping_pipeline/config.yaml``
    if present, otherwise from ``_BUILTIN_FALLBACK``. After that, the backend
    is the only writer — the pipeline copy is never modified by the server.
    """

    def __init__(self, data_dir: Path, pipeline_root: Path | None = None) -> None:
        self._data_dir = data_dir
        self._pipeline_root = pipeline_root
        self._config_path = data_dir / "inference_config.yaml"
        self._lock = threading.RLock()
        self._cached_config: dict[str, Any] | None = None
        self._cached_mtime: float | None = None
        self._ensure_seeded()

    # ── Seeding & persistence ──────────────────────────────────────────────────

    def _ensure_seeded(self) -> None:
        """Create the local config from the pipeline copy or the builtin fallback."""
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        if self._config_path.exists():
            return
        if self._pipeline_root is not None:
            src = self._pipeline_root / "config.yaml"
            if src.is_file():
                try:
                    shutil.copyfile(src, self._config_path)
                    logger.info("Seeded %s from %s", self._config_path, src)
                    return
                except OSError as exc:
                    logger.warning(
                        "Could not copy %s → %s: %s — using builtin defaults",
                        src,
                        self._config_path,
                        exc,
                    )
        with open(self._config_path, "w", encoding="utf-8") as fh:
            yaml.safe_dump(
                _BUILTIN_FALLBACK, fh, default_flow_style=False, sort_keys=False
            )
        logger.info(
            "Seeded %s from builtin defaults (no pipeline config found)",
            self._config_path,
        )

    def _load_yaml(self) -> dict[str, Any]:
        if not self._config_path.exists():
            self._ensure_seeded()
        with open(self._config_path, encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}

    def _save_yaml(self, data: dict[str, Any]) -> None:
        tmp_path = self._config_path.with_suffix(".yaml.tmp")
        try:
            with open(tmp_path, "w", encoding="utf-8") as fh:
                yaml.safe_dump(
                    data,
                    fh,
                    default_flow_style=False,
                    sort_keys=False,
                    allow_unicode=True,
                )
            tmp_path.replace(self._config_path)
        except Exception:
            if tmp_path.exists():
                tmp_path.unlink()
            raise

    def _file_mtime(self) -> float | None:
        try:
            return self._config_path.stat().st_mtime
        except OSError:
            return None

    def _get_raw(self) -> dict[str, Any]:
        """Return the parsed YAML — reloaded if the file has changed on disk.

        Direct edits to ``inference_config.yaml`` (editor, linter, scripted)
        used to require a backend restart because the in-memory cache was only
        invalidated by our own ``update_*`` writers. We now mtime-check on
        every read; if the file is newer than our last load, drop the cache
        and reparse so external edits take effect immediately.
        """
        with self._lock:
            current_mtime = self._file_mtime()
            if (
                self._cached_config is None
                or current_mtime is None
                or self._cached_mtime is None
                or current_mtime > self._cached_mtime
            ):
                self._cached_config = self._load_yaml()
                self._cached_mtime = current_mtime
            return self._cached_config

    # ── Public API ─────────────────────────────────────────────────────────────

    def get_egg_config(self) -> EggConfig:
        return self._validate_section("egg", EggConfig)

    def get_neonate_config(self) -> NeonateConfig:
        return self._validate_section("neonate", NeonateConfig)

    def get_larvae_config(self) -> LarvaeConfig:
        return self._validate_section("larvae", LarvaeConfig)

    def get_pupae_config(self) -> PupaeConfig:
        return self._validate_section("pupae", PupaeConfig)

    def get_inference_config(
        self, organism: str
    ) -> EggConfig | LarvaeConfig | NeonateConfig | PupaeConfig:
        """Polymorphic accessor used by ModelRegistry for device selection.

        ``pupae`` now uses ``PupaeConfig`` (polygon + MWIS) since the pupae
        weight is a YOLO-seg model — same shape as larvae.
        """
        if organism == "neonate":
            return self.get_neonate_config()
        if organism == "larvae":
            return self.get_larvae_config()
        if organism == "pupae":
            return self.get_pupae_config()
        return self._validate_section(organism, EggConfig)

    def _validate_section(self, organism: str, schema: type[Any]) -> Any:
        raw = self._get_raw()
        section = raw.get(organism, {})
        try:
            return schema.model_validate(section)
        except ValidationError as e:
            msg = (
                f"{organism} section in {self._config_path} failed validation: {e}. "
                "Check that all required fields are present and valid."
            )
            raise RuntimeError(msg) from e

    def update_egg_config(self, updates: dict[str, Any]) -> EggConfig:
        validated = ConfigUpdateRequest.model_validate(updates)
        with self._lock:
            raw = self._load_yaml()
            egg_section = dict(raw.get("egg", {}))
            for field_name, field_value in validated.model_dump().items():
                if field_value is not None:
                    egg_section[field_name] = field_value
            merged = EggConfig.model_validate(egg_section)
            raw["egg"] = merged.model_dump(exclude_none=True)
            self._save_yaml(raw)
            self._cached_config = raw
            self._cached_mtime = self._file_mtime()
            return merged

    def update_larvae(self, updates: dict[str, Any]) -> LarvaeConfig:
        """Patch top-level fields of the ``larvae`` section in inference_config.yaml.

        Only fields present in ``updates`` are overwritten; the SAM subsection
        and other knobs are preserved as-is.
        """
        with self._lock:
            raw = self._load_yaml()
            larvae_section = dict(raw.get("larvae", {}))
            for k, v in updates.items():
                larvae_section[k] = v
            merged = LarvaeConfig.model_validate(larvae_section)
            raw["larvae"] = merged.model_dump(exclude_none=True)
            self._save_yaml(raw)
            self._cached_config = raw
            self._cached_mtime = self._file_mtime()
            return merged

    def update_larvae_sam(self, updates: dict[str, Any]) -> LarvaeConfig:
        """Patch the ``larvae.sam`` subsection in inference_config.yaml.

        Only the fields present in ``updates`` are overwritten; the rest of the
        SAM block (and the rest of the larvae section) is preserved as-is.
        """
        with self._lock:
            raw = self._load_yaml()
            larvae_section = dict(raw.get("larvae", {}))
            sam_section = dict(larvae_section.get("sam", {}))
            for k, v in updates.items():
                sam_section[k] = v
            larvae_section["sam"] = sam_section
            merged = LarvaeConfig.model_validate(larvae_section)
            raw["larvae"] = merged.model_dump(exclude_none=True)
            self._save_yaml(raw)
            self._cached_config = raw
            self._cached_mtime = self._file_mtime()
            return merged

    def update_pupae(self, updates: dict[str, Any]) -> PupaeConfig:
        """Patch top-level fields of the ``pupae`` section."""
        PupaeConfigUpdateRequest.model_validate(updates)
        with self._lock:
            raw = self._load_yaml()
            pupae_section = dict(raw.get("pupae", {}))
            for k, v in updates.items():
                pupae_section[k] = v
            merged = PupaeConfig.model_validate(pupae_section)
            raw["pupae"] = merged.model_dump(exclude_none=True)
            self._save_yaml(raw)
            self._cached_config = raw
            self._cached_mtime = self._file_mtime()
            return merged

    def update_pupae_sam(self, updates: dict[str, Any]) -> PupaeConfig:
        """Patch the ``pupae.sam`` subsection."""
        with self._lock:
            raw = self._load_yaml()
            pupae_section = dict(raw.get("pupae", {}))
            sam_section = dict(pupae_section.get("sam", {}))
            for k, v in updates.items():
                sam_section[k] = v
            pupae_section["sam"] = sam_section
            merged = PupaeConfig.model_validate(pupae_section)
            raw["pupae"] = merged.model_dump(exclude_none=True)
            self._save_yaml(raw)
            self._cached_config = raw
            self._cached_mtime = self._file_mtime()
            return merged

    @property
    def config_path(self) -> Path:
        return self._config_path
