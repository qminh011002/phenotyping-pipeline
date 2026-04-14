"""App settings singleton model for persisting user-configurable paths."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import TIMESTAMP, CheckConstraint, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AppSettingsRow(Base):
    """Singleton row storing user-configurable paths.

    The frontend Settings tab (FE-011) writes `image_storage_dir` here via
    PUT /settings/storage after the user picks a folder with the native
    Tauri folder dialog. Never store image bytes or base64 in PostgreSQL.
    """

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    image_storage_dir: Mapped[str] = mapped_column(String(1000))
    data_dir: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        CheckConstraint("id = 1", name="ck_app_settings_singleton"),
    )
