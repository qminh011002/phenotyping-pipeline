import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PauseCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { LoadingScreen } from '@/components/LoadingScreen';
import { loadProcessingFiles, loadBatchId } from '@/features/upload/lib/processingSession';
import { useProcessingStore } from '@/stores/processingStore';
import {
    cancelProcessing,
    discardInterruptedBatch,
    finalizeInterruptedBatch,
    isManagerRunning,
    resumeActiveBatchIfAny,
} from '@/services/processingManager';

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

    const doneCount = storeImages.filter((img) => img.status === 'done').length;
    const errorCount = storeImages.filter((img) => img.status === 'error').length;
    const processedSoFar = doneCount + errorCount;
    const anyError = errorCount > 0;
    const allDone =
        !isProcessing && totalImages > 0 && storeImages.every((img) => img.status === 'done');

    function handleCancel() {
        cancelProcessing();
        navigate('/');
    }

    async function handleInterruptedViewResults() {
        await finalizeInterruptedBatch();
        navigate('/analyze/results');
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
        />
    );
}
