"""SQLAlchemy models for custom model uploads and organism assignments."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import BigInteger, ForeignKey, Index, String, Text, TIMESTAMP
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class CustomModel(Base):
    """A user-uploaded .pt model file."""

    __tablename__ = "custom_model"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    organism: Mapped[str] = mapped_column(String(20), index=True)
    original_filename: Mapped[str] = mapped_column(String(255))
    stored_path: Mapped[str] = mapped_column(Text)
    file_size_bytes: Mapped[int] = mapped_column(BigInteger)
    uploaded_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), default=lambda: datetime.now(UTC)
    )
    is_valid: Mapped[bool] = mapped_column(default=False)


class ModelAssignment(Base):
    """Maps an organism slot to its active custom model, if any."""

    __tablename__ = "model_assignment"
    __table_args__ = (
        Index("ix_model_assignment_custom_model_id", "custom_model_id"),
    )

    organism: Mapped[str] = mapped_column(String(20), primary_key=True)
    custom_model_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("custom_model.id", ondelete="SET NULL"), nullable=True
    )
    assigned_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), default=lambda: datetime.now(UTC)
    )
