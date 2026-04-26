import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { PauseCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { LoadingScreen } from '@/components/LoadingScreen';
import { loadProcessingFiles, loadBatchId } from '@/features/upload/lib/processingSession';
import { useProcessingStore } from '@/stores/processingStore';
import type { ProcessingLogEntry } from '@/stores/processingStore';
import {
    cancelProcessing,
    discardInterruptedBatch,
    finalizeInterruptedBatch,
    isManagerRunning,
    resumeActiveBatchIfAny,
} from '@/services/processingManager';

function formatLogTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return d.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function LiveProcessingLog({ logs }: { logs: ProcessingLogEntry[] }) {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [logs]);

    return (
        <section className="mt-8 w-[min(48rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border bg-card text-left shadow-sm">
            <div className="flex h-14 items-center gap-3 border-b bg-muted/20 px-6">
                <span className="relative flex h-4 w-4" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-40" />
                    <span className="relative inline-flex h-4 w-4 rounded-full bg-green-500" />
                </span>
                <span className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Live Log
                </span>
            </div>
            <div
                ref={scrollRef}
                className="max-h-52 overflow-y-auto bg-slate-950 px-6 py-4 font-mono text-sm leading-7 text-slate-300"
            >
                {logs.length === 0 ? (
                    <div className="text-slate-500">Waiting for processing events...</div>
                ) : (
                    logs.map((log) => (
                        <div key={log.id} className="flex min-w-0 gap-3 whitespace-pre-wrap">
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
                    ))
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
        if (completedBatchId) {
            navigate('/analyze/results');
        }
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
            navigate('/analyze/results');
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
