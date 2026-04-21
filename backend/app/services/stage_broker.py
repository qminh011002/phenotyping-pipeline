"""Dedicated broker for processing-stage events.

Separate from the logs WebSocket: this channel carries ONLY stage progress
events, broadcast to every connected client. Thread-safe — inference workers
(which run in a ThreadPoolExecutor) can call ``emit_stage`` directly; the
broker bridges into the asyncio event loop via a loop captured at startup.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class StageBroker:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Capture the main event loop so worker threads can schedule emits."""
        self._loop = loop

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            clients = list(self._clients)
        dead: list[WebSocket] = []
        for ws in clients:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)

    def emit_stage(
        self, stage: str, batch_id: str, filename: str, organism: str = "egg"
    ) -> None:
        """Thread-safe stage emission. Safe to call from any thread."""
        payload: dict[str, Any] = {
            "stage": stage,
            "batch_id": batch_id,
            "filename": filename,
            "organism": organism,
        }
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast(payload), loop)
        except RuntimeError:
            pass


_broker: StageBroker | None = None


def get_broker() -> StageBroker:
    global _broker
    if _broker is None:
        _broker = StageBroker()
    return _broker


def emit_stage(stage: str, batch_id: str, filename: str, organism: str = "egg") -> None:
    """Module-level convenience wrapper around the singleton broker."""
    get_broker().emit_stage(stage, batch_id, filename, organism)
