import { Link } from 'react-router-dom';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProcessingStore } from '@/stores/processingStore';
import { loadBatchDetail } from '@/features/upload/lib/processingSession';

interface ProcessingIndicatorProps {
    collapsed?: boolean;
}

export function ProcessingIndicator({ collapsed = false }: ProcessingIndicatorProps) {
    const isProcessing = useProcessingStore((s) => s.isProcessing);
    const processedCount = useProcessingStore((s) => s.processedCount);
    const totalImages = useProcessingStore((s) => s.totalImages);
    const completedBatchId = useProcessingStore((s) => s.completedBatchId);

    if (!isProcessing && !completedBatchId) return null;

    if (completedBatchId) {
        const stored = loadBatchDetail();
        const firstImageId = stored?.images?.[0]?.id;
        const to = firstImageId
            ? `/analyze/results/${completedBatchId}/images/${firstImageId}`
            : `/analyze/results/${completedBatchId}`;
        return (
            <Link
                to={to}
                className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium',
                    'bg-green-500/10 text-green-600 dark:text-green-400',
                    'transition-colors duration-150 hover:bg-green-500/20',
                )}
            >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                {!collapsed && <span className="truncate">Analysis complete</span>}
            </Link>
        );
    }

    const progress = totalImages > 0 ? Math.round((processedCount / totalImages) * 100) : 0;

    return (
        <Link
            to="/analyze/processing"
            className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium',
                'bg-primary/10 text-primary',
                'transition-colors duration-150 hover:bg-primary/20',
            )}
        >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            {!collapsed && (
                <span className="truncate">
                    Processing {processedCount}/{totalImages} ({progress}%)
                </span>
            )}
        </Link>
    );
}
