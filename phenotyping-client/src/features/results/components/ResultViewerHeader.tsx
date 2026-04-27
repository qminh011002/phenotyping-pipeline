import { ArrowLeft, Check, ChevronRight, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DetectionResult } from "@/types/api";

import { ResultNavigation } from "./ResultNavigation";

interface BatchDetailLike {
  id: string;
  name: string;
  status?: string;
}

interface BatchSummaryLike {
  total_count: number;
  total_elapsed_seconds: number;
}

interface ResultViewerHeaderProps {
  batchDetail: BatchDetailLike | null;
  batchSummary: BatchSummaryLike | null;
  currentIndex: number;
  currentResult: DetectionResult;
  results: DetectionResult[];
  canEdit: boolean;
  editMode: boolean;
  isDirty: boolean;
  /** True when the batch has already been saved to Records — hides Finish. */
  isSaved: boolean;
  /** True while the Finish request is in flight. */
  finishing: boolean;
  onBack: () => void;
  onNavigate: (index: number) => void;
  // Kept for API compatibility; rename is no longer available from this header.
  onRename?: (next: string) => Promise<void>;
  onFinish: () => void;
}

export function ResultViewerHeader({
  batchDetail,
  currentIndex,
  currentResult,
  results,
  canEdit,
  editMode,
  isDirty,
  isSaved,
  finishing,
  onBack,
  onNavigate,
  onFinish,
}: ResultViewerHeaderProps) {
  const isBatch = results.length > 1;
  const filename = currentResult.filename;

  async function copyFilename() {
    try {
      await navigator.clipboard.writeText(filename);
      toast.success("Filename copied");
    } catch {
      toast.error("Failed to copy filename");
    }
  }

  return (
    <header className="bg-card grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b px-6 py-3">
      {/* Left — back + breadcrumb + filename */}
      <div className="flex items-center gap-3 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          title="Back to home"
          className="h-8 w-8 shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5 text-sm min-w-0">
            <span
              className="truncate font-semibold text-foreground"
              title={batchDetail?.name ?? ""}
            >
              {batchDetail?.name ?? "Untitled batch"}
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span
              className={cn(
                "inline-flex items-center gap-1 font-semibold tracking-wide",
                canEdit && editMode
                  ? "text-green-500 dark:text-green-400"
                  : "text-muted-foreground",
              )}
            >
              <Pencil className="h-3.5 w-3.5" />
              ANNOTATE
              {canEdit && editMode && isDirty && (
                <span className="ml-0.5 text-green-500 dark:text-green-400">•</span>
              )}
            </span>
            {!isSaved && batchDetail?.status === "draft" && (
              <span className="ml-1 inline-flex items-center rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                Draft
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={copyFilename}
            title="Click to copy filename"
            className={cn(
              "max-w-full truncate text-left font-mono text-xs text-muted-foreground",
              "rounded-sm px-0.5 -mx-0.5 select-all",
              "hover:text-foreground hover:bg-accent/40",
              "focus:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/60 focus-visible:text-foreground",
            )}
          >
            {filename}
          </button>
        </div>
      </div>

      {/* Center — prev/next image navigation */}
      <div className="flex items-center justify-center">
        {isBatch && (
          <ResultNavigation
            results={results}
            currentIndex={currentIndex}
            onNavigate={onNavigate}
          />
        )}
      </div>

      {/* Right — actions */}
      <div className="flex items-center justify-end gap-2">
        {!isSaved && (
          <Button
            size="sm"
            onClick={onFinish}
            disabled={finishing}
            className="gap-2"
          >
            {finishing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            {finishing ? "Saving…" : "Finish"}
          </Button>
        )}
      </div>
    </header>
  );
}
