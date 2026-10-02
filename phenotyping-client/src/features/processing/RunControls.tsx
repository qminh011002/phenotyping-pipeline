// RunControls — Pause / Resume and Stop for one running analysis. Shared by
// the floating tracker, the batch page and the live run page, so a run can be
// controlled from wherever the operator happens to be.
//
// Pause only exists for the run this tab drives: the processing loop lives in
// the tab that started it, so only that tab can hold it between images. Any
// run can be stopped — including one whose tab was closed or reloaded, which
// would otherwise sit in "processing" with nothing driving it.

import { useState } from 'react';
import { Pause, Play, Square } from 'lucide-react';

import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { pluralize } from '@/lib/format';
import {
    pauseProcessing,
    resumeProcessing,
    stopBatchRun,
    type CancelMode,
} from '@/services/processingManager';
import { useProcessingStore } from '@/stores/processingStore';
import { toastAction } from '@/lib/toasts';

export interface ControlledRun {
    /** Batch id; null in the first moments of a run, before the server has one. */
    id: string | null;
    /** This tab drives the run. */
    local: boolean;
    processed: number;
    total: number;
    /** Local runs only: images are being added to an existing batch. */
    appending: boolean;
}

interface RunControlsProps {
    run: ControlledRun;
    /** `compact`: icon-only buttons, for the tracker. */
    compact?: boolean;
    /** Called once the stop has been issued (the run may still be unwinding). */
    onStopped?: (mode: CancelMode) => void;
}

export function RunControls({ run, compact = false, onStopped }: RunControlsProps) {
    const pauseState = useProcessingStore((s) => s.pauseState);
    const cancelling = useProcessingStore((s) => s.cancelling);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [stopping, setStopping] = useState(false);
    const busy = stopping || (run.local && cancelling);
    const paused = pauseState === 'paused';

    async function stop(mode: CancelMode) {
        setDialogOpen(false);
        if (!run.id) return;
        setStopping(true);
        try {
            await toastAction(stopBatchRun(run.id, mode), {
                loading: 'Stopping run…',
                success:
                    mode === 'keep'
                        ? { title: 'Run stopped', description: 'Processed images were kept.' }
                        : {
                              title: 'Run discarded',
                              description: 'Nothing from this run was kept.',
                          },
                error: 'Could not stop this run',
            });
            onStopped?.(mode);
        } catch {
            // Reported by toastAction.
        } finally {
            setStopping(false);
        }
    }

    const pauseLabel = pauseState === 'running' ? 'Pause' : paused ? 'Resume' : 'Don’t pause';
    const pauseTitle =
        pauseState === 'running'
            ? 'Finish the current image, then wait'
            : paused
              ? 'Continue with the next image'
              : 'Pausing after the current image — click to keep going instead';
    const PauseIcon = pauseState === 'running' ? Pause : Play;

    return (
        <>
            <div className="flex shrink-0 items-center gap-1.5">
                {run.local && (
                    <Button
                        variant="outline"
                        size={compact ? 'icon-xs' : 'sm'}
                        onClick={pauseState === 'running' ? pauseProcessing : resumeProcessing}
                        disabled={busy}
                        title={pauseTitle}
                        aria-label={compact ? pauseLabel : undefined}
                    >
                        <PauseIcon aria-hidden />
                        {!compact && pauseLabel}
                    </Button>
                )}
                <Button
                    variant="outline"
                    size={compact ? 'icon-xs' : 'sm'}
                    onClick={() => setDialogOpen(true)}
                    disabled={!run.id || (compact && busy)}
                    loading={!compact && busy}
                    title="Stop this run"
                    aria-label={compact ? 'Stop this run' : undefined}
                >
                    <Square aria-hidden />
                    {!compact && (run.local ? 'Cancel' : 'Stop run')}
                </Button>
            </div>

            <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
                {/* Three actions need more room than the default dialog. */}
                <AlertDialogContent className="sm:max-w-xl">
                    <AlertDialogHeader>
                        <AlertDialogTitle>Stop this run?</AlertDialogTitle>
                        <AlertDialogDescription>
                            <StopDescription run={run} />
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep running</AlertDialogCancel>
                        <Button variant="destructive" onClick={() => void stop('discard')}>
                            {!run.local
                                ? 'Discard this run'
                                : run.appending
                                  ? 'Discard new images'
                                  : 'Discard batch'}
                        </Button>
                        {run.processed > 0 && (
                            <Button onClick={() => void stop('keep')}>
                                Stop and keep {run.processed} {pluralize(run.processed, 'image')}
                            </Button>
                        )}
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

function StopDescription({ run }: { run: ControlledRun }) {
    const progress =
        run.processed > 0 ? (
            <>
                <span className="font-medium text-foreground">
                    {run.processed} of {run.total}
                </span>{' '}
                {pluralize(run.total, 'image')} processed so far. The image in progress is dropped
                either way.{' '}
            </>
        ) : (
            <>No image has finished yet. </>
        );

    if (!run.local) {
        return (
            <>
                {progress}
                This run was started in another tab or device. If that tab was closed or reloaded,
                nothing is driving it any more and it will not finish on its own. Discarding marks a
                new batch as failed; a batch that was only having images added goes back to how it
                was.
            </>
        );
    }
    if (run.processed > 0) {
        return (
            <>
                {progress}
                Keep what is done and review it, or discard{' '}
                {run.appending ? 'everything this run added' : 'the batch'}.
            </>
        );
    }
    return (
        <>
            {progress}
            {run.appending
                ? 'Stopping leaves the batch as it was before this run.'
                : 'Stopping discards the batch.'}
        </>
    );
}
