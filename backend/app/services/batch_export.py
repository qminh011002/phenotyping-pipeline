"""Build a ZIP archive of a batch's overlay images + an .xlsx summary.

The archive is streamed back to the client so we never hold the whole zip in
memory at once. Per-image inclusion is decided by the caller (the download
dialog sends the subset of image IDs the user ticked).

Current image source: overlay PNG (written to disk at inference time). Once
we have a persisted, edited overlay per image we'll switch this to whichever
is newest — but for now the overlay is the only rendered output on disk.

Summary columns reflect the *edited* count/average confidence when the
operator has saved edits, otherwise the model's output. This matches the
numbers the operator sees in the ResultViewer.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from collections.abc import AsyncIterator, Iterable
from pathlib import Path
from uuid import UUID

from openpyxl import Workbook
from openpyxl.styles import (
    Alignment,
    Border,
    Font,
    PatternFill,
    Side,
)
from openpyxl.utils import get_column_letter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analysis import AnalysisBatch, AnalysisImage

logger = logging.getLogger(__name__)

# Excel styling — a calm, "corporate report" look: dark header with white
# bold text, zebra-striped body, thin borders, auto-sized columns.
_HEADER_FILL = PatternFill("solid", fgColor="1F2937")  # slate-800
_HEADER_FONT = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
_TITLE_FONT = Font(name="Calibri", size=16, bold=True, color="111827")
_META_FONT = Font(name="Calibri", size=10, color="4B5563")  # slate-600
_ZEBRA_FILL = PatternFill("solid", fgColor="F8FAFC")  # slate-50
_BORDER = Border(
    left=Side(style="thin", color="E5E7EB"),
    right=Side(style="thin", color="E5E7EB"),
    top=Side(style="thin", color="E5E7EB"),
    bottom=Side(style="thin", color="E5E7EB"),
)
_SUMMARY_HEADERS = [
    "#",
    "Filename",
    "Count",
    "Avg confidence",
    "Elapsed (s)",
    "Edited",
]
# Columns are typed so numeric formats render correctly in Excel.
_NUMERIC_FORMATS = {
    3: "#,##0",          # Count
    4: "0.0%",           # Avg confidence
    5: "0.00",           # Elapsed seconds
}


def _slugify(value: str) -> str:
    """Filesystem-safe filename slug. Keeps letters/digits/.-_ and collapses
    everything else to '_'."""
    clean = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._")
    return clean or "batch"


def _effective_stats(image: AnalysisImage) -> tuple[int, float | None, bool]:
    """Return (count, avg_confidence, edited).

    When `edited_annotations` is populated, the counts reflect the operator's
    edits; otherwise we fall back to the stored model totals. User-drawn boxes
    may not carry a meaningful confidence — they're excluded from the average
    but included in the count, matching how the ResultViewer's StatBoard
    behaves.
    """
    edited = image.edited_annotations
    if isinstance(edited, list) and len(edited) > 0:
        count = len(edited)
        confidences: list[float] = []
        for box in edited:
            if not isinstance(box, dict):
                continue
            origin = box.get("origin", "model")
            if origin == "user":
                continue
            conf = box.get("confidence")
            if isinstance(conf, (int, float)):
                confidences.append(float(conf))
        avg = sum(confidences) / len(confidences) if confidences else None
        return count, avg, True

    # No edits — fall back to the stored aggregates.
    return (image.count or 0, image.avg_confidence, False)


def _style_summary_sheet(
    ws,
    batch: AnalysisBatch,
    rows: list[tuple[int, str, int, float | None, float | None, bool]],
) -> None:
    """Write a formatted summary sheet: batch header → meta → table."""
    # Title row
    ws["A1"] = batch.name or "Untitled batch"
    ws["A1"].font = _TITLE_FONT
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(_SUMMARY_HEADERS))
    ws.row_dimensions[1].height = 24

    # Meta rows (organism / device / mode / totals)
    meta_pairs = [
        ("Organism", (batch.organism_type or "").capitalize()),
        ("Device", (batch.device or "").upper()),
        ("Mode", (batch.mode or "").capitalize()),
        ("Images exported", len(rows)),
        ("Total count", batch.total_count if batch.total_count is not None else "—"),
        (
            "Avg confidence",
            f"{batch.avg_confidence * 100:.1f}%"
            if batch.avg_confidence is not None
            else "—",
        ),
    ]
    for i, (label, value) in enumerate(meta_pairs, start=2):
        ws.cell(row=i, column=1, value=label).font = Font(
            name="Calibri", size=10, bold=True, color="4B5563"
        )
        ws.cell(row=i, column=2, value=value).font = _META_FONT

    # Blank spacer row, then the table header
    header_row = 2 + len(meta_pairs) + 1
    for col, label in enumerate(_SUMMARY_HEADERS, start=1):
        cell = ws.cell(row=header_row, column=col, value=label)
        cell.fill = _HEADER_FILL
        cell.font = _HEADER_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = _BORDER
    ws.row_dimensions[header_row].height = 22

    # Body rows
    data_start = header_row + 1
    for i, (idx, filename, count, avg_conf, elapsed, edited) in enumerate(rows):
        r = data_start + i
        zebra = i % 2 == 1

        values = [
            idx,
            filename,
            count,
            avg_conf,  # may be None
            elapsed,   # may be None
            "Yes" if edited else "No",
        ]
        for col, value in enumerate(values, start=1):
            cell = ws.cell(row=r, column=col, value=value)
            cell.border = _BORDER
            if zebra:
                cell.fill = _ZEBRA_FILL
            if col == 1:
                cell.alignment = Alignment(horizontal="center")
            elif col == 2:
                cell.alignment = Alignment(horizontal="left")
                cell.font = Font(name="Consolas", size=10)
            else:
                cell.alignment = Alignment(horizontal="right")
            fmt = _NUMERIC_FORMATS.get(col)
            if fmt is not None:
                cell.number_format = fmt

    # Column widths — big enough for typical filenames, compact elsewhere.
    widths = {1: 5, 2: 42, 3: 10, 4: 16, 5: 14, 6: 10}
    for col, w in widths.items():
        ws.column_dimensions[get_column_letter(col)].width = w

    # Freeze the title/meta + header so scrolling keeps them visible.
    ws.freeze_panes = ws.cell(row=data_start, column=1)


def _build_xlsx(
    batch: AnalysisBatch, images: Iterable[AnalysisImage]
) -> bytes:
    """Render the styled summary workbook to an in-memory bytes buffer."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"

    rows: list[tuple[int, str, int, float | None, float | None, bool]] = []
    for idx, img in enumerate(images, start=1):
        count, avg_conf, edited = _effective_stats(img)
        rows.append(
            (idx, img.original_filename, count, avg_conf, img.elapsed_secs, edited)
        )

    _style_summary_sheet(ws, batch, rows)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _resolve_overlay_path(overlay_path: str, storage_dir: Path) -> Path:
    p = Path(overlay_path)
    if not p.is_absolute():
        p = storage_dir / p
    return p


