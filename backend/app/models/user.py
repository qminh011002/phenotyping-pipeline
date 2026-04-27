"""SQLAlchemy models for authentication: User and RevokedToken."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import TIMESTAMP, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _now_utc() -> datetime:
    return datetime.now(UTC)


class User(Base):
    """A registered user account."""

    __tablename__ = "user_account"
    __table_args__ = (
        Index("ix_user_account_email", "email", unique=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), default=_now_utc, nullable=False
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )


class RevokedToken(Base):
    """A refresh-token jti that has been invalidated.

    Logout revokes the active refresh jti. Refresh-token rotation also revokes
    the previous jti. Reuse of a revoked jti triggers a compromise response
    (see services/auth.py: rotate_refresh_token).
    """

    __tablename__ = "revoked_token"
    __table_args__ = (
        Index("ix_revoked_token_user_id", "user_id"),
        Index("ix_revoked_token_expires_at", "expires_at"),
    )

    jti: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_account.id", ondelete="CASCADE"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False
    )
    revoked_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), default=_now_utc, nullable=False
    )
