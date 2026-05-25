import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { PauseCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { LoadingScreen } from '@/components/LoadingScreen';
import { cn } from '@/lib/utils';
import {
    loadBatchDetail,
    loadProcessingFiles,
    loadBatchId,
} from '@/features/upload/lib/processingSession';
import { useProcessingStore } from '@/stores/processingStore';
import type { ProcessingLogEntry } from '@/stores/processingStore';
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

function LiveProcessingLog({ logs }: { logs: ProcessingLogEntry[] }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const rowVirtualizer = useVirtualizer({
        count: logs.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 24,
        overscan: 12,
    });

    useEffect(() => {
        if (logs.length === 0) return;
        rowVirtualizer.scrollToIndex(logs.length - 1, { align: 'end' });
    }, [logs.length, rowVirtualizer]);

    return (
        <section className="mt-8 w-[min(52rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-card text-left">
            <div className="flex h-10 items-center gap-2 border-b border-border bg-muted/30 px-4">
                <span className="relative flex h-2 w-2" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Live log
                </span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">
                    {logs.length} {logs.length === 1 ? 'event' : 'events'}
                </span>
            </div>
            <div
                ref={scrollRef}
                className="max-h-56 overflow-y-auto bg-muted/20 px-4 py-2.5 font-mono text-[12px] leading-6 text-foreground/90"
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
                            const levelClass =
                                log.level === 'ERROR'
                                    ? 'text-destructive'
                                    : log.level === 'WARN'
                                      ? 'text-amber-600 dark:text-amber-400'
                                      : 'text-emerald-600 dark:text-emerald-400';
                            return (
                                <div
                                    key={virtualRow.key}
                                    ref={rowVirtualizer.measureElement}
                                    data-index={virtualRow.index}
                                    className="absolute left-0 top-0 flex w-full min-w-0 gap-3 whitespace-pre-wrap"
                                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                                >
                                    <span
                                        className={cn(
                                            'w-10 shrink-0 font-semibold',
                                            levelClass,
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
        </section>
    );
}

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
            <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    <PauseCircle className="h-6 w-6" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight">
                    Processing interrupted
                </h2>
                <p className="mt-1 truncate text-sm font-medium text-foreground/80">
                    {batchName}
                </p>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {processedCount} of {totalImages} images completed · {progress}%
                </p>
                <Progress value={progress} className="mx-auto mt-4 h-1.5 w-full" />
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

export default function ProcessingPage() {
    const navigate = useNavigate();

    const isProcessing = useProcessingStore((s) => s.isProcessing);
    const storeImages = useProcessingStore((s) => s.images);
    const totalImages = useProcessingStore((s) => s.totalImages);
    const stage = useProcessingStore((s) => s.stage);
    const error = useProcessingStore((s) => s.error);
    const interruptedBatch = useProcessingStore((s) => s.interruptedBatch);
    const completedBatchId = useProcessingStore((s) => s.completedBatchId);
    const activeBatchId = useProcessingStore((s) => s.activeBatchId);
    const organism = useProcessingStore((s) => s.organism);
    const liveLogs = useProcessingStore((s) => s.liveLogs);

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
        // all work. First image ID comes from the batch detail just stored by
        // the processing manager.
        const stored = loadBatchDetail();
        const firstImageId = stored?.images?.[0]?.id;
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
    }, [completedBatchId, navigate, organism]);

    const { doneCount, errorCount, needsCalibrationCount, allCompleted } = useMemo(() => {
        let done = 0;
        let err = 0;
        let needsCal = 0;
        let resting = 0;
        for (const img of storeImages) {
            if (img.status === 'done') {
                done += 1;
                resting += 1;
            } else if (img.status === 'error') {
                err += 1;
                resting += 1;
            } else if (img.status === 'needs_calibration') {
                needsCal += 1;
                resting += 1;
            }
        }
        return {
            doneCount: done,
            errorCount: err,
            needsCalibrationCount: needsCal,
            allCompleted: resting === storeImages.length,
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

    const counter =
        totalImages > 0 ? `${processedSoFar} / ${totalImages} images processed` : undefined;

    return (
        <LoadingScreen
            status={status}
            counter={counter}
            action={
                isProcessing ? (
                    <Button variant="outline" size="sm" onClick={handleCancel}>
                        Cancel
                    </Button>
                ) : undefined
            }
        >
            <LiveProcessingLog logs={liveLogs} />
        </LoadingScreen>
    );
}
