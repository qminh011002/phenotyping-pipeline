"""SQLAlchemy models for larvae detection, calibration, and measurement (INF-005)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    TIMESTAMP,
    Boolean,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def _now_utc() -> datetime:
    return datetime.now(UTC)


# Enum types are created/dropped by the Alembic migration; ORM references must
# use ``create_type=False`` so SQLAlchemy doesn't try to issue duplicate DDL.
_DETECTION_ORIGIN = Enum(
    "model", "user", name="larvae_detection_origin", create_type=False
)
_CALIBRATION_STATUS = Enum(
    "detected",
    "manual",
    "failed",
    name="larvae_calibration_status",
    create_type=False,
)


class LarvaeDetection(Base):
    """One detected larva polygon on an analysis_image."""

    __tablename__ = "larvae_detection"
    __table_args__ = (Index("idx_larvae_detection_image_id", "image_id"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    image_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("analysis_image.id", ondelete="CASCADE"), nullable=False
    )
    polygon: Mapped[list] = mapped_column(JSONB, nullable=False)
    bbox: Mapped[dict] = mapped_column(JSONB, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    area_px: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), default=_now_utc, nullable=False
    )

    # Operator-corrected polygon — supersedes the model polygon when set.
    edited_polygon: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    edited_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    edited_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("user_account.id", ondelete="SET NULL"), nullable=True
    )
    # ``user`` when the polygon was drawn from scratch in the editor.
    origin: Mapped[str | None] = mapped_column(_DETECTION_ORIGIN, nullable=True)

    measurement: Mapped["LarvaeMeasurement | None"] = relationship(
        "LarvaeMeasurement",
        back_populates="detection",
        uselist=False,
        cascade="all, delete-orphan",
    )


class LarvaeCalibration(Base):
    """Per-image calibration (one row per analysis_image)."""

    __tablename__ = "larvae_calibration"
    __table_args__ = (
        UniqueConstraint("image_id", name="uq_larvae_calibration_image_id"),
        Index("idx_larvae_calibration_image_id", "image_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    image_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("analysis_image.id", ondelete="CASCADE"), nullable=False
    )
    auto_corners: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    edited_corners: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    mm_per_px_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    mm_per_px_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    calibration_object_w_mm: Mapped[float | None] = mapped_column(
        Float, nullable=True
    )
    calibration_object_h_mm: Mapped[float | None] = mapped_column(
        Float, nullable=True
    )
    detection_status: Mapped[str] = mapped_column(
        _CALIBRATION_STATUS, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), default=_now_utc, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), default=_now_utc, nullable=False
    )


class LarvaeMeasurement(Base):
    """Per-larva size metrics derived from polygon + calibration."""

    __tablename__ = "larvae_measurement"
    __table_args__ = (
        UniqueConstraint(
            "detection_id", name="uq_larvae_measurement_detection_id"
        ),
        Index("idx_larvae_measurement_detection_id", "detection_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    detection_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("larvae_detection.id", ondelete="CASCADE"), nullable=False
    )
    length_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_width_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_width_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    average_width_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    area_mm2: Mapped[float | None] = mapped_column(Float, nullable=True)
    volume_mm3: Mapped[float | None] = mapped_column(Float, nullable=True)
    centerline: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    widths: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    weight_mg: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Denormalised hint — flips TRUE when polygon/calibration changes after
    # this measurement was computed. Source of truth is timestamp comparison.
    is_stale: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    measured_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), default=_now_utc, nullable=False
    )

    detection: Mapped["LarvaeDetection"] = relationship(
        "LarvaeDetection", back_populates="measurement"
    )
