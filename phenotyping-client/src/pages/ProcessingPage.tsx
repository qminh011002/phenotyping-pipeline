import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { PauseCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { LoadingScreen } from '@/components/LoadingScreen';
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
        estimateSize: () => 28,
        overscan: 12,
    });

    useEffect(() => {
        if (logs.length === 0) return;
        rowVirtualizer.scrollToIndex(logs.length - 1, { align: 'end' });
    }, [logs.length, rowVirtualizer]);

    return (
        <section className="mt-8 w-[min(48rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border bg-card text-left shadow-sm">
            <div className="flex h-14 items-center gap-3 border-b bg-muted/20 px-6">
                <span className="relative flex items-center h-3.5 w-3.5" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-40" />
                    <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-green-500" />
                </span>
                <span className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Live Log
                </span>
            </div>
            <div
                ref={scrollRef}
                className="max-h-52 overflow-y-auto bg-black px-6 py-4 font-mono text-sm leading-7 text-slate-300"
            >
                {logs.length === 0 ? (
                    <div className="text-slate-500">Waiting for processing events...</div>
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
                                    className="absolute left-0 top-0 flex w-full min-w-0 gap-3 whitespace-pre-wrap"
                                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                                >
                                    <span
                                        className={
                                            log.level === 'ERROR'
                                                ? 'w-12 shrink-0 font-bold text-red-400'
                                                : log.level === 'WARN'
                                                  ? 'w-12 shrink-0 font-bold text-yellow-400'
                                                  : 'w-12 shrink-0 font-bold text-green-400'
                                        }
                                    >
                                        {log.level}
                                    </span>
                                    <span className="shrink-0 text-slate-500 tabular-nums">
                                        {formatLogTime(log.timestamp)}
                                    </span>
                                    <span className="min-w-0 break-words text-slate-300">
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
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-background px-6 text-center">
            <PauseCircle className="h-16 w-16 text-amber-500/70" />
            <div className="space-y-2">
                <p className="text-xl font-semibold">Processing interrupted</p>
                <p className="text-base font-medium">{batchName}</p>
                <p className="text-sm text-muted-foreground">
                    {processedCount} of {totalImages} images completed ({progress}%).
                </p>
                <Progress value={progress} className="mx-auto h-2 w-64" />
            </div>
            <div className="flex gap-3">
                {processedCount > 0 && (
                    <Button variant="outline" onClick={onViewResults}>
                        View Completed Results
                    </Button>
                )}
                <Button variant="destructive" onClick={onDiscard}>
                    Discard &amp; Start Over
                </Button>
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
        const url = firstImageId
            ? `/analyze/results/${completedBatchId}/images/${firstImageId}`
            : `/analyze/results/${completedBatchId}`;
        navigate(url);
    }, [completedBatchId, navigate]);

    const { doneCount, errorCount, allCompleted } = useMemo(() => {
        let done = 0;
        let err = 0;
        let completed = 0;
        for (const img of storeImages) {
            if (img.status === 'done') {
                done += 1;
                completed += 1;
            } else if (img.status === 'error') {
                err += 1;
            }
        }
        return {
            doneCount: done,
            errorCount: err,
            allCompleted: completed === storeImages.length,
        };
    }, [storeImages]);
    const processedSoFar = doneCount + errorCount;
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
