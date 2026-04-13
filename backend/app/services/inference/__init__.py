"""Egg inference service package.

Re-exports EggInferenceService for convenient imports.
"""

from __future__ import annotations

from app.services.inference.egg import EggInferenceService

__all__ = ["EggInferenceService"]
