"""Custom exception classes for domain-specific error handling.

- ModelNotLoadedError: inference attempted before model is ready
- InvalidImageError: upload is corrupt or unsupported format
- InferenceFailedError: inference raised an unexpected exception
"""

from __future__ import annotations


class ModelNotLoadedError(Exception):
    """Raised when inference is attempted before the YOLO model is loaded."""
    pass


class InvalidImageError(Exception):
    """Raised when an uploaded image is corrupt or has an unsupported format."""
    pass


class InferenceFailedError(Exception):
    """Raised when the inference pipeline raises an unexpected exception."""
    pass
