"""SAM model management schemas."""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, Field

from app.services.sam_model_service import SamModelFile


class SamModelResponse(BaseModel):
    """One SAM weight file on disk."""

    filename: str
    file_size_bytes: int = Field(ge=0)
    uploaded_at: datetime
    is_builtin: bool
    is_active: bool

    @classmethod
    def from_entry(cls, entry: SamModelFile) -> "SamModelResponse":
        return cls(
            filename=entry.filename,
            file_size_bytes=entry.file_size_bytes,
            uploaded_at=datetime.fromtimestamp(entry.uploaded_at, tz=timezone.utc),
            is_builtin=entry.is_builtin,
            is_active=entry.is_active,
        )


class SamModelListResponse(BaseModel):
    models: list[SamModelResponse] = Field(default_factory=list)
    active_filename: str | None = None


class SamModelActivateRequest(BaseModel):
    filename: str
