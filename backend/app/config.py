"""Application settings and pipeline configuration management.

- AppSettings: environment-based configuration via pydantic-settings.
- PipelineConfigManager: loads, validates, and persists phenotyping_pipeline/config.yaml.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import yaml
from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.schemas.config import ConfigUpdateRequest, EggConfig

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
        description="Path to the phenotyping_pipeline reference repository",
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

    def model_post_init(self, _warnings: list[str]) -> None:
        # Resolve pipeline_root to absolute path
        if not self.pipeline_root.is_absolute():
            self.pipeline_root = (Path.cwd() / self.pipeline_root).resolve()


class PipelineConfigManager:
    """Loads, validates, and persists the phenotyping_pipeline/config.yaml file.

    The manager is thread-safe for reads. Writes are serialized with a lock.
    Only the 'egg' section is validated and exposed; other sections are
    preserved intact on every write.
    """

    def __init__(self, pipeline_root: Path) -> None:
        self._pipeline_root = pipeline_root
        self._config_path = pipeline_root / "config.yaml"
        self._lock = threading.RLock()
        self._cached_config: dict[str, Any] | None = None

    def _load_yaml(self) -> dict[str, Any]:
        """Read and parse config.yaml from disk."""
        if not self._config_path.exists():
            msg = (
                f"Pipeline config not found at {self._config_path}. "
                "Set PIPELINE_ROOT in backend/.env to the phenotyping_pipeline directory."
            )
            raise FileNotFoundError(msg)
        with open(self._config_path, encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}

    def _save_yaml(self, data: dict[str, Any]) -> None:
        """Atomically replace config.yaml with new content."""
        tmp_path = self._config_path.with_suffix(".tmp")
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
        """Return the cached or freshly loaded raw config dict."""
        with self._lock:
            if self._cached_config is None:
                self._cached_config = self._load_yaml()
            return self._cached_config

    def get_egg_config(self) -> EggConfig:
        """Return the validated egg section as an EggConfig model."""
        raw = self._get_raw()
        egg_section = raw.get("egg", {})
        try:
            return EggConfig.model_validate(egg_section)
        except ValidationError as e:
            msg = (
                f"egg section in {self._config_path} failed validation: {e}. "
                "Check that all required fields are present and valid."
            )
            raise RuntimeError(msg) from e

    def update_egg_config(self, updates: dict[str, Any]) -> EggConfig:
        """Merge validated updates into the egg section and persist to disk.

        The updates dict is first validated as ConfigUpdateRequest, then
        merged with the current egg section. The merged result is validated
        as EggConfig before writing. If validation fails, no file is written.
        """
        # Validate as partial update request first
        validated = ConfigUpdateRequest.model_validate(updates)

        with self._lock:
            raw = self._load_yaml()
            egg_section = dict(raw.get("egg", {}))

            # Merge validated fields (exclude None)
            for field_name, field_value in validated.model_dump().items():
                if field_value is not None:
                    egg_section[field_name] = field_value

            # Validate merged section against full EggConfig
            merged = EggConfig.model_validate(egg_section)

            # Write back — egg section only; preserve other sections
            raw["egg"] = merged.model_dump()
            self._save_yaml(raw)
            self._cached_config = raw

            return merged

    def get_model_path(self, organism: str = "egg") -> Path:
        """Return the absolute path to the model weights for the given organism.

        The model path from config is relative to pipeline_root.
        """
        raw = self._get_raw()
        section = raw.get(organism, {})
        model_rel = section.get("model", "")
        if not model_rel:
            msg = f"No model path configured for organism={organism!r} in config.yaml"
            raise ValueError(msg)
        path = Path(model_rel)
        if not path.is_absolute():
            path = (self._pipeline_root / path).resolve()
        return path
