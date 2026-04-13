"""Pydantic schemas for structured log entries."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR"]


class LogEntry(BaseModel):
    """A single structured log record from the ring buffer."""

    timestamp: str = Field(description="ISO 8601 UTC timestamp with milliseconds")
    level: LogLevel
    message: str
    context: dict[str, Any] = Field(default_factory=dict)


class LogStreamMessage(BaseModel):
    """WebSocket message wrapper for /logs/stream."""

    type: Literal["log", "heartbeat"]
    data: LogEntry | None = Field(
        default=None,
        description="LogEntry for 'log' type, null for 'heartbeat'",
    )
