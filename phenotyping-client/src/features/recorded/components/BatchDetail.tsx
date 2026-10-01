// BatchDetail — full detail view for a single analysis batch.
//
// Layout:
//   - Header: back link, inline-editable name, organism / status chips, date,
//     and the actions (Add images, Download, Continue edit).
//   - A 4-up row of stat tiles (images, total count, time, confidence).
//   - "Run details": device / mode / classes, the config snapshot and notes.
//   - Processed images as a grid of compact cards (server-built thumbnail on
//     top, stats below). Clicking a card opens the result viewer on that image.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
    AlertCircle,
    ArrowLeft,
    ArrowRight,
    Calendar,
    CheckCircle2,
    ChevronDown,
    Clock,
    Cpu,
    Download,
    Gauge,
    ImagePlus,
    Images,
    Loader2,
    Sigma,
} from 'lucide-react';
import { toast } from 'sonner';

import {
    ErrorState,
    OrganismBadge,
    PaginationBar,
    StatTile,
    StatusBadge,
    Thumbnail,
} from '@/components/common';
import { InlineEditableText } from '@/components/common/InlineEditableText';
import { LoadingScreen } from '@/components/LoadingScreen';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
    formatCount,
    formatDateTime,
    formatDuration,
    formatNumber,
    formatPercent,
    pluralize,
} from '@/lib/format';
import { listContainerVariants, listItemVariants } from '@/lib/motion';
import { countLabel, isPolygonOrganism, organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';
import { getAnalysisDetail, getThumbnailUrl, renameBatch } from '@/services/api';
import type { AnalysisBatchDetail, AnalysisImageSummary } from '@/types/api';
import { openBatchInResults } from '../lib/openBatchInResults';
import { addImagesPath } from '../lib/paths';
import { DownloadBatchDialog } from './DownloadBatchDialog';

// The processed-images grid. These two constants must stay in sync with
// IMAGE_GRID below — the page size (exactly two rows) is derived from them.
const CARD_MIN_WIDTH = 160;
const GRID_GAP = 16;
const IMAGE_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4';

/** While a batch is processing, poll so counts and the action bar catch up. */
const PROCESSING_POLL_MS = 4000;

function detailKey(batchId: string | null) {
    return ['analysis-detail', batchId, { includeAnnotations: false }] as const;
}

// ── Small pieces ────────────────────────────────────────────────────────────

const IMAGE_STATUS: Record<string, { label: string; icon: React.ElementType; className: string }> =
    {
        completed: { label: 'Completed', icon: CheckCircle2, className: 'text-success' },
        failed: { label: 'Failed', icon: AlertCircle, className: 'text-destructive' },
        processing: { label: 'Processing', icon: Loader2, className: 'text-info' },
    };
const PENDING_STATUS = { label: 'Pending', icon: Clock, className: 'text-muted-foreground' };

/** Thin confidence meter. Spans only, so it can sit inside a `<p>`. */
function ConfidenceBar({ value, className }: { value: number; className?: string }) {
    const pct = Math.max(0, Math.min(100, value * 100));
    return (
        <span
            aria-hidden
            className={cn('block h-1 overflow-hidden rounded-full bg-muted', className)}
        >
            <span
                className="block h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                style={{ width: `${pct}%` }}
            />
        </span>
    );
}

function Chip({
    children,
    className,
    title,
}: {
    children: React.ReactNode;
    className?: string;
    title?: string;
}) {
    return (
        <span
            title={title}
            className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 text-xs font-medium text-foreground',
                className,
            )}
        >
            {children}
        </span>
    );
}

/** Carries the tooltip for a button that may be disabled (disabled buttons
 *  ignore the pointer, so their own `title` never shows). */
function WithHint({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <span title={title} className="inline-flex">
            {children}
        </span>
    );
}

function BackButton({ onClick }: { onClick: () => void }) {
    return (
        <Button
            variant="ghost"
            size="xs"
            onClick={onClick}
            title="Back to recorded batches"
            className="-ml-2 text-muted-foreground hover:text-foreground"
        >
            <ArrowLeft aria-hidden />
            Recorded batches
        </Button>
    );
}

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full flex-col">
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6 px-6 py-6">
                    {children}
                </div>
            </div>
        </div>
    );
}

