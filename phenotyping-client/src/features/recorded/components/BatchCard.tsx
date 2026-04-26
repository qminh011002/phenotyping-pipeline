// BatchCard — rich summary card for one analysis batch.
// Shows status, organism, image count, total eggs, confidence, and elapsed time.

import { memo, useState } from "react";
import {
  Calendar,
  ImageIcon,
  Egg,
  AlertCircle,
  Loader2,
  CheckCircle2,
  Clock,
  FileEdit,
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

type Status = "completed" | "failed" | "processing" | "draft" | "unknown";

function statusInfo(status: Status) {
  switch (status) {
    case "completed":
      return {
        label: "Completed",
        icon: CheckCircle2,
        badgeVariant: "success" as const,
        accentClass: "bg-green-500/10 text-green-700 dark:text-green-300",
        iconClass: "bg-green-500/10 text-green-600 dark:text-green-400",
        progressVariant: "success" as const,
      };
    case "failed":
      return {
        label: "Failed",
        icon: AlertCircle,
        badgeVariant: "destructive" as const,
        accentClass: "bg-destructive/10 text-destructive",
        iconClass: "bg-destructive/10 text-destructive",
        progressVariant: "destructive" as const,
      };
    case "processing":
      return {
        label: "Processing",
        icon: Loader2,
        badgeVariant: "warning" as const,
        accentClass: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        iconClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        progressVariant: "default" as const,
      };
    case "draft":
      return {
        label: "Draft",
        icon: FileEdit,
        badgeVariant: "warning" as const,
        accentClass: "border-l-amber-500 dark:border-l-amber-400",
      };
    default:
      return {
        label: "Unknown",
        icon: Clock,
        badgeVariant: "secondary" as const,
        accentClass: "bg-muted text-muted-foreground",
        iconClass: "bg-muted text-muted-foreground",
        progressVariant: "default" as const,
      };
  }
}

function parseStatus(status: string): Status {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "processing") return "processing";
  if (status === "draft") return "draft";
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

function BatchCardImpl({ batch, onDelete }: BatchCardProps) {
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
      onClick={(e) => {
        if (e.defaultPrevented) return;
        navigate(`/recorded?batch=${batch.id}`);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(`/recorded?batch=${batch.id}`);
        }
      }}
      className={cn(
        "group relative flex min-h-[210px] flex-col gap-4 overflow-hidden rounded-lg bg-card/80 px-4 py-4 shadow-sm",
        "transition-all duration-200 hover:-translate-y-0.5 hover:bg-card hover:shadow-lg",
        "focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "active:scale-[0.99] cursor-pointer select-none",
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-primary/70 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

      {/* Top row: status badge + timestamp */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-md", info.iconClass)}>
            <StatusIcon className={cn("size-4", status === "processing" && "animate-spin")} />
          </div>
          <div className="min-w-0">
            <Badge
              variant={info.badgeVariant}
              className={cn("h-5 gap-1 rounded-md px-2 text-[10px]", info.accentClass)}
            >
              {info.label}
            </Badge>
            <div className="mt-1 text-xs font-medium text-muted-foreground capitalize">
              {batch.organism_type} · {batch.mode}
            </div>
          </div>
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
      <div className="min-w-0">
        <h3
          className="truncate text-base font-semibold tracking-tight text-foreground"
          title={batch.name}
        >
          {batch.name || "Untitled batch"}
        </h3>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {batch.processed_image_count}/{batch.total_image_count} processed
          {batch.classes.length > 0 && ` · ${batch.classes.join(", ")}`}
        </p>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md bg-muted/45 p-3">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ImageIcon className="h-3 w-3" />
            Images
          </div>
          <span className="mt-1 block text-lg font-semibold tabular-nums">{batch.total_image_count}</span>
        </div>

        <div className="rounded-md bg-muted/45 p-3">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Egg className="h-3 w-3" />
            Eggs
          </div>
          <span className="mt-1 block text-lg font-semibold tabular-nums">{formatCount(batch.total_count)}</span>
        </div>

        <div className="rounded-md bg-muted/45 p-3">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            Time
          </div>
          <span className="mt-1 block text-lg font-semibold tabular-nums">{formatElapsed(batch.total_elapsed_secs)}</span>
        </div>
      </div>

      {/* Footer: device tag + confidence bar */}
      <div className="mt-auto flex items-center gap-2">
        <div className="flex items-center gap-1">
          <Badge variant="secondary" className="font-mono text-[10px] gap-1 h-5 uppercase">
            <Cpu className="h-2.5 w-2.5" />
            {batch.device}
          </Badge>
        </div>

        {confidencePct !== null && (
          <div className="ml-auto flex items-center gap-2">
            <Progress
              value={confidencePct}
              variant={confidencePct >= 75 ? info.progressVariant : "default"}
              className="h-1.5 w-20"
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

export const BatchCard = memo(BatchCardImpl);
