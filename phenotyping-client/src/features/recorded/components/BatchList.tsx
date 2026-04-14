// BatchList — paginated grid of BatchCards with empty / loading states.

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
import { Microscope } from "lucide-react";
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
}

function SkeletonCard() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-12" />
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
}: BatchListProps) {
  if (error !== null) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => onPageChange(page)}
          className="mt-2 text-sm text-primary hover:underline"
        >
          Retry
        </button>
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
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Microscope className="mb-3 h-10 w-10 text-muted-foreground" />
        <p className="text-base font-medium">No analyses recorded yet.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Run your first analysis to see results here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {batches.map((batch) => (
          <BatchCard key={batch.id} batch={batch} onDelete={onDelete} />
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
