import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useProcessingStore } from '@/stores/processingStore';
import { loadBatchDetail } from '@/features/upload/lib/processingSession';

interface ProcessingIndicatorProps {
    collapsed?: boolean;
}

/** Sidebar status card: live progress while a batch runs, then a shortcut
 *  into its results. Renders nothing when idle. */
export function ProcessingIndicator({ collapsed = false }: ProcessingIndicatorProps) {
    const isProcessing = useProcessingStore((s) => s.isProcessing);
    const processedCount = useProcessingStore((s) => s.processedCount);
    const totalImages = useProcessingStore((s) => s.totalImages);
    const completedBatchId = useProcessingStore((s) => s.completedBatchId);
    const completedFirstImageId = useProcessingStore((s) => s.completedFirstImageId);

    if (!isProcessing && !completedBatchId) return null;

    if (completedBatchId) {
        const firstImageId = completedFirstImageId ?? loadBatchDetail()?.images?.[0]?.id;
        const to = firstImageId
            ? `/analyze/results/${completedBatchId}/images/${firstImageId}`
            : `/analyze/results/${completedBatchId}`;
        return (
            <Link
                to={to}
                title="Analysis complete — open results"
                className={cn(
                    'group flex items-center gap-2 rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-xs font-medium text-success',
                    'transition-colors duration-150 hover:bg-success/15',
                    'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    collapsed && 'justify-center px-0',
                )}
            >
                <CheckCircle2 className="size-4 shrink-0" />
                {!collapsed && (
                    <>
                        <span className="min-w-0 flex-1 truncate">Analysis complete</span>
                        <ArrowRight className="size-3.5 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5" />
                    </>
                )}
            </Link>
        );
    }

    const progress = totalImages > 0 ? Math.round((processedCount / totalImages) * 100) : 0;

    return (
        <Link
            to="/analyze/processing"
            title={`Processing ${processedCount}/${totalImages} (${progress}%)`}
            className={cn(
                'flex flex-col gap-2 rounded-lg border border-sidebar-border bg-card px-3 py-2.5 text-xs',
                'transition-colors duration-150 hover:bg-sidebar-accent',
                'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                collapsed && 'items-center px-0',
            )}
        >
            <span className="flex items-center gap-2 font-medium text-foreground">
                <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                {!collapsed && (
                    <>
                        <span className="min-w-0 flex-1 truncate">Processing</span>
                        <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                            {processedCount}/{totalImages}
                        </span>
                    </>
                )}
            </span>
            {!collapsed && (
                <span
                    className="h-1 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-valuenow={progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                >
                    <span
                        className="block h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                        style={{ width: `${progress}%` }}
                    />
                </span>
            )}
        </Link>
    );
}
