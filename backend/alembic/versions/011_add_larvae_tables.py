"""Add larvae detection / calibration / measurement tables (INF-005).

Revision ID: 011
Revises: 010
Create Date: 2026-05-05

The ``analysis_batch.organism_type`` discriminator already exists from 001
(NOT NULL, default ``'egg'``), so existing rows are already correctly tagged
and no backfill is required here.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "011"
down_revision: str | None = "010"
branch_labels: str | None = None
depends_on: str | None = None


_DETECTION_ORIGIN = postgresql.ENUM(
    "model", "user", name="larvae_detection_origin"
)
_CALIBRATION_STATUS = postgresql.ENUM(
    "detected", "manual", "failed", name="larvae_calibration_status"
)


def upgrade() -> None:
    bind = op.get_bind()
    _DETECTION_ORIGIN.create(bind, checkfirst=True)
    _CALIBRATION_STATUS.create(bind, checkfirst=True)

    # ── larvae_detection ────────────────────────────────────────────────────
    op.create_table(
        "larvae_detection",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("image_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("polygon", postgresql.JSONB(), nullable=False),
        sa.Column("bbox", postgresql.JSONB(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("area_px", sa.Integer(), nullable=True),
        sa.Column("model_version", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("edited_polygon", postgresql.JSONB(), nullable=True),
        sa.Column(
            "edited_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=True,
        ),
        sa.Column("edited_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "origin",
            postgresql.ENUM(
                "model", "user", name="larvae_detection_origin", create_type=False
            ),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(
            ["image_id"], ["analysis_image.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["edited_by"], ["user_account.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_larvae_detection_image_id",
        "larvae_detection",
        ["image_id"],
        unique=False,
    )

    # ── larvae_calibration ──────────────────────────────────────────────────
    op.create_table(
        "larvae_calibration",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("image_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("auto_corners", postgresql.JSONB(), nullable=True),
        sa.Column("edited_corners", postgresql.JSONB(), nullable=True),
        sa.Column("mm_per_px_x", sa.Float(), nullable=True),
        sa.Column("mm_per_px_y", sa.Float(), nullable=True),
        sa.Column("calibration_object_w_mm", sa.Float(), nullable=True),
        sa.Column("calibration_object_h_mm", sa.Float(), nullable=True),
        sa.Column(
            "detection_status",
            postgresql.ENUM(
                "detected",
                "manual",
                "failed",
                name="larvae_calibration_status",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["image_id"], ["analysis_image.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("image_id", name="uq_larvae_calibration_image_id"),
    )
    op.create_index(
        "idx_larvae_calibration_image_id",
        "larvae_calibration",
        ["image_id"],
        unique=False,
    )

    # ── larvae_measurement ──────────────────────────────────────────────────
    op.create_table(
        "larvae_measurement",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "detection_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("length_mm", sa.Float(), nullable=True),
        sa.Column("min_width_mm", sa.Float(), nullable=True),
        sa.Column("max_width_mm", sa.Float(), nullable=True),
        sa.Column("average_width_mm", sa.Float(), nullable=True),
        sa.Column("area_mm2", sa.Float(), nullable=True),
        sa.Column("volume_mm3", sa.Float(), nullable=True),
        sa.Column("centerline", postgresql.JSONB(), nullable=True),
        sa.Column("widths", postgresql.JSONB(), nullable=True),
        sa.Column("weight_mg", sa.Float(), nullable=True),
        sa.Column(
            "is_stale",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "measured_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["detection_id"], ["larvae_detection.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "detection_id", name="uq_larvae_measurement_detection_id"
        ),
    )
    op.create_index(
        "idx_larvae_measurement_detection_id",
        "larvae_measurement",
        ["detection_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "idx_larvae_measurement_detection_id", table_name="larvae_measurement"
    )
    op.drop_table("larvae_measurement")
    op.drop_index(
        "idx_larvae_calibration_image_id", table_name="larvae_calibration"
    )
    op.drop_table("larvae_calibration")
    op.drop_index(
        "idx_larvae_detection_image_id", table_name="larvae_detection"
    )
    op.drop_table("larvae_detection")

    bind = op.get_bind()
    _CALIBRATION_STATUS.drop(bind, checkfirst=True)
    _DETECTION_ORIGIN.drop(bind, checkfirst=True)
