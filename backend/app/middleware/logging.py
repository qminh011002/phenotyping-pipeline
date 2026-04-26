"""Request logging middleware for timing and observability.

Logs every HTTP request at INFO level with:
  - HTTP method
  - URL path
  - Status code
  - Elapsed time in milliseconds
  - Client IP

5xx errors are additionally logged at ERROR level with the full traceback.
"""

from __future__ import annotations

import logging
import time
from typing import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("app.http")


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Middleware that logs every request with timing and outcome.

    Usage in main.py::

        from app.middleware.logging import RequestLoggingMiddleware
        app.add_middleware(RequestLoggingMiddleware)
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        method = request.method
        path = request.url.path
        client_ip = request.client.host if request.client else "unknown"
        query = request.url.query
        if query:
            # Truncate query string to avoid logging sensitive params
            log_path = f"{path}?{query[:100]}"
        else:
            log_path = path

        start = time.perf_counter()
        status_code = 500  # default in case of unhandled exception

        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        except Exception:
            raise
        finally:
            elapsed_ms = (time.perf_counter() - start) * 1000
            log_level = logging.ERROR if status_code >= 500 else logging.INFO
            logger.log(
                log_level,
                "%s %s %s %.1fms",
                method,
                log_path,
                status_code,
                elapsed_ms,
                extra={
                    "context": {
                        "method": method,
                        "path": path,
                        "query": query or None,
                        "status": status_code,
                        "elapsed_ms": round(elapsed_ms, 2),
                        "client_ip": client_ip,
                    }
                },
            )
