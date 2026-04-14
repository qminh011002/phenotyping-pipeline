// useRecorded — stateful hook for the recorded-analyses list.
// Handles search, filter, sort, pagination, and data fetching.

import { useState, useEffect, useCallback, useRef } from "react";
import { listAnalyses, deleteAnalysis } from "@/services/api";
import type { AnalysisBatchSummary, AnalysisListResponse, Organism } from "@/types/api";

export type SortKey = "created_at" | "total_count";
export type SortDir = "asc" | "desc";

export interface RecordedFilters {
  q: string;
  organism: Organism | "";
  sortKey: SortKey;
  sortDir: SortDir;
}

const DEFAULT_FILTERS: RecordedFilters = {
  q: "",
  organism: "",
  sortKey: "created_at",
  sortDir: "desc",
};

const PAGE_SIZE = 12;

export interface UseRecordedReturn {
  batches: AnalysisBatchSummary[];
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

export function useRecorded(): UseRecordedReturn {
  const [batches, setBatches] = useState<AnalysisBatchSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFiltersState] = useState<RecordedFilters>(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const fetchBatches = useCallback(
    async (currentPage: number, currentFilters: RecordedFilters) => {
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();

      setLoading(true);
      setError(null);

      try {
        const data: AnalysisListResponse = await listAnalyses({
          page: currentPage,
          pageSize: PAGE_SIZE,
          q: currentFilters.q || undefined,
          organism: currentFilters.organism || undefined,
        });

        let items = data.items;

        // Client-side sort (backend only supports date; sort by count here)
        if (currentFilters.sortKey === "total_count") {
          items = [...items].sort((a, b) => {
            const aVal = a.total_count ?? -1;
            const bVal = b.total_count ?? -1;
            return currentFilters.sortDir === "asc" ? aVal - bVal : bVal - aVal;
          });
        } else {
          items = [...items].sort((a, b) => {
            const aVal = new Date(a.created_at).getTime();
            const bVal = new Date(b.created_at).getTime();
            return currentFilters.sortDir === "asc" ? aVal - bVal : bVal - aVal;
          });
        }

        setBatches(items);
        setTotal(data.total);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(String(err));
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Re-fetch whenever page or filters change
  useEffect(() => {
    fetchBatches(page, filters);
    return () => { abortRef.current?.abort(); };
  }, [page, filters, fetchBatches]);

  const setFilters = useCallback((updates: Partial<RecordedFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...updates }));
    setPage(1);
  }, []);

  const deleteBatch = useCallback(
    async (batchId: string) => {
      await deleteAnalysis(batchId);
      setBatches((prev) => prev.filter((b) => b.id !== batchId));
      setTotal((prev) => Math.max(0, prev - 1));
    },
    []
  );

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
