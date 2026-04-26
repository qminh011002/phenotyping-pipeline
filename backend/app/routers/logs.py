"""GET /logs/recent and WebSocket /logs/stream endpoints.

GET  /logs/recent  — returns recent log entries from the in-memory ring buffer.
WS   /logs/stream  — streams real-time log entries and 1-second heartbeat frames.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from app.deps import get_log_buffer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/logs", tags=["logs"])


@router.get(
    "/recent",
    summary="Get recent log entries from ring buffer",
    responses={
        200: {"description": '{"logs": [...]}'},
    },
)
async def get_recent_logs(
    limit: int = Query(default=200, ge=1, le=1000, description="Max entries to return"),
) -> dict:
    """Return the last N log entries from the ring buffer.

    Entries are returned in chronological order (oldest first).
    The ring buffer holds at most 1000 entries; if limit > 1000 the result
    is capped at the full buffer contents.
    """
    log_buffer = get_log_buffer()
    logs = log_buffer.get_recent(limit=limit)
    return {"logs": logs}


@router.websocket(
    "/stream",
)
async def ws_logs_stream(websocket: WebSocket) -> None:
    """Stream real-time log entries and heartbeat frames over WebSocket.

    On connect:
        1. Subscribe to the LogBuffer — receives a (client_id, queue) pair.
        2. Immediately begin reading from the queue and sending frames.

    Message format (server → client):
        - Log frame:    {"type": "log",       "data": LogEntry}
        - Heartbeat:    {"type": "heartbeat",  "data": None}

    The LogBuffer heartbeat task pushes a heartbeat frame every 1.0 second,
    regardless of whether any logs were emitted. Clients use heartbeats
    to detect dropped connections.

    On disconnect:
        - The subscription is removed from the LogBuffer.
        - The number of dropped messages is logged at DEBUG level.
    """
    await websocket.accept()

    log_buffer = get_log_buffer()
    client_id: str | None = None

    try:
        client_id, queue = await log_buffer.subscribe()

        logger.debug(
            "WS client connected",
            extra={
                "context": {
                    "client_id": client_id,
                    "total_clients": log_buffer.subscriber_count,
                }
            },
        )

        while True:
            # Await the next frame from the queue
            frame = await queue.get()

            try:
                await websocket.send_json(frame)
            except Exception as exc:
                # Client disconnected mid-stream — log cause and clean up.
                logger.debug("logs WS send failed: %s", exc)
                break

    except WebSocketDisconnect:
        # Normal disconnect initiated by the client
        pass
    except Exception as exc:
        logger.exception(
            "WebSocket /logs/stream error",
            extra={"context": {"client_id": client_id, "exception": str(exc)}},
        )
    finally:
        # Always unsubscribe so the queue can be garbage collected
        if client_id is not None:
            dropped = await log_buffer.unsubscribe(client_id)
            logger.debug(
                "WS client disconnected",
                extra={
                    "context": {
                        "client_id": client_id,
                        "dropped_logs": dropped,
                    }
                },
            )
