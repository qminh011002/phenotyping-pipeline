"""Async SQLAlchemy engine, session factory, and FastAPI dependency injection."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

BACKEND_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


class DatabaseSettings(BaseSettings):
    """Database connection settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=BACKEND_ENV_FILE,
        env_file_encoding="utf-8",
        env_prefix="",
        extra="ignore",
    )

    database_url: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/phenotyping"
    )
    # Per-process pool. With N uvicorn workers the cluster-wide cap is
    # N × (db_pool_size + db_max_overflow); keep that under the postgres
    # ``max_connections`` setting (with headroom for psql, migrations, etc.).
    db_pool_size: int = 10
    db_max_overflow: int = 20


class Database:
    """Async database engine and session manager."""

    def __init__(
        self,
        database_url: str,
        pool_size: int = 10,
        max_overflow: int = 20,
    ) -> None:
        self._engine: AsyncEngine | None = None
        self._session_factory: async_sessionmaker[AsyncSession] | None = None
        self._database_url = database_url
        self._pool_size = pool_size
        self._max_overflow = max_overflow

    def init(self) -> None:
        """Create the async engine and session factory. Call from lifespan startup."""
        self._engine = create_async_engine(
            self._database_url,
            echo=False,
            pool_pre_ping=True,
            pool_size=self._pool_size,
            max_overflow=self._max_overflow,
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
        _db = Database(
            settings.database_url,
            pool_size=settings.db_pool_size,
            max_overflow=settings.db_max_overflow,
        )
    return _db


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields a database session."""
    db = get_db()
    async with db.session() as session:
        yield session
