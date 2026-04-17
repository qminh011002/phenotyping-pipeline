// ProcessingPage — pure subscriber to the processing manager.
//
// All inference happens inside services/processingManager.ts so the loop is
// not bound to this component's lifecycle. This page just renders whatever
// state the manager has written to useProcessingStore, plus a thin tick to
// animate per-image ETAs.
//
// On mount it asks the manager to reconcile against the backend (handles the
// "user navigated away during processing" and "user opened the page directly"
// cases). It never starts work itself — UploadPage's Process button is the
// only entry point for new runs.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Microscope, AlertCircle, CheckCircle2, Timer, PauseCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  loadProcessingFiles,
  loadBatchId,
} from "@/features/upload/lib/processingSession";
import { useProcessingStore } from "@/stores/processingStore";
import {
  cancelProcessing,
  discardInterruptedBatch,
  finalizeInterruptedBatch,
  isManagerRunning,
  resumeActiveBatchIfAny,
} from "@/services/processingManager";

const DEFAULT_SECS_PER_IMAGE = 15;
const MAX_VIRTUAL_IMAGE_PROGRESS = 0.95;

// ── ETA formatter ─────────────────────────────────────────────────────────────

function formatEta(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
}

// ── Per-image status card ─────────────────────────────────────────────────────

interface DisplayImage {
  id: string;
  filename: string;
  blobUrl: string;
  status: "pending" | "processing" | "done" | "error";
  count?: number;
  avgConfidence?: number;
  elapsedSeconds?: number;
  error?: string;
}

function StatusCard({ entry, etaSeconds }: { entry: DisplayImage; etaSeconds?: number }) {
  return (
    <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center">
        {entry.status === "pending" && (
          <div className="h-5 w-5 rounded-full border-2 border-muted-foreground/30" />
        )}
        {entry.status === "processing" && (
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        )}
        {entry.status === "done" && (
          <CheckCircle2 className="h-5 w-5 text-green-500" />
        )}
        {entry.status === "error" && (
          <AlertCircle className="h-5 w-5 text-red-500" />
        )}
      </div>

      {entry.blobUrl && (
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded border">
          <img
            src={entry.blobUrl}
            alt={entry.filename}
            className="h-full w-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          {entry.status === "done" && entry.count !== undefined && (
            <div className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 py-0.5 text-[9px] font-bold text-white">
              {entry.count}
            </div>
          )}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.filename}</p>
        <p className="text-xs text-muted-foreground">
          {entry.status === "pending" && (
            <>Waiting{etaSeconds !== undefined ? ` · ~${formatEta(etaSeconds)}` : "…"}</>
          )}
          {entry.status === "processing" && (
            <>
              Processing…
              {etaSeconds !== undefined && (
                <>
                  {" "}· {etaSeconds > 0 ? `${formatEta(etaSeconds)} left` : "finishing…"}
                </>
              )}
            </>
          )}
          {entry.status === "done" && entry.count !== undefined && (
            <>
              {entry.count} eggs · {((entry.avgConfidence ?? 0) * 100).toFixed(1)}% confidence ·{" "}
              {(entry.elapsedSeconds ?? 0).toFixed(1)}s
            </>
          )}
          {entry.status === "done" && entry.count === undefined && "Completed"}
          {entry.status === "error" && (entry.error ?? "Processing failed")}
        </p>
      </div>

      {entry.status === "done" && entry.elapsedSeconds !== undefined && (
        <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 transition-colors duration-150 hover:bg-green-200 dark:bg-green-900 dark:text-green-300 dark:hover:bg-green-800">
          {entry.elapsedSeconds.toFixed(1)}s
        </span>
      )}
      {entry.status === "processing" && etaSeconds !== undefined && etaSeconds > 0 && (
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums text-primary">
          {formatEta(etaSeconds)}
        </span>
      )}
    </div>
  );
}

// ── Interrupted batch UI (FS-012) ────────────────────────────────────────────

