"""Tests for slot-aware custom model management service logic."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.model_upload_service import (
    ModelOrganismMismatchError,
    ModelUploadService,
)


@pytest.mark.asyncio
async def test_save_uploaded_file_scopes_model_to_organism(tmp_path):
    service = ModelUploadService(data_dir=tmp_path, pipeline_root=tmp_path)
    service._validate_yolo = MagicMock(return_value=True)

    db = MagicMock()
    db.flush = AsyncMock()

    record = await service.save_uploaded_file(
        db=db,
        organism="larvae",
        filename="larvae_v2.pt",
        content=b"weights",
    )

    assert record.organism == "larvae"
    assert record.original_filename == "larvae_v2.pt"
    assert Path(record.stored_path).exists()
    assert "/larvae/" in record.stored_path
    db.add.assert_called_once()
    db.flush.assert_awaited_once()


@pytest.mark.asyncio
async def test_assign_model_rejects_cross_slot_custom_model(tmp_path):
    service = ModelUploadService(data_dir=tmp_path, pipeline_root=tmp_path)
    service.get_custom_model = AsyncMock(
        return_value=SimpleNamespace(
            id="abc",
            organism="egg",
            original_filename="egg_custom.pt",
            stored_path=str(tmp_path / "egg_custom.pt"),
        )
    )

    db = MagicMock()

    with pytest.raises(ModelOrganismMismatchError):
        await service.assign_model(db, "larvae", "abc")


@pytest.mark.asyncio
async def test_assign_model_updates_selected_slot_only(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("egg:\n  model: models/egg_best.pt\n")

    service = ModelUploadService(data_dir=tmp_path, pipeline_root=tmp_path)
    service.get_custom_model = AsyncMock(
        return_value=SimpleNamespace(
            id="xyz",
            organism="egg",
            original_filename="egg_new.pt",
            stored_path=str(tmp_path / "custom" / "egg" / "egg_new.pt"),
        )
    )
    service._update_config_yaml = MagicMock()

    existing_assignment = None
    execute_result = MagicMock()
    execute_result.scalar_one_or_none.return_value = existing_assignment

    db = MagicMock()
    db.execute = AsyncMock(return_value=execute_result)
    db.flush = AsyncMock()

    result = await service.assign_model(db, "egg", "xyz")

    assert result["organism"] == "egg"
    assert result["custom_model_id"] == "xyz"
    assert result["model_filename"] == "egg_new.pt"
    db.add.assert_called_once()
    db.flush.assert_awaited_once()
    service._update_config_yaml.assert_called_once_with(
        "egg",
        str(tmp_path / "custom" / "egg" / "egg_new.pt"),
    )
