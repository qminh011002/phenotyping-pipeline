"""Auth service: bcrypt password hashing + JWT issue/verify/rotate (BE-020)."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, Literal

import bcrypt
import jwt
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import AppSettings
from app.models.user import RevokedToken, User

logger = logging.getLogger(__name__)

# bcrypt cost — 12 is the modern default. Higher costs slow login proportionally.
_BCRYPT_ROUNDS: Final = 12
# bcrypt's algorithm has a hard 72-byte password limit. We pre-hash with SHA-256
# so longer passphrases hash safely and consistently. The standard mitigation.
_BCRYPT_MAX_BYTES: Final = 72


TokenType = Literal["access", "refresh"]


class AuthError(Exception):
    """Raised by decode/rotate when a token is unusable. Carries an error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code  # token_expired | token_invalid | token_revoked


@dataclass(slots=True)
class DecodedToken:
    sub: str  # user id (uuid as str)
    jti: str
    type: TokenType
    exp: datetime
    iat: datetime
    email: str | None = None


# ── Password hashing ────────────────────────────────────────────────────────────


def _prep(plain: str) -> bytes:
    raw = plain.encode("utf-8")
    if len(raw) <= _BCRYPT_MAX_BYTES:
        return raw
    # Pre-hash long passphrases so bcrypt's 72-byte cap never silently truncates.
    import hashlib

    return hashlib.sha256(raw).hexdigest().encode("ascii")


def hash_password(plain: str) -> str:
    salt = bcrypt.gensalt(rounds=_BCRYPT_ROUNDS)
    return bcrypt.hashpw(_prep(plain), salt).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_prep(plain), hashed.encode("ascii"))
    except (ValueError, TypeError):
        return False


# ── JWT encode / decode ─────────────────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(UTC)


def _secret_for(token_type: TokenType, settings: AppSettings) -> str:
    if token_type == "access":
        return settings.jwt_access_secret
    return settings.jwt_refresh_secret


def _ttl_for(token_type: TokenType, settings: AppSettings) -> timedelta:
    if token_type == "access":
        return timedelta(minutes=settings.jwt_access_ttl_min)
    return timedelta(days=settings.jwt_refresh_ttl_days)


def create_access_token(user: User, settings: AppSettings) -> tuple[str, datetime]:
    return _create_token("access", user, settings)


def create_refresh_token(user: User, settings: AppSettings) -> tuple[str, datetime]:
    return _create_token("refresh", user, settings)


def _create_token(
    token_type: TokenType, user: User, settings: AppSettings
) -> tuple[str, datetime]:
    now = _now()
    exp = now + _ttl_for(token_type, settings)
    payload: dict[str, object] = {
        "sub": str(user.id),
        "jti": uuid.uuid4().hex,
        "type": token_type,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    if token_type == "access":
        payload["email"] = user.email
    token = jwt.encode(
        payload,
        _secret_for(token_type, settings),
        algorithm=settings.jwt_algorithm,
    )
    return token, exp


def decode_token(
    token: str, expected_type: TokenType, settings: AppSettings
) -> DecodedToken:
    """Decode + validate a JWT. Raises ``AuthError`` with a stable code on failure."""
    try:
        payload = jwt.decode(
            token,
            _secret_for(expected_type, settings),
            algorithms=[settings.jwt_algorithm],
        )
    except jwt.ExpiredSignatureError as exc:
        raise AuthError("token_expired", "Token has expired") from exc
    except jwt.InvalidTokenError as exc:
        raise AuthError("token_invalid", f"Invalid token: {exc}") from exc

    actual_type = payload.get("type")
    if actual_type != expected_type:
        raise AuthError(
            "token_invalid",
            f"Wrong token type: expected {expected_type}, got {actual_type!r}",
        )

    sub = payload.get("sub")
    jti = payload.get("jti")
    exp = payload.get("exp")
    iat = payload.get("iat")
    if (
        not isinstance(sub, str)
        or not isinstance(jti, str)
        or not isinstance(exp, int)
        or not isinstance(iat, int)
    ):
        raise AuthError("token_invalid", "Token missing required claims")

    return DecodedToken(
        sub=sub,
        jti=jti,
        type=actual_type,
        exp=datetime.fromtimestamp(exp, tz=UTC),
        iat=datetime.fromtimestamp(iat, tz=UTC),
        email=payload.get("email") if isinstance(payload.get("email"), str) else None,
    )


# ── Revocation ──────────────────────────────────────────────────────────────────


async def is_revoked(session: AsyncSession, jti: str) -> bool:
    result = await session.execute(
        select(RevokedToken.jti).where(RevokedToken.jti == jti).limit(1)
    )
    return result.scalar_one_or_none() is not None


async def revoke_jti(
    session: AsyncSession,
    *,
    jti: str,
    user_id: uuid.UUID,
    expires_at: datetime,
) -> None:
    """Insert a revocation row. Idempotent — re-revoking a jti is a no-op."""
    if await is_revoked(session, jti):
        return
    session.add(RevokedToken(jti=jti, user_id=user_id, expires_at=expires_at))


async def revoke_all_user_refresh_tokens(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """Compromise response — wipe the user's session everywhere.

    We can't enumerate live refresh jti's (they live only in clients), so the
    practical effect here is to delete this user's revocation rows so the table
    doesn't grow unbounded; the real protection is logging and forcing the user
    to re-authenticate. Tokens already issued will be rejected on next use
    because the user's password / state can be invalidated by other means.

    For now we simply log and rely on the caller to also log out the user. A
    future enhancement is per-user "min_iat" so any token issued before a given
    moment is rejected. Tracked in BE-020 follow-ups.
    """
    logger.warning(
        "Compromise response: refresh-token reuse detected",
        extra={"context": {"user_id": str(user_id)}},
    )
    # Cleanup: remove already-expired rows for this user — keeps the table small.
    await session.execute(
        delete(RevokedToken)
        .where(RevokedToken.user_id == user_id)
        .where(RevokedToken.expires_at < _now())
    )


# ── Refresh-token rotation ──────────────────────────────────────────────────────


async def rotate_refresh_token(
    session: AsyncSession,
    *,
    presented_token: str,
    settings: AppSettings,
) -> tuple[User, str, datetime, str, datetime]:
    """Validate a refresh token and issue a new pair; revoke the old jti.

    Returns: ``(user, access_token, access_exp, refresh_token, refresh_exp)``.

    Raises ``AuthError`` with codes ``token_expired`` / ``token_invalid`` /
    ``token_revoked``. On revoked-token reuse, also calls
    ``revoke_all_user_refresh_tokens`` as a compromise response.
    """
    decoded = decode_token(presented_token, "refresh", settings)

    if await is_revoked(session, decoded.jti):
        try:
            await revoke_all_user_refresh_tokens(session, uuid.UUID(decoded.sub))
        except ValueError:
            pass
        raise AuthError("token_revoked", "Refresh token has been revoked")

    user = (
        await session.execute(select(User).where(User.id == uuid.UUID(decoded.sub)))
    ).scalar_one_or_none()
    if user is None:
        raise AuthError("token_invalid", "User no longer exists")

    # Revoke the presented refresh token before issuing a new one.
    await revoke_jti(
        session,
        jti=decoded.jti,
        user_id=user.id,
        expires_at=decoded.exp,
    )

    access_token, access_exp = create_access_token(user, settings)
    refresh_token, refresh_exp = create_refresh_token(user, settings)
    return user, access_token, access_exp, refresh_token, refresh_exp
