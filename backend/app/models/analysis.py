"""SQLAlchemy models for analysis batches and images."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, Text, TIMESTAMP
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class AnalysisBatch(Base):
    """A batch of images processed together as a single analysis run."""

    __tablename__ = "analysis_batch"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="processing")
    organism_type: Mapped[str] = mapped_column(String(20), default="egg")
    mode: Mapped[str] = mapped_column(String(20), default="upload")
    device: Mapped[str] = mapped_column(String(20), default="cpu")
    config_snapshot: Mapped[dict] = mapped_column(JSONB, default=dict)
    total_image_count: Mapped[int] = mapped_column(default=0)
    total_count: Mapped[int | None] = mapped_column(nullable=True)
    avg_confidence: Mapped[float | None] = mapped_column(nullable=True)
    total_elapsed_secs: Mapped[float | None] = mapped_column(nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), default=datetime.utcnow
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    processed_image_count: Mapped[int] = mapped_column(default=0)
    failed_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    images: Mapped[list["AnalysisImage"]] = relationship(
        "AnalysisImage",
        back_populates="batch",
        cascade="all, delete-orphan",
        order_by="AnalysisImage.created_at",
    )


class AnalysisImage(Base):
    """A single image within an analysis batch."""

    __tablename__ = "analysis_image"
    __table_args__ = (
        Index("ix_analysis_image_batch_id", "batch_id"),
        Index("ix_analysis_image_original_filename", "original_filename"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, default=uuid.uuid4
    )
    batch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("analysis_batch.id", ondelete="CASCADE")
    )
    original_filename: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    count: Mapped[int | None] = mapped_column(nullable=True)
    avg_confidence: Mapped[float | None] = mapped_column(nullable=True)
    elapsed_secs: Mapped[float | None] = mapped_column(nullable=True)
    overlay_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), default=datetime.utcnow
    )
    # FS-009: operator-corrected bounding boxes — supersedes model annotations when set
    edited_annotations: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True
    )

    batch: Mapped["AnalysisBatch"] = relationship(
        "AnalysisBatch", back_populates="images"
    )
