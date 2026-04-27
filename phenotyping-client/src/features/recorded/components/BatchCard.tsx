// BatchCard — rich summary card for one analysis batch.
// Shows status, organism, image count, total eggs, confidence, and elapsed time.

import { memo, useState } from "react";
import {
  ImageIcon,
  Egg,
  AlertCircle,
  Loader2,
  CheckCircle2,
  Clock,
  FileEdit,
  Trash2,
  Cpu,
  MoreVertical,
  Gauge,
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
import { getAnalysesRawUrl } from "@/services/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { RecordedBatchSummary } from "../hooks/useRecorded";
import { useOverlayThumbnail } from "../lib/overlayThumbnail";

interface BatchCardProps {
  batch: RecordedBatchSummary;
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
        accentClass:
          "border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-300",
        dotClass: "bg-green-500 shadow-[0_0_8px_rgb(34_197_94_/_0.65)]",
      };
    case "failed":
      return {
        label: "Failed",
        icon: AlertCircle,
        badgeVariant: "destructive" as const,
        accentClass: "border-destructive/25 bg-destructive/10 text-destructive",
        dotClass: "bg-destructive shadow-[0_0_8px_rgb(239_68_68_/_0.55)]",
      };
    case "processing":
      return {
        label: "Processing",
        icon: Loader2,
        badgeVariant: "warning" as const,
        accentClass:
          "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        dotClass: "bg-amber-500 shadow-[0_0_8px_rgb(245_158_11_/_0.55)]",
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
        accentClass: "border-border bg-muted text-muted-foreground",
        dotClass: "bg-muted-foreground",
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

function formatRelativeDate(isoString: string): string {
  const date = new Date(isoString);
  const diffMs = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (!Number.isFinite(diffMs)) return `${formatDate(isoString)} ${formatTime(isoString)}`;
  if (diffMs < minute) return "edited just now";
  if (diffMs < hour) {
    const minutes = Math.max(1, Math.floor(diffMs / minute));
    return `edited ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (diffMs < day) {
    const hours = Math.max(1, Math.floor(diffMs / hour));
    return `edited ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  const days = Math.floor(diffMs / day);
  if (days === 1) return "edited a day ago";
  if (days < 30) return `edited ${days} days ago`;
  return `edited ${formatDate(isoString)}`;
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

interface StatChipProps {
  icon: typeof ImageIcon;
  label: string;
  value: string | number;
}

function StatChip({ icon: Icon, label, value }: StatChipProps) {
  return (
    <span
      className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-muted/45 px-2 py-1 text-[11px] font-medium text-muted-foreground"
      title={`${value} ${label}`}
    >
      <Icon className="size-3 shrink-0 text-muted-foreground/75" />
      <span>
        <span className="font-semibold tabular-nums text-foreground">
          {value}
        </span>{" "}
        {label}
      </span>
    </span>
  );
}

function ThumbPattern({ status }: { status: Status }) {
  const tint =
    status === "failed"
      ? "from-destructive/25"
      : status === "processing"
        ? "from-amber-500/25"
        : "from-primary/25";

  return (
    <div className="relative flex size-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
      <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,rgb(255_255_255_/_0.06)_0,rgb(255_255_255_/_0.06)_2px,transparent_2px,transparent_9px)]" />
      <div className={cn("absolute inset-0 bg-gradient-to-br to-transparent", tint)} />
      <div className="absolute left-2 top-2 size-2 rounded-full bg-foreground/70 blur-[1px]" />
      <div className="absolute left-8 top-3 size-3 rounded-full bg-foreground/55 blur-[1px]" />
      <div className="absolute bottom-3 left-4 size-2.5 rounded-full bg-foreground/60 blur-[1px]" />
      <div className="absolute bottom-5 right-3 size-3.5 rounded-full bg-foreground/65 blur-[1px]" />
      <ImageIcon className="relative m-auto size-5 text-muted-foreground/45" />
    </div>
  );
}

function BatchThumbnail({ batch, status }: { batch: RecordedBatchSummary; status: Status }) {
  const firstImage = batch.firstImage;
  const srcUrl = firstImage ? getAnalysesRawUrl(batch.id, firstImage.id) : null;
  const { thumbUrl, error } = useOverlayThumbnail(srcUrl);

  return (
    <div className="relative flex size-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
      {thumbUrl && !error ? (
        <img
          src={thumbUrl}
          alt={firstImage?.original_filename ?? `${batch.name} first image`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
        />
      ) : (
        <ThumbPattern status={status} />
      )}
    </div>
  );
}

function CompactDeleteAction({
  batch,
  deleting,
  onDelete,
  handleDelete,
}: {
  batch: RecordedBatchSummary;
  deleting: boolean;
  onDelete?: (batchId: string) => Promise<void>;
  handleDelete: () => Promise<void>;
}) {
  if (!onDelete) {
    return (
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70">
        <MoreVertical className="size-4" />
      </div>
    );
  }

  return (
    <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors duration-150",
              "hover:bg-destructive/10 hover:text-destructive",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              deleting && "pointer-events-none opacity-50",
            )}
            title="Delete batch"
            disabled={deleting}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Trash2 className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            <MoreVertical className="absolute size-4 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />
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
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
}

function VersionChip({ name }: { name: string }) {
  const match = name.match(/(?:^|[_\-\s])(R\d+)$/i);
  if (!match) return null;

  return (
    <span className="absolute left-0 top-0 z-10 rounded-br-md bg-primary px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none text-primary-foreground">
      {match[1].toUpperCase()}
    </span>
  );
}

function ConfidenceChip({ confidencePct }: { confidencePct: number | null }) {
  if (confidencePct === null) return null;

  return (
    <span
      className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-muted/45 px-2 py-1 text-[11px] font-medium text-muted-foreground"
      title={`${confidencePct}% confidence`}
    >
      <Gauge className="size-3 shrink-0 text-muted-foreground/75" />
      <span>
        <span className="font-semibold tabular-nums text-foreground">
          {confidencePct}%
        </span>{" "}
        Conf
      </span>
    </span>
  );
}

function DeviceChip({ device }: { device: string }) {
  return (
    <span
      className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-muted/45 px-2 py-1 font-mono text-[10px] font-medium uppercase text-muted-foreground"
      title={device}
    >
      <Cpu className="size-3 shrink-0 text-muted-foreground/75" />
      <span>{device}</span>
    </span>
  );
}

function TimeChip({ value }: { value: string }) {
  return (
    <span
      className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-muted/45 px-2 py-1 text-[11px] font-medium text-muted-foreground"
      title={`Elapsed ${value}`}
    >
      <Clock className="size-3 shrink-0 text-muted-foreground/75" />
      <span>{value}</span>
    </span>
  );
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
        "group relative flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card/80 shadow-sm",
        "transition-all duration-150 hover:-translate-y-px hover:bg-card hover:shadow-md",
        "focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "active:scale-[0.99] cursor-pointer select-none",
      )}
    >
      <VersionChip name={batch.name} />

      <div className="flex min-w-0 shrink-0 items-start gap-3 px-3.5 pt-3.5">
        <BatchThumbnail batch={batch} status={status} />

        <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <Badge
              variant={info.badgeVariant}
              className={cn(
                "h-5 max-w-full min-w-0 gap-1 rounded-md border px-2 text-[10px] font-semibold uppercase",
                info.accentClass,
              )}
            >
              <StatusIcon className={cn("size-3 shrink-0", status === "processing" && "animate-spin")} />
              <span className="min-w-0 truncate">{info.label}</span>
            </Badge>

            <CompactDeleteAction
              batch={batch}
              deleting={deleting}
              onDelete={onDelete}
              handleDelete={handleDelete}
            />
          </div>

          <h3
            className="min-w-0 truncate text-sm font-bold tracking-tight text-foreground"
            title={batch.name}
          >
            {batch.name || "Untitled batch"}
          </h3>

          <div
            className="min-w-0 truncate text-[11px] text-muted-foreground"
            title={`${formatDate(batch.created_at)} · ${formatTime(batch.created_at)}`}
          >
            {formatRelativeDate(batch.created_at)}
          </div>
        </div>
      </div>

      <div className="mt-4 flex min-w-0 shrink-0 items-start gap-2 px-3.5 pb-3.5">
        <span className={cn("mt-2 size-2 shrink-0 rounded-full", info.dotClass)} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 overflow-hidden">
          <StatChip icon={ImageIcon} label="Images" value={batch.total_image_count.toLocaleString()} />
          <StatChip icon={Egg} label="Eggs" value={formatCount(batch.total_count)} />
          <TimeChip value={formatElapsed(batch.total_elapsed_secs)} />
          <ConfidenceChip confidencePct={confidencePct} />
          <DeviceChip device={batch.device} />
        </div>
      </div>
    </div>
  );
}

export const BatchCard = memo(BatchCardImpl);
