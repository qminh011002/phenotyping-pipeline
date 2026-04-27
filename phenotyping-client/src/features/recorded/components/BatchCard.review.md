# BatchCard Review Context

This file isolates the review context for [`BatchCard.tsx`](/home/minhtq/company_projects/phenotyping-ecosystem/phenotyping-client/src/features/recorded/components/BatchCard.tsx).

## Purpose

Use this Markdown file to share the component with another AI without needing the rest of the repo.

## Component Path

`src/features/recorded/components/BatchCard.tsx`

## Prop Contract Used By The Component

```ts
export interface AnalysisBatchSummary {
  id: string;
  name: string;
  created_at: string;
  completed_at: string | null;
  status: string;
  organism_type: string;
  mode: string;
  device: string;
  total_image_count: number;
  total_count: number | null;
  avg_confidence: number | null;
  total_elapsed_secs: number | null;
  processed_image_count: number;
  failed_at: string | null;
  failure_reason: string | null;
  classes: string[];
}
```

## Mock Data

```ts
import type { AnalysisBatchSummary } from "@/types/api";

export const mockBatches: AnalysisBatchSummary[] = [
  {
    id: "7f4de9d1-8e84-4ab7-b1ef-9e95d5f4b001",
    name: "Field Run A01",
    created_at: "2026-04-22T08:15:00.000Z",
    completed_at: "2026-04-22T08:17:31.000Z",
    status: "completed",
    organism_type: "egg",
    mode: "detect",
    device: "cpu",
    total_image_count: 24,
    total_count: 482,
    avg_confidence: 0.91,
    total_elapsed_secs: 151.4,
    processed_image_count: 24,
    failed_at: null,
    failure_reason: null,
    classes: ["egg"],
  },
  {
    id: "7f4de9d1-8e84-4ab7-b1ef-9e95d5f4b002",
    name: "Incubator Tray B07",
    created_at: "2026-04-22T09:02:00.000Z",
    completed_at: null,
    status: "processing",
    organism_type: "larvae",
    mode: "segment",
    device: "cuda:0",
    total_image_count: 40,
    total_count: 219,
    avg_confidence: 0.74,
    total_elapsed_secs: 43.6,
    processed_image_count: 17,
    failed_at: null,
    failure_reason: null,
    classes: ["larvae"],
  },
  {
    id: "7f4de9d1-8e84-4ab7-b1ef-9e95d5f4b003",
    name: "Night Capture C12",
    created_at: "2026-04-22T10:41:00.000Z",
    completed_at: null,
    status: "failed",
    organism_type: "pupae",
    mode: "detect",
    device: "cpu",
    total_image_count: 12,
    total_count: null,
    avg_confidence: null,
    total_elapsed_secs: null,
    processed_image_count: 3,
    failed_at: "2026-04-22T10:42:09.000Z",
    failure_reason: "Model checkpoint could not be loaded",
    classes: ["pupae"],
  },
  {
    id: "7f4de9d1-8e84-4ab7-b1ef-9e95d5f4b004",
    name: "",
    created_at: "2026-04-22T11:05:00.000Z",
    completed_at: null,
    status: "queued",
    organism_type: "neonate",
    mode: "classify",
    device: "cpu",
    total_image_count: 1,
    total_count: null,
    avg_confidence: null,
    total_elapsed_secs: 4.2,
    processed_image_count: 0,
    failed_at: null,
    failure_reason: null,
    classes: ["neonate"],
  },
];

export async function mockDeleteBatch(batchId: string) {
  console.log("Delete batch:", batchId);
}
```

## Minimal Usage Example

```tsx
import { BatchCard } from "./BatchCard";
import { mockBatches, mockDeleteBatch } from "./mockBatches";

export function BatchCardReviewExample() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {mockBatches.map((batch) => (
        <BatchCard key={batch.id} batch={batch} onDelete={mockDeleteBatch} />
      ))}
    </div>
  );
}
```

## Current Component Source

```tsx
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

      <div className="min-w-0 -mt-1">
        <h3 className="truncate text-sm font-semibold text-foreground" title={batch.name}>
          {batch.name || "Untitled batch"}
        </h3>
      </div>

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

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <Badge variant="outline" className="font-mono text-[10px] gap-1 h-5 uppercase">
            <Cpu className="h-2.5 w-2.5" />
            {batch.device}
          </Badge>
          <Badge variant="outline" className="text-[10px] h-5 capitalize">
            {batch.mode}
          </Badge>
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
```

## Runtime Dependencies The Reviewer Should Know

- `useNavigate` from `react-router-dom`
- `AlertDialog`, `Badge`, `Progress` UI primitives
- `toast` from `sonner`
- `cn` helper from `@/lib/utils`
- `lucide-react` icons