function InterruptedBatch({
  batchName,
  processedCount,
  totalImages,
  onViewResults,
  onDiscard,
}: {
  batchName: string;
  processedCount: number;
  totalImages: number;
  onViewResults: () => void;
  onDiscard: () => void;
}) {
  const progress = totalImages > 0 ? Math.round((processedCount / totalImages) * 100) : 0;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <PauseCircle className="h-5 w-5 text-amber-500" />
          <h1 className="text-lg font-semibold">Processing interrupted</h1>
        </div>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <PauseCircle className="h-16 w-16 text-amber-500/50" />
        <div className="space-y-2">
          <p className="text-lg font-medium">{batchName}</p>
          <p className="text-sm text-muted-foreground">
            Processing was interrupted. {processedCount} of {totalImages} images completed ({progress}%).
          </p>
          <Progress value={progress} className="mx-auto h-2 w-64" />
        </div>
        <div className="flex gap-3">
          {processedCount > 0 && (
            <Button variant="outline" onClick={onViewResults}>
              View Completed Results
            </Button>
          )}
          <Button variant="destructive" onClick={onDiscard}>
            Discard &amp; Start Over
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ProcessingPage() {
  const navigate = useNavigate();
  const [, setNowTick] = useState(0);

  // Pull store state — subscribe to the slices we render.
  const isProcessing = useProcessingStore((s) => s.isProcessing);
  const storeImages = useProcessingStore((s) => s.images);
  const totalImages = useProcessingStore((s) => s.totalImages);
  const processedCount = useProcessingStore((s) => s.processedCount);
  const currentImageStartMs = useProcessingStore((s) => s.currentImageStartMs);
  const completedDurations = useProcessingStore((s) => s.completedDurations);
  const totalElapsedSeconds = useProcessingStore((s) => s.totalElapsedSeconds);
  const error = useProcessingStore((s) => s.error);
  const interruptedBatch = useProcessingStore((s) => s.interruptedBatch);
  const completedBatchId = useProcessingStore((s) => s.completedBatchId);
  const activeBatchId = useProcessingStore((s) => s.activeBatchId);

  // ── Mount: ask manager to reconcile against backend ────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // If the manager isn't already running, see if a backend batch is active.
      if (!isManagerRunning()) {
        const took = await resumeActiveBatchIfAny();
        if (cancelled) return;
        // If nothing to do here AND no fresh upload session, send the user back.
        if (!took && !isManagerRunning()) {
          const sessionBatchId = loadBatchId();
          const stored = loadProcessingFiles();
          if (!sessionBatchId || stored.length === 0) {
            navigate("/analyze");
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // Tick to animate ETA / virtual progress while processing.
  useEffect(() => {
    if (!isProcessing) return;
    const id = window.setInterval(() => setNowTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [isProcessing]);

  // Auto-navigate to results once a batch completes.
  useEffect(() => {
    if (completedBatchId) {
      navigate("/analyze/results");
    }
  }, [completedBatchId, navigate]);

  // ── Derived rendering data ─────────────────────────────────────────────────

  // Hydrate blob URLs from the upload session for thumbnails.
  const blobLookup = useMemo(() => {
    const files = loadProcessingFiles();
    const map = new Map<string, string>();
    files.forEach((f) => map.set(f.id, f.blobUrl));
    return map;
  }, [storeImages.length]);

  const displayImages: DisplayImage[] = storeImages.map((img) => ({
    id: img.id,
    filename: img.filename,
    blobUrl: blobLookup.get(img.id) ?? "",
    status: img.status,
    count: img.count,
    avgConfidence: img.avgConfidence,
    elapsedSeconds: img.elapsedSeconds,
    error: img.error,
  }));

  const doneCount = displayImages.filter((img) => img.status === "done").length;
  const errorCount = displayImages.filter((img) => img.status === "error").length;
  const anyError = errorCount > 0;

  const avgSecsPerImage =
    completedDurations.length > 0
      ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length
      : DEFAULT_SECS_PER_IMAGE;

  let virtualImageProgress = 0;
  if (isProcessing && currentImageStartMs !== null) {
    const elapsed = (Date.now() - currentImageStartMs) / 1000;
    virtualImageProgress = Math.min(
      MAX_VIRTUAL_IMAGE_PROGRESS,
      elapsed / Math.max(avgSecsPerImage, 0.1),
    );
  }

  const progress =
    totalImages > 0
      ? ((doneCount + errorCount + virtualImageProgress) / totalImages) * 100
      : 0;

  const remainingImages =
    totalImages > 0
      ? Math.max(0, totalImages - doneCount - errorCount - virtualImageProgress)
      : 0;
  const etaSeconds =
    isProcessing && totalImages > 0 ? remainingImages * avgSecsPerImage : null;

  const allDone =
    !isProcessing && totalImages > 0 && displayImages.every((img) => img.status === "done");

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleCancel() {
    cancelProcessing();
    navigate("/");
  }

  function handleViewResults() {
    sessionStorage.removeItem("phenotyping_processing_organism");
    sessionStorage.removeItem("phenotyping_processing_batch_id");
    navigate("/analyze/results");
  }

  async function handleInterruptedViewResults() {
    await finalizeInterruptedBatch();
    navigate("/analyze/results");
  }

  function handleInterruptedDiscard() {
    discardInterruptedBatch();
    navigate("/analyze");
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (interruptedBatch) {
    return (
      <InterruptedBatch
        batchName={interruptedBatch.name}
        processedCount={interruptedBatch.processedCount}
        totalImages={interruptedBatch.totalImages}
        onViewResults={handleInterruptedViewResults}
        onDiscard={handleInterruptedDiscard}
      />
    );
  }

  // Loading / creating-batch view: store hasn't been populated yet, but we
  // know we should be doing something (manager is running, or active batch
  // exists). Show a spinner until images land.
  if (storeImages.length === 0 && !error) {
    const label = activeBatchId ? "Preparing analysis…" : "Loading…";
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-3">
            <Microscope className="h-5 w-5 animate-pulse text-primary" />
            <h1 className="text-lg font-semibold">{label}</h1>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span>{activeBatchId ? "Creating analysis record…" : "Loading images…"}</span>
          </div>
        </div>
      </div>
    );
  }

  if (error && storeImages.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <h1 className="text-lg font-semibold">Processing failed</h1>
          </div>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <AlertCircle className="h-12 w-12 text-destructive" />
          <div>
            <p className="text-sm font-medium">Failed to start processing</p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          </div>
          <Button variant="outline" onClick={() => navigate("/analyze")}>
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-3">
          {isProcessing ? (
            <Microscope className="h-5 w-5 animate-pulse text-primary" />
          ) : anyError ? (
            <AlertCircle className="h-5 w-5 text-destructive" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          )}
          <h1 className="text-lg font-semibold">
            {isProcessing
              ? "Processing images…"
              : anyError
              ? "Completed with errors"
              : "Analysis complete"}
          </h1>
        </div>
        {isProcessing && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancel}
            className="transition-colors duration-150 hover:bg-accent active:scale-[0.99]"
          >
            Cancel
          </Button>
        )}
      </header>

      {/* ── Progress ──────────────────────────────────────────────────────── */}
      <div className="border-b px-6 py-5">
        <div className="mx-auto max-w-2xl space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {isProcessing
                  ? `Analyzing image ${Math.min(processedCount + errorCount + 1, totalImages)} of ${totalImages}`
                  : allDone
                  ? `All ${totalImages} images processed`
                  : `${doneCount} of ${totalImages} images processed`}
              </span>
              <span className="font-mono tabular-nums font-medium">{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="h-2 w-full" />
            {isProcessing && etaSeconds !== null && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Timer className="h-3.5 w-3.5" />
                  {etaSeconds > 0
                    ? `About ${formatEta(etaSeconds)} remaining`
                    : "Finishing up…"}
                </span>
                <span className="font-mono tabular-nums">
                  ~{avgSecsPerImage.toFixed(1)}s / image
                </span>
              </div>
            )}
          </div>

          {!isProcessing && totalImages > 0 && (
            <div className="flex flex-wrap gap-3 text-sm">
              <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                {doneCount} completed
              </span>
              {anyError && (
                <span className="flex items-center gap-1.5 text-red-500">
                  <AlertCircle className="h-4 w-4" />
                  {errorCount} failed
                </span>
              )}
              {totalElapsedSeconds > 0 && (
                <span className="text-muted-foreground">
                  Total time: {totalElapsedSeconds.toFixed(1)}s
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Per-image list ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-2xl space-y-2">
          {displayImages.map((img) => {
            let perImageEta: number | undefined;
            if (img.status === "processing") {
              const elapsed = currentImageStartMs ? (Date.now() - currentImageStartMs) / 1000 : 0;
              perImageEta = Math.max(0, avgSecsPerImage - elapsed);
            } else if (img.status === "pending") {
              perImageEta = avgSecsPerImage;
            }
            return <StatusCard key={img.id} entry={img} etaSeconds={perImageEta} />;
          })}
        </div>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      {!isProcessing && totalImages > 0 && (
        <footer className="flex items-center justify-end gap-3 border-t px-6 py-4">
          <Button
            variant="outline"
            onClick={handleCancel}
            className="transition-colors duration-150 hover:bg-accent active:scale-[0.99]"
          >
            New Analysis
          </Button>
          <Button
            onClick={handleViewResults}
            className="transition-colors duration-150 active:scale-[0.99]"
          >
            View Results
            <svg className="ml-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </Button>
        </footer>
      )}
    </div>
  );
}
