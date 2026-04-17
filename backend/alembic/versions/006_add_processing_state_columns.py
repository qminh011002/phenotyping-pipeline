"""Add processed_image_count, failed_at, failure_reason to analysis_batch.

Revision ID: 006
Revises: 005
Create Date: 2026-04-17
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision: str = "006"
down_revision: str | None = "005"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "analysis_batch",
        sa.Column("processed_image_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "analysis_batch",
        sa.Column("failed_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "analysis_batch",
        sa.Column("failure_reason", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("analysis_batch", "failure_reason")
    op.drop_column("analysis_batch", "failed_at")
    op.drop_column("analysis_batch", "processed_image_count")
