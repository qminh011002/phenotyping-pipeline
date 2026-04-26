"""In-memory ring buffer and per-client queue manager for log streaming.

See `.cursor/rules/logging.mdc` for the full architecture specification.

Architecture:
    Python logging stdlib
         │
         ▼
    RingBufferHandler  (logging.Handler)
         │
         ├── appends to ring deque (maxlen=1000)
         │
         └── fans out to per-client asyncio.Queues
                   │
                   ▼
             WebSocket /logs/stream  +  GET /logs/recent
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any

_QUEUE_MAXSIZE = 500
_RING_MAXLEN = 1000

_logger = logging.getLogger(__name__)


def _log_task_exception(task: "asyncio.Task[Any]") -> None:
    exc = task.exception()
    if exc is not None:
        _logger.debug("log push task failed: %s", exc)


class LogBuffer:
    """Manages the in-memory ring buffer and per-client WebSocket subscriber queues.

    Thread-safe: subscriber dict operations are protected by a lock.
    The ring deque itself is thread-safe for appends (deque is thread-safe for
    append/popleft operations from a single consumer).
    """

    def __init__(self) -> None:
        self._ring: deque[dict[str, Any]] = deque(maxlen=_RING_MAXLEN)
        self._subscribers: dict[str, asyncio.Queue[dict[str, Any]]] = {}
        self._dropped_counts: dict[str, int] = {}
        self._lock = asyncio.Lock()
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._stop_heartbeat = False
        # Captured in start_heartbeat (runs in the event loop) so logs emitted
        # from worker threads — where asyncio.get_running_loop() raises — can
        # still schedule fan-out via loop.call_soon_threadsafe.
        self._loop: asyncio.AbstractEventLoop | None = None

    # ── Subscriber management ────────────────────────────────────────────────

    async def subscribe(self) -> tuple[str, asyncio.Queue[dict[str, Any]]]:
        """Register a new WebSocket client and return its ID and queue.

        Returns:
            A tuple of (client_id, queue) where queue is a fresh asyncio.Queue
            sized at 500 entries. The caller uses this queue to receive log frames.
        """
        client_id = str(uuid.uuid4())
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)

        async with self._lock:
            self._subscribers[client_id] = queue
            self._dropped_counts[client_id] = 0

        logging.getLogger(__name__).debug(
            "WS client connected",
            extra={"context": {"client_id": client_id, "total_clients": len(self._subscribers)}},
        )

        return client_id, queue

    async def unsubscribe(self, client_id: str) -> int:
        """Remove a WebSocket client and return the number of dropped log entries.

        Logs a WARNING if the dropped count is greater than zero.
        """
        queue: asyncio.Queue[dict[str, Any]] | None = None

        async with self._lock:
            queue = self._subscribers.pop(client_id, None)
            dropped = self._dropped_counts.pop(client_id, 0)

        if queue is not None:
            logger = logging.getLogger(__name__)
            if dropped > 0:
                logger.warning(
                    "Log queue overflow — dropped %d messages for client %s",
                    dropped,
                    client_id,
                    extra={"context": {"client_id": client_id, "dropped_count": dropped}},
                )
            logger.debug(
                "WS client disconnected",
                extra={
                    "context": {
                        "client_id": client_id,
                        "total_clients": len(self._subscribers),
                        "dropped_logs": dropped,
                    }
                },
            )

        return dropped

    @property
    def subscriber_count(self) -> int:
        """Current number of WS subscribers (best-effort, lock-free read)."""
        return len(self._subscribers)

    # ── Buffer access ────────────────────────────────────────────────────────

    def get_recent(self, limit: int = 200) -> list[dict[str, Any]]:
        """Return the last N entries from the ring buffer in chronological order.

        Args:
            limit: Maximum number of entries to return. Defaults to 200.

        Returns:
            A list of log entry dicts, oldest first.
        """
        items = list(self._ring)
        return items[-limit:]

    # ── Internal: push from RingBufferHandler ────────────────────────────────

    def push_from_handler(
        self, formatted_json: str, level: str, message: str, context: dict[str, Any]
    ) -> None:
        """Called by RingBufferHandler.emit().

        This is invoked from both asyncio threads and worker threads. We use
        loop.call_soon_threadsafe() with a sync wrapper that creates a task
        so the coroutine (_push_async) is properly scheduled.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # Called from a worker thread — fall back to the loop captured at
            # startup. Without this, all logs emitted from the inference pool
            # are silently dropped.
            loop = self._loop
            if loop is None or loop.is_closed():
                return

        def _schedule() -> None:
            task = asyncio.create_task(
                self._push_async(formatted_json, level, message, context)
            )
            task.add_done_callback(_log_task_exception)

        loop.call_soon_threadsafe(_schedule)

    async def _push_async(
        self, formatted_json: str, level: str, message: str, context: dict[str, Any]
    ) -> None:
        """Append entry to ring and fan out to all subscriber queues (async-safe)."""
        entry = json.loads(formatted_json)

        # Append to ring buffer
        self._ring.append(entry)

        async with self._lock:
            subs = list(self._subscribers.items())
            for client_id, queue in subs:
                frame = {"type": "log", "data": entry}
                try:
                    queue.put_nowait(frame)
                except asyncio.QueueFull:
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    try:
                        queue.put_nowait(frame)
                    except asyncio.QueueFull:
                        pass
                    self._dropped_counts[client_id] = (
                        self._dropped_counts.get(client_id, 0) + 1
                    )

    # ── Heartbeat ───────────────────────────────────────────────────────────

    async def _heartbeat_loop(self) -> None:
        """Push a heartbeat frame to every subscriber queue every 1.0 seconds.

        This runs as an asyncio task started by start_heartbeat().
        """
        heartbeat_frame = {"type": "heartbeat", "data": None}

        while not self._stop_heartbeat:
            await asyncio.sleep(1.0)

            if self._stop_heartbeat:
                break

            async with self._lock:
                client_ids = list(self._subscribers.keys())

            for client_id in client_ids:
                queue = self._subscribers.get(client_id)
                if queue is None:
                    continue

                try:
                    queue.put_nowait(heartbeat_frame)
                except asyncio.QueueFull:
                    # Heartbeats are low-priority; never evict real logs
                    pass

    def start_heartbeat(self) -> None:
        """Start the 1-second heartbeat task. Idempotent."""
        if self._heartbeat_task is not None and not self._heartbeat_task.done():
            return
        self._stop_heartbeat = False
        try:
            loop = asyncio.get_running_loop()
            self._loop = loop
            self._heartbeat_task = loop.create_task(self._heartbeat_loop())
        except RuntimeError:
            # No running loop yet — start_heartbeat is called during startup
            # when there is no running loop; it will be started properly
            # via an explicit schedule
            pass

    def stop_heartbeat(self) -> None:
        """Cancel the heartbeat task. Idempotent."""
        self._stop_heartbeat = True
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
