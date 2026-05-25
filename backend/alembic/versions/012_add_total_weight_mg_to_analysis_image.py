"""Per-image total weight (mg) entered by the user, distributed across
larvae/pupae measurements proportionally to segmented area.

Revision ID: 012
Revises: 011
Create Date: 2026-05-25
"""

from __future__ import annotations

from alembic import op

revision: str = "012"
down_revision: str | None = "011"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE analysis_image "
        "ADD COLUMN IF NOT EXISTS total_weight_mg DOUBLE PRECISION"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE analysis_image DROP COLUMN IF EXISTS total_weight_mg")
