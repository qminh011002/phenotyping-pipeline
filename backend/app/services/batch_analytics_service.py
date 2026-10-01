"""Aggregations behind GET /analyses/{batch_id}/analytics.

One batch at a time: how the per-image counts spread, how confident the model
was detection by detection, what review changed, and — for larvae / pupae —
the measured size distributions.
"""

from __future__ import annotations

import statistics
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analysis import AnalysisBatch, AnalysisImage
from app.schemas.analysis import (
    BatchAnalytics,
    BatchAnalyticsImage,
    BatchClassRow,
    BatchCountStats,
    BatchReviewStats,
    DashboardHistogramBin,
)
from app.services.dashboard_service import size_distributions

_POLYGON_ORGANISMS = ("larvae", "pupae")
_CONFIDENCE_BINS = 20
_LOW_CONFIDENCE = 0.5

# The boxes that count for an image: the reviewed list once there is one,
# else what the model produced. A JSONB column can hold JSON ``null``, so the
# type is checked rather than relying on SQL NULL.
_EFFECTIVE_BOXES = """
    CASE
        WHEN jsonb_typeof(i.edited_annotations) = 'array' THEN i.edited_annotations
        WHEN jsonb_typeof(i.annotations) = 'array' THEN i.annotations
        ELSE '[]'::jsonb
    END
"""

_IMAGE_REVIEW_SQL = text("""
    SELECT
        i.id,
        CASE WHEN jsonb_typeof(i.annotations) = 'array'
             THEN jsonb_array_length(i.annotations) END AS model_count,
        jsonb_typeof(i.edited_annotations) = 'array' AS edited,
        (
            SELECT count(*)
            FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(i.edited_annotations) = 'array'
                     THEN i.edited_annotations ELSE '[]'::jsonb END
            ) AS b
            WHERE b ->> 'origin' = 'user'
        ) AS user_added
    FROM analysis_image i
    WHERE i.batch_id = :batch_id
    """)

_POLYGON_REVIEW_SQL = text("""
    SELECT
        d.image_id,
        count(*) FILTER (WHERE d.origin = 'user') AS user_added,
        bool_or(d.edited_polygon IS NOT NULL OR d.origin = 'user') AS edited,
        count(m.length_mm) AS measured,
        avg(m.length_mm) AS mean_length_mm
    FROM larvae_detection d
    JOIN analysis_image i ON i.id = d.image_id
    LEFT JOIN larvae_measurement m ON m.detection_id = d.id
    WHERE i.batch_id = :batch_id
    GROUP BY d.image_id
    """)

# width_bucket(x, 0, 1, n) puts x == 1.0 in bucket n + 1; fold it back.
_BOX_CONFIDENCE_SQL = text(f"""
    SELECT least(width_bucket((b ->> 'confidence')::float8, 0.0, 1.0, :bins), :bins),
           count(*)
    FROM analysis_image i
    CROSS JOIN LATERAL jsonb_array_elements({_EFFECTIVE_BOXES}) AS b
    WHERE i.batch_id = :batch_id
      AND i.status = 'completed'
      AND jsonb_typeof(b -> 'confidence') = 'number'
      AND coalesce(b ->> 'origin', 'model') <> 'user'
    GROUP BY 1
    """)

_POLYGON_CONFIDENCE_SQL = text("""
    SELECT least(width_bucket(d.confidence, 0.0, 1.0, :bins), :bins), count(*)
    FROM larvae_detection d
    JOIN analysis_image i ON i.id = d.image_id
    WHERE i.batch_id = :batch_id
      AND i.status = 'completed'
      AND d.origin IS DISTINCT FROM 'user'
    GROUP BY 1
    """)

_CLASSES_SQL = text(f"""
    SELECT b ->> 'label' AS label, count(*)
    FROM analysis_image i
    CROSS JOIN LATERAL jsonb_array_elements({_EFFECTIVE_BOXES}) AS b
    WHERE i.batch_id = :batch_id
      AND i.status = 'completed'
      AND coalesce(b ->> 'label', '') <> ''
    GROUP BY 1
    ORDER BY 2 DESC, 1
    """)


def _count_stats(counts: list[int]) -> BatchCountStats:
    if not counts:
        return BatchCountStats()
    mean = statistics.fmean(counts)
    sd = statistics.stdev(counts) if len(counts) > 1 else None
    return BatchCountStats(
        images=len(counts),
        total=sum(counts),
        mean=mean,
        median=float(statistics.median(counts)),
        sd=sd,
        cv=(sd / mean) if sd is not None and mean > 0 else None,
        min=min(counts),
        max=max(counts),
    )