function formatConfigValue(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

// ── Run details ─────────────────────────────────────────────────────────────

function RunDetails({ detail }: { detail: AnalysisBatchDetail }) {
    const [configOpen, setConfigOpen] = useState(false);
    const config = Object.entries(detail.config_snapshot ?? {});
    const classes = detail.classes ?? [];

    return (
        <section className="panel" aria-labelledby="run-details-title">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
                <h2 id="run-details-title" className="text-sm font-semibold">
                    Run details
                </h2>

                <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <div className="flex items-center gap-2">
                        <dt className="eyebrow">Device</dt>
                        <dd>
                            <Chip className="font-mono uppercase">
                                <Cpu className="size-3.5 text-muted-foreground" aria-hidden />
                                {detail.device}
                            </Chip>
                        </dd>
                    </div>
                    <div className="flex items-center gap-2">
                        <dt className="eyebrow">Mode</dt>
                        <dd>
                            <Chip className="capitalize">{detail.mode}</Chip>
                        </dd>
                    </div>
                    {classes.length > 0 && (
                        <div className="flex items-center gap-2">
                            <dt className="eyebrow">Classes</dt>
                            <dd className="flex flex-wrap items-center gap-1.5">
                                {classes.map((c) => (
                                    <Chip key={c}>{c}</Chip>
                                ))}
                            </dd>
                        </div>
                    )}
                </dl>

                {config.length > 0 && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-muted-foreground hover:text-foreground"
                        onClick={() => setConfigOpen((open) => !open)}
                        aria-expanded={configOpen}
                        aria-controls="run-details-config"
                    >
                        Config snapshot
                        <span className="tabular-nums">({config.length})</span>
                        <ChevronDown
                            className={cn(
                                'transition-transform duration-150 ease-out',
                                configOpen && 'rotate-180',
                            )}
                            aria-hidden
                        />
                    </Button>
                )}
            </div>

            {config.length > 0 && configOpen && (
                <div id="run-details-config" className="border-t border-border p-4">
                    <dl className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-8 gap-y-2 font-mono text-xs">
                        {config.map(([key, raw]) => {
                            const value = formatConfigValue(raw);
                            return (
                                <div
                                    key={key}
                                    className="flex min-w-0 items-baseline justify-between gap-3"
                                >
                                    <dt className="truncate text-muted-foreground" title={key}>
                                        {key}
                                    </dt>
                                    <dd
                                        className="max-w-[60%] truncate font-medium tabular-nums text-foreground"
                                        title={value}
                                    >
                                        {value}
                                    </dd>
                                </div>
                            );
                        })}
                    </dl>
                </div>
            )}

            {detail.notes && (
                <div className="border-t border-border p-4">
                    <h3 className="eyebrow mb-1.5">Notes</h3>
                    <p className="max-w-3xl whitespace-pre-wrap text-sm">{detail.notes}</p>
                </div>
            )}
        </section>
    );
}

// ── Image card ──────────────────────────────────────────────────────────────

interface ImageCardProps {
    image: AnalysisImageSummary;
    batchId: string;
    organism: string;
    onOpen: (image: AnalysisImageSummary) => void;
}

