// BatchList — paginated grid of BatchCards with empty / loading states.

import type { Variants } from "framer-motion";
import { motion } from "framer-motion";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { Microscope, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { BatchCard } from "./BatchCard";
import type { AnalysisBatchSummary } from "@/types/api";

interface BatchListProps {
  batches: AnalysisBatchSummary[];
  page: number;
  totalPages: number;
  loading: boolean;
  error: string | null;
  onPageChange: (page: number) => void;
  onDelete?: (batchId: string) => Promise<void>;
  itemVariants?: Variants;
}

function SkeletonCard() {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-l-4 border-l-border bg-card px-4 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-4 w-12" />
        </div>
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-5 w-8" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-5 w-12" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-5 w-10" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-14 rounded-md" />
        <Skeleton className="h-5 w-16 rounded-md" />
        <Skeleton className="ml-auto h-1.5 w-14 rounded-full" />
      </div>
    </div>
  );
}

function buildPaginationItems(currentPage: number, totalPages: number) {
  const items: (number | "ellipsis")[] = [];

  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) items.push(i);
  } else {
    items.push(1);
    if (currentPage > 3) items.push("ellipsis");
    const start = Math.max(2, currentPage - 1);
    const end = Math.min(totalPages - 1, currentPage + 1);
    for (let i = start; i <= end; i++) items.push(i);
    if (currentPage < totalPages - 2) items.push("ellipsis");
    items.push(totalPages);
  }

  return items;
}

export function BatchList({
  batches,
  page,
  totalPages,
  loading,
  error,
  onPageChange,
  onDelete,
  itemVariants,
}: BatchListProps) {
  const navigate = useNavigate();

  if (error !== null) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <p className="text-sm text-destructive">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page)}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (batches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <Microscope className="h-8 w-8 text-muted-foreground" />
        </div>
        <div>
          <p className="text-base font-medium">No analyses recorded yet</p>
          <p className="mt-1 text-sm text-muted-foreground max-w-xs">
            Run your first analysis to see the results here.
          </p>
        </div>
        <Button size="sm" onClick={() => navigate("/analyze")}>
          <Plus className="mr-2 h-4 w-4" />
          Start Analysis
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {batches.map((batch) => (
          itemVariants ? (
            <motion.div key={batch.id} variants={itemVariants}>
              <BatchCard batch={batch} onDelete={onDelete} />
            </motion.div>
          ) : (
            <BatchCard key={batch.id} batch={batch} onDelete={onDelete} />
          )
        ))}
      </div>

      {totalPages > 1 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                onClick={(e) => { e.preventDefault(); onPageChange(page - 1); }}
                aria-disabled={page <= 1}
                className={page <= 1 ? "pointer-events-none opacity-50" : "transition-colors duration-150 hover:bg-accent"}
              />
            </PaginationItem>

            {buildPaginationItems(page, totalPages).map((item, idx) =>
              item === "ellipsis" ? (
                <PaginationItem key={`ellipsis-${idx}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={item}>
                  <PaginationLink
                    href="#"
                    isActive={item === page}
                    onClick={(e) => { e.preventDefault(); onPageChange(item); }}
                    className="transition-colors duration-150 hover:bg-accent"
                  >
                    {item}
                  </PaginationLink>
                </PaginationItem>
              )
            )}

            <PaginationItem>
              <PaginationNext
                href="#"
                onClick={(e) => { e.preventDefault(); onPageChange(page + 1); }}
                aria-disabled={page >= totalPages}
                className={page >= totalPages ? "pointer-events-none opacity-50" : "transition-colors duration-150 hover:bg-accent"}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
