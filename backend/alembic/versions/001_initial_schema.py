"""Initial schema — analysis_batch, analysis_image, and app_settings tables.

Revision ID: 001
Revises:
Create Date: 2026-04-13
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "001"
down_revision: str | None = None
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    # ── analysis_batch ──────────────────────────────────────────────────────────
    op.create_table(
        "analysis_batch",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("completed_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("status", sa.String(20), server_default="processing", nullable=False),
        sa.Column("organism_type", sa.String(20), server_default="egg", nullable=False),
        sa.Column("mode", sa.String(20), server_default="upload", nullable=False),
        sa.Column("device", sa.String(20), server_default="cpu", nullable=False),
        sa.Column(
            "config_snapshot",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("total_image_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("total_count", sa.Integer(), nullable=True),
        sa.Column("avg_confidence", sa.Float(), nullable=True),
        sa.Column("total_elapsed_secs", sa.Float(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_batch_created_at", "analysis_batch", ["created_at"], unique=False)
    op.create_index("idx_batch_status", "analysis_batch", ["status"], unique=False)
    op.create_index("idx_batch_organism", "analysis_batch", ["organism_type"], unique=False)

    # ── analysis_image ─────────────────────────────────────────────────────────
    op.create_table(
        "analysis_image",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("batch_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("original_filename", sa.String(500), nullable=False),
        sa.Column("original_width", sa.Integer(), nullable=True),
        sa.Column("original_height", sa.Integer(), nullable=True),
        sa.Column("file_size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("file_hash", sa.String(64), nullable=True),
        sa.Column("status", sa.String(20), server_default="pending", nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("count", sa.Integer(), nullable=True),
        sa.Column("avg_confidence", sa.Float(), nullable=True),
        sa.Column("elapsed_secs", sa.Float(), nullable=True),
        sa.Column("annotations", postgresql.JSONB(), nullable=True),
        sa.Column("overlay_path", sa.String(1000), nullable=True),
        sa.Column("tile_count", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["batch_id"], ["analysis_batch.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_image_batch_id", "analysis_image", ["batch_id"], unique=False)
    op.create_index("idx_image_filename", "analysis_image", ["original_filename"], unique=False)

    # ── app_settings ───────────────────────────────────────────────────────────
    op.create_table(
        "app_settings",
        sa.Column("id", sa.Integer(), server_default="1", nullable=False),
        sa.Column("image_storage_dir", sa.String(1000), nullable=False),
        sa.Column("data_dir", sa.String(1000), nullable=True),
        sa.Column("updated_at", postgresql.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_app_settings_singleton"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("app_settings")
    op.drop_index("idx_image_filename", table_name="analysis_image")
    op.drop_index("idx_image_batch_id", table_name="analysis_image")
    op.drop_table("analysis_image")
    op.drop_index("idx_batch_organism", table_name="analysis_batch")
    op.drop_index("idx_batch_status", table_name="analysis_batch")
    op.drop_index("idx_batch_created_at", table_name="analysis_batch")
    op.drop_table("analysis_batch")
