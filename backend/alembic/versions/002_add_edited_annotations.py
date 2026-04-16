"""Add edited_annotations JSONB column to analysis_image.

Revision ID: 002
Revises: 001
Create Date: 2026-04-16

IMPORTANT: Downgrading this migration is destructive — any user edits stored in
edited_annotations will be permanently lost. See the downgrade() docstring.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # Stores operator-corrected bounding boxes as a full replacement for the
    # model's original annotations. Nullable so old rows (pre-FS-009) have NULL.
    op.add_column(
        "analysis_image",
        sa.Column("edited_annotations", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    # DESTRUCTIVE: drops the column and all stored user edits.
    # In production with real user data this is irreversible.
    op.drop_column("analysis_image", "edited_annotations")
