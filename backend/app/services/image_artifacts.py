"""Derived image files that sit next to an image's overlay PNG.

Two kinds of artifact are managed here:

* **Thumbnails** — small JPEGs for list/grid views. Built on first request and
  cached on disk as ``{stem}_thumb_{variant}_{edge}.jpg``; rebuilt when the
  source file is newer. Grids used to download the full-resolution PNG for
  every card just to shrink it in the browser.
* **Polygon overlays** — for larvae/pupae the ``_overlay.png`` is a render of
  the detections. Polygon edits and SAM refinement change the detections
  without touching the PNG, so they drop a ``.stale`` marker instead and the
  overlay is re-rendered the next time something actually needs it.

All OpenCV work is synchronous; callers run it in a worker thread.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from uuid import UUID

import cv2
import numpy as np
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analysis import AnalysisImage
from app.models.larvae import LarvaeDetection

logger = logging.getLogger(__name__)

THUMBNAIL_EDGES = (160, 320, 640)
_THUMB_JPEG_QUALITY = 80
_PNG_PARAMS = [cv2.IMWRITE_PNG_COMPRESSION, 1]

# Stroke colours match the inference-time overlay and the editor SVG.
POLYGON_COLORS_BGR: dict[str, tuple[int, int, int]] = {
    "larvae": (255, 255, 0),
    "pupae": (0, 255, 255),
}


# ── Paths ─────────────────────────────────────────────────────────────────────


def overlay_stem(overlay_path: Path) -> str:
    return overlay_path.name.removesuffix("_overlay.png")


def raw_path_for(overlay_path: Path) -> Path | None:
    """The uploaded source image written alongside the overlay."""
    candidates = sorted(overlay_path.parent.glob(f"{overlay_stem(overlay_path)}_raw.*"))
    return candidates[0] if candidates else None


def warped_path_for(overlay_path: Path) -> Path:
    return overlay_path.with_name(f"{overlay_stem(overlay_path)}_warped.png")


def thumbnail_path(overlay_path: Path, variant: str, edge: int) -> Path:
    return overlay_path.with_name(
        f"{overlay_stem(overlay_path)}_thumb_{variant}_{edge}.jpg"
    )


def _stale_marker(overlay_path: Path) -> Path:
    return overlay_path.with_name(overlay_path.name + ".stale")


def snap_thumbnail_edge(requested: int) -> int:
    """Clamp a requested size to the supported set (bounds the disk cache)."""
    for edge in THUMBNAIL_EDGES:
        if requested <= edge:
            return edge
    return THUMBNAIL_EDGES[-1]


# ── Thumbnails ────────────────────────────────────────────────────────────────


def _imread(path: Path, flags: int) -> np.ndarray | None:
    # np.fromfile + imdecode instead of cv2.imread: imread can't open
    # non-ASCII paths on Windows.
    try:
        data = np.fromfile(str(path), dtype=np.uint8)
    except OSError:
        return None
    if data.size == 0:
        return None
    return cv2.imdecode(data, flags)


def build_thumbnail(src: Path, dst: Path, edge: int) -> bool:
    """Write a JPEG thumbnail of ``src`` (longest side ≤ ``edge``) to ``dst``."""
    # JPEG sources decode straight to quarter size; if that undershoots the
    # target (small source), fall back to a full decode.
    image = _imread(src, cv2.IMREAD_REDUCED_COLOR_4)
    if image is None or max(image.shape[:2]) < edge:
        image = _imread(src, cv2.IMREAD_COLOR)
    if image is None:
        return False
    h, w = image.shape[:2]
    scale = min(1.0, edge / max(h, w))
    if scale < 1.0:
        image = cv2.resize(
            image,
            (max(1, round(w * scale)), max(1, round(h * scale))),
            interpolation=cv2.INTER_AREA,
        )
    ok, buf = cv2.imencode(
        ".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, _THUMB_JPEG_QUALITY]
    )
    if not ok:
        return False
    # Write-then-rename so a concurrent reader never sees a half-written file.
    tmp = dst.with_name(f"{dst.name}.{os.getpid()}.tmp")
    try:
        tmp.write_bytes(buf.tobytes())
        tmp.replace(dst)
    except OSError:
        tmp.unlink(missing_ok=True)
        return False
    return True


def ensure_thumbnail(src: Path, dst: Path, edge: int) -> bool:
    """Build ``dst`` unless a thumbnail at least as new as ``src`` exists."""
    try:
        if dst.exists() and dst.stat().st_mtime_ns >= src.stat().st_mtime_ns:
            return True
    except OSError:
        return False
    return build_thumbnail(src, dst, edge)


def clear_thumbnails(overlay_path: Path, variant: str | None = None) -> None:
    pattern = f"{overlay_stem(overlay_path)}_thumb_{variant or '*'}_*.jpg"
    for thumb in overlay_path.parent.glob(pattern):
        thumb.unlink(missing_ok=True)


# ── Polygon overlay freshness ─────────────────────────────────────────────────


def mark_overlay_stale(overlay_path: Path) -> None:
    """Record that the detections changed after the overlay was rendered."""
    try:
        _stale_marker(overlay_path).touch()
    except OSError as exc:
        logger.warning("Could not mark overlay stale: %s", exc)


def is_overlay_stale(overlay_path: Path) -> bool:
    return _stale_marker(overlay_path).exists()


def mark_overlay_rendered(overlay_path: Path) -> None:
    """The overlay was just redrawn from current detections by the caller."""
    _stale_marker(overlay_path).unlink(missing_ok=True)
    clear_thumbnails(overlay_path)


def render_polygon_overlay(
    overlay_path: Path,
    polygons: list[np.ndarray],
    color_bgr: tuple[int, int, int],
) -> bool:
    """Draw ``polygons`` on the image's clean base frame and write the overlay.

    The base is the warped frame when one exists (polygons are stored in its
    coordinates), otherwise the raw upload.
    """
    warped = warped_path_for(overlay_path)
    base = warped if warped.exists() else raw_path_for(overlay_path)
    if base is None:
        return False
    canvas = _imread(base, cv2.IMREAD_COLOR)
    if canvas is None:
        return False
    if polygons:
        cv2.polylines(canvas, polygons, True, color_bgr, 2)
    if not cv2.imwrite(str(overlay_path), canvas, _PNG_PARAMS):
        return False
    _stale_marker(overlay_path).unlink(missing_ok=True)
    clear_thumbnails(overlay_path, "overlay")
    return True


async def ensure_polygon_overlay_fresh(
    image_id: UUID,
    overlay_path: Path,
    organism: str,
    db: AsyncSession,
) -> None:
    """Re-render the overlay from the current detections if it is stale."""
    if not is_overlay_stale(overlay_path):
        return
    rows = await db.execute(
        select(LarvaeDetection.polygon, LarvaeDetection.edited_polygon).where(
            LarvaeDetection.image_id == image_id
        )
    )
    polygons = [
        np.array(edited or polygon, dtype=np.int32).reshape(-1, 1, 2)
        for polygon, edited in rows
    ]
    color = POLYGON_COLORS_BGR.get(organism, POLYGON_COLORS_BGR["larvae"])
    ok = await asyncio.to_thread(render_polygon_overlay, overlay_path, polygons, color)
    if not ok:
        logger.warning(
            "Overlay re-render skipped — base image unreadable",
            extra={"context": {"image_id": str(image_id)}},
        )


def resolve_overlay_file(image: AnalysisImage, storage_dir: Path) -> Path | None:
    """Absolute overlay path for an image row, or None when it has no result."""
    if not image.overlay_path:
        return None
    path = Path(image.overlay_path)
    return path if path.is_absolute() else storage_dir / path