const ImageCard = memo(function ImageCard({ image, batchId, organism, onOpen }: ImageCardProps) {
    const info = IMAGE_STATUS[image.status] ?? PENDING_STATUS;
    const StatusIcon = info.icon;
    const canOpen = image.status === 'completed';
    // Small server-built JPEG, fetched only once the card nears the viewport.
    const thumbSrc = image.overlay_path ? getThumbnailUrl(batchId, image.id, 'overlay', 320) : null;

    return (
        <div
            className={cn(
                'group/card panel flex h-full flex-col overflow-hidden outline-none',
                'transition-[border-color,box-shadow] duration-150 ease-out',
                canOpen
                    ? 'cursor-pointer hover:border-foreground/20 hover:shadow-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
                    : 'opacity-80',
            )}
            onClick={() => canOpen && onOpen(image)}
            onKeyDown={(e) => {
                if (!canOpen) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(image);
                }
            }}
            role={canOpen ? 'button' : undefined}
            tabIndex={canOpen ? 0 : undefined}
            aria-label={canOpen ? `Open ${image.original_filename}` : undefined}
        >
            {/* Square thumbnail, so every card has the same footprint */}
            <div className="relative border-b border-border">
                <Thumbnail src={thumbSrc} alt="" className="aspect-square w-full" />
                {canOpen && (
                    <span
                        aria-hidden
                        className="pointer-events-none absolute inset-0 bg-foreground/0 transition-colors duration-150 ease-out group-hover/card:bg-foreground/5"
                    />
                )}
                {/* Always visible, so failures stand out at a glance */}
                <span
                    title={info.label}
                    className={cn(
                        'absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-full border border-border bg-card/90',
                        info.className,
                    )}
                >
                    <StatusIcon
                        className={cn('size-3.5', image.status === 'processing' && 'animate-spin')}
                        aria-hidden
                    />
                    <span className="sr-only">{info.label}</span>
                </span>
            </div>

            <div className="flex flex-1 flex-col gap-1.5 p-3">
                <p className="truncate text-xs font-medium" title={image.original_filename}>
                    {image.original_filename}
                </p>

                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
                    {image.count !== null && (
                        <span className="font-medium text-foreground">
                            {countLabel(organism, image.count)}
                        </span>
                    )}
                    {image.elapsed_secs !== null && (
                        <span className="inline-flex items-center gap-1" title="Processing time">
                            <Clock className="size-3" aria-hidden />
                            {formatDuration(image.elapsed_secs)}
                        </span>
                    )}
                </div>

                {image.error_message && (
                    <p
                        className="flex min-w-0 items-center gap-1 text-xs text-destructive"
                        title={image.error_message}
                    >
                        <AlertCircle className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">{image.error_message}</span>
                    </p>
                )}

                {image.avg_confidence !== null && (
                    <div className="mt-auto flex items-center gap-2" title="Average confidence">
                        <ConfidenceBar value={image.avg_confidence} className="flex-1" />
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {formatPercent(image.avg_confidence, 0)}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
});

// ── Page ────────────────────────────────────────────────────────────────────

function BatchIdRedirect() {
    const navigate = useNavigate();
    useEffect(() => {
        navigate('/recorded', { replace: true });
    }, [navigate]);
    return null;
}

function DetailSkeleton({ onBack }: { onBack: () => void }) {
    return (
        <Shell>
            <div className="flex flex-col gap-2" role="status" aria-label="Loading batch">
                <div>
                    <BackButton onClick={onBack} />
                </div>
                <Skeleton className="h-8 w-72 max-w-full" />
                <Skeleton className="h-5 w-56 max-w-full" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile label="Images processed" value="" icon={Images} loading />
                <StatTile label="Total count" value="" icon={Sigma} loading />
                <StatTile label="Processing time" value="" icon={Clock} loading />
                <StatTile label="Average confidence" value="" icon={Gauge} loading />
            </div>
            <Skeleton className="h-14 rounded-xl" />
            <div className={IMAGE_GRID}>
                {Array.from({ length: 12 }).map((_, i) => (
                    <Skeleton key={i} className="aspect-[4/5] rounded-xl" />
                ))}
            </div>
        </Shell>
    );
}

export function BatchDetail() {
    const [searchParams] = useSearchParams();
    const batchId = searchParams.get('batch');
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    // Page state for the processed-images grid. Page size is derived from the
    // measured grid width (see gridRef / columns below) so that exactly two
    // rows render per page regardless of viewport size.
    const [page, setPage] = useState(1);
    const gridRef = useRef<HTMLDivElement>(null);
    const [columns, setColumns] = useState(6);
    const [transitioning, setTransitioning] = useState(false);
    const [downloadOpen, setDownloadOpen] = useState(false);

    const detailQuery = useQuery({
        queryKey: detailKey(batchId),
        enabled: Boolean(batchId),
        queryFn: ({ signal }) =>
            getAnalysisDetail(batchId as string, signal, { includeAnnotations: false }),
        // Coming back from the editor or the upload page: show the cached
        // batch at once, but always refresh it.
        refetchOnMount: 'always',
        refetchInterval: (query) =>
            query.state.data?.status === 'processing' ? PROCESSING_POLL_MS : false,
    });
    const detail = detailQuery.data ?? null;
    const hasDetail = detail !== null;
    const loading = detailQuery.isPending;
    const error = detailQuery.error
        ? detailQuery.error instanceof Error
            ? detailQuery.error.message
            : String(detailQuery.error)
        : null;

    // Measure the grid so we can derive "how many cards fit per row" and
    // page-size the list to exactly two rows.
    //
    // Uses useLayoutEffect so the measurement commits before paint — otherwise
    // the first frame shows columns = initial default (e.g. 6) and the user
    // briefly sees the wrong page size even though the grid CSS has already
    // packed more columns than that.
    useLayoutEffect(() => {
        const el = gridRef.current;
        if (!el) return;
        const measure = () => {
            // getBoundingClientRect keeps the sub-pixel width that clientWidth
            // rounds away; the 0.5 px of slack stops a fractional width from
            // dropping a column the CSS grid actually fits.
            const w = el.getBoundingClientRect().width;
            if (w <= 0) return;
            const cols = Math.max(
                1,
                Math.floor((w + GRID_GAP + 0.5) / (CARD_MIN_WIDTH + GRID_GAP)),
            );
            setColumns((prev) => (prev === cols ? prev : cols));
        };
        measure();
        let rafId = 0;
        const debounced = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                measure();
            });
        };
        const ro = new ResizeObserver(debounced);
        ro.observe(el);
        return () => {
            ro.disconnect();
            if (rafId) cancelAnimationFrame(rafId);
        };
    }, [hasDetail]);

    const imageCount = detail?.images.length ?? 0;

    // Clamp `page` when the derived `pageCount` shrinks under us (resize,
    // batch reload). Sits before the early returns to keep hook order stable.
    useEffect(() => {
        if (!hasDetail) return;
        const ps = Math.max(columns * 2, 1);
        const pc = Math.max(1, Math.ceil(imageCount / ps));
        if (page > pc) setPage(pc);
    }, [page, columns, hasDetail, imageCount]);

    const stats = useMemo(() => {
        const images = detail?.images ?? [];
        let completed = 0;
        let failed = 0;
        const elapsed: number[] = [];
        for (const img of images) {
            if (img.status === 'completed') completed++;
            else if (img.status === 'failed') failed++;
            if (img.elapsed_secs !== null && img.elapsed_secs >= 0) elapsed.push(img.elapsed_secs);
        }
        let timing: string | undefined;
        if (elapsed.length === 1) {
            timing = `${formatDuration(elapsed[0])} for 1 image`;
        } else if (elapsed.length > 1) {
            const avg = elapsed.reduce((a, b) => a + b, 0) / elapsed.length;
            timing =
                `avg ${formatDuration(avg)} per image · ` +
                `min ${formatDuration(Math.min(...elapsed))} · ` +
                `max ${formatDuration(Math.max(...elapsed))}`;
        }
        return { completed, failed, timing };
    }, [detail]);

    async function loadFullDetailForEdit(): Promise<AnalysisBatchDetail | null> {
        if (!detail) return null;
        // Initial detail was fetched without annotations; re-fetch the full
        // payload now that the user is entering edit so ResultViewer has
        // boxes to render.
        try {
            return await getAnalysisDetail(detail.id, undefined, {
                includeAnnotations: true,
            });
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to load batch annotations');
            return null;
        }
    }

    async function openSingleImage(image: AnalysisImageSummary) {
        if (!detail) return;
        setTransitioning(true);
        const full = await loadFullDetailForEdit();
        if (!full) {
            setTransitioning(false);
            return;
        }
        // Pre-populate sessionStorage as a hot cache for ResultViewer, then
        // navigate with explicit batch + image ids so the URL is the canonical
        // source of truth (reload, share, back/forward all work).
        const ok = openBatchInResults(full, { singleImageId: image.id });
        if (!ok) {
            setTransitioning(false);
            return;
        }
        // requestAnimationFrame paints the LoadingScreen before React Router
        // tears this view down, avoiding a blank flash.
        requestAnimationFrame(() => navigate(`/analyze/results/${full.id}/images/${image.id}`));
    }

    async function openAllImages() {
        if (!detail) return;
        setTransitioning(true);
        const full = await loadFullDetailForEdit();
        if (!full) {
            setTransitioning(false);
            return;
        }
        const ok = openBatchInResults(full);
        if (!ok) {
            setTransitioning(false);
            return;
        }
        const firstImageId = full.images[0]?.id;
        const url = firstImageId
            ? `/analyze/results/${full.id}/images/${firstImageId}`
            : `/analyze/results/${full.id}`;
        requestAnimationFrame(() => navigate(url));
    }

    async function rename(next: string) {
        if (!detail) return;
        try {
            const updated = await renameBatch(detail.id, next);
            queryClient.setQueryData(detailKey(detail.id), updated);
            void queryClient.invalidateQueries({ queryKey: ['recorded-batches'] });
            toast.success('Batch renamed');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to rename batch');
            throw err;
        }
    }

    const backToList = () => navigate('/recorded');

    if (transitioning) {
        return <LoadingScreen status="Opening batch..." />;
    }

    if (!batchId) {
        return <BatchIdRedirect />;
    }

    if (loading) {
        return <DetailSkeleton onBack={backToList} />;
    }

    // A failed background refresh keeps the batch on screen; only a batch that
    // never loaded shows the error page.
    if (!detail) {
        if (error === null) return null;
        return (
            <Shell>
                <div>
                    <BackButton onClick={backToList} />
                </div>
                <ErrorState
                    message={error}
                    title="Could not load this analysis batch"
                    onRetry={() => void detailQuery.refetch()}
                    onBack={backToList}
                />
            </Shell>
        );
    }

    const meta = organismMeta(detail.organism_type);
    const { completed: completedCount, failed: failedCount } = stats;
    const canContinue = completedCount > 0;
    const processing = detail.status === 'processing';
    const countOnly =
        isPolygonOrganism(detail.organism_type) && detail.config_snapshot?.count_only === true;

    // Exactly two rows per page. If the width gives us 6 columns → 12 per page,
    // 8 columns → 16, etc. The clamp above handles the case where `page` sits
    // past the end after a resize.
    const pageSize = Math.max(columns * 2, 1);
    const pageCount = Math.max(1, Math.ceil(detail.images.length / pageSize));
    const currentPage = Math.min(page, pageCount);
    const pageStart = (currentPage - 1) * pageSize;
    const pageEnd = Math.min(pageStart + pageSize, detail.images.length);
    const pageImages = detail.images.slice(pageStart, pageEnd);

    return (
        <Shell>
            {/* Header */}
            <header className="flex flex-col gap-2">
                <div>
                    <BackButton onClick={backToList} />
                </div>

                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                    <div className="min-w-0 flex-1 basis-80">
                        <h1 className="min-w-0 text-2xl font-semibold tracking-tight">
                            <InlineEditableText
                                value={detail.name}
                                onSave={rename}
                                ariaLabel="Rename batch"
                                className="max-w-full"
                                inputClassName="max-w-full"
                            />
                        </h1>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
                            <OrganismBadge organism={detail.organism_type} />
                            <StatusBadge status={detail.status} />
                            {countOnly && (
                                <span
                                    title="Sizes are measured on demand in the result viewer"
                                    className="inline-flex h-5 shrink-0 items-center rounded-md border border-info/25 bg-info/10 px-1.5 text-[11px] font-medium text-info"
                                >
                                    Count only
                                </span>
                            )}
                            <span className="inline-flex items-center gap-1.5 pl-1">
                                <Calendar className="size-3.5" aria-hidden />
                                {formatDateTime(detail.created_at)}
                            </span>
                        </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <WithHint
                            title={
                                processing
                                    ? 'This batch is still processing — wait for it to finish before adding images'
                                    : 'Upload more images into this batch'
                            }
                        >
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={processing}
                                onClick={() =>
                                    navigate(addImagesPath(detail.id, detail.organism_type))
                                }
                            >
                                <ImagePlus aria-hidden />
                                Add images
                            </Button>
                        </WithHint>

                        <WithHint
                            title={
                                canContinue
                                    ? 'Download overlays + summary.xlsx as a ZIP'
                                    : 'No completed images to download'
                            }
                        >
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setDownloadOpen(true)}
                                disabled={!canContinue}
                            >
                                <Download aria-hidden />
                                Download
                            </Button>
                        </WithHint>

                        <WithHint
                            title={
                                canContinue
                                    ? 'Open all processed images in the review tool'
                                    : 'No completed images to review'
                            }
                        >
                            <Button size="sm" onClick={openAllImages} disabled={!canContinue}>
                                Continue edit
                                <ArrowRight aria-hidden />
                            </Button>
                        </WithHint>
                    </div>
                </div>
            </header>

            <DownloadBatchDialog
                open={downloadOpen}
                onOpenChange={setDownloadOpen}
                batch={detail}
            />

            {detail.status === 'failed' && detail.failure_reason && (
                <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                >
                    <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>{detail.failure_reason}</span>
                </div>
            )}

            {/* Summary */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                    label="Images processed"
                    icon={Images}
                    value={formatCount(completedCount)}
                    unit={`of ${formatCount(detail.total_image_count)}`}
                    hint={
                        failedCount > 0 ? (
                            <span className="font-medium text-destructive">
                                +{formatCount(failedCount)} failed
                            </span>
                        ) : completedCount < detail.total_image_count ? (
                            `${formatCount(detail.total_image_count - completedCount)} not processed yet`
                        ) : (
                            'All images processed'
                        )
                    }
                />
                <StatTile
                    label={`Total ${meta.nounPlural}`}
                    icon={Sigma}
                    value={formatCount(detail.total_count)}
                    hint={
                        detail.total_count !== null && completedCount > 0
                            ? `≈ ${formatNumber(detail.total_count / completedCount)} per image`
                            : undefined
                    }
                />
                <StatTile
                    label="Processing time"
                    icon={Clock}
                    value={formatDuration(detail.total_elapsed_secs)}
                    hint={stats.timing && <span title={stats.timing}>{stats.timing}</span>}
                />
                <StatTile
                    label="Average confidence"
                    icon={Gauge}
                    value={formatPercent(detail.avg_confidence)}
                    hint={
                        detail.avg_confidence !== null && (
                            <ConfidenceBar value={detail.avg_confidence} className="mt-1.5 h-1.5" />
                        )
                    }
                />
            </div>

            <RunDetails detail={detail} />

            {/* Processed images */}
            <section aria-labelledby="processed-images-title">
                <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h2 id="processed-images-title" className="text-sm font-semibold">
                        Processed images
                    </h2>
                    <span className="text-xs tabular-nums text-muted-foreground">
                        {formatCount(detail.images.length)}{' '}
                        {pluralize(detail.images.length, 'image')}
                    </span>
                    {failedCount > 0 && (
                        <span className="inline-flex h-5 items-center gap-1 rounded-md border border-destructive/25 bg-destructive/10 px-1.5 text-[11px] font-medium tabular-nums text-destructive">
                            <AlertCircle className="size-3" aria-hidden />
                            {formatCount(failedCount)} failed
                        </span>
                    )}
                    {pageCount > 1 && (
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            Showing {pageStart + 1}–{pageEnd} of {detail.images.length}
                        </span>
                    )}
                </div>

                {/* Stable wrapper — this div never unmounts across page flips, so
                    the ResizeObserver stays attached. The motion.div inside takes
                    `key={currentPage}` to replay the stagger on each page change,
                    but the outer width is what we measure. */}
                <div ref={gridRef} className="w-full scroll-mt-14">
                    {detail.images.length === 0 ? (
                        <div className="panel px-4 py-10 text-center text-sm text-muted-foreground">
                            This batch has no images yet.
                        </div>
                    ) : (
                        <motion.div
                            className={IMAGE_GRID}
                            variants={listContainerVariants}
                            initial="hidden"
                            animate="visible"
                            key={currentPage}
                        >
                            {pageImages.map((image) => (
                                <motion.div
                                    key={image.id}
                                    variants={listItemVariants}
                                    className="h-full min-w-0"
                                >
                                    <ImageCard
                                        image={image}
                                        batchId={detail.id}
                                        organism={detail.organism_type}
                                        onOpen={openSingleImage}
                                    />
                                </motion.div>
                            ))}
                        </motion.div>
                    )}
                </div>

                {pageCount > 1 && (
                    <div className="mt-6">
                        <PaginationBar
                            page={currentPage}
                            pageCount={pageCount}
                            onChange={(p) => {
                                setPage(p);
                                // Scroll back to the top of the grid so the new
                                // page is visible without extra scrolling.
                                requestAnimationFrame(() => {
                                    gridRef.current?.scrollIntoView({
                                        behavior: 'smooth',
                                        block: 'start',
                                    });
                                });
                            }}
                        />
                    </div>
                )}
            </section>
        </Shell>
    );
}
