"""AppSettings service — reads and writes the app_settings singleton DB row.

The app_settings table is the runtime source of truth for user-configurable paths
(image_storage_dir, data_dir). The pydantic AppSettings from .env is only the
first-run default; after the first startup seeding, all reads and writes go
through this service to the database.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.app_settings import AppSettingsRow

if TYPE_CHECKING:
    from pathlib import Path

logger = logging.getLogger(__name__)


class AppSettingsService:
    """CRUD operations for the app_settings singleton table.

    All methods are async and accept an ``AsyncSession`` from the database
    dependency. The row with id=1 is guaranteed to exist (seeded at startup
    by main.py lifespan if missing).
    """

    async def get_settings(self, db: AsyncSession) -> AppSettingsRow:
        """Return the singleton app_settings row.

        Raises:
            RuntimeError: if the singleton row is missing (should have been
                seeded at startup by main.py).
        """
        result = await db.execute(
            select(AppSettingsRow).where(AppSettingsRow.id == 1).with_for_update()
        )
        row = result.scalar_one_or_none()
        if row is None:
            msg = (
                "app_settings singleton row is missing from the database. "
                "Ensure the backend startup has seeded it (main.py lifespan)."
            )
            raise RuntimeError(msg)
        return row

    async def update_storage_dir(
        self,
        db: AsyncSession,
        new_dir: str,
    ) -> AppSettingsRow:
        """Update the image_storage_dir path and persist to the DB row."""
        await db.execute(
            update(AppSettingsRow)
            .where(AppSettingsRow.id == 1)
            .values(
                image_storage_dir=new_dir,
                updated_at=datetime.now(timezone.utc),
            )
        )
        await db.flush()
        logger.info(
            "app_settings.image_storage_dir updated in DB",
            extra={"context": {"image_storage_dir": new_dir}},
        )
        return await self.get_settings(db)

    async def update_settings(
        self,
        db: AsyncSession,
        image_storage_dir: str | None = None,
        data_dir: str | None = None,
    ) -> AppSettingsRow:
        """Update one or more fields on the singleton row."""
        values: dict[str, object] = {"updated_at": datetime.now(timezone.utc)}
        if image_storage_dir is not None:
            values["image_storage_dir"] = image_storage_dir
        if data_dir is not None:
            values["data_dir"] = data_dir

        await db.execute(
            update(AppSettingsRow)
            .where(AppSettingsRow.id == 1)
            .values(**values)
        )
        await db.flush()
        logger.info(
            "app_settings row updated",
            extra={"context": {"updated_fields": list(values.keys())}},
        )
        return await self.get_settings(db)
