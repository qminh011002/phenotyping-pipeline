"""Service for uploading, validating, and assigning custom .pt model files."""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.custom_model import CustomModel, ModelAssignment

logger = logging.getLogger(__name__)

VALID_ORGANISMS = ("egg", "larvae", "pupae", "neonate")

DEFAULT_MODELS: dict[str, str] = {
    "egg": "models/egg_best.pt",
    "larvae": "models/larvae_best.pt",
    "pupae": "models/pupae_best.pt",
    "neonate": "models/neonate_best.pt",
}

MAX_FILE_SIZE = 500 * 1024 * 1024  # 500 MB


class ModelUploadService:
    """Handles custom model file storage, YOLO validation, and config.yaml updates."""

    def __init__(self, data_dir: Path, pipeline_root: Path) -> None:
        self._custom_dir = data_dir / "models" / "custom"
        self._pipeline_root = pipeline_root
        self._config_path = pipeline_root / "config.yaml"

    def _validate_organism(self, organism: str) -> None:
        if organism not in VALID_ORGANISMS:
            msg = f"Invalid organism. Must be one of: {', '.join(VALID_ORGANISMS)}"
            raise InvalidOrganismError(msg)

    def _organism_dir(self, organism: str) -> Path:
        return self._custom_dir / organism

    def _ensure_custom_dir(self, organism: str) -> Path:
        self._validate_organism(organism)
        path = self._organism_dir(organism)
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def save_uploaded_file(
        self,
        db: AsyncSession,
        organism: str,
        filename: str,
        content: bytes,
    ) -> CustomModel:
        """Save an uploaded .pt file to disk and create a DB record."""
        custom_dir = self._ensure_custom_dir(organism)

        model_id = uuid.uuid4()
        stored_name = f"{model_id}_{filename}"
        stored_path = custom_dir / stored_name

        stored_path.write_bytes(content)

        is_valid = self._validate_yolo(stored_path)
        if not is_valid:
            stored_path.unlink(missing_ok=True)
            raise InvalidModelError(
                "Invalid model file: not a YOLO detection model or file is corrupt"
            )

        record = CustomModel(
            id=model_id,
            organism=organism,
            original_filename=filename,
            stored_path=str(stored_path),
            file_size_bytes=len(content),
            uploaded_at=datetime.now(UTC),
            is_valid=True,
        )
        db.add(record)
        await db.flush()

        logger.info(
            "Custom model uploaded",
            extra={
                "context": {
                    "model_id": str(model_id),
                    "organism": organism,
                    "filename": filename,
                    "size_bytes": len(content),
                }
            },
        )
        return record

    def _validate_yolo(self, path: Path) -> bool:
        """Load the .pt file with ultralytics and check task == 'detect'."""
        try:
            from ultralytics import YOLO

            model = YOLO(str(path))
            valid = model.task == "detect"
            del model
            return valid
        except Exception as exc:
            logger.warning(
                "YOLO validation failed for %s: %s",
                path.name,
                exc,
            )
            return False

    async def list_custom_models(
        self, db: AsyncSession, organism: str | None = None
    ) -> list[CustomModel]:
        """Return uploaded custom models, optionally filtered by organism."""
        stmt = select(CustomModel)
        if organism is not None:
            self._validate_organism(organism)
            stmt = stmt.where(CustomModel.organism == organism)
        result = await db.execute(
            stmt.order_by(CustomModel.organism.asc(), CustomModel.uploaded_at.desc())
        )
        return list(result.scalars().all())

    async def get_custom_model(
        self, db: AsyncSession, model_id: uuid.UUID
    ) -> CustomModel | None:
        """Return a single custom model by ID."""
        result = await db.execute(
            select(CustomModel).where(CustomModel.id == model_id)
        )
        return result.scalar_one_or_none()

    async def delete_custom_model(
        self, db: AsyncSession, model_id: uuid.UUID
    ) -> str | None:
        """Delete a custom model. Returns organism name if currently assigned (cannot delete)."""
        assignment = await db.execute(
            select(ModelAssignment).where(
                ModelAssignment.custom_model_id == model_id
            )
        )
        row = assignment.scalar_one_or_none()
        if row is not None:
            return row.organism

        record = await self.get_custom_model(db, model_id)
        if record is None:
            return None

        stored_path = Path(record.stored_path)
        stored_path.unlink(missing_ok=True)

        await db.execute(
            delete(CustomModel).where(CustomModel.id == model_id)
        )
        await db.flush()

        logger.info(
            "Custom model deleted",
            extra={"context": {"model_id": str(model_id)}},
        )
        return None

    async def get_assignments(
        self, db: AsyncSession
    ) -> dict[str, dict[str, Any]]:
        """Return current model assignments for all organisms."""
        result = await db.execute(select(ModelAssignment))
        assignments_map: dict[str, ModelAssignment] = {
            row.organism: row for row in result.scalars().all()
        }

        out: dict[str, dict[str, Any]] = {}
        for organism in VALID_ORGANISMS:
            assignment = assignments_map.get(organism)
            if assignment and assignment.custom_model_id:
                custom = await self.get_custom_model(db, assignment.custom_model_id)
                if custom:
                    out[organism] = {
                        "organism": organism,
                        "is_default": False,
                        "model_filename": custom.original_filename,
                        "custom_model": custom,
                    }
                    continue

            default_rel = DEFAULT_MODELS[organism]
            out[organism] = {
                "organism": organism,
                "is_default": True,
                "model_filename": Path(default_rel).name,
                "custom_model": None,
            }

        return out

    async def assign_model(
        self,
        db: AsyncSession,
        organism: str,
        custom_model_id: uuid.UUID | None,
    ) -> dict[str, Any]:
        """Assign a custom model to an organism slot, or revert to default."""
        self._validate_organism(organism)

        if custom_model_id is not None:
            custom = await self.get_custom_model(db, custom_model_id)
            if custom is None:
                raise ModelNotFoundError("Custom model not found")
            if custom.organism != organism:
                raise ModelOrganismMismatchError(
                    f"Model belongs to '{custom.organism}' and cannot be assigned to '{organism}'"
                )

        result = await db.execute(
            select(ModelAssignment).where(ModelAssignment.organism == organism)
        )
        assignment = result.scalar_one_or_none()

        if assignment is None:
            assignment = ModelAssignment(
                organism=organism,
                custom_model_id=custom_model_id,
                assigned_at=datetime.now(UTC),
            )
            db.add(assignment)
        else:
            assignment.custom_model_id = custom_model_id
            assignment.assigned_at = datetime.now(UTC)

        await db.flush()

        if custom_model_id is not None:
            custom = await self.get_custom_model(db, custom_model_id)
            assert custom is not None
            new_model_path = custom.stored_path
            model_filename = custom.original_filename
        else:
            new_model_path = DEFAULT_MODELS[organism]
            model_filename = Path(new_model_path).name

        self._update_config_yaml(organism, new_model_path)

        logger.info(
            "Model assignment updated",
            extra={
                "context": {
                    "organism": organism,
                    "custom_model_id": str(custom_model_id),
                    "model_path": new_model_path,
                }
            },
        )

        return {
            "organism": organism,
            "custom_model_id": custom_model_id,
            "model_filename": model_filename,
        }

    def _update_config_yaml(self, organism: str, model_path: str) -> None:
        """Update the model path for an organism in config.yaml."""
        import yaml

        with open(self._config_path, encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}

        if organism not in data:
            data[organism] = {}

        data[organism]["model"] = model_path

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


class InvalidModelError(Exception):
    """Raised when an uploaded .pt file fails YOLO validation."""


class ModelNotFoundError(Exception):
    """Raised when a referenced custom model doesn't exist."""


class InvalidOrganismError(Exception):
    """Raised when a requested organism slot is invalid."""


class ModelOrganismMismatchError(Exception):
    """Raised when a model is assigned to the wrong organism slot."""