class BatchAnalyticsService:
    """Read-only analytics for a single batch. Stateless."""

    async def get_analytics(
        self, batch_id: UUID, db: AsyncSession, user_id: UUID
    ) -> BatchAnalytics | None:
        """Analytics for a batch the caller owns, else ``None``."""
        batch = (
            await db.execute(
                select(AnalysisBatch.id, AnalysisBatch.organism_type)
                .where(AnalysisBatch.id == batch_id)
                .where(AnalysisBatch.user_id == user_id)
            )
        ).one_or_none()
        if batch is None:
            return None
        organism = batch.organism_type
        polygon = organism in _POLYGON_ORGANISMS
        params = {"batch_id": batch_id}

        rows = (
            await db.execute(
                select(
                    AnalysisImage.id,
                    AnalysisImage.original_filename,
                    AnalysisImage.status,
                    AnalysisImage.count,
                    AnalysisImage.avg_confidence,
                    AnalysisImage.elapsed_secs,
                )
                .where(AnalysisImage.batch_id == batch_id)
                .order_by(AnalysisImage.created_at)
            )
        ).all()
        review_by_image = {r.id: r for r in await db.execute(_IMAGE_REVIEW_SQL, params)}
        polygon_by_image = (
            {r.image_id: r for r in await db.execute(_POLYGON_REVIEW_SQL, params)}
            if polygon
            else {}
        )

        images: list[BatchAnalyticsImage] = []
        for r in rows:
            review = review_by_image.get(r.id)
            model_count = review.model_count if review else None
            image = BatchAnalyticsImage(
                id=r.id,
                filename=r.original_filename,
                status=r.status,
                count=r.count,
                avg_confidence=r.avg_confidence,
                elapsed_secs=r.elapsed_secs,
                model_count=model_count,
            )
            if polygon:
                # Polygon review lives in larvae_detection. A deleted detection
                # leaves no row behind, so a changed count also means "edited".
                p = polygon_by_image.get(r.id)
                image.user_added = int(p.user_added) if p else 0
                image.measured = int(p.measured) if p else 0
                image.mean_length_mm = (
                    float(p.mean_length_mm)
                    if p and p.mean_length_mm is not None
                    else None
                )
                image.edited = bool(p and p.edited) or (
                    r.status == "completed"
                    and model_count is not None
                    and r.count is not None
                    and r.count != model_count
                )
            elif review:
                image.user_added = int(review.user_added or 0)
                image.edited = bool(review.edited)
            images.append(image)

        completed = [i for i in images if i.status == "completed"]
        counts = _count_stats([i.count or 0 for i in completed])

        band_counts = {
            int(band): int(n)
            for band, n in await db.execute(
                _POLYGON_CONFIDENCE_SQL if polygon else _BOX_CONFIDENCE_SQL,
                {**params, "bins": _CONFIDENCE_BINS},
            )
            if band is not None
        }
        step = 1.0 / _CONFIDENCE_BINS
        histogram = [
            DashboardHistogramBin(
                start=round(i * step, 4),
                end=round((i + 1) * step, 4),
                # Bucket 0 holds anything below 0 — keep it with the first band.
                count=band_counts.get(i + 1, 0)
                + (band_counts.get(0, 0) if i == 0 else 0),
            )
            for i in range(_CONFIDENCE_BINS)
        ]

        classes = (
            []
            if polygon
            else [
                BatchClassRow(label=label, count=int(n))
                for label, n in await db.execute(_CLASSES_SQL, params)
            ]
        )

        reviewed = [i for i in completed if i.model_count is not None]
        review_stats = BatchReviewStats(
            images_edited=sum(1 for i in completed if i.edited),
            model_detections=sum(i.model_count or 0 for i in reviewed),
            user_added=sum(i.user_added for i in completed),
            net_change=sum((i.count or 0) - (i.model_count or 0) for i in reviewed),
            low_confidence_detections=sum(
                b.count for b in histogram if b.end <= _LOW_CONFIDENCE + 1e-9
            ),
            low_confidence_images=sum(
                1
                for i in completed
                if (i.count or 0) > 0
                and i.avg_confidence is not None
                and i.avg_confidence < _LOW_CONFIDENCE
            ),
        )

        sizes = (
            await size_distributions(
                db, organism, lambda stmt: stmt.where(AnalysisBatch.id == batch_id)
            )
            if polygon
            else []
        )

        return BatchAnalytics(
            batch_id=batch_id,
            organism=organism,
            images=images,
            counts=counts,
            detection_confidence=histogram,
            classes=classes,
            review=review_stats,
            sizes=sizes,
        )
