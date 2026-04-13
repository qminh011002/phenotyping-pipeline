"""GET /config and PUT /config endpoints for pipeline configuration.

GET /config  — returns the current egg inference configuration from config.yaml.
PUT /config  — merges a partial update, validates, persists, and returns the full config.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status

from app.deps import get_pipeline_config
from app.schemas.config import ConfigUpdateRequest, EggConfig

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config", tags=["config"])


@router.get(
    "",
    response_model=EggConfig,
    summary="Get current egg inference configuration",
    responses={
        200: {"description": "Full egg config returned"},
        500: {"description": "Failed to read or parse config.yaml"},
    },
)
async def get_config() -> EggConfig:
    """Return the current egg inference configuration from config.yaml.

    This reflects whatever is currently persisted on disk.
    """
    try:
        cfg = get_pipeline_config()
        return cfg.get_egg_config()
    except Exception as exc:
        logger.exception("GET /config failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to read config: {exc}",
        ) from exc


@router.put(
    "",
    response_model=EggConfig,
    summary="Update egg inference configuration",
    responses={
        200: {"description": "Updated full config returned"},
        422: {"description": "Validation error (invalid field value)"},
        500: {"description": "Failed to persist config.yaml"},
    },
)
async def update_config(update: ConfigUpdateRequest) -> EggConfig:
    """Apply a partial update to the egg configuration.

    Only the fields present in the request body are changed. The updated
    full config is returned after validation and persistence.

    Note: changing ``device`` or ``model`` does not reload the model —
    the new values apply to the next inference request. Restart required
    for those changes to take effect.

    Changes are logged at INFO with only the modified fields shown.
    """
    cfg_mgr = get_pipeline_config()

    # Capture old config for diff logging
    old_config = cfg_mgr.get_egg_config()

    try:
        merged = cfg_mgr.update_egg_config(update.model_dump(exclude_none=True))
    except Exception as exc:
        logger.exception("PUT /config failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to persist config: {exc}",
        ) from exc

    # Log only the fields that actually changed
    changed_fields: dict[str, tuple[str, str]] = {}
    for field_name in update.model_fields:
        old_val = getattr(old_config, field_name, None)
        new_val = getattr(merged, field_name, None)
        if old_val != new_val:
            changed_fields[field_name] = (str(old_val), str(new_val))

    if changed_fields:
        diff_parts = " | ".join(
            f"{k}: {old} → {new}" for k, (old, new) in changed_fields.items()
        )
        logger.info(
            "Config updated: %s",
            diff_parts,
            extra={"context": {"old": dict(old_config), "new": dict(merged), "changed": list(changed_fields.keys())}},
        )

    return merged
