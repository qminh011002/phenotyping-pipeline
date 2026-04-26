"""FastAPI exception handlers that map custom exceptions to HTTP responses."""

from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.errors.exceptions import InvalidImageError, InferenceFailedError, ModelNotLoadedError

logger = logging.getLogger(__name__)


def register_exception_handlers(app: FastAPI) -> None:
    """Register all custom exception handlers on the FastAPI app."""

    @app.exception_handler(ModelNotLoadedError)
    async def model_not_loaded_handler(
        request: Request, exc: ModelNotLoadedError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={"detail": str(exc), "code": "MODEL_NOT_LOADED"},
        )

    @app.exception_handler(InvalidImageError)
    async def invalid_image_handler(
        request: Request, exc: InvalidImageError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=400,
            content={"detail": str(exc), "code": "INVALID_IMAGE"},
        )

    @app.exception_handler(InferenceFailedError)
    async def inference_failed_handler(
        request: Request, exc: InferenceFailedError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"detail": str(exc), "code": "INFERENCE_FAILED"},
        )

    # Catch-all so uncaught errors return a consistent JSON shape instead of
    # leaking the default Starlette HTML 500 page.
    @app.exception_handler(Exception)
    async def fallback_handler(request: Request, exc: Exception) -> JSONResponse:
        # Let FastAPI's own handlers process HTTPException — re-raising would
        # bypass them, so return their canonical shape directly.
        if isinstance(exc, HTTPException):
            return JSONResponse(
                status_code=exc.status_code,
                content={"detail": exc.detail},
                headers=exc.headers,
            )
        logger.exception(
            "Unhandled error on %s %s", request.method, request.url.path
        )
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error", "code": "INTERNAL_ERROR"},
        )
