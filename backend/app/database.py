"""Async SQLAlchemy engine, session factory, and FastAPI dependency injection."""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Annotated

from pydantic_settings import BaseSettings
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from typing_extensions import Self
from app.db.base import Base


class DatabaseSettings(BaseSettings):
    """Database connection settings loaded from environment variables."""

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/phenotyping"


class Database:
    """Async database engine and session manager."""

    def __init__(self, database_url: str) -> None:
        self._engine: AsyncEngine | None = None
        self._session_factory: async_sessionmaker[AsyncSession] | None = None
        self._database_url = database_url

    def init(self) -> None:
        """Create the async engine and session factory. Call from lifespan startup."""
        self._engine = create_async_engine(
            self._database_url,
            echo=False,
            pool_pre_ping=True,
            pool_size=10,
            max_overflow=20,
        )
        self._session_factory = async_sessionmaker(
            bind=self._engine,
            class_=AsyncSession,
            expire_on_commit=False,
            autoflush=False,
        )

    @asynccontextmanager
    async def session(self) -> AsyncGenerator[AsyncSession, None]:
        """Context manager for a database session with automatic rollback on error."""
        if self._session_factory is None:
            msg = "Database not initialized. Call db.init() in lifespan startup."
            raise RuntimeError(msg)
        async with self._session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async def close(self) -> None:
        """Dispose the engine. Call from lifespan shutdown."""
        if self._engine is not None:
            await self._engine.dispose()
            self._engine = None
            self._session_factory = None

    @property
    def engine(self) -> AsyncEngine:
        if self._engine is None:
            msg = "Database not initialized. Call db.init() in lifespan startup."
            raise RuntimeError(msg)
        return self._engine


# Module-level singleton instance
_db: Database | None = None


def get_db() -> Database:
    """Return the module-level database singleton instance."""
    global _db
    if _db is None:
        settings = DatabaseSettings()
        _db = Database(settings.database_url)
    return _db


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields a database session."""
    db = get_db()
    async with db.session() as session:
        yield session
