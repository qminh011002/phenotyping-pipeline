"""Aggregations behind GET /dashboard/overview.

Everything is scoped to one user and one look-back window. Reviewed work only:
``completed`` and ``draft`` batches feed the metrics; ``failed`` and
``processing`` batches appear only in the attention counters.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import Select, func, literal_column, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analysis import AnalysisBatch, AnalysisImage
from app.models.larvae import LarvaeCalibration, LarvaeDetection, LarvaeMeasurement
from app.schemas.analysis import (
    AnalysisBatchSummary,
    DashboardAttention,
    DashboardBatchRow,
    DashboardHistogramBin,
    DashboardKpis,
    DashboardOrganismRow,
    DashboardOverview,
    DashboardSizeStats,
    DashboardTimePoint,
)
from app.services.analysis_service import AnalysisService

logger = logging.getLogger(__name__)

_METRIC_STATUSES = ("completed", "draft")
_POLYGON_ORGANISMS = ("larvae", "pupae")
_CONFIDENCE_BINS = 20
_SIZE_BINS = 16
_BATCH_ROWS = 12
_RECENT_ROWS = 8
_LOW_CONFIDENCE = 0.5

# (metric key, unit, measurement column)
_SIZE_METRICS = (
    ("length_mm", "mm", LarvaeMeasurement.length_mm),
    ("max_width_mm", "mm", LarvaeMeasurement.max_width_mm),
    ("area_mm2", "mm²", LarvaeMeasurement.area_mm2),
    ("weight_mg", "mg", LarvaeMeasurement.weight_mg),
)


def bucket_for_days(days: int) -> str:
    """Day buckets up to a month, weeks up to four months, months beyond."""
    if days == 0 or days > 120:
        return "month"
    if days > 31:
        return "week"
    return "day"


def _f(value: object) -> float | None:
    return float(value) if value is not None else None  # type: ignore[arg-type]


async def size_distributions(
    db: AsyncSession, organism: str, scope: Callable[[Select], Select]
) -> list[DashboardSizeStats]:
    """Distribution of each measured metric over the measurements ``scope`` keeps.

    ``scope`` narrows a statement that already joins measurement → detection →
    image → batch. Two queries per metric: summary stats, then a histogram
    whose range is clipped to P1–P99 so one mis-segmented blob doesn't flatten
    every other bar.
    """
    out: list[DashboardSizeStats] = []
    for key, unit, col in _SIZE_METRICS:

        def scoped(stmt, _col=col):
            return scope(
                stmt.select_from(LarvaeMeasurement)
                .join(
                    LarvaeDetection,
                    LarvaeDetection.id == LarvaeMeasurement.detection_id,
                )
                .join(AnalysisImage, AnalysisImage.id == LarvaeDetection.image_id)
                .join(AnalysisBatch, AnalysisBatch.id == AnalysisImage.batch_id)
                .where(_col.is_not(None))
                .where(_col > 0)
            )

        summary = (
            await db.execute(
                scoped(
                    select(
                        func.count(col),
                        func.avg(col),
                        func.min(col),
                        func.max(col),
                        func.percentile_cont(0.5).within_group(col),
                        func.percentile_cont(0.05).within_group(col),
                        func.percentile_cont(0.95).within_group(col),
                        func.percentile_cont(0.01).within_group(col),
                        func.percentile_cont(0.99).within_group(col),
                    )
                )
            )
        ).one()
        n = int(summary[0] or 0)
        if n == 0:
            continue
        lo, hi = float(summary[7]), float(summary[8])
        bins: list[DashboardHistogramBin] = []
        if hi > lo:
            band = func.width_bucket(col, lo, hi, _SIZE_BINS).label("band")
            counts = {
                int(b): int(c)
                for b, c in await db.execute(
                    scoped(select(band, func.count(col)))
                    .where(col >= lo)
                    .where(col <= hi)
                    .group_by(band)
                )
                if b is not None
            }
            # x == hi lands in bucket _SIZE_BINS + 1; fold into the last bin.
            counts[_SIZE_BINS] = counts.get(_SIZE_BINS, 0) + counts.pop(
                _SIZE_BINS + 1, 0
            )
            step = (hi - lo) / _SIZE_BINS
            bins = [
                DashboardHistogramBin(
                    start=lo + i * step,
                    end=lo + (i + 1) * step,
                    count=counts.get(i + 1, 0),
                )
                for i in range(_SIZE_BINS)
            ]
        out.append(
            DashboardSizeStats(
                organism=organism,
                metric=key,
                unit=unit,
                n=n,
                mean=_f(summary[1]),
                min=_f(summary[2]),
                max=_f(summary[3]),
                median=_f(summary[4]),
                p5=_f(summary[5]),
                p95=_f(summary[6]),
                bins=bins,
            )
        )
    return out


class DashboardService:
    """Read-only aggregate queries for the dashboard. Stateless."""

    def _scope(self, stmt, user_id: UUID, start: datetime | None, end: datetime | None):
        stmt = stmt.where(AnalysisBatch.user_id == user_id).where(
            AnalysisBatch.status.in_(_METRIC_STATUSES)
        )
        if start is not None:
            stmt = stmt.where(AnalysisBatch.created_at >= start)
        if end is not None:
            stmt = stmt.where(AnalysisBatch.created_at < end)
        return stmt

    async def _kpis(
        self,
        db: AsyncSession,
        user_id: UUID,
        start: datetime | None,
        end: datetime | None,
        organism: str | None,
    ) -> DashboardKpis:
        batch_stmt = self._scope(
            select(func.count(AnalysisBatch.id)), user_id, start, end
        )
        img_stmt = self._scope(
            select(
                func.count(AnalysisImage.id),
                func.coalesce(func.sum(AnalysisImage.count), 0),
                func.sum(AnalysisImage.avg_confidence * AnalysisImage.count),
                func.avg(AnalysisImage.elapsed_secs),
            )
            .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
            .where(AnalysisImage.status == "completed"),
            user_id,
            start,
            end,
        )
        if organism:
            batch_stmt = batch_stmt.where(AnalysisBatch.organism_type == organism)
            img_stmt = img_stmt.where(AnalysisBatch.organism_type == organism)

        batches = int((await db.execute(batch_stmt)).scalar() or 0)
        images, detections, conf_weighted, avg_secs = (await db.execute(img_stmt)).one()
        images = int(images or 0)
        detections = int(detections or 0)
        return DashboardKpis(
            batches=batches,
            images=images,
            detections=detections,
            avg_count_per_image=(detections / images) if images else None,
            # Detection-weighted, so a 2-object image doesn't count as much as
            # a 2,000-object one.
            avg_confidence=(
                float(conf_weighted) / detections
                if detections and conf_weighted is not None
                else None
            ),
            avg_secs_per_image=_f(avg_secs),
        )

    async def _bucket_starts(
        self,
        db: AsyncSession,
        user_id: UUID,
        start: datetime | None,
        end: datetime,
        bucket: str,
    ) -> list[datetime]:
        """Every bucket in the window, empty ones included.

        Generated by the database so the instants match ``date_trunc`` in
        ``_timeseries`` exactly (same session time zone); the client can then
        draw a continuous axis without guessing where a "day" starts.
        """
        if start is None:
            start = (
                await db.execute(
                    self._scope(
                        select(func.min(AnalysisBatch.created_at)), user_id, None, end
                    )
                )
            ).scalar()
            if start is None:
                return []
        # ``bucket`` comes from bucket_for_days — a fixed set, never user input.
        step = literal_column(f"interval '1 {bucket}'")
        series = func.generate_series(
            func.date_trunc(bucket, start), func.date_trunc(bucket, end), step
        )
        return [row[0] for row in await db.execute(select(series))]

    async def _timeseries(
        self,
        db: AsyncSession,
        user_id: UUID,
        start: datetime | None,
        end: datetime,
        bucket: str,
        organism: str | None,
    ) -> list[DashboardTimePoint]:
        bucket_col = func.date_trunc(bucket, AnalysisBatch.created_at).label("bucket")
        stmt = self._scope(
            select(
                bucket_col,
                AnalysisBatch.organism_type,
                func.count(func.distinct(AnalysisBatch.id)),
                func.count(AnalysisImage.id),
                func.coalesce(func.sum(AnalysisImage.count), 0),
                func.avg(AnalysisImage.elapsed_secs),
            )
            .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
            .where(AnalysisImage.status == "completed")
            .group_by(bucket_col, AnalysisBatch.organism_type)
            .order_by(bucket_col),
            user_id,
            start,
            end,
        )
        if organism:
            stmt = stmt.where(AnalysisBatch.organism_type == organism)
        return [
            DashboardTimePoint(
                bucket=row[0],
                organism=row[1],
                batches=int(row[2] or 0),
                images=int(row[3] or 0),
                detections=int(row[4] or 0),
                avg_secs_per_image=_f(row[5]),
            )
            for row in await db.execute(stmt)
        ]

    async def _organisms(
        self,
        db: AsyncSession,
        user_id: UUID,
        start: datetime | None,
        end: datetime,
    ) -> list[DashboardOrganismRow]:
        stmt = self._scope(
            select(
                AnalysisBatch.organism_type,
                func.count(func.distinct(AnalysisBatch.id)),
                func.count(AnalysisImage.id),
                func.coalesce(func.sum(AnalysisImage.count), 0),
                func.sum(AnalysisImage.avg_confidence * AnalysisImage.count),
            )
            .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
            .where(AnalysisImage.status == "completed")
            .group_by(AnalysisBatch.organism_type),
            user_id,
            start,
            end,
        )
        rows: list[DashboardOrganismRow] = []
        for organism, batches, images, detections, conf_weighted in await db.execute(
            stmt
        ):
            images = int(images or 0)
            detections = int(detections or 0)
            rows.append(
                DashboardOrganismRow(
                    organism=organism,
                    batches=int(batches or 0),
                    images=images,
                    detections=detections,
                    avg_count_per_image=(detections / images) if images else None,
                    avg_confidence=(
                        float(conf_weighted) / detections
                        if detections and conf_weighted is not None
                        else None
                    ),
                )
            )
        rows.sort(key=lambda r: r.detections, reverse=True)
        return rows

    async def _confidence_histogram(
        self,
        db: AsyncSession,
        user_id: UUID,
        start: datetime | None,
        end: datetime,
        organism: str | None,
    ) -> list[DashboardHistogramBin]:
        """Images per 10-point confidence band (per-image mean confidence)."""
        # width_bucket(x, 0, 1, 10) puts x == 1.0 in bucket 11; fold it back.
        band = func.least(
            func.width_bucket(AnalysisImage.avg_confidence, 0.0, 1.0, _CONFIDENCE_BINS),
            _CONFIDENCE_BINS,
        ).label("band")
        stmt = self._scope(
            select(band, func.count(AnalysisImage.id))
            .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
            .where(AnalysisImage.status == "completed")
            .where(AnalysisImage.avg_confidence.is_not(None))
            .where(AnalysisImage.count > 0)
            .group_by(band),
            user_id,
            start,
            end,
        )
        if organism:
            stmt = stmt.where(AnalysisBatch.organism_type == organism)
        counts = {int(b): int(n) for b, n in await db.execute(stmt) if b is not None}
        step = 1.0 / _CONFIDENCE_BINS
        return [
            DashboardHistogramBin(
                start=round(i * step, 4),
                end=round((i + 1) * step, 4),
                count=counts.get(i + 1, 0),
            )
            for i in range(_CONFIDENCE_BINS)
        ]

    async def _size_stats(
        self,
        db: AsyncSession,
        user_id: UUID,
        start: datetime | None,
        end: datetime,
        organism: str | None,
    ) -> list[DashboardSizeStats]:
        """Distribution of each measured metric per polygon organism."""
        organisms = [organism] if organism else list(_POLYGON_ORGANISMS)
        out: list[DashboardSizeStats] = []
        for org in organisms:
            if org not in _POLYGON_ORGANISMS:
                continue

            def scope(stmt, _org: str = org):
                return self._scope(
                    stmt.where(AnalysisBatch.organism_type == _org),
                    user_id,
                    start,
                    end,
                )

            out.extend(await size_distributions(db, org, scope))
        return out

    async def _batch_rows(
        self,
        db: AsyncSession,
        user_id: UUID,
        start: datetime | None,
        end: datetime,
        organism: str | None,
    ) -> list[DashboardBatchRow]:
        """Most recent batches with per-image count spread and mean length."""
        stmt = self._scope(
            select(
                AnalysisBatch.id,
                AnalysisBatch.name,
                AnalysisBatch.organism_type,
                AnalysisBatch.status,
                AnalysisBatch.created_at,
                func.count(AnalysisImage.id),
                func.coalesce(func.sum(AnalysisImage.count), 0),
                func.avg(AnalysisImage.count),
                func.min(AnalysisImage.count),
                func.max(AnalysisImage.count),
                func.sum(AnalysisImage.avg_confidence * AnalysisImage.count),
            )
            .join(AnalysisImage, AnalysisImage.batch_id == AnalysisBatch.id)
            .where(AnalysisImage.status == "completed")
            .group_by(
                AnalysisBatch.id,
                AnalysisBatch.name,
                AnalysisBatch.organism_type,
                AnalysisBatch.status,
                AnalysisBatch.created_at,
            )
            .order_by(AnalysisBatch.created_at.desc())
            .limit(_BATCH_ROWS),
            user_id,
            start,
            end,
        )
        if organism:
            stmt = stmt.where(AnalysisBatch.organism_type == organism)
        rows = list(await db.execute(stmt))
        if not rows:
            return []

        length_by_batch: dict[UUID, tuple[float | None, int]] = {}
        polygon_ids = [r[0] for r in rows if r[2] in _POLYGON_ORGANISMS]
        if polygon_ids:
            length_stmt = (
                select(
                    AnalysisImage.batch_id,
                    func.avg(LarvaeMeasurement.length_mm),
                    func.count(LarvaeMeasurement.length_mm),
                )
                .select_from(LarvaeMeasurement)
                .join(
                    LarvaeDetection,
                    LarvaeDetection.id == LarvaeMeasurement.detection_id,
                )
                .join(AnalysisImage, AnalysisImage.id == LarvaeDetection.image_id)
                .where(AnalysisImage.batch_id.in_(polygon_ids))
                .where(LarvaeMeasurement.length_mm.is_not(None))
                .group_by(AnalysisImage.batch_id)
            )
            for batch_id, mean_len, n in await db.execute(length_stmt):
                length_by_batch[batch_id] = (_f(mean_len), int(n or 0))

        out: list[DashboardBatchRow] = []
        for r in rows:
            total = int(r[6] or 0)
            mean_len, measured = length_by_batch.get(r[0], (None, 0))
            out.append(
                DashboardBatchRow(
                    id=r[0],
                    name=r[1],
                    organism=r[2],
                    status=r[3],
                    created_at=r[4],
                    images=int(r[5] or 0),
                    total_count=total,
                    mean_count=_f(r[7]),
                    min_count=int(r[8]) if r[8] is not None else None,
                    max_count=int(r[9]) if r[9] is not None else None,
                    avg_confidence=(
                        float(r[10]) / total if total and r[10] is not None else None
                    ),
                    mean_length_mm=mean_len,
                    measured_objects=measured,
                )
            )
        # Chronological, so the comparison chart reads left → right in time.
        out.reverse()
        return out

    async def _attention(self, db: AsyncSession, user_id: UUID) -> DashboardAttention:
        """Outstanding work, across all time — a draft from last quarter is
        still a draft."""
        status_rows = await db.execute(
            select(AnalysisBatch.status, func.count(AnalysisBatch.id))
            .where(AnalysisBatch.user_id == user_id)
            .group_by(AnalysisBatch.status)
        )
        by_status = {s: int(n) for s, n in status_rows}

        polygon_images = (
            select(AnalysisImage.id)
            .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
            .where(AnalysisBatch.user_id == user_id)
            .where(AnalysisBatch.status.in_(_METRIC_STATUSES))
            .where(AnalysisBatch.organism_type.in_(_POLYGON_ORGANISMS))
            .where(AnalysisImage.status == "completed")
        )
        calibrated = select(LarvaeCalibration.image_id).where(
            LarvaeCalibration.detection_status != "failed"
        )
        needs_calibration = int(
            (
                await db.execute(
                    select(func.count()).select_from(
                        polygon_images.where(
                            AnalysisImage.id.not_in(calibrated)
                        ).subquery()
                    )
                )
            ).scalar()
            or 0
        )
        measured_images = (
            select(LarvaeDetection.image_id)
            .join(
                LarvaeMeasurement,
                LarvaeMeasurement.detection_id == LarvaeDetection.id,
            )
            .distinct()
        )
        unmeasured = int(
            (
                await db.execute(
                    select(func.count()).select_from(
                        polygon_images.where(AnalysisImage.count > 0)
                        .where(AnalysisImage.id.not_in(measured_images))
                        .subquery()
                    )
                )
            ).scalar()
            or 0
        )
        low_conf = int(
            (
                await db.execute(
                    select(func.count(AnalysisImage.id))
                    .join(AnalysisBatch, AnalysisImage.batch_id == AnalysisBatch.id)
                    .where(AnalysisBatch.user_id == user_id)
                    .where(AnalysisBatch.status.in_(_METRIC_STATUSES))
                    .where(AnalysisImage.status == "completed")
                    .where(AnalysisImage.count > 0)
                    .where(AnalysisImage.avg_confidence < _LOW_CONFIDENCE)
                )
            ).scalar()
            or 0
        )
        return DashboardAttention(
            drafts=by_status.get("draft", 0),
            failed=by_status.get("failed", 0),
            needs_calibration=needs_calibration,
            unmeasured_images=unmeasured,
            low_confidence_images=low_conf,
        )

    async def _recent(
        self, db: AsyncSession, user_id: UUID
    ) -> list[AnalysisBatchSummary]:
        rows = (
            await db.execute(
                select(AnalysisBatch)
                .where(AnalysisBatch.user_id == user_id)
                .order_by(AnalysisBatch.created_at.desc())
                .limit(_RECENT_ROWS)
            )
        ).scalars()
        to_summary = AnalysisService()._to_summary
        return [to_summary(b) for b in rows]

    async def get_overview(
        self,
        db: AsyncSession,
        user_id: UUID,
        days: int = 30,
        organism: str | None = None,
    ) -> DashboardOverview:
        """Assemble the dashboard payload. ``days == 0`` means all time."""
        end = datetime.now(UTC)
        start = end - timedelta(days=days) if days > 0 else None
        bucket = bucket_for_days(days)

        kpis = await self._kpis(db, user_id, start, end, organism)
        previous = (
            await self._kpis(db, user_id, start - timedelta(days=days), start, organism)
            if start is not None
            else None
        )
        return DashboardOverview(
            days=days,
            bucket=bucket,
            range_start=start,
            range_end=end,
            kpis=kpis,
            previous=previous,
            buckets=await self._bucket_starts(db, user_id, start, end, bucket),
            timeseries=await self._timeseries(
                db, user_id, start, end, bucket, organism
            ),
            organisms=await self._organisms(db, user_id, start, end),
            confidence_histogram=await self._confidence_histogram(
                db, user_id, start, end, organism
            ),
            sizes=await self._size_stats(db, user_id, start, end, organism),
            batches=await self._batch_rows(db, user_id, start, end, organism),
            attention=await self._attention(db, user_id),
            recent_analyses=await self._recent(db, user_id),
        )
