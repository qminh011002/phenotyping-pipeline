// RecordedPage — top-level page for browsing recorded analysis batches.
// Route: /recorded
// Also mounts BatchDetail for /recorded?batch=:batchId (detail view).

import { motion } from 'framer-motion';
import { useRecorded } from '@/features/recorded/hooks/useRecorded';
import { SearchFilters } from '@/features/recorded/components/SearchFilters';
import { BatchList } from '@/features/recorded/components/BatchList';
import { BatchDetail } from '@/features/recorded/components/BatchDetail';
import { useSearchParams } from 'react-router-dom';
import { listContainerVariants, listItemVariants } from '@/lib/motion';

export default function RecordedPage() {
    const [searchParams] = useSearchParams();
    const batchId = searchParams.get('batch');

    const {
        batches,
        total,
        page,
        totalPages,
        filters,
        loading,
        error,
        setPage,
        setFilters,
        deleteBatch,
    } = useRecorded({ enabled: !batchId });

    if (batchId) {
        return <BatchDetail />;
    }

    return (
        <div className="flex flex-col h-full">
            <header className="border-b border-border bg-background px-6 pb-4 pt-5">
                <div className="mx-auto w-full max-w-screen-2xl space-y-4">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                History
                            </p>
                            <h1 className="mt-1 text-xl font-semibold tracking-tight">
                                Recorded batches
                            </h1>
                        </div>
                    </div>
                    <SearchFilters filters={filters} onFiltersChange={setFilters} total={total} />
                </div>
            </header>

            {/* Batch grid */}
            <motion.div
                className="flex-1 overflow-y-auto px-6 py-5"
                variants={listContainerVariants}
                initial="hidden"
                animate="visible"
            >
                <div className="mx-auto w-full max-w-screen-2xl">
                    <BatchList
                        batches={batches}
                        page={page}
                        totalPages={totalPages}
                        loading={loading}
                        error={error}
                        onPageChange={setPage}
                        onDelete={deleteBatch}
                        itemVariants={listItemVariants}
                    />
                </div>
            </motion.div>
        </div>
    );
}
