"""Analysis batch and image models for storing inference results."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, Text, TIMESTAMP
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


TZ_TS = TIMESTAMP(timezone=True)


class AnalysisBatch(Base):
    """Represents one "Process" action (a batch of one or more images)."""

    __tablename__ = "analysis_batch"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    created_at: Mapped[datetime] = mapped_column(
        TZ_TS,
        server_default="now()",
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        TZ_TS,
        nullable=True,
    )
    status: Mapped[str] = mapped_column(String(20), default="pending")
    organism_type: Mapped[str] = mapped_column(String(20), default="egg")
    mode: Mapped[str] = mapped_column(String(20), default="upload")
    device: Mapped[str] = mapped_column(String(20), default="cpu")
    config_snapshot: Mapped[dict] = mapped_column(JSONB)
    total_image_count: Mapped[int] = mapped_column(default=0)
    total_count: Mapped[int | None] = mapped_column(nullable=True)
    avg_confidence: Mapped[float | None] = mapped_column(nullable=True)
    total_elapsed_secs: Mapped[float | None] = mapped_column(nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    images: Mapped[list["AnalysisImage"]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("idx_batch_created_at", created_at.desc()),
        Index("idx_batch_status", status),
        Index("idx_batch_organism", organism_type),
    )


class AnalysisImage(Base):
    """One row per processed image within a batch."""

    __tablename__ = "analysis_image"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    batch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("analysis_batch.id", ondelete="CASCADE"),
    )
    created_at: Mapped[datetime] = mapped_column(
        TZ_TS,
        server_default="now()",
    )
    original_filename: Mapped[str] = mapped_column(String(500))
    original_width: Mapped[int | None] = mapped_column(nullable=True)
    original_height: Mapped[int | None] = mapped_column(nullable=True)
    file_size_bytes: Mapped[int | None] = mapped_column(nullable=True)
    file_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    count: Mapped[int | None] = mapped_column(nullable=True)
    avg_confidence: Mapped[float | None] = mapped_column(nullable=True)
    elapsed_secs: Mapped[float | None] = mapped_column(nullable=True)
    annotations: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    overlay_path: Mapped[str | None] = mapped_column(
        String(1000),
        nullable=True,
    )
    tile_count: Mapped[int | None] = mapped_column(nullable=True)

    batch: Mapped["AnalysisBatch"] = relationship(back_populates="images")

    __table_args__ = (
        Index("idx_image_batch_id", batch_id),
        Index("idx_image_filename", original_filename),
    )
