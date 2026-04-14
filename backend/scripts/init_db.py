#!/usr/bin/env python3
"""One-shot script: create all tables defined by SQLAlchemy models on the target database.

Run ONCE after scaffolding the schema, or whenever a new model is added:
    cd backend
    python -m scripts.init_db

This script does NOT run inside the FastAPI lifespan — schema creation is kept
explicit and manual per the project convention. The app_settings singleton seed
is handled separately by the FastAPI lifespan on every startup.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

# Ensure the backend package is on the path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db.base import Base
from app.database import Database, DatabaseSettings

# Register every model so Base.metadata sees them
from app.models.analysis import AnalysisBatch, AnalysisImage  # noqa: F401
from app.models.app_settings import AppSettingsRow  # noqa: F401


async def run() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger = logging.getLogger("init_db")

    settings = DatabaseSettings()
    logger.info("Connecting to: %s", settings.database_url.split("@")[1])  # hide password

    db = Database(database_url=settings.database_url)

    logger.info("Creating engine...")
    db.init()

    try:
        async with db.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Tables created successfully: %s", ", ".join(sorted(Base.metadata.tables)))
    finally:
        await db.close()
        logger.info("Engine disposed.")


if __name__ == "__main__":
    asyncio.run(run())
