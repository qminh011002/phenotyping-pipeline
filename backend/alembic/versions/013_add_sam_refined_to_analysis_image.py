"""Track whether SAM has refined an image's polygons.

Count-only larvae/pupae runs skip SAM at inference time; the result viewer
can refine later (POST /analyses/{batch_id}/images/{image_id}/refine). The
flag tells the viewer whether refinement is still pending.

Existing larvae/pupae images are backfilled to TRUE unless their batch's
config snapshot recorded SAM as disabled — before this revision SAM ran
during inference whenever it was enabled.

Revision ID: 013
Revises: 012
Create Date: 2026-10-01
"""

from __future__ import annotations

from alembic import op

revision: str = "013"
down_revision: str | None = "012"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE analysis_image "
        "ADD COLUMN IF NOT EXISTS sam_refined BOOLEAN NOT NULL DEFAULT false"
    )
    op.execute("""
        UPDATE analysis_image AS img
        SET sam_refined = true
        FROM analysis_batch AS b
        WHERE img.batch_id = b.id
          AND b.organism_type IN ('larvae', 'pupae')
          AND COALESCE(b.config_snapshot ->> 'sam_enabled', 'true') <> 'false'
        """)


def downgrade() -> None:
    op.execute("ALTER TABLE analysis_image DROP COLUMN IF EXISTS sam_refined")
