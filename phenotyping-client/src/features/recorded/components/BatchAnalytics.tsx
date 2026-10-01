// BatchAnalytics — the analytics view of one batch, shown in the main area of
// the batch page in place of the image grid.
//
// Layout:
//   - Headline tiles: mean per image, range, model confidence, review.
//   - Count per image (one column per image, click to open it) beside the
//     detection-confidence histogram.
//   - Larvae / pupae: measured size distributions.
//   - Processing time per image beside the images worth a second look.
//   - A sortable per-image table — every plotted value, readable.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    AlertCircle,
    ArrowDown,
    ArrowUp,
    ChartNoAxesColumn,
    CheckCircle2,
    Gauge,
    PencilLine,
    Sigma,
    UnfoldVertical,
} from 'lucide-react';

import { ErrorState, StatTile } from '@/components/common';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartCard, ChartEmpty, DataTable } from '@/features/dashboard/components/ChartCard';
import { ColumnChart } from '@/features/dashboard/components/ColumnChart';
import { SizeDistributionCard } from '@/features/dashboard/components/SizeDistributionCard';
import { formatCount, formatDuration, formatNumber, formatPercent, pluralize } from '@/lib/format';
import { isPolygonOrganism, organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';
import { getBatchAnalytics } from '@/services/api';
import type { BatchAnalytics as BatchAnalyticsData, BatchAnalyticsImage } from '@/types/api';

const LOW_CONFIDENCE = 0.5;
/** A count this many standard deviations from the batch mean is flagged. */
const OUTLIER_Z = 2;
/** Below this many images a standard deviation says too little to flag on. */
const OUTLIER_MIN_IMAGES = 5;
const NEUTRAL = 'color-mix(in oklab, var(--foreground) 55%, transparent)';

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatCount(Math.abs(n))}`;

/** One decimal for small averages, none once the decimals stop mattering. */
function formatMean(value: number | null): string {
    return formatNumber(value, value !== null && Math.abs(value) >= 100 ? 0 : 1);
}

interface BatchAnalyticsProps {
    batchId: string;
    organism: string;
    /** Detection-weighted mean confidence of the batch. */
    avgConfidence: number | null;
    onOpenImage: (imageId: string) => void;
}

export function BatchAnalytics({
    batchId,
    organism,
    avgConfidence,
    onOpenImage,
}: BatchAnalyticsProps) {
    const query = useQuery({
        queryKey: ['analysis-analytics', batchId],
        queryFn: ({ signal }) => getBatchAnalytics(batchId, signal),
        // Counts and sizes change in the review tool: always refresh on return.
        refetchOnMount: 'always',
    });

    if (query.isPending) return <AnalyticsSkeleton />;
    if (!query.data) {
        return (
            <div className="panel">
                <ErrorState
                    title="Could not load analytics for this batch"
                    message={
                        query.error instanceof Error ? query.error.message : String(query.error)
                    }
                    onRetry={() => void query.refetch()}
                />
            </div>
        );
    }
    return (
        <AnalyticsBody
            data={query.data}
            organism={organism}
            avgConfidence={avgConfidence}
            onOpenImage={onOpenImage}
        />
    );
}

function AnalyticsSkeleton() {
    return (
        <div className="flex flex-col gap-4" role="status" aria-label="Loading analytics">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile label="Mean per image" value="" icon={Sigma} loading />
                <StatTile label="Range per image" value="" icon={UnfoldVertical} loading />
                <StatTile label="Model confidence" value="" icon={Gauge} loading />
                <StatTile label="Reviewed by hand" value="" icon={PencilLine} loading />
            </div>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
                <Skeleton className="h-72 rounded-xl" />
                <Skeleton className="h-72 rounded-xl" />
            </div>
            <Skeleton className="h-64 rounded-xl" />
        </div>
    );
}

// ── Flags ───────────────────────────────────────────────────────────────────

interface Flag {
    image: BatchAnalyticsImage;
    reason: string;
    severe: boolean;
}

function buildFlags(data: BatchAnalyticsData, polygon: boolean): Flag[] {
    const { mean, sd, images: n } = data.counts;
    const anyMeasured = data.images.some((i) => i.measured > 0);
    const flags: Flag[] = [];
    for (const image of data.images) {
        if (image.status === 'failed') {
            flags.push({ image, reason: 'Processing failed', severe: true });
            continue;
        }
        if (image.status !== 'completed') continue;
        const count = image.count ?? 0;
        if (count > 0 && image.avg_confidence !== null && image.avg_confidence < LOW_CONFIDENCE) {
            flags.push({
                image,
                reason: `Mean confidence ${formatPercent(image.avg_confidence, 0)}`,
                severe: false,
            });
        }
        if (mean !== null && sd !== null && sd > 0 && n >= OUTLIER_MIN_IMAGES) {
            const z = (count - mean) / sd;
            if (Math.abs(z) >= OUTLIER_Z) {
                flags.push({
                    image,
                    reason: `Count ${formatCount(count)} is far ${z > 0 ? 'above' : 'below'} the batch mean (${formatMean(mean)})`,
                    severe: false,
                });
            }
        }
        // Only once measuring has started: a count-only batch is not "behind".
        if (polygon && anyMeasured && count > 0 && image.measured < count) {
            flags.push({
                image,
                reason:
                    image.measured === 0
                        ? 'Not measured yet'
                        : `${formatCount(count - image.measured)} of ${formatCount(count)} not measured`,
                severe: false,
            });
        }
    }
    return flags;
}

// ── Body ────────────────────────────────────────────────────────────────────

function AnalyticsBody({
    data,
    organism,
    avgConfidence,
    onOpenImage,
}: {
    data: BatchAnalyticsData;
    organism: string;
    avgConfidence: number | null;
    onOpenImage: (imageId: string) => void;
}) {
    const meta = organismMeta(organism);
    const polygon = isPolygonOrganism(organism);
    const { counts, review } = data;

    const completed = useMemo(
        () => data.images.filter((i) => i.status === 'completed'),
        [data.images],
    );
    const flags = useMemo(() => buildFlags(data, polygon), [data, polygon]);
    const confidenceTotal = data.detection_confidence.reduce((sum, b) => sum + b.count, 0);
    const timed = completed.filter((i) => i.elapsed_secs !== null);

    if (completed.length === 0) {
        return (
            <div className="panel flex flex-col items-center gap-2 px-6 py-14 text-center">
                <ChartNoAxesColumn className="size-6 text-muted-foreground/60" aria-hidden />
                <p className="text-sm font-medium">Nothing to analyse yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                    Analytics appear once at least one image of this batch has been processed.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                    label="Mean per image"
                    icon={Sigma}
                    value={formatMean(counts.mean)}
                    unit={meta.nounPlural}
                    hint={
                        counts.sd !== null
                            ? `Median ${formatMean(counts.median)} · SD ${formatMean(counts.sd)}`
                            : `Median ${formatMean(counts.median)}`
                    }
                />
                <StatTile
                    label="Range per image"
                    icon={UnfoldVertical}
                    value={`${formatCount(counts.min)}–${formatCount(counts.max)}`}
                    hint={
                        counts.cv !== null
                            ? `Varies ${formatPercent(counts.cv, 0)} around the mean (CV) · ${formatCount(counts.images)} ${pluralize(counts.images, 'image')}`
                            : `${formatCount(counts.images)} ${pluralize(counts.images, 'image')}`
                    }
                />
                <StatTile
                    label="Model confidence"
                    icon={Gauge}
                    value={formatPercent(avgConfidence)}
                    hint={
                        confidenceTotal === 0
                            ? 'No model detections'
                            : review.low_confidence_detections === 0
                              ? 'No detection below 50%'
                              : `${formatCount(review.low_confidence_detections)} ${pluralize(review.low_confidence_detections, 'detection')} below 50%`
                    }
                />
                <StatTile
                    label="Reviewed by hand"
                    icon={PencilLine}
                    value={formatCount(review.images_edited)}
                    unit={`of ${formatCount(completed.length)} ${pluralize(completed.length, 'image')}`}
                    hint={
                        review.images_edited === 0
                            ? 'Counts are the model output, unedited'
                            : `${signed(review.net_change)} vs model · ${formatCount(review.user_added)} drawn by hand`
                    }
                />
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
                <ChartCard
                    title="Count per image"
                    subtitle={`${meta.label} count of each image, in upload order · dashed line is the batch mean · click a column to open the image`}
                    table={
                        <DataTable
                            columns={[
                                { label: 'Image' },
                                { label: 'Count', numeric: true },
                                { label: 'vs mean', numeric: true },
                            ]}
                            rows={completed.map((i) => [
                                i.filename,
                                formatCount(i.count),
                                counts.mean ? formatDelta((i.count ?? 0) / counts.mean - 1) : '—',
                            ])}
                        />
                    }
                    className="h-full"
                >
                    <ColumnChart
                        series={[{ key: 'count', label: meta.nounPlural, color: meta.color }]}
                        data={completed.map((i, idx) => ({
                            key: i.id,
                            label: String(idx + 1),
                            title: i.filename,
                            values: [i.count ?? 0],
                        }))}
                        references={
                            counts.mean !== null && completed.length > 1
                                ? [{ value: counts.mean, label: `Mean ${formatMean(counts.mean)}` }]
                                : undefined
                        }
                        onSelect={(idx) => onOpenImage(completed[idx].id)}
                        xCaption="Image"
                        ariaLabel={`${meta.label} count per image`}
                    />
                </ChartCard>

                <ChartCard
                    title="Detection confidence"
                    subtitle="Model detections by confidence"
                    table={
                        confidenceTotal > 0 ? (
                            <DataTable
                                columns={[
                                    { label: 'Confidence' },
                                    { label: 'Detections', numeric: true },
                                ]}
                                rows={data.detection_confidence
                                    .filter((b) => b.count > 0)
                                    .map((b) => [
                                        `${pct(b.start)}–${pct(b.end)}`,
                                        b.count.toLocaleString(),
                                    ])}
                            />
                        ) : undefined
                    }
                    className="h-full"
                >
                    {confidenceTotal === 0 ? (
                        <ChartEmpty>No model detections in this batch.</ChartEmpty>
                    ) : (
                        <>
                            <ColumnChart
                                series={[
                                    { key: 'detections', label: 'detections', color: meta.color },
                                ]}
                                data={data.detection_confidence.map((b) => ({
                                    key: String(b.start),
                                    label: pct(b.start),
                                    title: `${pct(b.start)}–${pct(b.end)} confidence`,
                                    values: [b.count],
                                }))}
                                height={170}
                                ariaLabel="Distribution of detection confidence"
                            />
                            <p className="mt-3 text-xs text-muted-foreground">
                                {review.low_confidence_detections === 0 ? (
                                    'No detection falls below 50% confidence.'
                                ) : (
                                    <>
                                        <span className="font-medium text-foreground tabular-nums">
                                            {formatPercent(
                                                review.low_confidence_detections / confidenceTotal,
                                            )}
                                        </span>{' '}
                                        of detections fall below 50% — the first place to look when
                                        reviewing.
                                    </>
                                )}
                            </p>
                        </>
                    )}
                </ChartCard>
            </div>

            {polygon && <SizeDistributionCard sizes={data.sizes} scope="batch" />}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
                <ChartCard
                    title="Processing time per image"
                    subtitle="Seconds the pipeline spent on each image, in upload order"
                    table={
                        timed.length > 0 ? (
                            <DataTable
                                columns={[{ label: 'Image' }, { label: 'Time', numeric: true }]}
                                rows={timed.map((i) => [
                                    i.filename,
                                    formatDuration(i.elapsed_secs),
                                ])}
                            />
                        ) : undefined
                    }
                    className="h-full"
                >
                    {timed.length === 0 ? (
                        <ChartEmpty>No timing was recorded for this batch.</ChartEmpty>
                    ) : (
                        <ColumnChart
                            series={[{ key: 'secs', label: 'processing', color: NEUTRAL }]}
                            data={completed.map((i, idx) => ({
                                key: i.id,
                                label: String(idx + 1),
                                title: i.filename,
                                values: [i.elapsed_secs ?? 0],
                            }))}
                            formatValue={formatSeconds}
                            onSelect={(idx) => onOpenImage(completed[idx].id)}
                            height={150}
                            xCaption="Image"
                            ariaLabel="Processing time per image"
                        />
                    )}
                </ChartCard>

                <FlagsCard flags={flags} onOpenImage={onOpenImage} />
            </div>

            {data.classes.length > 1 && <ClassesCard classes={data.classes} color={meta.color} />}

            <ImageTable
                images={data.images}
                mean={counts.mean}
                polygon={polygon}
                onOpenImage={onOpenImage}
            />
        </div>
    );
}

/** Axis-friendly seconds: "0.4s", "12s". */
function formatSeconds(value: number): string {
    return `${Number(value.toFixed(value < 10 ? 2 : 0))}s`;
}

/** Fractional difference → "+12%" / "−8%" / "0%". */
function formatDelta(fraction: number): string {
    const rounded = Math.round(fraction * 100);
    return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)}%`;
}

