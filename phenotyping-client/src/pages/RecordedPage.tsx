// RecordedPage — top-level page for browsing recorded analysis batches.
// Route: /recorded
// Also mounts BatchDetail for /recorded/:batchId (detail view as a sub-route).

import { useRecorded } from "@/features/recorded/hooks/useRecorded";
import { SearchFilters } from "@/features/recorded/components/SearchFilters";
import { BatchList } from "@/features/recorded/components/BatchList";
import { BatchDetail } from "@/features/recorded/components/BatchDetail";
import { useSearchParams } from "react-router-dom";

export default function RecordedPage() {
  const [searchParams] = useSearchParams();
  const batchId = searchParams.get("batch");

  if (batchId) {
    return <BatchDetail />;
  }

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
  } = useRecorded();

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <header className="flex flex-col gap-3 border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Recorded Analyses</h1>
        <SearchFilters
          filters={filters}
          onFiltersChange={setFilters}
          total={total}
        />
      </header>

      {/* Batch grid */}
      <div className="flex-1 overflow-y-auto p-6">
        <BatchList
          batches={batches}
          page={page}
          totalPages={totalPages}
          loading={loading}
          error={error}
          onPageChange={setPage}
          onDelete={deleteBatch}
        />
      </div>
    </div>
  );
}
