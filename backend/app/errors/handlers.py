"""FastAPI exception handlers that map custom exceptions to HTTP responses."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.errors.exceptions import InvalidImageError, InferenceFailedError, ModelNotLoadedError


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
