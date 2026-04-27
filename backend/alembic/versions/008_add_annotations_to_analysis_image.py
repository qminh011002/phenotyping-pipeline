"""Persist model annotations on analysis_image so saved batches can be reopened
for viewing / editing without losing the model's original detections.

Revision ID: 008
Revises: 007
Create Date: 2026-04-22
"""

from __future__ import annotations

from alembic import op

revision: str = "008"
down_revision: str | None = "007"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # Nullable — existing rows (pre-008 batches) won't have annotations.
    # Callers already handle the missing-annotations case for legacy data.
    op.execute("ALTER TABLE analysis_image ADD COLUMN IF NOT EXISTS annotations JSONB")


def downgrade() -> None:
    op.execute("ALTER TABLE analysis_image DROP COLUMN IF EXISTS annotations")
