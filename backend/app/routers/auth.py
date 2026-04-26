"""Auth router — register / login / refresh / logout / me (BE-020)."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import CurrentUser, get_session_dep, get_settings
from app.models.user import User
from app.schemas.auth import (
    AuthResponse,
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    RegisterRequest,
    TokenPair,
    UserOut,
)
from app.services.auth import (
    AuthError,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    revoke_jti,
    rotate_refresh_token,
    verify_password,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


def _unauthorized(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": code, "message": message},
        headers={"WWW-Authenticate": "Bearer"},
    )


def _access_ttl_seconds() -> int:
    return int(get_settings().jwt_access_ttl_min * 60)


def _build_auth_response(user: User) -> AuthResponse:
    settings = get_settings()
    access, _ = create_access_token(user, settings)
    refresh, _ = create_refresh_token(user, settings)
    return AuthResponse(
        user=UserOut.model_validate(user),
        access_token=access,
        refresh_token=refresh,
        access_expires_in=_access_ttl_seconds(),
    )


@router.post(
    "/register",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
)
async def register(
    body: RegisterRequest,
    session: Annotated[AsyncSession, Depends(get_session_dep)],
) -> AuthResponse:
    email = body.email.lower().strip()
    existing = await session.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "email_taken", "message": "Email is already registered"},
        )
    user = User(
        email=email,
        name=body.name,
        password_hash=hash_password(body.password),
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "email_taken", "message": "Email is already registered"},
        ) from exc
    logger.info(
        "User registered",
        extra={"context": {"user_id": str(user.id), "email": email}},
    )
    return _build_auth_response(user)


@router.post("/login", response_model=AuthResponse)
async def login(
    body: LoginRequest,
    session: Annotated[AsyncSession, Depends(get_session_dep)],
) -> AuthResponse:
    email = body.email.lower().strip()
    result = await session.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        # Same response for unknown email vs wrong password — don't leak which.
        raise _unauthorized("invalid_credentials", "Invalid email or password")
    logger.info(
        "User login",
        extra={"context": {"user_id": str(user.id), "email": email}},
    )
    return _build_auth_response(user)


@router.post("/refresh", response_model=TokenPair)
async def refresh(
    body: RefreshRequest,
    session: Annotated[AsyncSession, Depends(get_session_dep)],
) -> TokenPair:
    settings = get_settings()
    try:
        _user, access, _aexp, refresh_tok, _rexp = await rotate_refresh_token(
            session,
            presented_token=body.refresh_token,
            settings=settings,
        )
    except AuthError as exc:
        raise _unauthorized(exc.code, str(exc)) from exc
    return TokenPair(
        access_token=access,
        refresh_token=refresh_tok,
        access_expires_in=_access_ttl_seconds(),
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    body: LogoutRequest,
    session: Annotated[AsyncSession, Depends(get_session_dep)],
) -> Response:
    """Revoke the presented refresh token. Idempotent — already-revoked is 204."""
    settings = get_settings()
    try:
        decoded = decode_token(body.refresh_token, "refresh", settings)
    except AuthError:
        # Idempotent: a malformed/expired token is already unusable, return 204.
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    import uuid as _uuid

    try:
        user_id = _uuid.UUID(decoded.sub)
    except ValueError:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    await revoke_jti(
        session,
        jti=decoded.jti,
        user_id=user_id,
        expires_at=decoded.exp,
    )
    logger.info(
        "User logout",
        extra={"context": {"user_id": str(user_id), "jti": decoded.jti}},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> UserOut:
    return UserOut.model_validate(user)
