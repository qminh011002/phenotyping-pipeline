"""Structured logging configuration with ring buffer and JSON formatter.

See `.cursor/rules/logging.mdc` for the full architecture specification.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from functools import wraps
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.services.log_buffer import LogBuffer


# ── JsonFormatter ──────────────────────────────────────────────────────────────


class JsonFormatter(logging.Formatter):
    """Format log records as structured JSON on a single line.

    Output shape matches the LogEntry schema in api-contract.mdc:
    {
      "timestamp": "2026-04-11T15:42:01.123Z",
      "level": "INFO",
      "message": "...",
      "context": { ... }
    }

    Only emits fields defined in the schema; drops stdlib noise (name, pathname, lineno).
    """

    # Fields to exclude from the context dict — they are stdlib noise
    _EXCLUDE = frozenset(
        {
            "name",
            "msg",
            "args",
            "created",
            "filename",
            "funcName",
            "levelname",
            "levelno",
            "lineno",
            "module",
            "msecs",
            "pathname",
            "process",
            "processName",
            "relativeCreated",
            "thread",
            "threadName",
            "exc_info",
            "exc_text",
            "stack_info",
            "message",
            "taskName",
            # Keys added by our SafeMakeRecord patch
            "_safe_extra",
        }
    )

    def format(self, record: logging.LogRecord) -> str:
        context: dict[str, Any] = {
            k: v
            for k, v in record.__dict__.items()
            if k not in self._EXCLUDE
        }

        # Merge in safe_extra (reserved LogRecord keys preserved by SafeMakeRecord)
        if hasattr(record, "_safe_extra"):
            context.update(record._safe_extra)

        timestamp = (
            datetime.fromtimestamp(record.created, tz=timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
            + "Z"
        )

        return json.dumps(
            {
                "timestamp": timestamp,
                "level": record.levelname,
                "message": record.getMessage(),
                "context": context,
            },
            ensure_ascii=False,
        )


# ── SafeMakeRecord ─────────────────────────────────────────────────────────────


# Reserved LogRecord keys that CANNOT be in extra={...} in logger.info(..., extra={...})
_RESERVED_LOGRECORD_KEYS = frozenset(
    {
        "filename",
        "funcName",
        "levelname",
        "lineno",
        "message",
        "module",
        "pathname",
        "process",
        "thread",
    }
)


class SafeMakeRecord(logging.Logger):
    """Logger subclass that safely handles reserved keys in extra={...}.

    Python's standard LogRecord.__init__ raises KeyError when extra={...}
    contains keys that conflict with LogRecord's own attributes
    (filename, funcName, levelname, lineno, etc.). This subclass
    intercepts those reserved keys and stores them under _safe_extra
    so that JsonFormatter can include them in the context dict.
    """

    def makeRecord(
        self,
        name: str,
        level: int,
        fn: str,
        lno: int,
        msg: Any,
        args: Any,
        exc_info: Any,
        func: str | None = None,
        extra: dict[str, Any] | None = None,
        sinfo: str | None = None,
    ) -> logging.LogRecord:
        if extra:
            safe_extra: dict[str, Any] = {}
            for key in list(extra.keys()):
                if key in _RESERVED_LOGRECORD_KEYS:
                    safe_extra[key] = extra.pop(key)
            if safe_extra:
                # Create record first with sanitized extra
                record = super().makeRecord(name, level, fn, lno, msg, args, exc_info, func, extra, sinfo)
                record._safe_extra = safe_extra
                return record
        return super().makeRecord(name, level, fn, lno, msg, args, exc_info, func, extra, sinfo)


# ── RingBufferHandler ──────────────────────────────────────────────────────────


class RingBufferHandler(logging.Handler):
    """Custom handler that stores log records in a ring buffer and fans them out.

    - Stores last 1000 formatted entries in the LogBuffer's deque.
    - Fans out each entry to all connected WebSocket subscriber queues.
    - Uses loop.call_soon_threadsafe() for thread-safety when bridging from
      worker threads (inference pool) into the asyncio event loop.
    - If a subscriber queue is full, drops the oldest entry — never blocks.
    - JSON serialization happens once here, not per subscriber (performance requirement).
    """

    def __init__(self, log_buffer: LogBuffer) -> None:
        super().__init__()
        self._log_buffer = log_buffer

    def emit(self, record: logging.LogRecord) -> None:
        """Format the record and push to the ring buffer + fan out to subscribers."""
        formatted = self.format(record)

        try:
            entry = json.loads(formatted)
        except Exception:
            entry = {}

        level = record.levelname
        message = record.getMessage()
        context = entry.get("context", {})

        try:
            self._log_buffer.push_from_handler(formatted, level, message, context)
        except Exception:
            # Never let logging errors propagate to the inference path
            pass

    def handleError(self, record: logging.LogRecord) -> None:
        """Suppress logging errors so the inference path never crashes."""
        pass


# ── configure_logging ──────────────────────────────────────────────────────────


def configure_logging(log_buffer: LogBuffer | None = None) -> None:
    """Configure application-wide structured logging.

    Called once at startup from the FastAPI lifespan, before any other module
    logs anything. Sets up:
    - Root logger: INFO level (configurable), JSON-formatted handlers
    - RingBufferHandler (if log_buffer provided) for in-memory log storage
    - Console handler to stdout (JSON lines for Tauri capture)
    - File handler (plain text) for human review
    - SafeMakeRecord patch so that reserved keys in extra={...} don't raise
    """
    from app.deps import get_settings

    settings = get_settings()
    log_level = getattr(logging, settings.log_level.upper(), logging.INFO)

    # Patch Logger.makeRecord globally so all loggers handle reserved extra keys
    # without needing to inherit from SafeMakeRecord explicitly
    _patch_logger_make_record()

    # Root logger
    root = logging.getLogger()
    root.setLevel(log_level)

    # Remove any pre-existing handlers (e.g., uvicorn default)
    for handler in root.handlers[:]:
        root.remove_handler(handler)

    json_formatter = JsonFormatter()

    # RingBufferHandler — stores logs in memory and fans out to WS subscribers
    if log_buffer is not None:
        ring_handler = RingBufferHandler(log_buffer)
        ring_handler.setLevel(logging.DEBUG)
        ring_handler.setFormatter(json_formatter)
        root.addHandler(ring_handler)

    # Console handler — JSON lines to stdout (captured by Tauri / terminal)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(log_level)
    console_handler.setFormatter(json_formatter)
    root.addHandler(console_handler)

    # File handler — human-readable plain text
    try:
        file_handler = logging.FileHandler("app.log", encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s %(name)s — %(message)s",
                datefmt="%Y-%m-%dT%H:%M:%S",
            )
        )
        root.addHandler(file_handler)
    except OSError:
        pass

    # Suppress noisy third-party loggers
    for noisy in ("httpx", "httpcore", "uvicorn.access", "uvicorn.error"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _patch_logger_make_record() -> None:
    """Monkey-patch logging.Logger.makeRecord to handle reserved extra keys.

    Python's LogRecord.__init__ raises KeyError when extra={...} contains reserved
    LogRecord attribute names. This patch intercepts those keys, stores them in
    _safe_extra on the record, and lets JsonFormatter include them in context.
    """
    _original_make_record = logging.Logger.makeRecord

    @wraps(_original_make_record)
    def _safe_make_record(
        self: logging.Logger,
        name: str,
        level: int,
        fn: str,
        lno: int,
        msg: Any,
        args: Any,
        exc_info: Any,
        func: str | None = None,
        extra: dict[str, Any] | None = None,
        sinfo: str | None = None,
    ) -> logging.LogRecord:
        if extra:
            safe_extra: dict[str, Any] = {}
            for key in list(extra.keys()):
                if key in _RESERVED_LOGRECORD_KEYS:
                    safe_extra[key] = extra.pop(key)
            if safe_extra:
                record = _original_make_record(
                    self, name, level, fn, lno, msg, args, exc_info, func, extra, sinfo
                )
                record._safe_extra = safe_extra
                return record
        return _original_make_record(
            self, name, level, fn, lno, msg, args, exc_info, func, extra, sinfo
        )

    logging.Logger.makeRecord = _safe_make_record  # type: ignore[method-assign]
