// ProcessingPage — live view of the running batch: overall progress and ETA,
// what each image came out as, and the server's stage log.
//
// The inference loop itself lives in services/processingManager; this page
// only reads the processing store, so leaving and coming back is harmless.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    CircleDashed,
    Loader2,
    PauseCircle,
    ScanLine,
} from 'lucide-react';

import { OrganismBadge } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { LoadingScreen } from '@/components/LoadingScreen';
import { formatDuration, formatPercent, pluralize } from '@/lib/format';
import { isPolygonOrganism, organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';
import {
    loadBatchDetail,
    loadProcessingFiles,
    loadBatchId,
} from '@/features/upload/lib/processingSession';
import { useProcessingStore } from '@/stores/processingStore';
import type { ImageStatus, ProcessingImage, ProcessingLogEntry } from '@/stores/processingStore';
import {
    cancelProcessing,
    discardInterruptedBatch,
    finalizeInterruptedBatch,
    isManagerRunning,
    resumeActiveBatchIfAny,
} from '@/services/processingManager';

const logTimeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
});

function formatLogTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return logTimeFormatter.format(d);
}

// ── Live log ─────────────────────────────────────────────────────────────────

function LiveProcessingLog({ logs }: { logs: ProcessingLogEntry[] }) {
    const [open, setOpen] = useState(true);
    const scrollRef = useRef<HTMLDivElement>(null);
    const rowVirtualizer = useVirtualizer({
        count: logs.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 22,
        overscan: 12,
    });

    useEffect(() => {
        if (logs.length === 0 || !open) return;
        rowVirtualizer.scrollToIndex(logs.length - 1, { align: 'end' });
    }, [logs.length, open, rowVirtualizer]);

    return (
        <section className="panel overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="flex h-10 w-full items-center gap-2 px-4 text-left focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
                <span className="relative flex size-2" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/60" />
                    <span className="relative inline-flex size-2 rounded-full bg-success" />
                </span>
                <span className="text-sm font-semibold">Live log</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">
                    {logs.length} {pluralize(logs.length, 'event')}
                </span>
                <ChevronDown
                    className={cn(
                        'size-4 text-muted-foreground transition-transform duration-150',
                        open && 'rotate-180',
                    )}
                />
            </button>
            {open && (
                <div
                    ref={scrollRef}
                    className="max-h-52 overflow-y-auto border-t border-border bg-muted/40 px-4 py-2 font-mono text-[12px] leading-[22px]"
                >
                    {logs.length === 0 ? (
                        <div className="text-muted-foreground">Waiting for processing events…</div>
                    ) : (
                        <div
                            className="relative"
                            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                        >
                            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                const log = logs[virtualRow.index];
                                return (
                                    <div
                                        key={virtualRow.key}
                                        ref={rowVirtualizer.measureElement}
                                        data-index={virtualRow.index}
                                        className="absolute top-0 left-0 flex w-full min-w-0 gap-3 whitespace-pre-wrap"
                                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                                    >
                                        <span
                                            className={cn(
                                                'w-10 shrink-0 font-semibold',
                                                log.level === 'ERROR'
                                                    ? 'text-destructive'
                                                    : log.level === 'WARN'
                                                      ? 'text-warning'
                                                      : 'text-success',
                                            )}
                                        >
                                            {log.level}
                                        </span>
                                        <span className="shrink-0 text-muted-foreground tabular-nums">
                                            {formatLogTime(log.timestamp)}
                                        </span>
                                        <span className="min-w-0 break-words text-foreground/85">
                                            {log.message}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}

// ── Per-image list ───────────────────────────────────────────────────────────

const STATUS_VIEW: Record<
    ImageStatus,
    { label: string; icon: React.ElementType; className: string }
> = {
    pending: { label: 'Queued', icon: CircleDashed, className: 'text-muted-foreground' },
    processing: { label: 'Processing', icon: Loader2, className: 'text-info' },
    done: { label: 'Done', icon: CheckCircle2, className: 'text-success' },
    needs_calibration: { label: 'Needs calibration', icon: ScanLine, className: 'text-warning' },
    error: { label: 'Failed', icon: AlertCircle, className: 'text-destructive' },
};

const ImageRow = memo(function ImageRow({ image, noun }: { image: ProcessingImage; noun: string }) {
    const view = STATUS_VIEW[image.status];
    const Icon = view.icon;
    return (
        <div className="grid h-10 grid-cols-[minmax(0,1fr)_9.5rem_5.5rem_4.5rem_4.5rem] items-center gap-3 px-4 text-sm">
            <span
                className={cn(
                    'truncate font-mono text-[13px]',
                    image.status === 'pending' && 'text-muted-foreground',
                )}
                title={image.error ? `${image.filename} — ${image.error}` : image.filename}
            >
                {image.filename}
                {image.error && (
                    <span className="ml-2 font-sans text-xs text-destructive">{image.error}</span>
                )}
            </span>
            <span className={cn('flex items-center gap-1.5 text-xs font-medium', view.className)}>
                <Icon
                    className={cn(
                        'size-3.5 shrink-0',
                        image.status === 'processing' && 'animate-spin',
                    )}
                    aria-hidden
                />
                {view.label}
            </span>
            <span className="text-right tabular-nums" title={noun}>
                {image.count != null ? image.count.toLocaleString() : '—'}
            </span>
            <span className="text-right text-muted-foreground tabular-nums">
                {image.avgConfidence != null && image.count
                    ? formatPercent(image.avgConfidence, 0)
                    : '—'}
            </span>
            <span className="text-right text-muted-foreground tabular-nums">
                {image.elapsedSeconds != null ? formatDuration(image.elapsedSeconds) : '—'}
            </span>
        </div>
    );
});

function ImageList({ images, noun }: { images: ProcessingImage[]; noun: string }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: images.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 40,
        overscan: 10,
    });
    const activeIndex = images.findIndex((img) => img.status === 'processing');

    // Keep the image being processed in view as the run advances.
    useEffect(() => {
        if (activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: 'center' });
    }, [activeIndex, virtualizer]);

    return (
        <section className="panel flex min-h-0 flex-col overflow-hidden">
            <div className="grid grid-cols-[minmax(0,1fr)_9.5rem_5.5rem_4.5rem_4.5rem] gap-3 border-b border-border bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground">
                <span>Image</span>
                <span>Status</span>
                <span className="text-right capitalize">{noun}</span>
                <span className="text-right">Conf.</span>
                <span className="text-right">Time</span>
            </div>
            <div ref={scrollRef} className="max-h-[22rem] min-h-0 overflow-y-auto">
                <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                    {virtualizer.getVirtualItems().map((row) => (
                        <div
                            key={images[row.index].id}
                            className={cn(
                                'absolute top-0 left-0 w-full border-b border-border/60',
                                images[row.index].status === 'processing' && 'bg-info/5',
                            )}
                            style={{ transform: `translateY(${row.start}px)` }}
                        >
                            <ImageRow image={images[row.index]} noun={noun} />
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}

// ── Interrupted batch ────────────────────────────────────────────────────────

function InterruptedBatch({
    batchName,
    processedCount,
    totalImages,
    onViewResults,
    onDiscard,
}: {
    batchName: string;
    processedCount: number;
    totalImages: number;
    onViewResults: () => void;
    onDiscard: () => void;
}) {
    const progress = totalImages > 0 ? Math.round((processedCount / totalImages) * 100) : 0;
    return (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background px-6">
            <div className="panel w-full max-w-md p-6 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-warning/10 text-warning">
                    <PauseCircle className="h-6 w-6" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight">
                    Processing interrupted
                </h2>
                <p className="mt-1 truncate text-sm font-medium text-foreground/80">{batchName}</p>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {processedCount} of {totalImages} images completed · {progress}%
                </p>
                <Progress value={progress} className="mx-auto mt-4 h-1.5 w-full" />
                <p className="mt-4 text-xs text-muted-foreground">
                    The page was reloaded while this batch was running, so the remaining images are
                    no longer available to the browser.
                </p>
                <div className="mt-5 flex items-center justify-center gap-2">
                    {processedCount > 0 && (
                        <Button variant="outline" size="sm" onClick={onViewResults}>
                            View completed results
                        </Button>
                    )}
                    <Button variant="destructive" size="sm" onClick={onDiscard}>
                        Discard &amp; start over
                    </Button>
                </div>
            </div>
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function SummaryStat({
    label,
    value,
    tone,
}: {
    label: string;
    value: React.ReactNode;
    tone?: 'warning' | 'destructive';
}) {
    return (
        <div className="min-w-0">
            <dt className="truncate text-xs text-muted-foreground">{label}</dt>
            <dd
                className={cn(
                    'mt-0.5 text-xl font-semibold tracking-tight',
                    tone === 'warning' && 'text-warning',
                    tone === 'destructive' && 'text-destructive',
                )}
            >
                {value}
            </dd>
        </div>
    );
}

export default function ProcessingPage() {
    const navigate = useNavigate();

    const isProcessing = useProcessingStore((s) => s.isProcessing);
    const storeImages = useProcessingStore((s) => s.images);
    const totalImages = useProcessingStore((s) => s.totalImages);
    const stage = useProcessingStore((s) => s.stage);
    const error = useProcessingStore((s) => s.error);
    const interruptedBatch = useProcessingStore((s) => s.interruptedBatch);
    const completedBatchId = useProcessingStore((s) => s.completedBatchId);
    const completedFirstImageId = useProcessingStore((s) => s.completedFirstImageId);
    const activeBatchId = useProcessingStore((s) => s.activeBatchId);
    const organism = useProcessingStore((s) => s.organism);
    const liveLogs = useProcessingStore((s) => s.liveLogs);
    const projectName = useProcessingStore((s) => s.projectName);
    const appendingToName = useProcessingStore((s) => s.appendingToName);
    const analysisMode = useProcessingStore((s) => s.analysisMode);
    const completedDurations = useProcessingStore((s) => s.completedDurations);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!isManagerRunning()) {
                const took = await resumeActiveBatchIfAny();
                if (cancelled) return;
                if (!took && !isManagerRunning()) {
                    const sessionBatchId = loadBatchId();
                    const stored = loadProcessingFiles();
                    if (!sessionBatchId || stored.length === 0) {
                        navigate('/analyze');
                    }
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [navigate]);

    useEffect(() => {
        if (!completedBatchId) return;
        // Construct a URL-driven results link so reload / share / back-forward
        // all work. Open on the first image this run processed (for an append
        // that is the first *new* image).
        const firstImageId = completedFirstImageId ?? loadBatchDetail()?.images?.[0]?.id;
        const base = firstImageId
            ? `/analyze/results/${completedBatchId}/images/${firstImageId}`
            : `/analyze/results/${completedBatchId}`;
        const url =
            organism === 'larvae'
                ? `${base}?organism=larvae`
                : organism === 'pupae'
                  ? `${base}?organism=pupae`
                  : base;
        navigate(url);
    }, [completedBatchId, completedFirstImageId, navigate, organism]);

    const { doneCount, errorCount, needsCalibrationCount, allCompleted, countedSoFar } =
        useMemo(() => {
            let done = 0;
            let err = 0;
            let needsCal = 0;
            let counted = 0;
            for (const img of storeImages) {
                if (img.status === 'done') done += 1;
                else if (img.status === 'error') err += 1;
                else if (img.status === 'needs_calibration') needsCal += 1;
                counted += img.count ?? 0;
            }
            return {
                doneCount: done,
                errorCount: err,
                needsCalibrationCount: needsCal,
                allCompleted: done + err + needsCal === storeImages.length,
                countedSoFar: counted,
            };
        }, [storeImages]);
    const processedSoFar = doneCount + errorCount + needsCalibrationCount;
    const anyError = errorCount > 0;
    const allDone = !isProcessing && totalImages > 0 && allCompleted;

    function handleCancel() {
        cancelProcessing();
        navigate('/');
    }

    async function handleInterruptedViewResults() {
        try {
            await finalizeInterruptedBatch();
            const stored = loadBatchDetail();
            const batchId = stored?.id;
            const firstImageId = stored?.images?.[0]?.id;
            if (batchId && firstImageId) {
                navigate(`/analyze/results/${batchId}/images/${firstImageId}`);
            } else if (batchId) {
                navigate(`/analyze/results/${batchId}`);
            } else {
                navigate('/analyze/results');
            }
        } catch (err) {
            console.error('finalizeInterruptedBatch failed', err);
        }
    }

    function handleInterruptedDiscard() {
        discardInterruptedBatch();
        navigate('/analyze');
    }

    if (interruptedBatch) {
        return (
            <InterruptedBatch
                batchName={interruptedBatch.name}
                processedCount={interruptedBatch.processedCount}
                totalImages={interruptedBatch.totalImages}
                onViewResults={handleInterruptedViewResults}
                onDiscard={handleInterruptedDiscard}
            />
        );
    }

    if (error && storeImages.length === 0) {
        return (
            <LoadingScreen
                status="Processing failed"
                counter={error}
                action={
                    <Button variant="outline" onClick={() => navigate('/analyze')}>
                        Go Back
                    </Button>
                }
            />
        );
    }

    if (storeImages.length === 0) {
        return <LoadingScreen status={activeBatchId ? 'Preparing analysis...' : 'Loading...'} />;
    }

    let status: string;
    if (isProcessing) {
        if (stage) {
            status = stage;
        } else {
            const current = Math.min(processedSoFar + 1, totalImages);
            status = `Processing image ${current} of ${totalImages}...`;
        }
    } else if (allDone) {
        status = 'Analysis complete';
    } else if (anyError) {
        status = 'Completed with errors';
    } else {
        status = 'Loading...';
    }

    const meta = organismMeta(organism);
    const polygon = isPolygonOrganism(organism);
    const progress = totalImages > 0 ? (processedSoFar / totalImages) * 100 : 0;
    const remaining = Math.max(0, totalImages - processedSoFar);
    // Wall time per image ≈ inference time + upload/persist overhead; the
    // inference durations alone are a slight under-estimate, which is fine
    // for an ETA that is labelled approximate.
    const avgSeconds =
        completedDurations.length > 0
            ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length
            : null;
    const eta = isProcessing && avgSeconds != null && remaining > 0 ? avgSeconds * remaining : null;
    const title = appendingToName ?? projectName ?? 'Analysis';

    return (
        <div className="flex h-full flex-col">
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-6">
                    {/* Header + progress */}
                    <section className="panel p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                            <div className="flex min-w-0 items-center gap-4">
                                <img
                                    src="/assets/gif/worm_cute_antennae.gif"
                                    alt=""
                                    aria-hidden
                                    className="h-12 w-auto shrink-0 [image-rendering:pixelated]"
                                />
                                <div className="min-w-0">
                                    <p className="eyebrow">
                                        {appendingToName
                                            ? 'Adding images to batch'
                                            : 'Processing batch'}
                                    </p>
                                    <h1 className="mt-0.5 flex items-center gap-2 text-xl font-semibold tracking-tight">
                                        <span className="truncate" title={title}>
                                            {title}
                                        </span>
                                        <OrganismBadge organism={organism} />
                                        {polygon && (
                                            <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                                                {analysisMode === 'count'
                                                    ? 'Count only'
                                                    : 'Count + measure'}
                                            </span>
                                        )}
                                    </h1>
                                </div>
                            </div>
                            {isProcessing && (
                                <Button variant="outline" size="sm" onClick={handleCancel}>
                                    Cancel
                                </Button>
                            )}
                        </div>

                        <div className="mt-5">
                            <div className="mb-2 flex items-baseline justify-between gap-4">
                                <p
                                    className="min-w-0 truncate text-sm font-medium"
                                    title={status}
                                    aria-live="polite"
                                >
                                    {status}
                                </p>
                                <p className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                                    {processedSoFar} / {totalImages} images processed
                                </p>
                            </div>
                            <Progress value={progress} className="h-2" />
                            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground tabular-nums">
                                <span>{Math.round(progress)}%</span>
                                <span>
                                    {eta != null
                                        ? `About ${formatDuration(eta)} left`
                                        : isProcessing
                                          ? 'Estimating time left…'
                                          : ''}
                                </span>
                            </div>
                        </div>

                        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
                            <SummaryStat
                                label={`${meta.nounPlural.charAt(0).toUpperCase()}${meta.nounPlural.slice(1)} counted so far`}
                                value={countedSoFar.toLocaleString()}
                            />
                            <SummaryStat
                                label="Time per image"
                                value={avgSeconds != null ? formatDuration(avgSeconds) : '—'}
                            />
                            <SummaryStat
                                label="Need calibration"
                                value={needsCalibrationCount}
                                tone={needsCalibrationCount > 0 ? 'warning' : undefined}
                            />
                            <SummaryStat
                                label="Failed"
                                value={errorCount}
                                tone={errorCount > 0 ? 'destructive' : undefined}
                            />
                        </dl>
                    </section>

                    <ImageList images={storeImages} noun={meta.nounPlural} />
                    <LiveProcessingLog logs={liveLogs} />
                </div>
            </div>
        </div>
    );
}
