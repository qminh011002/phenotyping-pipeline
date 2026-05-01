// BatchDetail — full detail view for a single analysis batch.
//
// Layout goals (after the recorded-view redesign):
//   - Fills the full viewport width (no narrow max-w-3xl column).
//   - Header carries the batch name + a single primary "Continue" button
//     that opens the whole batch in the result viewer.
//   - CPU / mode / timing / confidence live in the body as stat cards, not
//     as tiny header badges, so they have room to breathe on a wide screen.
//   - Images render as a responsive grid of compact cards (thumbnail on
//     top, stats below). Clicking a card opens the result viewer focused
//     on that single image — the full batch is still loaded underneath so
//     the user can flip through neighbours after landing.

import { memo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
    ArrowLeft,
    Calendar,
    Clock,
    Egg,
    ImageIcon,
    AlertCircle,
    CheckCircle2,
    Loader2,
    ArrowRight,
    Cpu,
    TrendingUp,
    Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from '@/components/ui/pagination';
import { ErrorState } from '@/components/common/ErrorState';
import { InlineEditableText } from '@/components/common/InlineEditableText';
import { LoadingScreen } from '@/components/LoadingScreen';
import { toast } from 'sonner';
import { getAnalysisDetail, getAnalysesOverlayUrl, renameBatch } from '@/services/api';
import { cn } from '@/lib/utils';
import { listContainerVariants, listItemVariants } from '@/lib/motion';
import type { AnalysisBatchDetail, AnalysisImageSummary } from '@/types/api';
import { useOverlayThumbnail } from '../lib/overlayThumbnail';
import { openBatchInResults } from '../lib/openBatchInResults';
import { DownloadBatchDialog } from './DownloadBatchDialog';

type ImageStatus = 'completed' | 'failed' | 'processing' | 'unknown';

function statusInfo(status: ImageStatus) {
    switch (status) {
        case 'completed':
            return { icon: CheckCircle2, className: 'text-green-500' };
        case 'failed':
            return { icon: AlertCircle, className: 'text-destructive' };
        case 'processing':
            return { icon: Loader2, className: 'text-amber-500 animate-spin' };
        default:
            return { icon: Clock, className: 'text-muted-foreground' };
    }
}

function parseImageStatus(status: string): ImageStatus {
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'processing') return 'processing';
    return 'unknown';
}

function formatElapsed(seconds: number | null): string {
    if (seconds === null) return '—';
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
}

const batchDateFormatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
});
const batchTimeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
});

function formatDate(isoString: string): string {
    return batchDateFormatter.format(new Date(isoString));
}

function formatTime(isoString: string): string {
    return batchTimeFormatter.format(new Date(isoString));
}

const imageVisibilityCallbacks = new Map<Element, () => void>();
let sharedImageObserver: IntersectionObserver | null = null;

function observeImageVisibility(element: Element, onVisible: () => void): () => void {
    if (!sharedImageObserver) {
        sharedImageObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const callback = imageVisibilityCallbacks.get(entry.target);
                    if (!callback) continue;
                    imageVisibilityCallbacks.delete(entry.target);
                    sharedImageObserver?.unobserve(entry.target);
                    callback();
                }
            },
            { rootMargin: '400px 0px' },
        );
    }

    imageVisibilityCallbacks.set(element, onVisible);
    sharedImageObserver.observe(element);

    return () => {
        imageVisibilityCallbacks.delete(element);
        sharedImageObserver?.unobserve(element);
    };
}

interface StatCardProps {
    icon: React.ElementType;
    label: string;
    value: React.ReactNode;
    sub?: React.ReactNode;
    accent?: boolean;
}

