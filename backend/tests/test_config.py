"""Tests for app/config.py — AppSettings and PipelineConfigManager."""

from __future__ import annotations

import threading
import tempfile
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from app.config import AppSettings, PipelineConfigManager
from app.schemas.config import ConfigUpdateRequest, EggConfig


# ── AppSettings ────────────────────────────────────────────────────────────

class TestAppSettings:
    def test_defaults(self, monkeypatch, tmp_path):
        """Without any env vars, AppSettings loads its defaults."""
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.chdir(tmp_path)
        settings = AppSettings()
        assert settings.database_url == "postgresql+asyncpg://postgres:postgres@localhost:5432/phenotyping"
        assert settings.log_level == "INFO"
        assert settings.version == "0.1.0"

    def test_database_url_from_env(self, monkeypatch):
        """DATABASE_URL is read from the environment."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://user:pass@db:5432/testdb")
        settings = AppSettings()
        assert settings.database_url == "postgresql+asyncpg://user:pass@db:5432/testdb"

    def test_log_level_from_env(self, monkeypatch):
        """LOG_LEVEL is read from the environment."""
        monkeypatch.setenv("LOG_LEVEL", "DEBUG")
        settings = AppSettings()
        assert settings.log_level == "DEBUG"


# ── PipelineConfigManager ─────────────────────────────────────────────────

class TestPipelineConfigManager:
    def _write_config(self, path: Path, data: dict) -> None:
        path.write_text(yaml.safe_dump(data))

    def _make_manager(self, tmp_path: Path) -> PipelineConfigManager:
        """Create a PipelineConfigManager backed by a temporary directory."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        return PipelineConfigManager(pipeline_root=config_dir)

    def _egg_config(self, **overrides):
        defaults = dict(
            model="models/egg_best.pt",
            device="cpu",
            tile_size=512,
            overlap=0.5,
            confidence_threshold=0.4,
            min_box_area=100,
            dedup_mode="center_zone",
            edge_margin=3,
            nms_iou_threshold=0.4,
            batch_size=24,
        )
        return {**defaults, **overrides}

    def test_load_valid_config(self, tmp_path):
        """PipelineConfigManager loads a valid config.yaml and returns EggConfig."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        config_path = config_dir / "config.yaml"
        self._write_config(config_path, {"egg": self._egg_config()})

        mgr = PipelineConfigManager(pipeline_root=config_dir)
        cfg = mgr.get_egg_config()

        assert isinstance(cfg, EggConfig)
        assert cfg.tile_size == 512
        assert cfg.dedup_mode == "center_zone"
        assert cfg.device == "cpu"

    def test_load_missing_file_raises(self, tmp_path):
        """Raises FileNotFoundError if config.yaml does not exist."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()

        mgr = PipelineConfigManager(pipeline_root=config_dir)
        with pytest.raises(FileNotFoundError) as exc_info:
            mgr.get_egg_config()
        assert "config.yaml" in str(exc_info.value)

    def test_update_tile_size(self, tmp_path):
        """update_egg_config merges and persists partial updates."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        config_path = config_dir / "config.yaml"
        self._write_config(config_path, {"egg": self._egg_config()})

        mgr = PipelineConfigManager(pipeline_root=config_dir)
        updated = mgr.update_egg_config({"tile_size": 768, "device": "cuda:0"})

        assert updated.tile_size == 768
        assert updated.device == "cuda:0"
        assert updated.overlap == 0.5  # unchanged

        # Verify it was written to disk
        persisted = yaml.safe_load(config_path.read_text())
        assert persisted["egg"]["tile_size"] == 768

    def test_update_validates_before_write(self, tmp_path):
        """If validation fails, the file is NOT written."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        config_path = config_dir / "config.yaml"
        self._write_config(config_path, {"egg": self._egg_config()})

        mgr = PipelineConfigManager(pipeline_root=config_dir)

        with pytest.raises(Exception):  # ValidationError (tile_size not multiple of 32)
            mgr.update_egg_config({"tile_size": 300})

        # File should be unchanged
        persisted = yaml.safe_load(config_path.read_text())
        assert persisted["egg"]["tile_size"] == 512

    def test_update_invalid_device(self, tmp_path):
        """Invalid device string is rejected."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        config_path = config_dir / "config.yaml"
        self._write_config(config_path, {"egg": self._egg_config()})

        mgr = PipelineConfigManager(pipeline_root=config_dir)

        with pytest.raises(ValidationError):
            mgr.update_egg_config({"device": "metal"})

    def test_preserves_other_sections(self, tmp_path):
        """Only the 'egg' section is replaced; other sections are preserved."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        config_path = config_dir / "config.yaml"
        self._write_config(config_path, {
            "egg": self._egg_config(),
            "larvae": {"model": "models/larvae.pt"},
        })

        mgr = PipelineConfigManager(pipeline_root=config_dir)
        mgr.update_egg_config({"tile_size": 256})

        persisted = yaml.safe_load(config_path.read_text())
        assert persisted["egg"]["tile_size"] == 256
        assert persisted["larvae"]["model"] == "models/larvae.pt"

    def test_thread_safety_concurrent_reads(self, tmp_path):
        """Multiple threads can safely call get_egg_config concurrently."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        config_path = config_dir / "config.yaml"
        self._write_config(config_path, {"egg": self._egg_config()})

        mgr = PipelineConfigManager(pipeline_root=config_dir)
        results = []

        def read():
            cfg = mgr.get_egg_config()
            results.append(cfg.tile_size)

        threads = [threading.Thread(target=read) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(results) == 10
        assert all(r == 512 for r in results)

    def test_thread_safety_concurrent_updates(self, tmp_path):
        """Multiple threads can safely call update_egg_config (writes are serialized)."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        config_path = config_dir / "config.yaml"
        self._write_config(config_path, {"egg": self._egg_config()})

        mgr = PipelineConfigManager(pipeline_root=config_dir)
        updated_values = []

        def update(idx):
            new_size = 256 + idx * 32
            cfg = mgr.update_egg_config({"tile_size": new_size})
            updated_values.append(cfg.tile_size)

        threads = [threading.Thread(target=update, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # All updates succeed without raising
        assert len(updated_values) == 5

        # Final value on disk is consistent
        persisted = yaml.safe_load(config_path.read_text())
        assert persisted["egg"]["tile_size"] in [256 + i * 32 for i in range(5)]

    def test_get_model_path_relative(self, tmp_path):
        """get_model_path resolves a relative model path against pipeline_root."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        config_path = config_dir / "config.yaml"
        self._write_config(config_path, {
            "egg": self._egg_config(model="models/egg_best.pt"),
        })

        mgr = PipelineConfigManager(pipeline_root=config_dir)
        model_path = mgr.get_model_path("egg")

        assert model_path.is_absolute()
        assert model_path.name == "egg_best.pt"

    def test_get_model_path_absolute(self, tmp_path):
        """Absolute model paths are returned unchanged."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        config_path = config_dir / "config.yaml"
        abs_path = tmp_path / "models" / "egg_best.pt"
        abs_path.parent.mkdir()
        abs_path.touch()
        self._write_config(config_path, {
            "egg": self._egg_config(model=str(abs_path)),
        })

        mgr = PipelineConfigManager(pipeline_root=config_dir)
        model_path = mgr.get_model_path("egg")
        assert model_path == abs_path

    def test_get_model_path_missing_organism(self, tmp_path):
        """Raises ValueError if organism is not in config."""
        config_dir = tmp_path / "pipeline"
        config_dir.mkdir()
        config_path = config_dir / "config.yaml"
        self._write_config(config_path, {"egg": self._egg_config()})

        mgr = PipelineConfigManager(pipeline_root=config_dir)
        with pytest.raises(ValueError) as exc_info:
            mgr.get_model_path("pupae")
        assert "pupae" in str(exc_info.value)
