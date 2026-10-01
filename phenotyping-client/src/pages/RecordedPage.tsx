// RecordedPage — top-level page for browsing recorded analysis batches.
// Route: /recorded
// Also mounts BatchDetail for /recorded?batch=:batchId (detail view).

import { useCallback, useRef } from 'react';
import { Plus } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { PageHeader } from '@/components/common';
import { usePersistentFlag } from '@/hooks/usePersistentFlag';
import { Button } from '@/components/ui/button';
import { BatchDetail } from '@/features/recorded/components/BatchDetail';
import { BatchList } from '@/features/recorded/components/BatchList';
import { SearchFilters } from '@/features/recorded/components/SearchFilters';
import { parseStatusFilter, useRecorded } from '@/features/recorded/hooks/useRecorded';

export default function RecordedPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const batchId = searchParams.get('batch');
    const scrollRef = useRef<HTMLDivElement>(null);
    const [listView, setListView] = usePersistentFlag('phenotyping.recorded.list-view', false);
    const layout = listView ? 'list' : 'grid';

    const {
        batches,
        total,
        page,
        pageSize,
        totalPages,
        filters,
        hasActiveFilters,
        loading,
        refreshing,
        error,
        setPage,
        setFilters,
        clearFilters,
        refetch,
        deleteBatch,
    } = useRecorded({
        enabled: !batchId,
        // Deep links from the dashboard ("3 drafts to review") land filtered.
        initialFilters: { status: parseStatusFilter(searchParams.get('status')) },
    });

    const handlePageChange = useCallback(
        (next: number) => {
            setPage(next);
            scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        },
        [setPage],
    );

    if (batchId) {
        return <BatchDetail />;
    }

    return (
        <div className="flex h-full flex-col">
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
                <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6 px-6 py-6">
                    <PageHeader
                        eyebrow="History"
                        title="Recorded batches"
                        description="Every analysis you have run. Open a batch to review it, add images or export the results."
                        actions={
                            <Button size="sm" onClick={() => navigate('/analyze')}>
                                <Plus aria-hidden />
                                New analysis
                            </Button>
                        }
                    >
                        <SearchFilters
                            filters={filters}
                            onFiltersChange={setFilters}
                            onClear={clearFilters}
                            hasActiveFilters={hasActiveFilters}
                            total={total}
                            loading={loading}
                            layout={layout}
                            onLayoutChange={(next) => setListView(next === 'list')}
                        />
                    </PageHeader>

                    <BatchList
                        batches={batches}
                        total={total}
                        page={page}
                        pageSize={pageSize}
                        totalPages={totalPages}
                        loading={loading}
                        refreshing={refreshing}
                        error={error}
                        hasActiveFilters={hasActiveFilters}
                        onPageChange={handlePageChange}
                        onRetry={refetch}
                        onClearFilters={clearFilters}
                        onDelete={deleteBatch}
                        layout={layout}
                    />
                </div>
            </div>
        </div>
    );
}
