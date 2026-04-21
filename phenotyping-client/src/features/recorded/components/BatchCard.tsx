// BatchCard — rich summary card for one analysis batch.
// Shows status, organism, image count, total eggs, confidence, and elapsed time.

import { useState } from "react";
import {
  Calendar,
  ImageIcon,
  Egg,
  AlertCircle,
  Loader2,
  CheckCircle2,
  Clock,
  Trash2,
  ChevronRight,
  Cpu,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
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
      return {
        label: "Completed",
        icon: CheckCircle2,
        badgeVariant: "success" as const,
        accentClass: "border-l-green-500 dark:border-l-green-400",
      };
    case "failed":
      return {
        label: "Failed",
        icon: AlertCircle,
        badgeVariant: "destructive" as const,
        accentClass: "border-l-destructive",
      };
    case "processing":
      return {
        label: "Processing",
        icon: Loader2,
        badgeVariant: "warning" as const,
        accentClass: "border-l-amber-500 dark:border-l-amber-400",
      };
    default:
      return {
        label: "Unknown",
        icon: Clock,
        badgeVariant: "secondary" as const,
        accentClass: "border-l-border",
      };
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
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatCount(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString();
}

function formatElapsed(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

export function BatchCard({ batch, onDelete }: BatchCardProps) {
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);

  const status = parseStatus(batch.status);
  const info = statusInfo(status);
  const StatusIcon = info.icon;
  const confidencePct = batch.avg_confidence != null ? Math.round(batch.avg_confidence * 100) : null;

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
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/recorded?batch=${batch.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(`/recorded?batch=${batch.id}`);
        }
      }}
      className={cn(
        "group relative flex flex-col gap-4 rounded-xl border-l-4 border border-border bg-card px-4 py-4",
        "transition-all duration-200 hover:shadow-md hover:bg-accent/20",
        "focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "active:scale-[0.99] cursor-pointer select-none",
        info.accentClass,
      )}
    >
      {/* Top row: status badge + timestamp */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={info.badgeVariant} className="gap-1">
            <StatusIcon className={cn("h-3 w-3", status === "processing" && "animate-spin")} />
            {info.label}
          </Badge>
          <span className="text-xs font-medium text-muted-foreground capitalize">
            {batch.organism_type}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3" />
            <span className="hidden sm:inline">{formatDate(batch.created_at)} · </span>
            {formatTime(batch.created_at)}
          </div>
          {/* Delete — inline in the flex so it never collides with the
              date / chevron. Kept hidden until hover so the resting state
              reads as a single "info row", then swaps to chevron + trash
              on hover. Wrapped in a stopPropagation span so clicking
              anywhere on the trash icon doesn't bubble into the card's
              "open detail" handler. */}
          {onDelete && (
            <span onClick={(e) => e.stopPropagation()}>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground",
                      "opacity-0 transition-all duration-150",
                      "group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive",
                      "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                      deleting && "pointer-events-none opacity-50",
                    )}
                    title="Delete batch"
                    disabled={deleting}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this batch?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently remove the {batch.organism_type} analysis from{" "}
                      {formatDate(batch.created_at)} with {batch.total_image_count} image
                      {batch.total_image_count !== 1 ? "s" : ""}. This action cannot be undone.
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
            </span>
          )}
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 -translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0" />
        </div>
      </div>

      {/* Title — batch name (truncated, tooltip shows full). */}
      <div className="min-w-0 -mt-1">
        <h3
          className="truncate text-sm font-semibold text-foreground"
          title={batch.name}
        >
          {batch.name || "Untitled batch"}
        </h3>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ImageIcon className="h-3 w-3" />
            Images
          </div>
          <span className="text-sm font-semibold tabular-nums">{batch.total_image_count}</span>
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Egg className="h-3 w-3" />
            Eggs
          </div>
          <span className="text-sm font-semibold tabular-nums">{formatCount(batch.total_count)}</span>
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            Time
          </div>
          <span className="text-sm font-semibold tabular-nums">{formatElapsed(batch.total_elapsed_secs)}</span>
        </div>
      </div>

      {/* Footer: device tag + confidence bar */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <Badge variant="outline" className="font-mono text-[10px] gap-1 h-5 uppercase">
            <Cpu className="h-2.5 w-2.5" />
            {batch.device}
          </Badge>
          <Badge variant="outline" className="text-[10px] h-5 capitalize">{batch.mode}</Badge>
        </div>

        {confidencePct !== null && (
          <div className="ml-auto flex items-center gap-2">
            <Progress
              value={confidencePct}
              variant={confidencePct >= 75 ? "success" : "default"}
              className="h-1.5 w-14"
            />
            <span className="text-[11px] tabular-nums text-muted-foreground w-8 text-right">
              {confidencePct}%
            </span>
          </div>
        )}
      </div>

    </div>
  );
}
