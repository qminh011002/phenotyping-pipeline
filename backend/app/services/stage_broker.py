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
        results = await asyncio.gather(
            *(ws.send_json(payload) for ws in clients),
            return_exceptions=True,
        )
        dead = [ws for ws, r in zip(clients, results) if isinstance(r, Exception)]
        for ws, r in zip(clients, results):
            if isinstance(r, Exception):
                logger.debug("stage broadcast failed: %s", r)
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
            fut = asyncio.run_coroutine_threadsafe(self._broadcast(payload), loop)
            fut.add_done_callback(
                lambda f: f.exception() and logger.debug("stage emit failed: %s", f.exception())
            )
        except RuntimeError:
            pass


_broker: StageBroker = StageBroker()


def get_broker() -> StageBroker:
    return _broker


def emit_stage(stage: str, batch_id: str, filename: str, organism: str = "egg") -> None:
    """Module-level convenience wrapper around the singleton broker."""
    get_broker().emit_stage(stage, batch_id, filename, organism)