async def build_batch_archive(
    batch_id: UUID,
    image_ids: list[UUID] | None,
    db: AsyncSession,
    storage_dir: Path,
) -> tuple[str, bytes] | None:
    """Build the ZIP archive for a batch.

    Returns (filename, bytes) or None if the batch doesn't exist. Raises
    ValueError if `image_ids` is provided but none of them belong to the batch.

    The whole archive is built in-memory. Typical batches are tens of images
    × a few MB each so this is fine; if we later ship batches in the hundreds
    of MB we should stream it through a SpooledTemporaryFile instead.
    """
    batch_stmt = select(AnalysisBatch).where(AnalysisBatch.id == batch_id)
    batch = (await db.execute(batch_stmt)).scalar_one_or_none()
    if batch is None:
        return None

    img_stmt = (
        select(AnalysisImage)
        .where(AnalysisImage.batch_id == batch_id)
        .where(AnalysisImage.status == "completed")
        .order_by(AnalysisImage.created_at)
    )
    if image_ids:
        img_stmt = img_stmt.where(AnalysisImage.id.in_(image_ids))

    images: list[AnalysisImage] = list((await db.execute(img_stmt)).scalars().all())
    if not images:
        raise ValueError(
            "No completed images match the requested selection for this batch."
        )

    zip_buf = io.BytesIO()
    # ZIP_STORED — overlay PNGs are already compressed, and storing avoids a
    # needless zlib pass on every write.
    with zipfile.ZipFile(zip_buf, mode="w", compression=zipfile.ZIP_STORED) as zf:
        # Write images/*
        seen_names: set[str] = set()
        for img in images:
            if not img.overlay_path:
                continue
            src = _resolve_overlay_path(img.overlay_path, storage_dir)
            if not src.exists():
                logger.warning(
                    "Skipping missing overlay during export",
                    extra={
                        "context": {
                            "batch_id": str(batch_id),
                            "image_id": str(img.id),
                            "path": str(src),
                        }
                    },
                )
                continue

            # Name the file after the uploaded original filename, swapping in
            # the overlay's extension (PNG) so the archive makes sense to a
            # human. Disambiguate duplicates with a numeric suffix.
            stem = Path(img.original_filename).stem
            candidate = f"{stem}{src.suffix.lower() or '.png'}"
            n = 1
            while candidate in seen_names:
                candidate = f"{stem}_{n}{src.suffix.lower() or '.png'}"
                n += 1
            seen_names.add(candidate)
            zf.write(src, arcname=f"images/{candidate}")

        # Write summary.xlsx (compressed — xlsx is XML inside, benefits from
        # deflate even though the container is already ZIP).
        xlsx_bytes = _build_xlsx(batch, images)
        xlsx_info = zipfile.ZipInfo("summary.xlsx")
        xlsx_info.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(xlsx_info, xlsx_bytes)

    filename = f"{_slugify(batch.name or 'batch')}.zip"
    return filename, zip_buf.getvalue()


async def stream_batch_archive(
    batch_id: UUID,
    image_ids: list[UUID] | None,
    db: AsyncSession,
    storage_dir: Path,
    chunk_size: int = 64 * 1024,
) -> tuple[str, AsyncIterator[bytes]] | None:
    """Wrapper that yields the archive bytes in chunks for StreamingResponse."""
    built = await build_batch_archive(
        batch_id=batch_id, image_ids=image_ids, db=db, storage_dir=storage_dir
    )
    if built is None:
        return None
    filename, payload = built

    async def _iter() -> AsyncIterator[bytes]:
        for start in range(0, len(payload), chunk_size):
            yield payload[start : start + chunk_size]

    return filename, _iter()
