// ProcessingToast — persistent toast with live progress bar.
// Appears in top-right, persists when navigating, click navigates to the processing page.

import { useNavigate } from "react-router-dom";
import { Microscope } from "lucide-react";
import { useEffect } from "react";
import { useProcessingStore } from "@/stores/processingStore";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

// ── Global toast manager ────────────────────────────────────────────────────────

export function ProcessingToast() {
  const navigate = useNavigate();
  const { isProcessing, images, totalImages, setToastId, reset } = useProcessingStore();

  const doneCount = images.filter((img) => img.status === "done").length;
  const errorCount = images.filter((img) => img.status === "error").length;
  const hasErrors = errorCount > 0;
  const allDone = images.length > 0 && images.every((img) => img.status !== "pending" && img.status !== "processing");
  const totalDone = doneCount + errorCount;

  // Show/update toast when processing starts
  useEffect(() => {
    if (!isProcessing) return;

    // Use a fixed string id so we can update it later
    const id = "processing-toast";

    toast(
      <ProcessingToastContent
        totalImages={totalImages}
        onViewDetails={() => navigate("/analyze/processing")}
        onDismiss={() => {
          useProcessingStore.getState().reset();
          toast.dismiss(id);
        }}
      />,
      {
        id,
        position: "top-right",
        dismissible: false,
        duration: Infinity,
        className: "overflow-hidden p-0",
      },
    );
    setToastId(id);
  }, [isProcessing, navigate, totalImages, setToastId]);

  // When all done, replace toast with completion message
  useEffect(() => {
    if (!isProcessing) return;
    if (images.length === 0) return;
    if (totalDone < totalImages) return;
    if (!allDone) return;

    setTimeout(() => {
      const toastFn = hasErrors ? toast.warning : toast.success;

      toastFn("Analysis complete", {
        id: "processing-toast",
        position: "top-right",
        description: hasErrors
          ? `${doneCount} completed · ${errorCount} failed`
          : `${doneCount} image${doneCount !== 1 ? "s" : ""} completed successfully`,
        action: {
          label: "View Results",
          onClick: () => {
            navigate("/analyze/results");
            reset();
          },
        },
        duration: 6000,
      });
    }, 300);

    setToastId(null);
  }, [isProcessing, allDone, doneCount, errorCount, hasErrors, images.length, totalImages, totalDone, navigate, reset, setToastId]);

  return null;
}

// ── Toast inner content ─────────────────────────────────────────────────────────

function ProcessingToastContent({
  totalImages,
  onViewDetails,
  onDismiss,
}: {
  totalImages: number;
  onViewDetails: () => void;
  onDismiss: () => void;
}) {
  const { images } = useProcessingStore();

  const doneCount = images.filter((img) => img.status === "done").length;
  const errorCount = images.filter((img) => img.status === "error").length;
  const processingCount = images.filter((img) => img.status === "processing").length;
  const hasErrors = errorCount > 0;
  const totalProcessed = doneCount + errorCount;
  const progress = totalImages > 0 ? (totalProcessed / totalImages) * 100 : 0;

  return (
    <div className="flex w-full flex-col bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg border shadow-xs",
              processingCount > 0 && "border-primary/20 bg-primary/10 text-primary",
              processingCount === 0 && !hasErrors && "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
              processingCount === 0 && hasErrors && "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300",
            )}
          >
            <Microscope
              className={cn(
                "h-4 w-4",
                processingCount > 0 && "animate-pulse",
              )}
            />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-5">
              {processingCount > 0
                ? "Analyzing images…"
                : doneCount > 0
                ? "Analysis complete"
                : "Starting…"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {totalProcessed}/{totalImages} processed
            </p>
          </div>
        </div>
        <span className="rounded-full border border-border/70 bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
          {processingCount > 0
            ? `${processingCount} active`
            : hasErrors
            ? `${errorCount} failed`
            : "Finalized"}
        </span>
      </div>

      <div className="px-4 pt-3">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted/80">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              hasErrors ? "bg-amber-500" : "bg-primary",
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-xs">
        <span className="text-muted-foreground">{doneCount} complete</span>
        {processingCount > 0 && <span className="text-primary">{processingCount} processing</span>}
        {errorCount > 0 && <span className="text-amber-600 dark:text-amber-400">{errorCount} failed</span>}
      </div>

      <div className="flex items-center gap-2 border-t border-border/70 px-4 py-3">
        <Button
          type="button"
          onClick={onViewDetails}
          variant="outline"
          size="sm"
          className="h-8 flex-1"
        >
          View Details
        </Button>
        <Button
          type="button"
          onClick={onDismiss}
          variant="ghost"
          size="sm"
          className="h-8 px-3 text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
