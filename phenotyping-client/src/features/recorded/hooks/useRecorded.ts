// useRecorded — stateful hook for the recorded-analyses list.
// Handles search, organism / status filters, sort, pagination and deletion.
//
// One request per page: the list endpoint already carries everything a card
// needs, including `cover_image_id` for the cover thumbnail.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { deleteAnalysis, listAnalyses } from '@/services/api';
import type { AnalysisBatchSummary, Organism } from '@/types/api';

export type SortKey = 'created_at' | 'total_count';
export type SortDir = 'asc' | 'desc';
export type StatusFilter = 'all' | 'completed' | 'draft' | 'failed';

export interface RecordedFilters {
    q: string;
    organism: Organism | '';
    status: StatusFilter;
    sortKey: SortKey;
    sortDir: SortDir;
}

export const DEFAULT_FILTERS: RecordedFilters = {
    q: '',
    organism: '',
    status: 'all',
    sortKey: 'created_at',
    sortDir: 'desc',
};

const PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 250;
/** While a listed batch is processing, poll so its card keeps up. */
const PROCESSING_POLL_MS = 3000;

// "All" shows drafts alongside saved/failed batches so a batch the operator
// left via Quit & Save can be found and resumed — and batches still being
// analysed, which render as live progress cards.
const STATUSES: Record<StatusFilter, string[]> = {
    all: ['processing', 'completed', 'failed', 'draft'],
    completed: ['completed'],
    draft: ['draft'],
    failed: ['failed'],
};

/** A list row. Kept as a named type for the components of this feature. */
export type RecordedBatchSummary = AnalysisBatchSummary;

export interface UseRecordedReturn {
    batches: RecordedBatchSummary[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    filters: RecordedFilters;
    /** Search, organism or status differ from the defaults. */
    hasActiveFilters: boolean;
    /** First load — nothing to show yet. */
    loading: boolean;
    /** The previous page is still on screen while the next one loads. */
    refreshing: boolean;
    error: string | null;
    setPage: (page: number) => void;
    setFilters: (updates: Partial<RecordedFilters>) => void;
    clearFilters: () => void;
    refetch: () => void;
    deleteBatch: (batchId: string) => Promise<void>;
}

export interface UseRecordedOptions {
    enabled?: boolean;
    /** Filters to start from (e.g. a `?status=draft` deep link). */
    initialFilters?: Partial<RecordedFilters>;
}

const STATUS_FILTERS: StatusFilter[] = ['all', 'completed', 'draft', 'failed'];

/** Parse a `?status=` URL value; anything unknown means "all". */
export function parseStatusFilter(raw: string | null): StatusFilter {
    return STATUS_FILTERS.includes(raw as StatusFilter) ? (raw as StatusFilter) : 'all';
}

export function useRecorded(options: UseRecordedOptions = {}): UseRecordedReturn {
    const enabled = options.enabled ?? true;
    const queryClient = useQueryClient();
    const [page, setPage] = useState(1);
    const [filters, setFiltersState] = useState<RecordedFilters>(() => ({
        ...DEFAULT_FILTERS,
        ...options.initialFilters,
    }));

    // The input updates on every keystroke; the request waits for a pause.
    // The page resets together with the committed term, so a search costs
    // one request.
    const [searchTerm, setSearchTerm] = useState(filters.q.trim());
    useEffect(() => {
        const next = filters.q.trim();
        if (next === searchTerm) return;
        const timer = setTimeout(
            () => {
                setSearchTerm(next);
                setPage(1);
            },
            next ? SEARCH_DEBOUNCE_MS : 0,
        );
        return () => clearTimeout(timer);
    }, [filters.q, searchTerm]);

    const { organism, status, sortKey, sortDir } = filters;

    const query = useQuery({
        queryKey: ['recorded-batches', page, { q: searchTerm, organism, status, sortKey, sortDir }],
        enabled,
        queryFn: ({ signal }) =>
            listAnalyses(
                {
                    page,
                    pageSize: PAGE_SIZE,
                    q: searchTerm || undefined,
                    organism: organism || undefined,
                    statuses: STATUSES[status],
                    // Ordered by the server, so the order holds across pages.
                    sort: sortKey,
                    order: sortDir,
                },
                signal,
            ),
        placeholderData: (previous) => previous,
        refetchInterval: (q) =>
            q.state.data?.items.some((b) => b.status === 'processing') ? PROCESSING_POLL_MS : false,
        // Counts change when a batch is edited or extended elsewhere: show the
        // cached page at once, but refresh it every time the list comes back.
        staleTime: 0,
    });

    const data = query.data;
    const total = data?.total ?? 0;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const batches = useMemo(() => data?.items ?? [], [data]);

    // Deleting the last batch of the last page leaves `page` past the end.
    const settled = data !== undefined && !query.isPlaceholderData;
    useEffect(() => {
        if (!settled) return;
        const lastPage = Math.max(1, totalPages);
        if (page > lastPage) setPage(lastPage);
    }, [settled, totalPages, page]);

    const error = query.error
        ? query.error instanceof Error
            ? query.error.message
            : String(query.error)
        : null;

    const deleteBatch = useCallback(
        async (batchId: string) => {
            await deleteAnalysis(batchId);
            queryClient.removeQueries({ queryKey: ['analysis-detail', batchId] });
            await queryClient.invalidateQueries({ queryKey: ['recorded-batches'] });
        },
        [queryClient],
    );

    const setFilters = useCallback((updates: Partial<RecordedFilters>) => {
        setFiltersState((prev) => ({ ...prev, ...updates }));
        // A new organism / status / order starts over at page 1; a new search
        // term resets the page when it commits.
        if (
            'organism' in updates ||
            'status' in updates ||
            'sortKey' in updates ||
            'sortDir' in updates
        ) {
            setPage(1);
        }
    }, []);

    const clearFilters = useCallback(() => {
        setFiltersState((prev) => ({ ...prev, q: '', organism: '', status: 'all' }));
        setSearchTerm('');
        setPage(1);
    }, []);

    const { refetch: refetchQuery } = query;
    const refetch = useCallback(() => void refetchQuery(), [refetchQuery]);

    return {
        batches,
        total,
        page,
        pageSize: PAGE_SIZE,
        totalPages,
        filters,
        hasActiveFilters: filters.q !== '' || organism !== '' || status !== 'all',
        loading: enabled && query.isPending,
        refreshing: query.isPlaceholderData,
        error,
        setPage,
        setFilters,
        clearFilters,
        refetch,
        deleteBatch,
    };
}
