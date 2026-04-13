"""CORS middleware configuration for Tauri desktop client.

Tauri serves the frontend from:
  - `tauri://localhost` (production)
  - `http://localhost:1420` (Vite dev server)
"""

from __future__ import annotations

from fastapi.middleware.cors import CORSMiddleware


def get_cors_middleware() -> tuple[type[CORSMiddleware], dict]:
    """Return CORS middleware class and kwargs for FastAPI app.add_middleware()."""
    return (
        CORSMiddleware,
        {
            "allow_origins": [
                "tauri://localhost",
                "http://localhost:1420",
            ],
            "allow_credentials": False,
            "allow_methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            "allow_headers": ["*"],
            "allow_origins": [
                "tauri://localhost",
                "http://localhost:1420",
            ],
            "allow_credentials": False,
        },
    )
