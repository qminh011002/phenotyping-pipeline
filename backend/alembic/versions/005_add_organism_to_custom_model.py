"""Add organism column to custom_model and backfill existing rows.

Revision ID: 005
Revises: 004
Create Date: 2026-04-17
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision: str = "005"
down_revision: str | None = "004"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "custom_model",
        sa.Column("organism", sa.String(length=20), nullable=True),
    )

    # First pass: inherit slot from existing assignment rows when present.
    op.execute(
        sa.text(
            """
            UPDATE custom_model AS cm
            SET organism = ma.organism
            FROM model_assignment AS ma
            WHERE ma.custom_model_id = cm.id
              AND cm.organism IS NULL
            """
        )
    )

    # Second pass: infer from filename where possible; default to egg.
    op.execute(
        sa.text(
            """
            UPDATE custom_model
            SET organism = CASE
                WHEN lower(original_filename) LIKE '%larva%' THEN 'larvae'
                WHEN lower(original_filename) LIKE '%pupa%' THEN 'pupae'
                WHEN lower(original_filename) LIKE '%neonat%' THEN 'neonate'
                ELSE 'egg'
            END
            WHERE organism IS NULL
            """
        )
    )

    op.alter_column("custom_model", "organism", nullable=False)

    op.create_index(
        "ix_custom_model_organism_uploaded_at",
        "custom_model",
        ["organism", "uploaded_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_custom_model_organism_uploaded_at", table_name="custom_model")
    op.drop_column("custom_model", "organism")
