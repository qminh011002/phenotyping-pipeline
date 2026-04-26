// RecordedPage — top-level page for browsing recorded analysis batches.
// Route: /recorded
// Also mounts BatchDetail for /recorded?batch=:batchId (detail view).

import { motion } from "framer-motion";
import { useRecorded } from "@/features/recorded/hooks/useRecorded";
import { SearchFilters } from "@/features/recorded/components/SearchFilters";
import { BatchList } from "@/features/recorded/components/BatchList";
import { BatchDetail } from "@/features/recorded/components/BatchDetail";
import { useSearchParams } from "react-router-dom";
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
  } = useRecorded({ enabled: !batchId });

  if (batchId) {
    return <BatchDetail />;
  }

  return (
    <div className="flex flex-col h-full">
      <header className="border-b bg-card/50 px-6 py-3">
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
