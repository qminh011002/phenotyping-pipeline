// useRecorded — stateful hook for the recorded-analyses list.
// Handles search, filter, sort, pagination, and data fetching.

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listAnalyses, deleteAnalysis, getAnalysisDetail } from '@/services/api';
import type { AnalysisBatchSummary, AnalysisImageSummary, Organism } from '@/types/api';

export type SortKey = 'created_at' | 'total_count';
export type SortDir = 'asc' | 'desc';

export interface RecordedFilters {
    q: string;
    organism: Organism | '';
    sortKey: SortKey;
    sortDir: SortDir;
}

const DEFAULT_FILTERS: RecordedFilters = {
    q: '',
    organism: '',
    sortKey: 'created_at',
    sortDir: 'desc',
};

const PAGE_SIZE = 12;

const firstImageCache = new Map<string, AnalysisImageSummary | null>();

export interface RecordedBatchSummary extends AnalysisBatchSummary {
    firstImage: AnalysisImageSummary | null;
}

export interface UseRecordedReturn {
    batches: RecordedBatchSummary[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    filters: RecordedFilters;
    loading: boolean;
    error: string | null;
    setPage: (page: number) => void;
    setFilters: (updates: Partial<RecordedFilters>) => void;
    deleteBatch: (batchId: string) => Promise<void>;
}

export interface UseRecordedOptions {
    enabled?: boolean;
}

async function fetchRecordedBatches(
    currentPage: number,
    currentFilters: RecordedFilters,
    signal: AbortSignal,
): Promise<{ batches: RecordedBatchSummary[]; total: number }> {
    const data = await listAnalyses(
        {
            page: currentPage,
            pageSize: PAGE_SIZE,
            q: currentFilters.q || undefined,
            organism: currentFilters.organism || undefined,
            // Show drafts alongside completed/failed so the operator can find a
            // batch they exited via Quit & Save and resume it. The BatchCard
            // status badge differentiates draft vs complete.
            statuses: ['completed', 'failed', 'draft'],
        },
        signal,
    );

    let items = data.items;

    // Client-side sort (backend only supports date; sort by count here)
    if (currentFilters.sortKey === 'total_count') {
        items = [...items].sort((a, b) => {
            const aVal = a.total_count ?? -1;
            const bVal = b.total_count ?? -1;
            return currentFilters.sortDir === 'asc' ? aVal - bVal : bVal - aVal;
        });
    } else {
        items = [...items].sort((a, b) => {
            const aVal = new Date(a.created_at).getTime();
            const bVal = new Date(b.created_at).getTime();
            return currentFilters.sortDir === 'asc' ? aVal - bVal : bVal - aVal;
        });
    }

    const batches = await Promise.all(
        items.map(async (batch) => {
            if (firstImageCache.has(batch.id)) {
                return {
                    ...batch,
                    firstImage: firstImageCache.get(batch.id) ?? null,
                };
            }

            try {
                const detail = await getAnalysisDetail(batch.id, signal, {
                    includeAnnotations: false,
                });
                const firstImage = detail.images[0] ?? null;
                firstImageCache.set(batch.id, firstImage);
                return {
                    ...batch,
                    firstImage,
                };
            } catch (err) {
                if ((err as Error).name === 'AbortError') throw err;
                firstImageCache.set(batch.id, null);
                return {
                    ...batch,
                    firstImage: null,
                };
            }
        }),
    );

    return { batches, total: data.total };
}

export function useRecorded(options: UseRecordedOptions = {}): UseRecordedReturn {
    const enabled = options.enabled ?? true;
    const queryClient = useQueryClient();
    const [page, setPage] = useState(1);
    const [filters, setFiltersState] = useState<RecordedFilters>(DEFAULT_FILTERS);

    const query = useQuery({
        queryKey: ['recorded-batches', page, filters],
        enabled,
        queryFn: ({ signal }) => fetchRecordedBatches(page, filters, signal),
        placeholderData: (previous) => previous,
    });

    const data = query.data;
    const batches = data?.batches ?? [];
    const total = data?.total ?? 0;
    const loading = enabled && query.isPending;
    const error = query.error ? String(query.error) : null;

    const deleteBatch = useCallback(
        async (batchId: string) => {
            await deleteAnalysis(batchId);
            firstImageCache.delete(batchId);
            await queryClient.invalidateQueries({ queryKey: ['recorded-batches'] });
        },
        [queryClient],
    );

    const setFilters = useCallback((updates: Partial<RecordedFilters>) => {
        setFiltersState((prev) => ({ ...prev, ...updates }));
        setPage(1);
    }, []);

    return {
        batches,
        total,
        page,
        pageSize: PAGE_SIZE,
        totalPages: Math.ceil(total / PAGE_SIZE),
        filters,
        loading,
        error,
        setPage,
        setFilters,
        deleteBatch,
    };
}
