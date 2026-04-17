"""Add custom_model and model_assignment tables.

Revision ID: 004
Revises: 003
Create Date: 2026-04-17
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision: str = "004"
down_revision: str | None = "003"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "custom_model",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("original_filename", sa.String(255), nullable=False),
        sa.Column("stored_path", sa.Text, nullable=False),
        sa.Column("file_size_bytes", sa.Integer, nullable=False),
        sa.Column(
            "uploaded_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("is_valid", sa.Boolean, nullable=False, server_default="false"),
    )

    op.create_table(
        "model_assignment",
        sa.Column("organism", sa.String(20), primary_key=True),
        sa.Column(
            "custom_model_id",
            UUID(as_uuid=True),
            sa.ForeignKey("custom_model.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "assigned_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("model_assignment")
    op.drop_table("custom_model")
