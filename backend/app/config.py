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

from app.schemas.config import ConfigUpdateRequest, EggConfig, NeonateConfig

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
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/phenotyping"
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

    def model_post_init(self, __context: Any) -> None:
        if not self.pipeline_root.is_absolute():
            self.pipeline_root = (Path.cwd() / self.pipeline_root).resolve()
        if not self.data_dir.is_absolute():
            self.data_dir = (Path.cwd() / self.data_dir).resolve()


# Built-in fallback used when neither the backend's nor the pipeline's config.yaml
# is available — keeps the server up so the frontend can render a proper
# "model not installed" UI instead of crashing.
_BUILTIN_FALLBACK: dict[str, Any] = {
    organism: {
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
    for organism in ("egg", "larvae", "pupae", "neonate")
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
            yaml.safe_dump(_BUILTIN_FALLBACK, fh, default_flow_style=False, sort_keys=False)
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

    def _get_raw(self) -> dict[str, Any]:
        with self._lock:
            if self._cached_config is None:
                self._cached_config = self._load_yaml()
            return self._cached_config

    # ── Public API ─────────────────────────────────────────────────────────────

    def get_egg_config(self) -> EggConfig:
        return self._validate_section("egg", EggConfig)

    def get_neonate_config(self) -> NeonateConfig:
        return self._validate_section("neonate", NeonateConfig)

    def get_inference_config(self, organism: str) -> EggConfig | NeonateConfig:
        """Polymorphic accessor used by ModelRegistry for device selection.

        ``larvae``/``pupae`` reuse the ``EggConfig`` shape since the pipeline
        config keeps them in lockstep; only ``device`` is read from this path.
        """
        if organism == "neonate":
            return self.get_neonate_config()
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
            return merged

    @property
    def config_path(self) -> Path:
        return self._config_path
