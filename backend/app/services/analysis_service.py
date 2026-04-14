"""Analysis persistence service — CRUD operations for analysis batches and images.

Persists inference results from EggInferenceService to PostgreSQL.
Stores only URL/path references to overlay images saved on disk by the inference service.
"""

from __future__ import annotations

import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.analysis import AnalysisBatch, AnalysisImage
from app.schemas.analysis import (
    AnalysisBatchCreate,
    AnalysisBatchDetail,
    AnalysisBatchSummary,
    AnalysisImageResult,
    AnalysisImageSummary,
    AnalysisListResponse,
    DashboardStats,
)

if TYPE_CHECKING:
    from app.deps import AppSettings

logger = logging.getLogger(__name__)

# Number of recent analyses to include in dashboard stats
_RECENT_COUNT = 5


class AnalysisService:
    """CRUD service for analysis batches and images.

    All methods are async and accept an ``AsyncSession`` from the database
    dependency. Overlay images on disk are never stored in the database — only
    their path/URL references are persisted.
    """

    # ── Batch lifecycle ────────────────────────────────────────────────────────

    async def create_batch(
        self,
        data: AnalysisBatchCreate,
        db: AsyncSession,
    ) -> AnalysisBatch:
        """Insert a new analysis batch row with status 'processing'.

        A batch represents one "Process Images" action by the operator.
        The batch is created before any images are processed.
        """
        batch = AnalysisBatch(
            status="processing",
            organism_type=data.organism_type,
            mode=data.mode,
            device=data.device,
            config_snapshot=data.config_snapshot,
            total_image_count=data.total_image_count,
        )
        db.add(batch)
        await db.flush()
        await db.refresh(batch)
        logger.info(
            "Analysis batch created",
            extra={
                "context": {
                    "batch_id": str(batch.id),
                    "organism_type": data.organism_type,
                    "total_image_count": data.total_image_count,
                }
            },
        )
        return batch

    async def add_image_result(
        self,
        batch_id: UUID,
        result: AnalysisImageResult,
        db: AsyncSession,
    ) -> AnalysisImage:
        """Record a single image's inference result into the database.

        The overlay image is already saved to disk by EggInferenceService at:
            {image_storage_dir}/{batch_id}/{filename}_overlay.png

        We store the RELATIVE filesystem path as overlay_path (not the API overlay_url).
        The overlay_url points to /inference/results/{batch_id}/{filename}/overlay.png which
        the overlay router uses to serve the file from the same storage directory.
        """
        # The detection result's overlay_url is the API path like
        # "/inference/results/{batch_id}/{filename}/overlay.png".
        # We need to store the filesystem path {batch_id}/{filename}_overlay.png
        # in overlay_path so the analyses router can resolve it correctly.
        overlay_path_value: str | None = None
        if result.overlay_url:
            # Parse the API overlay_url to extract the filesystem path.
            # overlay_url format: "/inference/results/{batch_id}/{filename}/overlay.png"
            # filesystem format:   "{batch_id}/{filename}_overlay.png"
            url = result.overlay_url.rstrip("/")
            if url.startswith("/inference/results/"):
                suffix = url.removeprefix("/inference/results/")  # "{batch_id}/{filename}/overlay.png"
                # Drop the "/overlay.png" suffix and add "_overlay.png"
                if suffix.endswith("/overlay.png"):
                    overlay_path_value = suffix.removesuffix("/overlay.png") + "_overlay.png"

        image = AnalysisImage(
            batch_id=batch_id,
            original_filename=result.filename,
            original_width=result.original_width,
            original_height=result.original_height,
            file_size_bytes=result.file_size_bytes,
            status="completed",
            count=result.count,
            avg_confidence=result.avg_confidence,
            elapsed_secs=result.elapsed_seconds,
            annotations=result.annotations,
            overlay_path=overlay_path_value,
        )
        db.add(image)
        await db.flush()
        await db.refresh(image)
        return image

    async def complete_batch(
        self,
        batch_id: UUID,
        db: AsyncSession,
    ) -> AnalysisBatch:
        """Mark a batch as completed and compute aggregate statistics.

        Aggregates are computed from all child AnalysisImage rows that have
        status='completed'. Images with status='failed' are excluded from
        aggregates but counted in total_image_count.
        """
        stmt = (
            select(
                func.count(AnalysisImage.id).label("n"),
                func.coalesce(func.sum(AnalysisImage.count), 0).label("total_count"),
                func.coalesce(func.avg(AnalysisImage.avg_confidence), 0).label("avg_conf"),
                func.coalesce(func.sum(AnalysisImage.elapsed_secs), 0).label("total_elapsed"),
            )
            .where(AnalysisImage.batch_id == batch_id)
            .where(AnalysisImage.status == "completed")
        )
        result = await db.execute(stmt)
        row = result.one()

        stmt_batch = select(AnalysisBatch).where(AnalysisBatch.id == batch_id)
        batch_result = await db.execute(stmt_batch)
        batch = batch_result.scalar_one()

        batch.status = "completed"
        batch.completed_at = datetime.now(timezone.utc)
        batch.total_count = int(row.total_count)
        batch.avg_confidence = float(row.avg_conf) if row.n > 0 else None
        batch.total_elapsed_secs = float(row.total_elapsed)

        await db.flush()
        await db.refresh(batch)
        logger.info(
            "Analysis batch completed",
            extra={
                "context": {
                    "batch_id": str(batch_id),
                    "total_count": batch.total_count,
                    "avg_confidence": batch.avg_confidence,
                    "total_elapsed_secs": batch.total_elapsed_secs,
                }
            },
        )
        return batch

    async def fail_batch(
        self,
        batch_id: UUID,
        error: str,
        db: AsyncSession,
    ) -> AnalysisBatch:
        """Mark a batch as failed with an error message."""
        stmt = select(AnalysisBatch).where(AnalysisBatch.id == batch_id)
        result = await db.execute(stmt)
        batch = result.scalar_one()
        batch.status = "failed"
        batch.completed_at = datetime.now(timezone.utc)
        batch.notes = f"Batch failed: {error}"
        await db.flush()
        await db.refresh(batch)
        logger.warning(
            "Analysis batch failed",
            extra={
                "context": {
                    "batch_id": str(batch_id),
                    "error": error,
                }
            },
        )
        return batch

    # ── Query ──────────────────────────────────────────────────────────────────

    async def list_batches(
        self,
        page: int,
        page_size: int,
        search: str | None,
        organism: str | None,
        db: AsyncSession,
    ) -> AnalysisListResponse:
        """Return a paginated list of analysis batches.

        Args:
            page: 1-indexed page number.
            page_size: Number of items per page.
            search: Optional filename fragment (ILIKE on image filenames).
            organism: Optional organism type filter.
        """
        # Base count query
        count_stmt = select(func.count(AnalysisBatch.id))

        # Base batch query with eager-loaded images
        batch_stmt = (
            select(AnalysisBatch)
            .options(selectinload(AnalysisBatch.images))
            .order_by(AnalysisBatch.created_at.desc())
        )

        if organism:
            count_stmt = count_stmt.where(AnalysisBatch.organism_type == organism)
            batch_stmt = batch_stmt.where(AnalysisBatch.organism_type == organism)

        if search:
            # Filter batches whose images contain the search string
            search_pattern = f"%{search}%"
            count_stmt = count_stmt.join(
                AnalysisImage, AnalysisImage.batch_id == AnalysisBatch.id
            ).where(AnalysisImage.original_filename.ilike(search_pattern))
            batch_stmt = batch_stmt.join(
                AnalysisImage, AnalysisImage.batch_id == AnalysisBatch.id
            ).where(AnalysisImage.original_filename.ilike(search_pattern))

        # Execute count
        count_result = await db.execute(count_stmt)
        total = count_result.scalar() or 0

        # Execute paginated batch query
        offset = (page - 1) * page_size
        batch_stmt = batch_stmt.offset(offset).limit(page_size)
        batch_result = await db.execute(batch_stmt)
        batches = list(batch_result.scalars().unique().all())

        items = [self._to_summary(b) for b in batches]
        return AnalysisListResponse(
            items=items,
            total=total,
            page=page,
            page_size=page_size,
        )

    async def get_batch_detail(
        self,
        batch_id: UUID,
        db: AsyncSession,
    ) -> AnalysisBatchDetail | None:
        """Return full batch detail including all images."""
        stmt = (
            select(AnalysisBatch)
            .options(selectinload(AnalysisBatch.images))
            .where(AnalysisBatch.id == batch_id)
        )
        result = await db.execute(stmt)
        batch = result.scalar_one_or_none()
        if batch is None:
            return None

        image_summaries = [
            AnalysisImageSummary(
                id=img.id,
                original_filename=img.original_filename,
                status=img.status,
                count=img.count,
                avg_confidence=img.avg_confidence,
                elapsed_secs=img.elapsed_secs,
                overlay_path=img.overlay_path,
                error_message=img.error_message,
                created_at=img.created_at,
            )
            for img in sorted(batch.images, key=lambda i: i.created_at)
        ]

        return AnalysisBatchDetail(
            id=batch.id,
            created_at=batch.created_at,
            completed_at=batch.completed_at,
            status=batch.status,
            organism_type=batch.organism_type,
            mode=batch.mode,
            device=batch.device,
            total_image_count=batch.total_image_count,
            total_count=batch.total_count,
            avg_confidence=batch.avg_confidence,
            total_elapsed_secs=batch.total_elapsed_secs,
            config_snapshot=batch.config_snapshot or {},
            notes=batch.notes,
            images=image_summaries,
        )

    # ── Delete ────────────────────────────────────────────────────────────────

    async def delete_batch(
        self,
        batch_id: UUID,
        db: AsyncSession,
        storage_dir: Path,
    ) -> bool:
        """Delete a batch, its images, and all associated overlay files on disk.

        Returns True if a batch was deleted, False if it didn't exist.
        """
        stmt = (
            select(AnalysisBatch)
            .options(selectinload(AnalysisBatch.images))
            .where(AnalysisBatch.id == batch_id)
        )
        result = await db.execute(stmt)
        batch = result.scalar_one_or_none()
        if batch is None:
            return False

        # Collect overlay file paths from disk
        overlay_files: list[Path] = []
        for img in batch.images:
            if img.overlay_path:
                # overlay_path may be an absolute path or relative to storage_dir
                p = Path(img.overlay_path)
                if not p.is_absolute():
                    p = storage_dir / p
                overlay_files.append(p)

        # Delete DB rows (cascade handles images relationship)
        await db.delete(batch)
        await db.flush()

        # Delete overlay files from disk
        for p in overlay_files:
            try:
                if p.exists():
                    p.unlink()
            except OSError as exc:
                logger.warning(
                    "Failed to delete overlay file: %s (%s)",
                    p,
                    exc,
                    extra={"context": {"overlay_path": str(p), "exception": str(exc)}},
                )

        # Also clean up the batch directory if it exists
        batch_dir = storage_dir / str(batch_id)
        try:
            if batch_dir.exists():
                shutil.rmtree(batch_dir)
        except OSError as exc:
            logger.warning(
                "Failed to delete batch directory: %s (%s)",
                batch_dir,
                exc,
                extra={"context": {"batch_dir": str(batch_dir), "exception": str(exc)}},
            )

        logger.info(
            "Analysis batch deleted",
            extra={"context": {"batch_id": str(batch_id), "overlay_files_deleted": len(overlay_files)}},
        )
        return True

    # ── Dashboard ─────────────────────────────────────────────────────────────

    async def get_dashboard_stats(self, db: AsyncSession) -> DashboardStats:
        """Return aggregate statistics for the home dashboard."""
        # Count total completed analyses
        count_stmt = select(func.count(AnalysisBatch.id)).where(
            AnalysisBatch.status == "completed"
        )
        count_result = await db.execute(count_stmt)
        total_analyses = count_result.scalar() or 0

        # Aggregate image-level stats
        agg_stmt = select(
            func.count(AnalysisImage.id).label("total_images"),
            func.coalesce(func.sum(AnalysisImage.count), 0).label("total_eggs"),
            func.coalesce(func.avg(AnalysisImage.avg_confidence), 0).label("avg_conf"),
            func.coalesce(func.avg(AnalysisImage.elapsed_secs), 0).label("avg_time"),
        ).where(AnalysisImage.status == "completed")
        agg_result = await db.execute(agg_stmt)
        agg_row = agg_result.one()

        # Recent analyses
        recent_stmt = (
            select(AnalysisBatch)
            .order_by(AnalysisBatch.created_at.desc())
            .limit(_RECENT_COUNT)
        )
        recent_result = await db.execute(recent_stmt)
        recent_batches = list(recent_result.scalars().all())

        return DashboardStats(
            total_analyses=total_analyses,
            total_images_processed=int(agg_row.total_images),
            total_eggs_counted=int(agg_row.total_eggs),
            avg_confidence=(
                float(agg_row.avg_conf) if agg_row.total_images > 0 else None
            ),
            avg_processing_time=(
                float(agg_row.avg_time) if agg_row.total_images > 0 else None
            ),
            recent_analyses=[self._to_summary(b) for b in recent_batches],
        )

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _to_summary(self, batch: AnalysisBatch) -> AnalysisBatchSummary:
        return AnalysisBatchSummary(
            id=batch.id,
            created_at=batch.created_at,
            completed_at=batch.completed_at,
            status=batch.status,
            organism_type=batch.organism_type,
            mode=batch.mode,
            device=batch.device,
            total_image_count=batch.total_image_count,
            total_count=batch.total_count,
            avg_confidence=batch.avg_confidence,
            total_elapsed_secs=batch.total_elapsed_secs,
        )
