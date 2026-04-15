// RecordedPage — top-level page for browsing recorded analysis batches.
// Route: /recorded
// Also mounts BatchDetail for /recorded?batch=:batchId (detail view).

import { motion } from "framer-motion";
import { useRecorded } from "@/features/recorded/hooks/useRecorded";
import { SearchFilters } from "@/features/recorded/components/SearchFilters";
import { BatchList } from "@/features/recorded/components/BatchList";
import { BatchDetail } from "@/features/recorded/components/BatchDetail";
import { useSearchParams } from "react-router-dom";
import { History } from "lucide-react";
import { listContainerVariants, listItemVariants } from "@/lib/motion";

export default function RecordedPage() {
  const [searchParams] = useSearchParams();
  const batchId = searchParams.get("batch");

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

  if (batchId) {
    return <BatchDetail />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <header className="border-b bg-card/50 px-6 py-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <History className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-none">Recorded Analyses</h1>
            {!loading && total > 0 && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-0.5 text-xs text-muted-foreground"
              >
                {total.toLocaleString()} batch{total !== 1 ? "es" : ""} stored
              </motion.p>
            )}
          </div>
        </div>
        <SearchFilters
          filters={filters}
          onFiltersChange={setFilters}
          total={total}
        />
      </header>

      {/* Batch grid */}
      <motion.div
        className="flex-1 overflow-y-auto p-6"
        variants={listContainerVariants}
        initial="hidden"
        animate="visible"
      >
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
      </motion.div>
    </div>
  );
}
