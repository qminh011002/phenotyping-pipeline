"""Pydantic schemas for authentication endpoints (BE-020)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    name: str | None = Field(default=None, max_length=200)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class LogoutRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    name: str | None = None
    created_at: datetime


class TokenPair(BaseModel):
    """Issued by login/register/refresh — never include the user's password."""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    access_expires_in: int  # seconds


class AuthResponse(BaseModel):
    """Login + register response — token pair plus the authenticated user."""

    user: UserOut
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    access_expires_in: int
