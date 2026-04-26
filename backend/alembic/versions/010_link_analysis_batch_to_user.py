"""Link analysis_batch to user_account (BE-021).

Revision ID: 010
Revises: 009
Create Date: 2026-04-27

Adds a nullable ``user_id`` FK on ``analysis_batch`` referencing
``user_account.id`` ON DELETE RESTRICT, with an index on
``(user_id, created_at DESC)`` for the per-user listing query. Existing rows
keep ``user_id = NULL`` (legacy ownerless data); nothing is back-filled.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "010"
down_revision: str | None = "009"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "analysis_batch",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_analysis_batch_user_id_user_account",
        "analysis_batch",
        "user_account",
        ["user_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index(
        "idx_batch_user_created",
        "analysis_batch",
        ["user_id", sa.text("created_at DESC")],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_batch_user_created", table_name="analysis_batch")
    op.drop_constraint(
        "fk_analysis_batch_user_id_user_account",
        "analysis_batch",
        type_="foreignkey",
    )
    op.drop_column("analysis_batch", "user_id")
