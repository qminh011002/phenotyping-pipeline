"""Analysis persistence service — CRUD operations for analysis batches and images.

Persists inference results from EggInferenceService to PostgreSQL.
Stores only URL/path references to overlay images saved on disk by the inference service.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer, selectinload

from app.models.analysis import AnalysisBatch, AnalysisImage
from app.schemas.analysis import (
    ActiveBatchResponse,
    AnalysisBatchAppend,
    AnalysisBatchCreate,
    AnalysisBatchDetail,
    AnalysisBatchSummary,
    AnalysisBatchUpdate,
    AnalysisImageDetail,
    AnalysisImageResult,
    AnalysisImageSummary,
    AnalysisListResponse,
    DashboardStats,
    EditedAnnotationsUpdate,
)

logger = logging.getLogger(__name__)

# Number of recent analyses to include in dashboard stats
_RECENT_COUNT = 5

# Marker prefix for auto-generated default names. Matching this prefix lets
# add_image_result know a batch still has its auto-name and can be upgraded to
# a file-stem-based name once the first (and only) image lands.
_DEFAULT_NAME_PREFIX = "Batch of "

# Zombie-batch auto-fail threshold
_ZOMBIE_TIMEOUT = timedelta(hours=24)

_POLYGON_ORGANISMS = frozenset({"larvae", "pupae"})

# config_snapshot keys that exist only while an append run is in flight.
# ``_resume_status`` is the status the batch returns to when the run ends
# (or is cancelled); ``_processing_started_at`` anchors the zombie timeout to
# the append rather than to the batch's original creation time.
_RESUME_STATUS_KEY = "_resume_status"
_ACTIVE_SINCE_KEY = "_processing_started_at"


def _batch_images_light():
    """Loader option: batch images without their annotation JSONB payloads."""
    return selectinload(AnalysisBatch.images).options(
        defer(AnalysisImage.annotations, raiseload=True),
        defer(AnalysisImage.edited_annotations, raiseload=True),
    )


def _default_batch_name_for_count(total_image_count: int, created_at: datetime) -> str:
    """Timestamped default used at batch-create time for any N (including 1).

    For N==1 this is only a placeholder; add_image_result replaces it with the
    file stem once the first image record is persisted.
    """
    stamp = created_at.strftime("%Y-%m-%d %H:%M")
    return f"{_DEFAULT_NAME_PREFIX}{total_image_count} — {stamp}"


def default_batch_name(images: list[AnalysisImage], created_at: datetime) -> str:
    """Pure default-name generator reusable from create, complete, and migration backfill.

    - 1 image: filename stem of the sole image.
    - Otherwise: "Batch of N — YYYY-MM-DD HH:mm" from ``created_at``.
    """
    if len(images) == 1 and images[0].original_filename:
        return Path(images[0].original_filename).stem
    return _default_batch_name_for_count(len(images), created_at)


class AnalysisService:
    """CRUD service for analysis batches and images.

    All methods are async and accept an ``AsyncSession`` from the database
    dependency. Overlay images on disk are never stored in the database — only
    their path/URL references are persisted.
    """

    # ── Model snapshot helpers ─────────────────────────────────────────────────

    async def _lookup_detection_model_name(
        self, db: AsyncSession, organism: str
    ) -> str | None:
        """Return the active detection model filename for ``organism``.

        Used to snapshot which YOLO weights ran a batch so the result viewer
        shows the historical model rather than whatever is active now.
        """
        from app.deps import get_model_upload_service

        try:
            svc = get_model_upload_service()
            raw = await svc.get_assignments(db)
            entry = raw.get(organism)
            if entry is None:
                return None
            # ``model_filename`` resolves to custom > default > None.
            return entry.get("model_filename")
        except RuntimeError:
            # Service not initialised (e.g. test context).
            return None

    def _lookup_sam_model_name(self, organism: str) -> str | None:
        """Return the active SAM filename from the pipeline config."""
        from app.deps import get_pipeline_config

        try:
            cfg_mgr = get_pipeline_config()
            cfg = (
                cfg_mgr.get_pupae_config()
                if organism == "pupae"
                else cfg_mgr.get_larvae_config()
            )
            return cfg.sam.model
        except RuntimeError:
            return None

    def _parse_polygon_annotations(
        self,
        organism: str,
        annotations: list[dict],
        image_id: UUID,
    ) -> list[object]:
        """Validate polygon annotations for larvae/pupae persistence."""
        from app.schemas.larvae import LarvaeAnnotation
        from app.schemas.pupae import PupaeAnnotation

        ann_cls = PupaeAnnotation if organism == "pupae" else LarvaeAnnotation
        parsed: list[object] = []
        for ann in annotations:
            try:
                parsed.append(ann_cls.model_validate(ann))
            except Exception:  # noqa: BLE001 — log + skip individual bad rows
                logger.warning(
                    "Skipping malformed %s annotation",
                    organism,
                    extra={"context": {"image_id": str(image_id)}},
                )
        return parsed

    # ── Batch lifecycle ────────────────────────────────────────────────────────

    async def create_batch(
        self,
        data: AnalysisBatchCreate,
        db: AsyncSession,
        user_id: UUID,
    ) -> AnalysisBatch:
        """Insert a new analysis batch row with status 'processing'.

        A batch represents one "Process Images" action by the operator.
        The batch is created before any images are processed.
        """
        now = datetime.now(timezone.utc)
        if data.name is not None and data.name.strip():
            name = data.name.strip()[:200]
        else:
            # Placeholder default. For N==1 this is overwritten by
            # add_image_result once the file lands. For N>1 it's the final name
            # unless the operator renames.
            name = _default_batch_name_for_count(data.total_image_count, now)

        # Snapshot the model names that will be used to process this batch so
        # the result viewer can show the historical (not current) selection.
        snapshot = dict(data.config_snapshot or {})
        try:
            snapshot.setdefault(
                "detection_model",
                await self._lookup_detection_model_name(db, data.organism_type),
            )
        except Exception as exc:  # noqa: BLE001 — best-effort snapshot
            logger.debug("Could not snapshot detection_model: %s", exc)
        if data.organism_type in _POLYGON_ORGANISMS:
            try:
                snapshot.setdefault(
                    "sam_model", self._lookup_sam_model_name(data.organism_type)
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("Could not snapshot sam_model: %s", exc)

        batch = AnalysisBatch(
            name=name,
            user_id=user_id,
            status="processing",
            organism_type=data.organism_type,
            mode=data.mode,
            device=data.device,
            config_snapshot=snapshot,
            classes=list(data.classes),
            total_image_count=data.total_image_count,
            created_at=now,
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
        user_id: UUID,
    ) -> AnalysisImage | None:
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
                suffix = url.removeprefix(
                    "/inference/results/"
                )  # "{batch_id}/{filename}/overlay.png"
                # Drop the "/overlay.png" suffix and add "_overlay.png"
                if suffix.endswith("/overlay.png"):
                    overlay_path_value = (
                        suffix.removesuffix("/overlay.png") + "_overlay.png"
                    )

        # Verify the batch belongs to the user before inserting the image row.
        batch_stmt = (
            select(AnalysisBatch)
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
        batch_row = (await db.execute(batch_stmt)).scalar_one_or_none()
        if batch_row is None:
            return None

        image = AnalysisImage(
            batch_id=batch_id,
            original_filename=result.filename,
            status="completed",
            count=result.count,
            avg_confidence=result.avg_confidence,
            elapsed_secs=result.elapsed_seconds,
            overlay_path=overlay_path_value,
            annotations=result.annotations or None,
            sam_refined=bool(result.sam_refined),
        )
        db.add(image)
        await db.flush()
        await db.refresh(image)

        if batch_row is not None:
            batch_row.processed_image_count = batch_row.processed_image_count + 1

            # Maintain aggregates incrementally so we don't have to scan every
            # AnalysisImage row at finalize time. ``_recompute_aggregates`` is
            # kept as a finalize/repair step in ``complete_batch`` /
            # ``finish_batch``.
            prev_count = batch_row.total_count or 0
            new_count = prev_count + (result.count or 0)
            batch_row.total_count = new_count

            batch_row.total_elapsed_secs = (batch_row.total_elapsed_secs or 0.0) + (
                result.elapsed_seconds or 0.0
            )

            new_conf = result.avg_confidence
            if new_conf is not None and (result.count or 0) > 0:
                prev_avg = batch_row.avg_confidence or 0.0
                # Count-weighted running average: (Σ avg_i * n_i) / Σ n_i
                if new_count > 0:
                    batch_row.avg_confidence = (
                        prev_avg * prev_count + new_conf * (result.count or 0)
                    ) / new_count

            if (
                batch_row.total_image_count == 1
                and batch_row.name
                and batch_row.name.startswith(_DEFAULT_NAME_PREFIX)
            ):
                stem = Path(result.filename).stem or result.filename
                batch_row.name = stem[:200]
            await db.flush()

        # Larvae/pupae batches: also persist polygon detections into the
        # `larvae_detection` table so GET /analyses/{id}/larvae can find them.
        # The generic `annotations` JSON column on AnalysisImage is kept for
        # parity with egg, but the larvae read path joins on larvae_detection.
        if batch_row is not None and batch_row.organism_type in _POLYGON_ORGANISMS:
            if not result.annotations and result.calibration is None:
                return image

            # Imported here to avoid a circular dep at module load.
            from app.services.larvae_persistence import save_detections

            parsed = self._parse_polygon_annotations(
                batch_row.organism_type,
                result.annotations,
                image.id,
            )
            if parsed:
                await save_detections(
                    image_id=image.id,
                    annotations=parsed,
                    model_version=None,
                    db=db,
                )

            # Persist auto-calibration output if the inference run produced one.
            if result.calibration is not None:
                from app.schemas.calibration import CalibrationCorners
                from app.services.larvae_persistence import save_calibration

                try:
                    cal_obj = CalibrationCorners.model_validate(result.calibration)
                except Exception:  # noqa: BLE001 — log + skip a malformed payload
                    logger.warning(
                        "Skipping malformed calibration payload",
                        extra={"context": {"image_id": str(image.id)}},
                    )
                else:
                    cal_obj = cal_obj.model_copy(update={"image_id": str(image.id)})
                    await save_calibration(image.id, cal_obj, db)

        return image

    async def _recompute_aggregates(
        self, batch_id: UUID, db: AsyncSession
    ) -> tuple[int, float | None, float]:
        """Compute (total_count, avg_confidence, total_elapsed_secs) from child images.

        Aggregates over AnalysisImage rows with status='completed'. Failed
        images contribute to total_image_count but are excluded from counts
        and confidence.
        """
        # Global mean over all detected boxes:
        #   sum(avg_confidence_i * count_i) / sum(count_i)
        # The previous "avg of avg" understated/overstated batches with skew.
        stmt = (
            select(
                func.coalesce(func.sum(AnalysisImage.count), 0).label("total_count"),
                func.coalesce(
                    func.sum(AnalysisImage.avg_confidence * AnalysisImage.count), 0
                ).label("conf_weighted"),
                func.coalesce(func.sum(AnalysisImage.elapsed_secs), 0).label(
                    "total_elapsed"
                ),
            )
            .where(AnalysisImage.batch_id == batch_id)
            .where(AnalysisImage.status == "completed")
        )
        row = (await db.execute(stmt)).one()
        total_count = int(row.total_count)
        avg_conf = float(row.conf_weighted) / total_count if total_count > 0 else None
        return total_count, avg_conf, float(row.total_elapsed)

    async def complete_batch(
        self,
        batch_id: UUID,
        db: AsyncSession,
        user_id: UUID,
        stopped_early: bool = False,
    ) -> AnalysisBatch | None:
        """End the processing phase: compute aggregates and move the batch to ``draft``.

        Drafts are visible to the ResultViewer (so the operator can edit
        annotations) but hidden from the Records list. Promotion to
        ``completed`` happens in ``finish_batch`` when the operator clicks
        Finish.

        ``stopped_early``: the operator stopped the run and kept what was
        done. The images that never ran are dropped from the batch's size, so
        it does not read as "4 of 10 processed" forever.
        """
        stmt_batch = (
            select(AnalysisBatch)
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
        batch = (await db.execute(stmt_batch)).scalar_one_or_none()
        if batch is None:
            return None

        total_count, avg_conf, total_elapsed = await self._recompute_aggregates(
            batch_id, db
        )
        # A batch that was already saved to Records before images were
        # appended goes back to ``completed``; everything else lands in
        # ``draft`` for review.
        resume_status = self._pop_append_markers(batch)
        batch.status = "completed" if resume_status == "completed" else "draft"
        if stopped_early:
            batch.total_image_count = await self._count_images(batch_id, db)
        batch.total_count = total_count
        batch.avg_confidence = avg_conf
        batch.total_elapsed_secs = total_elapsed

        await db.flush()
        await db.refresh(batch)
        logger.info(
            "Analysis batch ready for review (draft)",
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

    async def finish_batch(
        self,
        batch_id: UUID,
        db: AsyncSession,
        user_id: UUID,
    ) -> AnalysisBatch | None:
        """Promote a draft batch to ``completed`` and stamp ``completed_at``.

        Scoped to ``user_id`` — a batch belonging to another user is treated
        as not found (404), matching the rest of the API surface.

        Re-runs the aggregate query so any annotation edits made during the
        review phase are reflected in ``total_count`` and ``avg_confidence``
        once edits are wired into per-image counts.

        Raises ``ValueError`` if the batch is not in ``draft`` state.
        """
        batch = (
            await db.execute(
                select(AnalysisBatch)
                .where(AnalysisBatch.id == batch_id)
                .where(AnalysisBatch.user_id == user_id)
            )
        ).scalar_one_or_none()
        if batch is None:
            return None

        if batch.status != "draft":
            raise ValueError(
                f"Batch {batch_id} is not in 'draft' state (got '{batch.status}')."
            )

        total_count, avg_conf, total_elapsed = await self._recompute_aggregates(
            batch_id, db
        )
        batch.total_count = total_count
        batch.avg_confidence = avg_conf
        batch.total_elapsed_secs = total_elapsed
        batch.status = "completed"
        batch.completed_at = datetime.now(timezone.utc)

        await db.flush()
        await db.refresh(batch)
        logger.info(
            "Analysis batch saved to records (completed)",
            extra={
                "context": {
                    "batch_id": str(batch_id),
                    "total_count": batch.total_count,
                    "avg_confidence": batch.avg_confidence,
                }
            },
        )
        return batch

    async def rename_batch(
        self,
        batch_id: UUID,
        data: AnalysisBatchUpdate,
        db: AsyncSession,
        user_id: UUID,
    ) -> AnalysisBatchDetail | None:
        """Rename a batch. Returns the full detail, or None if the batch is missing."""
        stmt = (
            select(AnalysisBatch)
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
        result = await db.execute(stmt)
        batch = result.scalar_one_or_none()
        if batch is None:
            return None
        batch.name = data.name  # already stripped + validated by the schema
        await db.flush()
        logger.info(
            "Analysis batch renamed",
            extra={"context": {"batch_id": str(batch_id), "name": batch.name}},
        )
        return await self.get_batch_detail(batch_id=batch_id, db=db, user_id=user_id)

    async def fail_batch(
        self,
        batch_id: UUID,
        error: str,
        db: AsyncSession,
        user_id: UUID,
    ) -> AnalysisBatch | None:
        """Mark a batch as failed. Returns None if batch not found or not in processing state."""
        stmt = (
            select(AnalysisBatch)
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
        result = await db.execute(stmt)
        batch = result.scalar_one_or_none()
        if batch is None:
            return None
        if batch.status != "processing":
            return None
        if await self._abort_append(batch, db):
            await db.refresh(batch)
            logger.info(
                "Append run aborted — batch restored",
                extra={
                    "context": {
                        "batch_id": str(batch_id),
                        "status": batch.status,
                        "reason": error,
                    }
                },
            )
            return batch
        now = datetime.now(timezone.utc)
        batch.status = "failed"
        batch.failed_at = now
        batch.failure_reason = error
        batch.completed_at = now
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

    # ── Append images to an existing batch ──────────────────────────────────────

    @staticmethod
    def _pop_append_markers(batch: AnalysisBatch) -> str | None:
        """Strip the in-flight append markers; return the status to resume to."""
        snapshot = dict(batch.config_snapshot or {})
        resume_status = snapshot.pop(_RESUME_STATUS_KEY, None)
        had_since = snapshot.pop(_ACTIVE_SINCE_KEY, None) is not None
        if resume_status is not None or had_since:
            batch.config_snapshot = snapshot
        return resume_status

    async def _count_images(self, batch_id: UUID, db: AsyncSession) -> int:
        stmt = select(func.count(AnalysisImage.id)).where(
            AnalysisImage.batch_id == batch_id
        )
        return int((await db.execute(stmt)).scalar() or 0)

    async def _abort_append(self, batch: AnalysisBatch, db: AsyncSession) -> bool:
        """Undo an in-flight append: restore the prior status, keep the images
        that already landed. Returns False when the batch is not appending."""
        if _RESUME_STATUS_KEY not in (batch.config_snapshot or {}):
            return False
        resume_status = self._pop_append_markers(batch)
        actual = await self._count_images(batch.id, db)
        total_count, avg_conf, total_elapsed = await self._recompute_aggregates(
            batch.id, db
        )
        batch.status = "completed" if resume_status == "completed" else "draft"
        batch.total_image_count = max(actual, 1)
        batch.processed_image_count = actual
        batch.total_count = total_count
        batch.avg_confidence = avg_conf
        batch.total_elapsed_secs = total_elapsed
        await db.flush()
        return True

    async def append_to_batch(
        self,
        batch_id: UUID,
        data: AnalysisBatchAppend,
        db: AsyncSession,
        user_id: UUID,
    ) -> AnalysisBatch | None:
        """Re-open a batch so more images can be processed into it.

        The batch moves back to ``processing``; ``complete_batch`` (or an
        abort via ``fail_batch``) returns it to the status it had before.
        Raises ``ValueError`` when the batch is already processing.
        """
        batch = (
            await db.execute(
                select(AnalysisBatch)
                .where(AnalysisBatch.id == batch_id)
                .where(AnalysisBatch.user_id == user_id)
            )
        ).scalar_one_or_none()
        if batch is None:
            return None
        if batch.status == "processing":
            raise ValueError(f"Batch {batch_id} is already processing.")

        actual = await self._count_images(batch_id, db)
        now = datetime.now(timezone.utc)
        snapshot = dict(batch.config_snapshot or {})
        snapshot.update(data.config_snapshot or {})
        snapshot[_RESUME_STATUS_KEY] = (
            "completed" if batch.status == "completed" else "draft"
        )
        snapshot[_ACTIVE_SINCE_KEY] = now.isoformat()

        batch.config_snapshot = snapshot
        batch.status = "processing"
        batch.total_image_count = actual + data.additional_image_count
        batch.processed_image_count = actual
        batch.failed_at = None
        batch.failure_reason = None
        await db.flush()
        await db.refresh(batch)
        logger.info(
            "Analysis batch re-opened for append",
            extra={
                "context": {
                    "batch_id": str(batch_id),
                    "existing_images": actual,
                    "additional_images": data.additional_image_count,
                }
            },
        )
        return batch

    # ── Counts after operator edits ─────────────────────────────────────────────

    async def refresh_batch_aggregates(self, batch_id: UUID, db: AsyncSession) -> None:
        """Re-derive a batch's totals from its image rows.

        Called after an edit changes an image's ``count`` so Records and the
        dashboard show the reviewed number, not the model's first pass.
        """
        batch = (
            await db.execute(select(AnalysisBatch).where(AnalysisBatch.id == batch_id))
        ).scalar_one_or_none()
        if batch is None:
            return
        total_count, avg_conf, _elapsed = await self._recompute_aggregates(batch_id, db)
        batch.total_count = total_count
        batch.avg_confidence = avg_conf
        await db.flush()

    # ── Active batch ────────────────────────────────────────────────────────────

    async def get_active_batch(
        self, db: AsyncSession, user_id: UUID
    ) -> ActiveBatchResponse:
        """Return the currently-processing batch for this user, if any.

        Zombie cleanup: if the active batch is older than 24 hours, auto-mark
        it as failed so it doesn't block new batches forever.
        """
        batch = await self.has_active_batch(db=db, user_id=user_id)

        if batch is None:
            return ActiveBatchResponse(active=False, batch=None)

        now = datetime.now(timezone.utc)
        started_at = self._processing_started_at(batch) or now
        if now - started_at > _ZOMBIE_TIMEOUT:
            if await self._abort_append(batch, db):
                logger.warning(
                    "Zombie append run aborted — batch restored",
                    extra={"context": {"batch_id": str(batch.id)}},
                )
                return ActiveBatchResponse(active=False, batch=None)
            batch.status = "failed"
            batch.failed_at = now
            batch.failure_reason = "Timed out — no progress for 24 hours"
            batch.completed_at = now
            await db.flush()
            await db.refresh(batch)
            logger.warning(
                "Zombie batch auto-failed",
                extra={"context": {"batch_id": str(batch.id)}},
            )
            return ActiveBatchResponse(active=False, batch=None)

        # Progress view only — callers that need boxes fetch the detail endpoint.
        detail = await self.get_batch_detail(
            batch_id=batch.id, db=db, user_id=user_id, include_annotations=False
        )
        return ActiveBatchResponse(active=True, batch=detail)

    async def has_active_batch(
        self, db: AsyncSession, user_id: UUID
    ) -> AnalysisBatch | None:
        """Return this user's active processing batch row (without images), or None."""
        stmt = (
            select(AnalysisBatch)
            .where(AnalysisBatch.status == "processing")
            .where(AnalysisBatch.user_id == user_id)
            .order_by(AnalysisBatch.created_at.desc())
            .limit(1)
        )
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    # ── Query ──────────────────────────────────────────────────────────────────

    async def list_batches(
        self,
        page: int,
        page_size: int,
        search: str | None,
        organism: str | None,
        db: AsyncSession,
        user_id: UUID,
        statuses: list[str] | None = None,
        sort: str = "created_at",
        descending: bool = True,
    ) -> AnalysisListResponse:
        """Return a paginated list of analysis batches.

        Args:
            page: 1-indexed page number.
            page_size: Number of items per page.
            search: Optional substring. ILIKE match against batch ``name`` OR
                any child image's ``original_filename``.
            organism: Optional organism type filter.
            statuses: Optional list of status values to include (e.g.
                ``["completed", "failed"]``). When None, no status filter.
            sort: ``created_at`` (default) or ``total_count``. Applied before
                pagination, so the order holds across pages.
            descending: Largest / newest first.
        """
        # Base count query — always scoped to this user.
        count_stmt = select(func.count(AnalysisBatch.id)).where(
            AnalysisBatch.user_id == user_id
        )

        # Base batch query — no selectinload(images) because the summary view
        # does not touch the relationship. Loading every image per row was
        # shipping ~50× the rows we render.
        if sort == "total_count":
            # Batches without a count (failed before any image) sort last
            # either way; creation date breaks ties so paging is stable.
            count_col = AnalysisBatch.total_count
            ordering = [
                (count_col.desc() if descending else count_col.asc()).nulls_last(),
                AnalysisBatch.created_at.desc(),
            ]
        else:
            created = AnalysisBatch.created_at
            ordering = [created.desc() if descending else created.asc()]
        batch_stmt = (
            select(AnalysisBatch)
            .where(AnalysisBatch.user_id == user_id)
            .order_by(*ordering, AnalysisBatch.id)
        )

        if organism:
            count_stmt = count_stmt.where(AnalysisBatch.organism_type == organism)
            batch_stmt = batch_stmt.where(AnalysisBatch.organism_type == organism)

        if statuses:
            count_stmt = count_stmt.where(AnalysisBatch.status.in_(statuses))
            batch_stmt = batch_stmt.where(AnalysisBatch.status.in_(statuses))

        if search:
            # Match the search string against the batch name OR any image's
            # original_filename (case-insensitive substring). Use a correlated
            # EXISTS on images so we don't need a join + DISTINCT dance.
            search_pattern = f"%{search}%"
            search_filter = or_(
                AnalysisBatch.name.ilike(search_pattern),
                AnalysisBatch.images.any(
                    AnalysisImage.original_filename.ilike(search_pattern)
                ),
            )
            count_stmt = count_stmt.where(search_filter)
            batch_stmt = batch_stmt.where(search_filter)

        # Execute count
        count_result = await db.execute(count_stmt)
        total = count_result.scalar() or 0

        # Execute paginated batch query
        offset = (page - 1) * page_size
        batch_stmt = batch_stmt.offset(offset).limit(page_size)
        batch_result = await db.execute(batch_stmt)
        batches = list(batch_result.scalars().unique().all())

        covers = await self._cover_image_ids([b.id for b in batches], db)
        items = [self._to_summary(b, covers.get(b.id)) for b in batches]
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
        user_id: UUID,
        include_annotations: bool = True,
    ) -> AnalysisBatchDetail | None:
        """Return full batch detail including all images. Scoped to ``user_id``.

        ``include_annotations=False`` strips the per-image ``annotations`` and
        ``edited_annotations`` arrays from the response — the metadata-only
        view used by the BatchDetail card grid, which doesn't render boxes.
        Saves bandwidth + JSON parse time on big batches; the ResultViewer
        re-fetches with the full payload before entering edit mode.
        """
        # Annotation arrays can run to thousands of boxes per image; when the
        # caller doesn't want them, don't pull them out of Postgres at all.
        images_loader = (
            selectinload(AnalysisBatch.images)
            if include_annotations
            else _batch_images_light()
        )
        stmt = (
            select(AnalysisBatch)
            .options(images_loader)
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
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
                annotations=img.annotations if include_annotations else None,
                edited_annotations=(
                    img.edited_annotations if include_annotations else None
                ),
            )
            for img in batch.images
        ]

        return AnalysisBatchDetail(
            id=batch.id,
            user_id=batch.user_id,
            name=batch.name,
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
            processed_image_count=batch.processed_image_count,
            failed_at=batch.failed_at,
            failure_reason=batch.failure_reason,
            classes=list(batch.classes or []),
            processing_started_at=self._processing_started_at(batch),
            config_snapshot=self._public_snapshot(batch.config_snapshot),
            notes=batch.notes,
            images=image_summaries,
        )

    async def get_image_detail(
        self,
        batch_id: UUID,
        image_id: UUID,
        db: AsyncSession,
        user_id: UUID,
    ) -> AnalysisImageDetail | None:
        """Return full detail for a single image (metadata + annotations).

        Used by the URL-driven ResultViewer to lazy-fetch annotations per
        image instead of pulling the whole batch upfront. Scoped to ``user_id``
        and to the given ``batch_id`` so a guess at ``image_id`` from another
        user can't leak data.
        """
        stmt = (
            select(AnalysisImage)
            .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
            .where(AnalysisImage.id == image_id)
            .where(AnalysisImage.batch_id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
        image = (await db.execute(stmt)).scalar_one_or_none()
        if image is None:
            return None
        return AnalysisImageDetail(
            id=image.id,
            original_filename=image.original_filename,
            status=image.status,
            count=image.count,
            avg_confidence=image.avg_confidence,
            elapsed_secs=image.elapsed_secs,
            overlay_path=image.overlay_path,
            error_message=image.error_message,
            created_at=image.created_at,
            annotations=image.annotations,
            edited_annotations=image.edited_annotations,
        )

    # ── Delete ────────────────────────────────────────────────────────────────

    async def delete_batch(
        self,
        batch_id: UUID,
        db: AsyncSession,
        storage_dir: Path,
        user_id: UUID,
    ) -> bool:
        """Delete a batch, its images, and all associated overlay files on disk.

        Returns True if a batch was deleted, False if it didn't exist.
        """
        stmt = (
            select(AnalysisBatch)
            .options(_batch_images_light())
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
        result = await db.execute(stmt)
        batch = result.scalar_one_or_none()
        if batch is None:
            return False

        # Delete DB rows (cascade handles images relationship)
        await db.delete(batch)
        await db.flush()

        # Overlays for a batch all live under storage_dir/{batch_id}/, so a
        # single rmtree is sufficient — no need to per-file unlink each
        # overlay (which blocks the loop on large batches). Run the rmtree
        # in a worker thread.
        batch_dir = storage_dir / str(batch_id)

        def _rmtree_batch_dir() -> None:
            try:
                if batch_dir.exists():
                    shutil.rmtree(batch_dir)
            except OSError as exc:
                logger.warning(
                    "Failed to delete batch directory: %s (%s)",
                    batch_dir,
                    exc,
                    extra={
                        "context": {
                            "batch_dir": str(batch_dir),
                            "exception": str(exc),
                        }
                    },
                )

        await asyncio.to_thread(_rmtree_batch_dir)

        logger.info(
            "Analysis batch deleted",
            extra={
                "context": {
                    "batch_id": str(batch_id),
                    "batch_dir": str(batch_dir),
                }
            },
        )
        return True

    # ── Dashboard ─────────────────────────────────────────────────────────────

    async def get_dashboard_stats(
        self, db: AsyncSession, user_id: UUID
    ) -> DashboardStats:
        """Return aggregate statistics for this user's dashboard."""
        # Count total completed analyses
        count_stmt = (
            select(func.count(AnalysisBatch.id))
            .where(AnalysisBatch.status == "completed")
            .where(AnalysisBatch.user_id == user_id)
        )
        count_result = await db.execute(count_stmt)
        total_analyses = count_result.scalar() or 0

        # Aggregate image-level stats — scoped via the parent batch's user_id.
        agg_stmt = (
            select(
                func.count(AnalysisImage.id).label("total_images"),
                func.coalesce(func.sum(AnalysisImage.count), 0).label("total_eggs"),
                func.coalesce(func.avg(AnalysisImage.avg_confidence), 0).label(
                    "avg_conf"
                ),
                func.coalesce(func.avg(AnalysisImage.elapsed_secs), 0).label(
                    "avg_time"
                ),
            )
            .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
            .where(AnalysisImage.status == "completed")
            .where(AnalysisBatch.user_id == user_id)
        )
        agg_result = await db.execute(agg_stmt)
        agg_row = agg_result.one()

        # Recent analyses
        recent_stmt = (
            select(AnalysisBatch)
            .where(AnalysisBatch.user_id == user_id)
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

    # ── Edit annotations ───────────────────────────────────────────────────────

    async def update_edited_annotations(
        self,
        batch_id: UUID,
        image_id: UUID,
        data: EditedAnnotationsUpdate,
        db: AsyncSession,
        user_id: UUID,
    ) -> AnalysisImageDetail | None:
        """Replace the edited_annotations for a single image (full-replace semantics).

        Returns the updated image detail, or None if the batch or image was not found.
        """
        stmt = (
            select(AnalysisImage)
            .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
            .where(AnalysisImage.id == image_id)
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
        result = await db.execute(stmt)
        image = result.scalar_one_or_none()
        if image is None:
            return None

        image.edited_annotations = data.edited_annotations
        # The reviewed box list is the count of record from here on.
        image.count = len(data.edited_annotations)
        await db.flush()
        await self.refresh_batch_aggregates(batch_id, db)
        await db.refresh(image)

        logger.info(
            "Edited annotations saved",
            extra={
                "context": {
                    "batch_id": str(batch_id),
                    "image_id": str(image_id),
                    "box_count": len(data.edited_annotations),
                }
            },
        )
        return AnalysisImageDetail(
            id=image.id,
            original_filename=image.original_filename,
            status=image.status,
            count=image.count,
            avg_confidence=image.avg_confidence,
            elapsed_secs=image.elapsed_secs,
            overlay_path=image.overlay_path,
            error_message=image.error_message,
            created_at=image.created_at,
            annotations=image.annotations,
            edited_annotations=image.edited_annotations,
        )

    async def clear_edited_annotations(
        self,
        batch_id: UUID,
        image_id: UUID,
        db: AsyncSession,
        user_id: UUID,
    ) -> bool:
        """Clear edited_annotations back to NULL (reset to model output).

        Returns True if the image was found and updated, False otherwise.
        """
        stmt = (
            select(AnalysisImage)
            .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
            .where(AnalysisImage.id == image_id)
            .where(AnalysisBatch.id == batch_id)
            .where(AnalysisBatch.user_id == user_id)
        )
        result = await db.execute(stmt)
        image = result.scalar_one_or_none()
        if image is None:
            return False

        image.edited_annotations = None
        if isinstance(image.annotations, list):
            image.count = len(image.annotations)
        await db.flush()
        await self.refresh_batch_aggregates(batch_id, db)

        logger.info(
            "Edited annotations cleared",
            extra={
                "context": {
                    "batch_id": str(batch_id),
                    "image_id": str(image_id),
                }
            },
        )
        return True

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _processing_started_at(batch: AnalysisBatch) -> datetime | None:
        """Start of the run in flight, or None when the batch is not processing."""
        if batch.status != "processing":
            return None
        started_at = batch.created_at
        since_raw = (batch.config_snapshot or {}).get(_ACTIVE_SINCE_KEY)
        if isinstance(since_raw, str):
            try:
                started_at = datetime.fromisoformat(since_raw)
            except ValueError:
                pass
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        return started_at

    @staticmethod
    def _public_snapshot(snapshot: dict | None) -> dict:
        """Config snapshot without the internal append bookkeeping keys."""
        return {
            k: v
            for k, v in (snapshot or {}).items()
            if k not in (_RESUME_STATUS_KEY, _ACTIVE_SINCE_KEY)
        }

    async def _cover_image_ids(
        self, batch_ids: list[UUID], db: AsyncSession
    ) -> dict[UUID, UUID]:
        """First completed image per batch, in one query."""
        if not batch_ids:
            return {}
        ranked = (
            select(
                AnalysisImage.batch_id.label("batch_id"),
                AnalysisImage.id.label("image_id"),
                func.row_number()
                .over(
                    partition_by=AnalysisImage.batch_id,
                    order_by=AnalysisImage.created_at,
                )
                .label("rn"),
            )
            .where(AnalysisImage.batch_id.in_(batch_ids))
            .where(AnalysisImage.status == "completed")
            .where(AnalysisImage.overlay_path.is_not(None))
            .subquery()
        )
        rows = await db.execute(
            select(ranked.c.batch_id, ranked.c.image_id).where(ranked.c.rn == 1)
        )
        return {row.batch_id: row.image_id for row in rows}

    def _to_summary(
        self, batch: AnalysisBatch, cover_image_id: UUID | None = None
    ) -> AnalysisBatchSummary:
        return AnalysisBatchSummary(
            id=batch.id,
            user_id=batch.user_id,
            name=batch.name,
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
            processed_image_count=batch.processed_image_count,
            failed_at=batch.failed_at,
            failure_reason=batch.failure_reason,
            classes=list(batch.classes or []),
            processing_started_at=self._processing_started_at(batch),
            cover_image_id=cover_image_id,
        )
