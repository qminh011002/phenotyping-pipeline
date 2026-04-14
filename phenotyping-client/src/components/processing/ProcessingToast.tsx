// ProcessingToast — persistent toast with live progress bar.
// Appears in top-right, persists when navigating, click navigates to the processing page.

import { useNavigate } from "react-router-dom";
import { Microscope, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useEffect } from "react";
import { useProcessingStore } from "@/stores/processingStore";
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
      <ProcessingToastContent totalImages={totalImages} />,
      {
        id,
        position: "top-right",
        dismissible: false,
        duration: Infinity,
        className: "w-80 p-0 overflow-hidden",
      },
    );
    setToastId(id);
  }, [isProcessing, totalImages, setToastId]);

  // When all done, replace toast with completion message
  useEffect(() => {
    if (!isProcessing) return;
    if (images.length === 0) return;
    if (totalDone < totalImages) return;
    if (!allDone) return;

    setTimeout(() => {
      toast("Analysis complete", {
        id: "processing-toast",
        position: "top-right",
        icon: hasErrors ? (
          <XCircle className="h-5 w-5 text-yellow-500" />
        ) : (
          <CheckCircle2 className="h-5 w-5 text-green-500" />
        ),
        description: `${doneCount} images${hasErrors ? ` · ${errorCount} failed` : " · all successful"}`,
        action: {
          label: "View Results",
          onClick: () => {
            navigate("/analyze/results");
            reset();
          },
        },
        duration: 6000,
        className: "w-80",
      });
    }, 300);

    setToastId(null);
  }, [isProcessing, allDone, doneCount, errorCount, hasErrors, images.length, totalImages, totalDone, navigate, reset, setToastId]);

  return null;
}

// ── Toast inner content ─────────────────────────────────────────────────────────

function ProcessingToastContent({ totalImages }: { totalImages: number }) {
  const { images } = useProcessingStore();

  const doneCount = images.filter((img) => img.status === "done").length;
  const errorCount = images.filter((img) => img.status === "error").length;
  const processingCount = images.filter((img) => img.status === "processing").length;
  const hasErrors = errorCount > 0;
  const progress = totalImages > 0 ? (doneCount / totalImages) * 100 : 0;

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Microscope className={cn(
            "h-4 w-4",
            processingCount > 0 ? "text-primary animate-pulse" : "text-muted-foreground",
          )} />
          <span className="text-sm font-medium">
            {processingCount > 0
              ? "Analyzing images…"
              : doneCount > 0
              ? "Analysis complete"
              : "Starting…"}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {doneCount}/{totalImages}
        </span>
      </div>

      {/* Progress bar */}
      <div className="px-4 pt-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              hasErrors ? "bg-yellow-500" : "bg-primary",
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 px-4 py-2 text-xs text-muted-foreground">
        <span>{doneCount} done</span>
        {processingCount > 0 && <span className="text-primary">{processingCount} processing</span>}
        {errorCount > 0 && <span className="text-yellow-600 dark:text-yellow-400">{errorCount} failed</span>}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t px-4 py-2">
        <button
          type="button"
          onClick={() => {/* noop — toast is already showing on this page */}}
          className="flex-1 rounded-sm bg-muted/60 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          View Details
        </button>
        <button
          type="button"
          onClick={() => {
            useProcessingStore.getState().reset();
            toast.dismiss("processing-toast");
          }}
          className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
