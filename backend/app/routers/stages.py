"""WebSocket endpoint for processing-stage progress events.

Clients connect to ``/ws/stages`` and receive one JSON frame per stage the
backend enters while processing an image:

    {
      "stage": "image.detect",
      "batch_id": "<uuid>",
      "filename": "IMG_1065",
      "organism": "egg"
    }
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.stage_broker import get_broker

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws/stages")
async def ws_stages(ws: WebSocket) -> None:
    broker = get_broker()
    await broker.connect(ws)
    client = f"{ws.client.host}:{ws.client.port}" if ws.client else "unknown"
    logger.info(
        "Stage WS client connected",
        extra={"context": {"event": "stages.ws.connect", "client": client}},
    )
    try:
        while True:
            # We don't expect client→server messages; block on receive to
            # detect disconnects promptly.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.debug("stage ws loop ended: %s", exc)
    finally:
        await broker.disconnect(ws)
        logger.info(
            "Stage WS client disconnected",
            extra={"context": {"event": "stages.ws.disconnect", "client": client}},
        )
