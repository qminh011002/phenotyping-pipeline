// BatchList — paginated grid (or list) of BatchCards with loading / error /
// empty states.

import { motion } from 'framer-motion';
import { Microscope, SearchX } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { EmptyState, ErrorState, PaginationBar } from '@/components/common';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCount } from '@/lib/format';
import { listContainerVariants, listItemVariants } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { RecordedBatchSummary } from '../hooks/useRecorded';
import { BatchCard, type BatchLayout } from './BatchCard';

interface BatchListProps {
    batches: RecordedBatchSummary[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    loading: boolean;
    /** The grid shows the previous result while the next one loads. */
    refreshing?: boolean;
    error: string | null;
    hasActiveFilters: boolean;
    onPageChange: (page: number) => void;
    onRetry: () => void;
    onClearFilters: () => void;
    onDelete?: (batchId: string) => Promise<void>;
    /** Gallery cards or compact rows. */
    layout?: BatchLayout;
}

// auto-fill (not auto-fit): a lone card keeps its size instead of stretching
// across the page.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4';
// Rows share one panel, split by hairlines.
const LIST = 'panel flex flex-col divide-y divide-border overflow-hidden';

function SkeletonCard() {
    return (
        <div className="panel flex flex-col overflow-hidden">
            <Skeleton className="aspect-[16/10] w-full rounded-none" />
            <div className="flex flex-col gap-2 p-4">
                <Skeleton className="h-6 w-2/3" />
                <div className="flex items-center gap-1.5">
                    <Skeleton className="h-5 w-14" />
                    <Skeleton className="h-5 w-16" />
                    <Skeleton className="ml-auto h-4 w-12" />
                </div>
                <div className="flex items-center gap-3 border-t border-border pt-3">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-10" />
                </div>
            </div>
        </div>
    );
}

function SkeletonRow() {
    return (
        <div className="flex items-center gap-4 px-3 py-2.5">
            <Skeleton className="aspect-[16/10] w-20 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-1/3" />
                <div className="flex items-center gap-1.5">
                    <Skeleton className="h-5 w-14" />
                    <Skeleton className="h-5 w-16" />
                </div>
            </div>
            <Skeleton className="hidden h-4 w-48 md:block" />
            <Skeleton className="hidden h-4 w-16 sm:block" />
        </div>
    );
}

export function BatchList({
    batches,
    total,
    page,
    pageSize,
    totalPages,
    loading,
    refreshing = false,
    error,
    hasActiveFilters,
    onPageChange,
    onRetry,
    onClearFilters,
    onDelete,
    layout = 'grid',
}: BatchListProps) {
    const isList = layout === 'list';
    const navigate = useNavigate();

    if (error !== null) {
        return <ErrorState title="Could not load batches" message={error} onRetry={onRetry} />;
    }

    if (loading) {
        return (
            <div className={isList ? LIST : GRID} aria-busy="true" aria-label="Loading batches">
                {Array.from({ length: 8 }).map((_, i) =>
                    isList ? <SkeletonRow key={i} /> : <SkeletonCard key={i} />,
                )}
            </div>
        );
    }

    if (batches.length === 0) {
        return hasActiveFilters ? (
            <EmptyState
                icon={SearchX}
                title="No batches match these filters"
                description="Try a different search term, or widen the status and organism filters."
                actionLabel="Clear filters"
                onAction={onClearFilters}
            />
        ) : (
            <EmptyState
                icon={Microscope}
                title="No analyses recorded yet"
                description="Run your first analysis to see the results here."
                actionLabel="Start analysis"
                onAction={() => navigate('/analyze')}
            />
        );
    }

    const first = (page - 1) * pageSize + 1;
    const last = Math.min(first + batches.length - 1, total);

    return (
        <div className="flex flex-col gap-6">
            <motion.div
                // Remount on switch so the new layout staggers in.
                key={layout}
                className={cn(
                    isList ? LIST : GRID,
                    'transition-opacity duration-150',
                    refreshing && 'opacity-60',
                )}
                aria-busy={refreshing}
                variants={listContainerVariants}
                initial="hidden"
                animate="visible"
            >
                {batches.map((batch) => (
                    <motion.div
                        key={batch.id}
                        variants={listItemVariants}
                        className={isList ? 'min-w-0' : 'h-full min-w-0'}
                    >
                        <BatchCard batch={batch} onDelete={onDelete} layout={layout} />
                    </motion.div>
                ))}
            </motion.div>

            {totalPages > 1 && (
                <div className="flex flex-col items-center gap-2">
                    <PaginationBar page={page} pageCount={totalPages} onChange={onPageChange} />
                    <p className="text-xs tabular-nums text-muted-foreground">
                        Showing {formatCount(first)}–{formatCount(last)} of {formatCount(total)}
                    </p>
                </div>
            )}
        </div>
    );
}
