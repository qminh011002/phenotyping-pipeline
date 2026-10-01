"""Custom exception classes for domain-specific error handling.

- ModelNotLoadedError: inference attempted before model is ready
- InvalidImageError: upload is corrupt or unsupported format
- InferenceFailedError: inference raised an unexpected exception
- InferenceCancelledError: the caller went away while inference was running
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


class InferenceCancelledError(Exception):
    """Raised inside the pipeline when the request that asked for it is gone.

    Long steps (SAM refinement runs once per detection) poll a stop flag and
    raise this, so a cancelled run frees the inference worker straight away
    instead of finishing work nobody will read.
    """

    pass
