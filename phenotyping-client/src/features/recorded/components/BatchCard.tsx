// BatchCard — compact summary card for one analysis batch.
// Shows date, organism, image count, total eggs, and a status badge.

import { useState } from "react";
import { Calendar, Image, Egg, AlertCircle, Loader2, CheckCircle2, Clock, Trash2, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { AnalysisBatchSummary } from "@/types/api";

interface BatchCardProps {
  batch: AnalysisBatchSummary;
  onDelete?: (batchId: string) => Promise<void>;
}

type Status = "completed" | "failed" | "processing" | "unknown";

function statusInfo(status: Status) {
  switch (status) {
    case "completed":
      return { label: "Completed", icon: CheckCircle2, className: "bg-green-500/10 text-green-600 dark:text-green-400" };
    case "failed":
      return { label: "Failed", icon: AlertCircle, className: "bg-red-500/10 text-red-600 dark:text-red-400" };
    case "processing":
      return { label: "Processing", icon: Loader2, className: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 animate-spin" };
    default:
      return { label: "Unknown", icon: Clock, className: "bg-muted text-muted-foreground" };
  }
}

function parseStatus(status: string): Status {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "processing") return "processing";
  return "unknown";
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatCount(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString();
}

export function BatchCard({ batch, onDelete }: BatchCardProps) {
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);

  const status = parseStatus(batch.status);
  const info = statusInfo(status);
  const StatusIcon = info.icon;

  async function handleDelete() {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete(batch.id);
      toast.success("Batch deleted");
    } catch {
      toast.error("Failed to delete batch");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-3 rounded-lg border bg-card p-4",
        "transition-shadow duration-200 hover:shadow-md",
        "focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "active:scale-[0.99] cursor-pointer",
      )}
      onClick={() => navigate(`/recorded?batch=${batch.id}`)}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", info.className)}>
              <StatusIcon className="h-3 w-3" />
              {info.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {batch.organism_type} · {batch.mode}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3 shrink-0" />
            {formatDate(batch.created_at)} · {formatTime(batch.created_at)}
          </div>
        </div>

        {/* Row-level chevron — slides in on hover, implies drill-in */}
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-foreground opacity-0 group-hover:opacity-100 -translate-x-1" />

        {/* Delete button */}
        {onDelete && (
          <div
            className="opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "rounded-md p-1.5 text-muted-foreground",
                    "hover:bg-destructive/10 hover:text-destructive transition-colors",
                    deleting && "opacity-50 pointer-events-none"
                  )}
                  title="Delete batch"
                  disabled={deleting}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this batch?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently remove analysis &ldquo;{batch.organism_type} — {formatDate(batch.created_at)}&rdquo;
                    with {batch.total_image_count} image{batch.total_image_count !== 1 ? "s" : ""}.
                    This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>

      {/* Metrics row */}
      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Image className="h-3.5 w-3.5" />
          <span>{batch.total_image_count} image{batch.total_image_count !== 1 ? "s" : ""}</span>
        </div>

        {batch.total_count !== null && (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Egg className="h-3.5 w-3.5" />
            <span>{formatCount(batch.total_count)} eggs</span>
          </div>
        )}

        {batch.avg_confidence !== null && (
          <div className="text-xs text-muted-foreground">
            avg {(batch.avg_confidence * 100).toFixed(1)}% confidence
          </div>
        )}
      </div>

      {/* Device / mode footer */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{batch.device}</span>
        <span className="rounded bg-muted px-1.5 py-0.5">{batch.mode}</span>
        {batch.total_elapsed_secs !== null && (
          <span className="ml-auto">
            {batch.total_elapsed_secs < 60
              ? `${batch.total_elapsed_secs.toFixed(1)}s`
              : `${(batch.total_elapsed_secs / 60).toFixed(1)}m`}
          </span>
        )}
      </div>
    </div>
  );
}
