// BatchDetail — full detail view for a single analysis batch.
// Shows batch info + image list with overlay thumbnails, stats, and status.

import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Calendar,
  Clock,
  Egg,
  ImageIcon,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ExternalLink,
  Cpu,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { ErrorState } from "@/components/common/ErrorState";
import { getAnalysisDetail, getAnalysesOverlayUrl } from "@/services/api";
import { cn } from "@/lib/utils";
import { listContainerVariants, listItemVariants } from "@/lib/motion";
import type { AnalysisBatchDetail, AnalysisImageSummary } from "@/types/api";

type ImageStatus = "completed" | "failed" | "processing" | "unknown";

function statusInfo(status: ImageStatus) {
  switch (status) {
    case "completed":
      return { icon: CheckCircle2, className: "text-green-500" };
    case "failed":
      return { icon: AlertCircle, className: "text-destructive" };
    case "processing":
      return { icon: Loader2, className: "text-amber-500 animate-spin" };
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

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface StatCardProps {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: boolean;
}

function StatCard({ icon: Icon, label, value, sub, accent }: StatCardProps) {
  return (
    <div className={cn(
      "flex flex-col gap-1.5 rounded-xl border bg-card p-4",
      accent && "border-primary/30 bg-primary/5",
    )}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums leading-none">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
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
  const confidencePct = image.avg_confidence != null ? Math.round(image.avg_confidence * 100) : null;

  return (
    <div className="flex items-center gap-4 rounded-lg border bg-card px-3 py-3 transition-colors duration-150 hover:bg-accent/40">
      {/* Thumbnail */}
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md bg-muted">
        {overlaySrc && !imgError ? (
          <img
            src={overlaySrc}
            alt={image.original_filename}
            className="h-full w-full object-cover transition-transform duration-200 hover:scale-105"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon className="h-5 w-5 text-muted-foreground/50" />
          </div>
        )}
        <div className={cn("absolute bottom-0.5 right-0.5 rounded-full bg-card/80 backdrop-blur-sm p-0.5", info.className)}>
          <StatusIcon className="h-3 w-3" />
        </div>
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{image.original_filename}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {image.count !== null && (
            <span className="flex items-center gap-1">
              <Egg className="h-3 w-3" />
              {image.count.toLocaleString()} eggs
            </span>
          )}
          {image.elapsed_secs !== null && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatElapsed(image.elapsed_secs)}
            </span>
          )}
          {image.error_message && (
            <span className="flex items-center gap-1 text-destructive truncate">
              <AlertCircle className="h-3 w-3 shrink-0" />
              {image.error_message}
            </span>
          )}
        </div>
      </div>

      {/* Confidence */}
      {confidencePct !== null && (
        <div className="hidden sm:flex flex-col items-end gap-1 shrink-0">
          <span className="text-xs tabular-nums text-muted-foreground">{confidencePct}%</span>
          <Progress value={confidencePct} variant={confidencePct >= 75 ? "success" : "default"} className="h-1 w-12" />
        </div>
      )}

      {/* View overlay link */}
      {overlaySrc && !imgError && (
        <Button
          variant="ghost"
          size="icon"
          asChild
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
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
  const [searchParams] = useSearchParams();
  const batchId = searchParams.get("batch");
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
        <div className="flex items-center gap-3 border-b px-6 py-4">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-24 rounded-xl" />
            </div>
            <Skeleton className="h-px w-full" />
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
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
        <div className="flex items-center gap-3 border-b px-6 py-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/recorded")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">Batch detail</span>
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
      <div className="flex items-center gap-3 border-b bg-card/50 px-6 py-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/recorded")}
          title="Back to recorded analyses"
          className="shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold leading-none">
            {detail.organism_type} — {detail.mode}
          </h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {formatDate(detail.created_at)} · {formatTime(detail.created_at)}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="outline" className="font-mono text-xs gap-1">
            <Cpu className="h-3 w-3" />
            {detail.device}
          </Badge>
          <Badge variant="outline" className="text-xs">{detail.mode}</Badge>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Summary stat cards */}
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              icon={ImageIcon}
              label="Images processed"
              value={
                <span>
                  {completedCount}
                  {failedCount > 0 && (
                    <span className="ml-2 text-sm font-normal text-destructive">
                      +{failedCount} failed
                    </span>
                  )}
                </span>
              }
              sub={`of ${detail.total_image_count} total`}
            />

            <StatCard
              icon={Egg}
              label="Total eggs counted"
              value={detail.total_count !== null ? detail.total_count.toLocaleString() : "—"}
              sub={
                detail.avg_confidence !== null
                  ? `avg ${(detail.avg_confidence * 100).toFixed(1)}% confidence`
                  : undefined
              }
              accent
            />

            <StatCard
              icon={Clock}
              label="Processing time"
              value={formatElapsed(detail.total_elapsed_secs)}
              sub={
                detail.total_elapsed_secs && detail.total_image_count > 0
                  ? `avg ${(detail.total_elapsed_secs / detail.total_image_count).toFixed(1)}s per image`
                  : undefined
              }
            />
          </div>

          {/* Confidence bar */}
          {detail.avg_confidence !== null && (
            <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
              <TrendingUp className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-muted-foreground">Average confidence</span>
                  <span className="text-xs font-semibold tabular-nums">
                    {(detail.avg_confidence * 100).toFixed(1)}%
                  </span>
                </div>
                <Progress
                  value={detail.avg_confidence * 100}
                  variant={detail.avg_confidence >= 0.75 ? "success" : "default"}
                  className="h-2"
                />
              </div>
            </div>
          )}

          {/* Config snapshot */}
          {detail.config_snapshot && Object.keys(detail.config_snapshot).length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Config snapshot
              </h2>
              <div className="flex flex-wrap gap-2">
                {Object.entries(detail.config_snapshot).map(([key, val]) => (
                  <span key={key} className="rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs">
                    {key}: <span className="text-foreground font-medium">{String(val)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {detail.notes && (
            <div>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</h2>
              <p className="rounded-lg border bg-card px-4 py-3 text-sm">{detail.notes}</p>
            </div>
          )}

          <Separator />

          {/* Image list */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Images ({detail.images.length})
              </h2>
              {failedCount > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {failedCount} failed
                </Badge>
              )}
            </div>

            <motion.div
              className="space-y-2"
              variants={listContainerVariants}
              initial="hidden"
              animate="visible"
            >
              {detail.images.map((image) => (
                <motion.div key={image.id} variants={listItemVariants}>
                  <ImageRow image={image} batchId={detail.id} />
                </motion.div>
              ))}
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
}
