"""Service for uploading, validating, and assigning custom .pt model files.

Storage layout (single source of truth — no YAML writes):

    data/models/<organism>/default/   ← operator-placed weights (treated as default)
    data/models/<organism>/custom/    ← uploaded via POST /models/<organism>/upload

Active-model resolution lives in :mod:`app.services.model_storage`. ``assign_model``
only mutates the DB; the caller is responsible for asking ``ModelRegistry`` to
reload the affected organism so the change takes effect immediately.
"""

from __future__ import annotations

import asyncio
import logging
import types
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.custom_model import CustomModel, ModelAssignment
from app.services.model_storage import VALID_ORGANISMS, ModelStorage

logger = logging.getLogger(__name__)

MAX_FILE_SIZE = 500 * 1024 * 1024  # 500 MB


class ModelUploadService:
    """Handles custom model file storage, YOLO validation, and DB assignment."""

    def __init__(self, storage: ModelStorage) -> None:
        self._storage = storage

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _validate_organism(self, organism: str) -> None:
        if organism not in VALID_ORGANISMS:
            msg = f"Invalid organism. Must be one of: {', '.join(VALID_ORGANISMS)}"
            raise InvalidOrganismError(msg)

    def _ensure_custom_dir(self, organism: str) -> Path:
        self._validate_organism(organism)
        path = self._storage.custom_dir(organism)
        path.mkdir(parents=True, exist_ok=True)
        return path

    # ── Upload ────────────────────────────────────────────────────────────────

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

        await asyncio.to_thread(stored_path.write_bytes, content)

        is_valid = await asyncio.to_thread(self._validate_yolo, stored_path)
        if not is_valid:
            await asyncio.to_thread(lambda: stored_path.unlink(missing_ok=True))
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
                    "stored_path": str(stored_path),
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
            logger.warning("YOLO validation failed for %s: %s", path.name, exc)
            return False

    # ── Listing / lookup / deletion ────────────────────────────────────────────

    async def list_custom_models(
        self, db: AsyncSession, organism: str | None = None
    ) -> list[CustomModel]:
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

        await db.execute(delete(CustomModel).where(CustomModel.id == model_id))
        await db.flush()

        logger.info(
            "Custom model deleted",
            extra={"context": {"model_id": str(model_id)}},
        )
        return None

    # ── Assignments ────────────────────────────────────────────────────────────

    async def get_assignments(
        self, db: AsyncSession
    ) -> dict[str, dict[str, Any]]:
        """Return current model assignments for every organism.

        For each organism the response includes the active filename derived from
        either the assigned custom model or the first ``.pt`` in the default
        folder, plus a ``has_default`` flag the frontend uses to decide between
        "Model not installed" and "Default available".
        """
        result = await db.execute(select(ModelAssignment))
        assignments_map: dict[str, ModelAssignment] = {
            row.organism: row for row in result.scalars().all()
        }

        custom_ids = [
            a.custom_model_id for a in assignments_map.values() if a.custom_model_id
        ]
        customs_map: dict[uuid.UUID, CustomModel] = {}
        if custom_ids:
            cresult = await db.execute(
                select(CustomModel).where(CustomModel.id.in_(custom_ids))
            )
            customs_map = {c.id: c for c in cresult.scalars().all()}

        out: dict[str, dict[str, Any]] = {}
        for organism in VALID_ORGANISMS:
            default_path = self._storage.find_default_model(organism)
            has_default = default_path is not None

            assignment = assignments_map.get(organism)
            if assignment and assignment.custom_model_id:
                custom = customs_map.get(assignment.custom_model_id)
                if custom:
                    out[organism] = {
                        "organism": organism,
                        "is_default": False,
                        "has_default": has_default,
                        "model_filename": custom.original_filename,
                        "default_filename": default_path.name if default_path else None,
                        "custom_model": custom,
                    }
                    continue

            out[organism] = {
                "organism": organism,
                "is_default": True,
                "has_default": has_default,
                "model_filename": default_path.name if default_path else None,
                "default_filename": default_path.name if default_path else None,
                "custom_model": None,
            }

        return out

    async def assign_model(
        self,
        db: AsyncSession,
        organism: str,
        custom_model_id: uuid.UUID | None,
    ) -> dict[str, Any]:
        """Assign a custom model to an organism slot, or revert to default.

        Mutates the DB only — the caller (router) is responsible for asking
        :class:`ModelRegistry` to reload the organism's weights so the change
        takes effect on the next inference call without a restart.
        """
        self._validate_organism(organism)

        if custom_model_id is not None:
            custom = await self.get_custom_model(db, custom_model_id)
            if custom is None:
                raise ModelNotFoundError("Custom model not found")
            if custom.organism != organism:
                raise ModelOrganismMismatchError(
                    f"Model belongs to {custom.organism!r} and cannot be assigned to {organism!r}"
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
            if custom is None:
                raise ModelNotFoundError("Custom model not found after assignment")
            model_filename = custom.original_filename
        else:
            default_path = self._storage.find_default_model(organism)
            model_filename = default_path.name if default_path else None

        logger.info(
            "Model assignment updated",
            extra={
                "context": {
                    "organism": organism,
                    "custom_model_id": str(custom_model_id) if custom_model_id else None,
                    "model_filename": model_filename,
                }
            },
        )

        return {
            "organism": organism,
            "custom_model_id": custom_model_id,
            "model_filename": model_filename,
        }

    async def get_active_custom_path(
        self, db: AsyncSession, organism: str
    ) -> Path | None:
        """Return the on-disk path of the assigned custom model, if any."""
        result = await db.execute(
            select(ModelAssignment).where(ModelAssignment.organism == organism)
        )
        assignment = result.scalar_one_or_none()
        if assignment is None or assignment.custom_model_id is None:
            return None
        custom = await self.get_custom_model(db, assignment.custom_model_id)
        if custom is None:
            return None
        return Path(custom.stored_path)

    # ── One-shot legacy migration helper ───────────────────────────────────────

    async def migrate_legacy_layout(self, db: AsyncSession) -> int:
        """Move files from ``data/models/custom/<organism>/`` to the new layout
        and rewrite ``custom_model.stored_path`` to match. Idempotent.
        """
        moved = await asyncio.to_thread(self._storage.migrate_legacy_custom_layout)
        if not moved:
            return 0

        old_to_new = {str(old): str(new) for old, new in moved}
        records = (await db.execute(select(CustomModel))).scalars().all()
        rewritten = 0
        for record in records:
            new_path = old_to_new.get(record.stored_path)
            if new_path is None:
                continue
            record.stored_path = new_path
            rewritten += 1
        if rewritten:
            await db.flush()
            logger.info(
                "Rewrote %d custom_model.stored_path values to the new layout",
                rewritten,
            )
        return rewritten


class InvalidModelError(Exception):
    """Raised when an uploaded .pt file fails YOLO validation."""


class ModelNotFoundError(Exception):
    """Raised when a referenced custom model doesn't exist."""


class InvalidOrganismError(Exception):
    """Raised when a requested organism slot is invalid."""


class ModelOrganismMismatchError(Exception):
    """Raised when a model is assigned to the wrong organism slot."""


# Public re-export for the existing routers / deps that import these names.
__all__ = [
    "MAX_FILE_SIZE",
    "VALID_ORGANISMS",
    "ModelUploadService",
    "InvalidModelError",
    "ModelNotFoundError",
    "InvalidOrganismError",
    "ModelOrganismMismatchError",
]