function StatCard({ icon: Icon, label, value, sub, accent }: StatCardProps) {
    return (
        <div
            className={cn(
                'flex flex-col gap-2 rounded-md bg-card/55 p-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]',
                accent && 'bg-primary/10 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]',
            )}
        >
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
                {label}
            </div>
            <div className="text-2xl font-bold tabular-nums leading-none">{value}</div>
            {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
        </div>
    );
}

// ── Image card ─────────────────────────────────────────────────────────────

interface ImageCardProps {
    image: AnalysisImageSummary;
    batchId: string;
    onOpen: (image: AnalysisImageSummary) => void;
}

const ImageCard = memo(function ImageCard({ image, batchId, onOpen }: ImageCardProps) {
    const cardRef = useRef<HTMLDivElement>(null);
    // IntersectionObserver-gated thumbnail fetch. Opening a batch with hundreds
    // of images would otherwise fire every fetch + canvas resize on mount.
    const [seen, setSeen] = useState(false);

    useEffect(() => {
        if (seen) return;
        const el = cardRef.current;
        if (!el) return;
        return observeImageVisibility(el, () => setSeen(true));
    }, [seen]);

    const overlaySrc = image.overlay_path ? getAnalysesOverlayUrl(batchId, image.id) : null;
    const { thumbUrl, error: thumbError } = useOverlayThumbnail(overlaySrc, seen);
    const status = parseImageStatus(image.status);
    const info = statusInfo(status);
    const StatusIcon = info.icon;
    const confidencePct =
        image.avg_confidence != null ? Math.round(image.avg_confidence * 100) : null;
    const canOpen = status === 'completed';

    return (
        <div
            ref={cardRef}
            className={cn(
                'group flex flex-col overflow-hidden rounded-md bg-card/55 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition-all duration-150',
                canOpen ? 'cursor-pointer hover:bg-card/80 hover:shadow-sm' : 'opacity-80',
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
            aria-label={canOpen ? `Open ${image.original_filename}` : image.original_filename}
        >
            {/* Thumbnail — aspect-square so every card has a predictable footprint */}
            <div className="relative aspect-square w-full overflow-hidden bg-muted">
                {thumbUrl && !thumbError ? (
                    <img
                        src={thumbUrl}
                        alt={image.original_filename}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                    />
                ) : overlaySrc && !thumbError ? (
                    <Skeleton className="h-full w-full" />
                ) : (
                    <div className="flex h-full w-full items-center justify-center">
                        <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
                    </div>
                )}
                {/* Status pill — always visible, so users can spot failures at a glance */}
                <div
                    className={cn(
                        'absolute top-2 right-2 rounded-full bg-card/85 backdrop-blur-sm p-1 shadow-sm',
                        info.className,
                    )}
                >
                    <StatusIcon className="h-3.5 w-3.5" />
                </div>
            </div>

            {/* Stats strip */}
            <div className="flex flex-col gap-1 p-2">
                <p className="truncate text-xs font-medium" title={image.original_filename}>
                    {image.original_filename}
                </p>

                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    {image.count !== null && (
                        <span className="flex items-center gap-1">
                            <Egg className="h-3 w-3" />
                            {image.count.toLocaleString()}
                        </span>
                    )}
                    {image.elapsed_secs !== null && (
                        <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatElapsed(image.elapsed_secs)}
                        </span>
                    )}
                    {image.error_message && (
                        <span
                            className="flex items-center gap-1 truncate text-destructive"
                            title={image.error_message}
                        >
                            <AlertCircle className="h-3 w-3 shrink-0" />
                            {image.error_message}
                        </span>
                    )}
                </div>

                {confidencePct !== null && (
                    <div className="flex items-center gap-2">
                        <Progress
                            value={confidencePct}
                            variant={confidencePct >= 75 ? 'success' : 'default'}
                            className="h-1 flex-1"
                        />
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {confidencePct}%
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
});

// ── Pagination bar ──────────────────────────────────────────────────────────
// Same shape as UploadPage's compact window — first, last, current ±1, with
// ellipses. Kept local to avoid a premature shared component; if a third
// consumer appears, lift it into `src/components/common`.

function PaginationBar({
    page,
    pageCount,
    onChange,
}: {
    page: number;
    pageCount: number;
    onChange: (page: number) => void;
}) {
    const pages: (number | 'ellipsis')[] = [];
    const push = (v: number | 'ellipsis') => {
        if (v === 'ellipsis' || pages[pages.length - 1] !== v) pages.push(v);
    };
    for (let i = 1; i <= pageCount; i++) {
        if (i === 1 || i === pageCount || Math.abs(i - page) <= 1) push(i);
        else if (i < page) push('ellipsis');
        else if (i > page) {
            push('ellipsis');
            // jump to tail
            while (i < pageCount) i++;
            push(pageCount);
            break;
        }
    }

    return (
        <Pagination>
            <PaginationContent>
                <PaginationItem>
                    <PaginationPrevious
                        href="#"
                        onClick={(e) => {
                            e.preventDefault();
                            if (page > 1) onChange(page - 1);
                        }}
                        aria-disabled={page === 1}
                        className={page === 1 ? 'pointer-events-none opacity-50' : ''}
                    />
                </PaginationItem>
                {pages.map((p, idx) =>
                    p === 'ellipsis' ? (
                        <PaginationItem key={`e${idx}`}>
                            <PaginationEllipsis />
                        </PaginationItem>
                    ) : (
                        <PaginationItem key={p}>
                            <PaginationLink
                                href="#"
                                isActive={p === page}
                                onClick={(e) => {
                                    e.preventDefault();
                                    onChange(p);
                                }}
                            >
                                {p}
                            </PaginationLink>
                        </PaginationItem>
                    ),
                )}
                <PaginationItem>
                    <PaginationNext
                        href="#"
                        onClick={(e) => {
                            e.preventDefault();
                            if (page < pageCount) onChange(page + 1);
                        }}
                        aria-disabled={page === pageCount}
                        className={page === pageCount ? 'pointer-events-none opacity-50' : ''}
                    />
                </PaginationItem>
            </PaginationContent>
        </Pagination>
    );
}

// ── Page ────────────────────────────────────────────────────────────────────

function BatchIdRedirect() {
    const navigate = useNavigate();
    useEffect(() => {
        navigate('/recorded', { replace: true });
    }, [navigate]);
    return null;
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
        queryKey: ['analysis-detail', batchId, { includeAnnotations: false }],
        enabled: Boolean(batchId),
        queryFn: ({ signal }) =>
            getAnalysisDetail(batchId as string, signal, { includeAnnotations: false }),
    });
    const detail = detailQuery.data ?? null;
    const loading = detailQuery.isPending;
    const error = detailQuery.error ? String(detailQuery.error) : null;

    // Measure the grid so we can derive "how many cards fit per row" and
    // page-size the list to exactly two rows. These constants must stay in
    // sync with the grid className (`minmax(120px, 1fr)` + `gap-3` = 12 px).
    //
    // Uses useLayoutEffect so the measurement commits before paint — otherwise
    // the first frame shows columns = initial default (e.g. 6) and the user
    // briefly sees the wrong page size even though the grid CSS has already
    // packed more columns than that.
    const CARD_MIN_WIDTH = 120;
    const GRID_GAP = 12;
    useLayoutEffect(() => {
        const el = gridRef.current;
        if (!el) return;
        const measure = () => {
            // Use getBoundingClientRect to pick up sub-pixel sizing that
            // clientWidth rounds away. Round UP by 0.5 px of slack when deciding
            // column count so a 1283.5-wide grid still counts as fitting 8×150
            // instead of falling back to 7.
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
    }, [Boolean(detail)]);

    // Clamp `page` when the derived `pageCount` shrinks under us (resize,
    // batch reload). Sits before the early returns to keep hook order stable.
    useEffect(() => {
        if (!detail) return;
        const ps = Math.max(columns * 2, 1);
        const pc = Math.max(1, Math.ceil(detail.images.length / ps));
        if (page > pc) setPage(pc);
    }, [page, columns, detail]);

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
        // navigate with explicit ?batch=&image= so the URL is the canonical
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

    if (transitioning) {
        return <LoadingScreen status="Opening batch..." />;
    }

    if (!batchId) {
        return <BatchIdRedirect />;
    }

    if (loading) {
        return (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-3 border-b px-6 py-4">
                    <Skeleton className="h-8 w-8 rounded-lg" />
                    <div className="flex flex-col gap-1.5">
                        <Skeleton className="h-5 w-48" />
                        <Skeleton className="h-3 w-32" />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-6">
                    <div className="space-y-6">
                        <div className="grid gap-4 sm:grid-cols-3">
                            <Skeleton className="h-24 rounded-xl" />
                            <Skeleton className="h-24 rounded-xl" />
                            <Skeleton className="h-24 rounded-xl" />
                        </div>
                        <Skeleton className="h-px w-full" />
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
                            {Array.from({ length: 12 }).map((_, i) => (
                                <Skeleton key={i} className="h-36 rounded-xl" />
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (error !== null) {
        return (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-3 border-b px-6 py-4">
                    <Button variant="ghost" size="icon" onClick={() => navigate('/recorded')}>
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm text-muted-foreground">Batch detail</span>
                </div>
                <div className="flex flex-1 items-center justify-center px-6">
                    <ErrorState
                        message={error}
                        title="Could not load this analysis batch"
                        onRetry={() => void detailQuery.refetch()}
                        onBack={() => navigate('/recorded')}
                    />
                </div>
            </div>
        );
    }

    if (!detail) return null;

    const completedCount = detail.images.filter((i) => i.status === 'completed').length;
    const failedCount = detail.images.filter((i) => i.status === 'failed').length;
    const canContinue = completedCount > 0;

    // Exactly two rows per page. If the width gives us 6 columns → 12 per page,
    // 8 columns → 16, etc. The clamp below handles the case where `page` sits
    // past the end after a resize.
    const pageSize = Math.max(columns * 2, 1);
    const pageCount = Math.max(1, Math.ceil(detail.images.length / pageSize));
    const currentPage = Math.min(page, pageCount);
    const pageStart = (currentPage - 1) * pageSize;
    const pageEnd = Math.min(pageStart + pageSize, detail.images.length);
    const pageImages = detail.images.slice(pageStart, pageEnd);

    return (
        <div className="flex flex-col h-full">
            {/* Header — integrated detail toolbar */}
            <header className="px-6 py-5 border-b">
                <div className="flex flex-col gap-4 mb-1.5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex min-w-0 items-center gap-4">
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => navigate('/recorded')}
                            title="Back to recorded analyses"
                            className=" shrink-0 bg-muted/35 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </Button>

                        <h1 className="min-w-0 text-xl font-semibold leading-tight tracking-normal">
                            <InlineEditableText
                                value={detail.name}
                                onSave={async (next) => {
                                    try {
                                        const updated = await renameBatch(detail.id, next);
                                        queryClient.setQueryData(
                                            [
                                                'analysis-detail',
                                                detail.id,
                                                { includeAnnotations: false },
                                            ],
                                            updated,
                                        );
                                        void queryClient.invalidateQueries({
                                            queryKey: ['recorded-batches'],
                                        });
                                        toast.success('Batch renamed');
                                    } catch (err) {
                                        toast.error(
                                            err instanceof Error
                                                ? err.message
                                                : 'Failed to rename batch',
                                        );
                                        throw err;
                                    }
                                }}
                                ariaLabel="Rename batch"
                                className="max-w-fit"
                            />
                        </h1>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
                        <Button
                            variant="outline"
                            onClick={() => setDownloadOpen(true)}
                            disabled={!canContinue}
                            title={
                                canContinue
                                    ? 'Download overlays + summary.xlsx as a ZIP'
                                    : 'No completed images to download'
                            }
                            className="border-0 bg-muted/45 hover:bg-muted/70"
                        >
                            <Download className="h-4 w-4" />
                            Download
                        </Button>

                        <Button
                            onClick={openAllImages}
                            disabled={!canContinue}
                            title={
                                canContinue
                                    ? 'Open all processed images in the review tool'
                                    : 'No completed images to review'
                            }
                        >
                            Continue Edit
                            <ArrowRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="rounded-md bg-primary/10 px-2 py-1 font-medium text-primary">
                        Recorded batch
                    </span>
                    <span className="capitalize">{detail.organism_type}</span>
                    <span className="text-border">·</span>
                    <span className="inline-flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {formatDate(detail.created_at)} · {formatTime(detail.created_at)}
                    </span>
                </div>
            </header>

            <DownloadBatchDialog
                open={downloadOpen}
                onOpenChange={setDownloadOpen}
                batch={detail}
            />

            {/* Body — full width, no narrow column */}
            <div className="flex-1 overflow-y-auto p-6">
                <div className="space-y-6">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded-md bg-muted/35 px-2 py-1">
                            {completedCount} of {detail.total_image_count} images processed
                        </span>
                        {detail.total_count !== null && (
                            <span className="rounded-md bg-muted/35 px-2 py-1">
                                {detail.total_count.toLocaleString()} total eggs
                            </span>
                        )}
                        {detail.avg_confidence !== null && (
                            <span className="rounded-md bg-muted/35 px-2 py-1">
                                {(detail.avg_confidence * 100).toFixed(1)}% avg confidence
                            </span>
                        )}
                    </div>

                    {/* Meta row — CPU + mode pulled out of the header into proper tiles */}
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge
                            variant="secondary"
                            className="gap-1.5 border-0 bg-muted/45 py-1.5 px-3 text-xs font-mono uppercase"
                        >
                            <Cpu className="h-3.5 w-3.5" />
                            {detail.device}
                        </Badge>
                        <Badge
                            variant="secondary"
                            className="gap-1.5 border-0 bg-muted/45 py-1.5 px-3 text-xs capitalize"
                        >
                            {detail.mode}
                        </Badge>
                        {detail.classes &&
                            detail.classes.length > 0 &&
                            detail.classes.map((c) => (
                                <Badge
                                    key={c}
                                    variant="secondary"
                                    className="border-0 bg-muted/45 py-1.5 px-3 text-xs"
                                >
                                    {c}
                                </Badge>
                            ))}
                    </div>

                    {/* Summary stat cards — 4-up so Average confidence sits on the
              same row as Images processed / Total eggs / Processing time. */}
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <StatCard
                            icon={ImageIcon}
                            label="Images processed"
                            value={
                                <span>
                                    {completedCount}
                                    {failedCount > 0 && (
                                        <span className="ml-2 text-sm font-normal text-destructive">
                                            +{failedCount} failed
                                        </span>
                                    )}
                                </span>
                            }
                            sub={`of ${detail.total_image_count} total`}
                        />

                        <StatCard
                            icon={Egg}
                            label="Total eggs counted"
                            value={
                                detail.total_count !== null
                                    ? detail.total_count.toLocaleString()
                                    : '—'
                            }
                            sub={
                                detail.avg_confidence !== null
                                    ? `avg ${(detail.avg_confidence * 100).toFixed(1)}% confidence`
                                    : undefined
                            }
                            accent
                        />

                        <StatCard
                            icon={Clock}
                            label="Processing time"
                            value={formatElapsed(detail.total_elapsed_secs)}
                            sub={
                                detail.total_elapsed_secs && detail.total_image_count > 0
                                    ? `avg ${(detail.total_elapsed_secs / detail.total_image_count).toFixed(1)}s per image`
                                    : undefined
                            }
                        />

                        {/* Average confidence — keeps the inline progress bar since
                the number alone is less informative at a glance. */}
                        <div className="flex flex-col gap-2 rounded-md bg-card/55 p-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <TrendingUp className="h-3.5 w-3.5" />
                                Average confidence
                            </div>
                            {detail.avg_confidence !== null ? (
                                <>
                                    <div className="text-2xl font-bold tabular-nums leading-none">
                                        {(detail.avg_confidence * 100).toFixed(1)}%
                                    </div>
                                    <Progress
                                        value={detail.avg_confidence * 100}
                                        variant={
                                            detail.avg_confidence >= 0.75 ? 'success' : 'default'
                                        }
                                        className="mt-0.5 h-1.5"
                                    />
                                </>
                            ) : (
                                <div className="text-2xl font-bold tabular-nums leading-none text-muted-foreground">
                                    —
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Config snapshot */}
                    {detail.config_snapshot && Object.keys(detail.config_snapshot).length > 0 && (
                        <div>
                            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Config snapshot
                            </h2>
                            <div className="flex flex-wrap gap-2">
                                {Object.entries(detail.config_snapshot).map(([key, val]) => (
                                    <span
                                        key={key}
                                        className="rounded-md bg-muted/45 px-2 py-1 font-mono text-xs"
                                    >
                                        {key}:{' '}
                                        <span className="text-foreground font-medium">
                                            {String(val)}
                                        </span>
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Notes */}
                    {detail.notes && (
                        <div>
                            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Notes
                            </h2>
                            <p className="rounded-md bg-card/55 px-4 py-3 text-sm shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
                                {detail.notes}
                            </p>
                        </div>
                    )}

                    <Separator />

                    {/* Processed images grid */}
                    <div>
                        <div className="flex items-center justify-between mb-3">
                            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Processed Images ({detail.images.length})
                            </h2>
                            {failedCount > 0 && (
                                <Badge variant="destructive" className="text-xs">
                                    {failedCount} failed
                                </Badge>
                            )}
                        </div>

                        {/* Stable wrapper — this div never unmounts across page flips,
                so the ResizeObserver stays attached. The motion.div inside
                takes `key={currentPage}` to replay the stagger animation
                on each page change, but the outer width is what we measure. */}
                        <div ref={gridRef} className="w-full">
                            <motion.div
                                className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(120px,1fr))]"
                                variants={listContainerVariants}
                                initial="hidden"
                                animate="visible"
                                key={currentPage}
                            >
                                {pageImages.map((image) => (
                                    <motion.div key={image.id} variants={listItemVariants}>
                                        <ImageCard
                                            image={image}
                                            batchId={detail.id}
                                            onOpen={openSingleImage}
                                        />
                                    </motion.div>
                                ))}
                            </motion.div>
                        </div>

                        {pageCount > 1 && (
                            <div className="mt-4 flex flex-col items-center gap-1">
                                <PaginationBar
                                    page={currentPage}
                                    pageCount={pageCount}
                                    onChange={(p) => {
                                        setPage(p);
                                        // Scroll the user back to the top of the grid so the
                                        // newly-rendered page is visible without extra scroll.
                                        requestAnimationFrame(() => {
                                            gridRef.current?.scrollIntoView({
                                                behavior: 'smooth',
                                                block: 'start',
                                            });
                                        });
                                    }}
                                />
                                <span className="text-[11px] text-muted-foreground">
                                    Showing {pageStart + 1}–{pageEnd} of {detail.images.length}
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