// ── Worth a second look ─────────────────────────────────────────────────────

function FlagsCard({
    flags,
    onOpenImage,
}: {
    flags: Flag[];
    onOpenImage: (imageId: string) => void;
}) {
    return (
        <section className="panel flex min-w-0 flex-col" aria-labelledby="batch-flags-title">
            <header className="px-5 pt-4">
                <h2 id="batch-flags-title" className="text-sm font-semibold">
                    Worth a second look
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                    Failed images, low confidence and counts far from the rest
                </p>
            </header>
            {flags.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-8 text-center text-sm text-muted-foreground">
                    <CheckCircle2 className="size-5 text-success" aria-hidden />
                    Nothing stands out in this batch.
                </div>
            ) : (
                <ul className="mt-3 max-h-64 divide-y divide-border overflow-y-auto border-t border-border">
                    {flags.map((flag, i) => {
                        const canOpen = flag.image.status === 'completed';
                        const body = (
                            <>
                                <AlertCircle
                                    className={cn(
                                        'mt-0.5 size-4 shrink-0',
                                        flag.severe ? 'text-destructive' : 'text-warning',
                                    )}
                                    aria-hidden
                                />
                                <span className="min-w-0">
                                    <span
                                        className="block truncate text-[13px] font-medium"
                                        title={flag.image.filename}
                                    >
                                        {flag.image.filename}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {flag.reason}
                                    </span>
                                </span>
                            </>
                        );
                        return (
                            <li key={`${flag.image.id}:${i}`}>
                                {canOpen ? (
                                    <button
                                        type="button"
                                        onClick={() => onOpenImage(flag.image.id)}
                                        className="flex w-full items-start gap-2.5 px-5 py-2.5 text-left transition-colors duration-150 outline-none hover:bg-muted/50 focus-visible:bg-muted/70"
                                    >
                                        {body}
                                    </button>
                                ) : (
                                    <div className="flex items-start gap-2.5 px-5 py-2.5">
                                        {body}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

// ── Classes ─────────────────────────────────────────────────────────────────

function ClassesCard({
    classes,
    color,
}: {
    classes: Array<{ label: string; count: number }>;
    color: string;
}) {
    const total = classes.reduce((sum, c) => sum + c.count, 0);
    const top = Math.max(...classes.map((c) => c.count));
    return (
        <section className="panel p-5" aria-labelledby="batch-classes-title">
            <h2 id="batch-classes-title" className="text-sm font-semibold">
                Classes
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
                Detections by label across the batch
            </p>
            <ul className="mt-4 grid gap-x-8 gap-y-2.5 md:grid-cols-2">
                {classes.map((c) => (
                    <li
                        key={c.label}
                        className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-xs"
                    >
                        <span className="truncate font-medium" title={c.label}>
                            {c.label}
                        </span>
                        <span aria-hidden className="h-2 overflow-hidden rounded-full bg-muted">
                            <span
                                className="block h-full rounded-full"
                                style={{
                                    width: `${(c.count / top) * 100}%`,
                                    backgroundColor: color,
                                }}
                            />
                        </span>
                        <span className="text-right tabular-nums text-muted-foreground">
                            <span className="font-medium text-foreground">
                                {formatCount(c.count)}
                            </span>{' '}
                            · {formatPercent(c.count / total, 0)}
                        </span>
                    </li>
                ))}
            </ul>
        </section>
    );
}

// ── Per-image table ─────────────────────────────────────────────────────────

type SortKey = 'order' | 'filename' | 'count' | 'confidence' | 'time' | 'length';

interface Column {
    key: SortKey;
    label: string;
    numeric?: boolean;
    value: (image: BatchAnalyticsImage, order: number) => number | string | null;
}

const BASE_COLUMNS: Column[] = [
    { key: 'order', label: '#', numeric: true, value: (_, order) => order },
    { key: 'filename', label: 'Image', value: (i) => i.filename.toLowerCase() },
    { key: 'count', label: 'Count', numeric: true, value: (i) => i.count },
    {
        key: 'confidence',
        label: 'Confidence',
        numeric: true,
        value: (i) => (i.count ? i.avg_confidence : null),
    },
    { key: 'time', label: 'Time', numeric: true, value: (i) => i.elapsed_secs },
];
const LENGTH_COLUMN: Column = {
    key: 'length',
    label: 'Mean length',
    numeric: true,
    value: (i) => i.mean_length_mm,
};

function ImageTable({
    images,
    mean,
    polygon,
    onOpenImage,
}: {
    images: BatchAnalyticsImage[];
    mean: number | null;
    polygon: boolean;
    onOpenImage: (imageId: string) => void;
}) {
    const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
        key: 'order',
        dir: 'asc',
    });
    const columns = polygon ? [...BASE_COLUMNS, LENGTH_COLUMN] : BASE_COLUMNS;

    const rows = useMemo(() => {
        const column = [...BASE_COLUMNS, LENGTH_COLUMN].find((c) => c.key === sort.key)!;
        const indexed = images.map((image, i) => ({ image, order: i + 1 }));
        indexed.sort((a, b) => {
            const va = column.value(a.image, a.order);
            const vb = column.value(b.image, b.order);
            // Missing values sink to the bottom in either direction.
            if (va === null || vb === null) {
                if (va === vb) return a.order - b.order;
                return va === null ? 1 : -1;
            }
            const cmp = va < vb ? -1 : va > vb ? 1 : a.order - b.order;
            return sort.dir === 'asc' ? cmp : -cmp;
        });
        return indexed;
    }, [images, sort]);

    function toggle(key: SortKey, numeric: boolean) {
        setSort((prev) =>
            prev.key === key
                ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                : // Numbers are most useful biggest-first; names and order ascending.
                  { key, dir: numeric && key !== 'order' ? 'desc' : 'asc' },
        );
    }

    return (
        <section className="panel overflow-hidden" aria-labelledby="batch-image-table-title">
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 pt-4 pb-3">
                <h2 id="batch-image-table-title" className="text-sm font-semibold">
                    All images
                </h2>
                <p className="text-xs text-muted-foreground">
                    Sort by any column · open a row to review that image
                </p>
            </header>
            <div className="max-h-[32rem] overflow-auto border-t border-border">
                <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
                        <tr>
                            {columns.map((c) => {
                                const active = sort.key === c.key;
                                const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
                                return (
                                    <th
                                        key={c.key}
                                        scope="col"
                                        aria-sort={
                                            active
                                                ? sort.dir === 'asc'
                                                    ? 'ascending'
                                                    : 'descending'
                                                : 'none'
                                        }
                                        className={cn(
                                            'px-3 py-2 font-medium first:pl-5',
                                            c.numeric && 'text-right',
                                        )}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => toggle(c.key, Boolean(c.numeric))}
                                            className={cn(
                                                'inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                                active && 'text-foreground',
                                            )}
                                        >
                                            {c.label}
                                            <Arrow
                                                className={cn('size-3', !active && 'opacity-0')}
                                                aria-hidden
                                            />
                                        </button>
                                    </th>
                                );
                            })}
                            <th scope="col" className="px-3 py-2 pr-5 font-medium">
                                Review
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {rows.map(({ image, order }) => {
                            const canOpen = image.status === 'completed';
                            const open = () => onOpenImage(image.id);
                            const lowConfidence =
                                Boolean(image.count) &&
                                image.avg_confidence !== null &&
                                image.avg_confidence < LOW_CONFIDENCE;
                            return (
                                <tr
                                    key={image.id}
                                    tabIndex={canOpen ? 0 : undefined}
                                    role={canOpen ? 'link' : undefined}
                                    aria-label={canOpen ? `Open ${image.filename}` : undefined}
                                    onClick={canOpen ? open : undefined}
                                    onKeyDown={
                                        canOpen
                                            ? (e) => {
                                                  if (e.key === 'Enter') open();
                                              }
                                            : undefined
                                    }
                                    className={cn(
                                        'transition-colors duration-150 outline-none',
                                        canOpen
                                            ? 'cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/70'
                                            : 'text-muted-foreground',
                                    )}
                                >
                                    <td className="py-2 pr-3 pl-5 text-right text-xs tabular-nums text-muted-foreground">
                                        {order}
                                    </td>
                                    <td className="max-w-72 px-3 py-2">
                                        <span
                                            className="block truncate font-medium"
                                            title={image.filename}
                                        >
                                            {image.filename}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {formatCount(image.count)}
                                        {canOpen && mean ? (
                                            <span className="ml-2 inline-block w-11 text-xs text-muted-foreground">
                                                {formatDelta((image.count ?? 0) / mean - 1)}
                                            </span>
                                        ) : null}
                                    </td>
                                    <td
                                        className={cn(
                                            'px-3 py-2 text-right tabular-nums',
                                            lowConfidence && 'font-medium text-warning',
                                        )}
                                    >
                                        {/* No detections → no confidence to report. */}
                                        {image.count ? formatPercent(image.avg_confidence, 0) : '—'}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {formatDuration(image.elapsed_secs)}
                                    </td>
                                    {polygon && (
                                        <td
                                            className="px-3 py-2 text-right tabular-nums"
                                            title={
                                                image.measured > 0
                                                    ? `${formatCount(image.measured)} measured`
                                                    : undefined
                                            }
                                        >
                                            {image.mean_length_mm !== null
                                                ? `${formatNumber(image.mean_length_mm, 2)} mm`
                                                : '—'}
                                        </td>
                                    )}
                                    <td className="px-3 py-2 pr-5 text-xs">
                                        <ReviewCell image={image} />
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function ReviewCell({ image }: { image: BatchAnalyticsImage }) {
    if (image.status === 'failed') {
        return <span className="font-medium text-destructive">Failed</span>;
    }
    if (image.status !== 'completed') {
        return <span className="text-muted-foreground capitalize">{image.status}</span>;
    }
    if (!image.edited) return <span className="text-muted-foreground">Model output</span>;
    const net = image.model_count !== null ? (image.count ?? 0) - image.model_count : null;
    return (
        <span className="inline-flex items-center gap-1.5">
            <PencilLine className="size-3 text-muted-foreground" aria-hidden />
            <span className="font-medium">Edited</span>
            {net !== null && net !== 0 && (
                <span className="tabular-nums text-muted-foreground">{signed(net)} vs model</span>
            )}
        </span>
    );
}
