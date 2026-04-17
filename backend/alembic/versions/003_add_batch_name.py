"""Add name column to analysis_batch with backfill.

Revision ID: 003
Revises: 002
Create Date: 2026-04-17

Three-step safe pattern: add nullable → backfill → set NOT NULL.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision: str = "003"
down_revision: str | None = "002"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # 1. Add nullable column.
    op.add_column(
        "analysis_batch",
        sa.Column("name", sa.String(length=200), nullable=True),
    )

    # 2. Backfill existing rows.
    #    - Single-image batch → file stem of the only image's original_filename.
    #    - Multi-image (or zero-image edge case) → "Batch of N — YYYY-MM-DD HH:mm".
    #    Postgres-only — matches the project's DB target.
    op.execute(
        """
        WITH firsts AS (
            SELECT DISTINCT ON (batch_id)
                batch_id,
                original_filename
            FROM analysis_image
            ORDER BY batch_id, created_at ASC
        )
        UPDATE analysis_batch AS b
        SET name = CASE
            WHEN b.total_image_count = 1 AND f.original_filename IS NOT NULL
                THEN regexp_replace(f.original_filename, '\\.[^.]+$', '')
            ELSE 'Batch of ' || b.total_image_count
                 || ' — '
                 || to_char(b.created_at, 'YYYY-MM-DD HH24:MI')
        END
        FROM firsts AS f
        WHERE f.batch_id = b.id;
        """
    )
    # Handle any batches with no images at all.
    op.execute(
        """
        UPDATE analysis_batch
        SET name = 'Batch of ' || total_image_count
                   || ' — '
                   || to_char(created_at, 'YYYY-MM-DD HH24:MI')
        WHERE name IS NULL;
        """
    )

    # 3. Set NOT NULL.
    op.alter_column("analysis_batch", "name", nullable=False)


def downgrade() -> None:
    op.drop_column("analysis_batch", "name")
