// BatchDetail — full detail view for a single analysis batch.
// Shows batch info + image list with overlay thumbnails, stats, and status.
// Used on the /recorded/:batchId route.

import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Calendar,
  Clock,
  Egg,
  Image,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/common/ErrorState";
import { getAnalysisDetail, getAnalysesOverlayUrl } from "@/services/api";
import { cn } from "@/lib/utils";
import type { AnalysisBatchDetail, AnalysisImageSummary } from "@/types/api";

type ImageStatus = "completed" | "failed" | "processing" | "unknown";

function statusInfo(status: ImageStatus) {
  switch (status) {
    case "completed":
      return { icon: CheckCircle2, className: "text-green-500" };
    case "failed":
      return { icon: AlertCircle, className: "text-red-500" };
    case "processing":
      return { icon: Loader2, className: "text-yellow-500 animate-spin" };
    default:
      return { icon: Clock, className: "text-muted-foreground" };
  }
}

function parseImageStatus(status: string): ImageStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "processing") return "processing";
  return "unknown";
}

function formatElapsed(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

interface ImageRowProps {
  image: AnalysisImageSummary;
  batchId: string;
}

function ImageRow({ image, batchId }: ImageRowProps) {
  const [imgError, setImgError] = useState(false);
  const overlaySrc = image.overlay_path ? getAnalysesOverlayUrl(batchId, image.id) : null;
  const status = parseImageStatus(image.status);
  const info = statusInfo(status);
  const StatusIcon = info.icon;

  return (
    <div className="flex items-center gap-4 rounded-md border p-3 transition-colors duration-100 hover:bg-accent/50 cursor-pointer focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.99]">
      {/* Thumbnail */}
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded bg-muted transition-shadow duration-200 hover:shadow-sm">
        {overlaySrc && !imgError ? (
          <img
            src={overlaySrc}
            alt={image.original_filename}
            className="h-full w-full object-cover transition-transform duration-200 hover:scale-105"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Image className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
        <div className={cn("absolute bottom-0.5 right-0.5 rounded-full", info.className)}>
          <StatusIcon className="h-3 w-3" />
        </div>
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{image.original_filename}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          {image.count !== null && (
            <span className="flex items-center gap-1">
              <Egg className="h-3 w-3" />
              {image.count.toLocaleString()} eggs
            </span>
          )}
          {image.avg_confidence !== null && (
            <span>{(image.avg_confidence * 100).toFixed(1)}% confidence</span>
          )}
          {image.elapsed_secs !== null && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatElapsed(image.elapsed_secs)}
            </span>
          )}
          {image.error_message && (
            <span className="flex items-center gap-1 truncate text-red-500">
              <AlertCircle className="h-3 w-3 shrink-0" />
              {image.error_message}
            </span>
          )}
        </div>
      </div>

      {/* View overlay link */}
      {overlaySrc && !imgError && (
        <Button
          variant="ghost"
          size="icon"
          asChild
          className="h-7 w-7 shrink-0"
        >
          <a href={overlaySrc} target="_blank" rel="noopener noreferrer" title="View overlay">
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      )}
    </div>
  );
}

export function BatchDetail() {
  const { batchId } = useParams<{ batchId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<AnalysisBatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function fetchBatch() {
    if (!batchId) return;
    setLoading(true);
    setError(null);
    getAnalysisDetail(batchId)
      .then((data) => setDetail(data))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchBatch();
  }, [batchId]);

  if (!batchId) {
    navigate("/recorded", { replace: true });
    return null;
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-4 border-b px-6 py-4">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="flex flex-1 overflow-y-auto p-6">
          <div className="flex w-full flex-col gap-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
            <Skeleton className="h-4 w-32" />
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-4 border-b px-6 py-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/recorded")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="text-destructive font-medium">Failed to load batch</span>
        </div>
        <div className="flex flex-1 items-center justify-center px-6">
          <ErrorState
            message={error}
            title="Could not load this analysis batch"
            onRetry={fetchBatch}
            onBack={() => navigate("/recorded")}
          />
        </div>
      </div>
    );
  }

  if (!detail) return null;

  const completedCount = detail.images.filter((i) => i.status === "completed").length;
  const failedCount = detail.images.filter((i) => i.status === "failed").length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-4 border-b px-6 py-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/recorded")}
          title="Back to recorded analyses"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">
            {detail.organism_type} — {detail.mode}
          </h1>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {formatDate(detail.created_at)}
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-2 py-0.5 font-mono">{detail.device}</span>
          <span className="rounded bg-muted px-2 py-0.5">{detail.mode}</span>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col overflow-y-auto p-6">
        {/* Summary stat cards */}
        <div className="grid gap-4 sm:grid-cols-3 mb-6">
          <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Image className="h-3.5 w-3.5" />
              Images processed
            </div>
            <div className="text-2xl font-bold">
              {completedCount}
              {failedCount > 0 && <span className="ml-2 text-sm font-normal text-destructive">+{failedCount} failed</span>}
            </div>
            <div className="text-xs text-muted-foreground">
              of {detail.total_image_count} total
            </div>
          </div>

          <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Egg className="h-3.5 w-3.5" />
              Total eggs counted
            </div>
            <div className="text-2xl font-bold">
              {detail.total_count !== null ? detail.total_count.toLocaleString() : "—"}
            </div>
            {detail.avg_confidence !== null && (
              <div className="text-xs text-muted-foreground">
                avg {(detail.avg_confidence * 100).toFixed(1)}% confidence
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              Processing time
            </div>
            <div className="text-2xl font-bold">
              {formatElapsed(detail.total_elapsed_secs)}
            </div>
            {detail.total_elapsed_secs && detail.total_image_count > 0 && (
              <div className="text-xs text-muted-foreground">
                avg {(detail.total_elapsed_secs / detail.total_image_count).toFixed(1)}s per image
              </div>
            )}
          </div>
        </div>

        {/* Config snapshot */}
        {detail.config_snapshot && Object.keys(detail.config_snapshot).length > 0 && (
          <div className="mb-6">
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Config snapshot</h2>
            <div className="flex flex-wrap gap-2">
              {Object.entries(detail.config_snapshot).map(([key, val]) => (
                <span key={key} className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
                  {key}: <span className="text-foreground">{String(val)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Notes */}
        {detail.notes && (
          <div className="mb-6">
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Notes</h2>
            <p className="rounded border bg-card px-3 py-2 text-sm">{detail.notes}</p>
          </div>
        )}

        {/* Image list */}
        <div>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            Images ({detail.images.length})
          </h2>
          <div className="space-y-2">
            {detail.images.map((image) => (
              <ImageRow key={image.id} image={image} batchId={detail.id} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
