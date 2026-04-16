// ProcessingPage — dedicated route for batch inference with live progress.
//
// Route: /analyze/processing
// Receives files via sessionStorage from UploadPage.
// Shows progress bar + per-image status. On completion navigates to result viewer.
// Also syncs progress to the global ProcessingToast via the Zustand store.
//
// FS-002: Creates a DB batch on mount, sends per-file inference requests,
// persists each result to PostgreSQL, and marks the batch complete.

import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Microscope, AlertCircle, CheckCircle2, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { inferSingleEgg } from "@/services/api";
import type { DetectionResult } from "@/types/api";
import {
  loadProcessingFiles,
  loadOrganism,
  loadBatchId,
  storeProcessingResults,
  storeDbBatchId,
  storeBatchSummary,
  storeBatchDetail,
  clearProcessingSession,
  storeProcessingConfig,
} from "@/features/upload/lib/processingSession";
import { useProcessingStore } from "@/stores/processingStore";

// Module-level guard: ensures createBatch fires at most once per session batch id,
// even if the component is remounted (React StrictMode dev remount, HMR, or fast
// navigate-away/back). The session batch id is regenerated on every new "Process"
// click in UploadPage, so legitimate new runs are always allowed.
const _startedSessionBatchIds = new Set<string>();

// Initial per-image estimate when we have no observed timings yet. We update
// this to a moving average as real images complete. CPU runs tend to be
// ~10–30s per image at typical tile settings; start optimistic and let the
// countdown self-correct.
const DEFAULT_SECS_PER_IMAGE = 15;

// Cap the "virtual" progress inside a single image so the bar never claims
// 100% until the server actually returns. 0.95 = 95%.
const MAX_VIRTUAL_IMAGE_PROGRESS = 0.95;

// ── Types ──────────────────────────────────────────────────────────────────────

type ImageStatus = "pending" | "processing" | "done" | "error";

interface ImageEntry {
  id: string;
  filename: string;
  blobUrl: string;
  status: ImageStatus;
  result?: DetectionResult;
  error?: string;
}

type PageState = "loading" | "creating_batch" | "processing" | "done" | "error";

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

interface StatusCardProps {
  entry: ImageEntry;
  // Seconds remaining for this specific image. Shown next to the status text.
  // - pending → full per-image estimate
  // - processing → estimate minus elapsed (counts down via tick)
  // - done/error → undefined (rendered as actual elapsed / error message)
  etaSeconds?: number;
}

function StatusCard({ entry, etaSeconds }: StatusCardProps) {
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

      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded border">
        <img
          src={entry.blobUrl}
          alt={entry.filename}
          className="h-full w-full object-cover"
        />
        {entry.status === "done" && entry.result && (
          <div className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 py-0.5 text-[9px] font-bold text-white">
            {entry.result.count}
          </div>
        )}
      </div>

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
          {entry.status === "done" && entry.result && (
            <>
              {entry.result.count} eggs · {(entry.result.avg_confidence * 100).toFixed(1)}% confidence ·{" "}
              {entry.result.elapsed_seconds.toFixed(1)}s
            </>
          )}
          {entry.status === "done" && !entry.result && "Completed"}
          {entry.status === "error" && (entry.error ?? "Processing failed")}
        </p>
      </div>

      {entry.status === "done" && entry.result && (
        <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 transition-colors duration-150 hover:bg-green-200 dark:bg-green-900 dark:text-green-300 dark:hover:bg-green-800">
          {entry.result.elapsed_seconds.toFixed(1)}s
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

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ProcessingPage() {
  const navigate = useNavigate();

  // ── Zustand store ──────────────────────────────────────────────────────────
  const { startProcessing, setImages, updateImage, finishProcessing, reset: resetStore } =
    useProcessingStore();
  // Selectors — subscribe so a re-mounted ProcessingPage (e.g. React strict
  // mode, HMR, or a quick navigate-away-and-back) reflects progress produced
  // by an already-running background run() of the same session.
  const storeImages = useProcessingStore((s) => s.images);
  const storeIsProcessing = useProcessingStore((s) => s.isProcessing);

  // ── Local state for page rendering ─────────────────────────────────────────
  const [images, setLocalImages] = useState<ImageEntry[]>([]);
  const [pageState, setPageState] = useState<PageState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [totalElapsed, setTotalElapsed] = useState(0);
  // Drives a re-render every 250ms while processing so the virtual progress
  // bar advances and the ETA counts down without waiting for network events.
  const [, setNowTick] = useState(0);

  // Refs backing the ETA calculation so they survive across renders without
  // causing re-renders themselves.
  const currentImageStartRef = useRef<number | null>(null);
  const completedDurationsRef = useRef<number[]>([]);

  const doneCount = images.filter((img) => img.status === "done").length;
  const errorCount = images.filter((img) => img.status === "error").length;
  const anyError = errorCount > 0;

  // Estimated seconds per image — moving average of completed images, falling
  // back to the default when nothing has finished yet.
  const avgSecsPerImage =
    completedDurationsRef.current.length > 0
      ? completedDurationsRef.current.reduce((a, b) => a + b, 0) /
        completedDurationsRef.current.length
      : DEFAULT_SECS_PER_IMAGE;

  // Virtual progress inside the currently-processing image (0–0.95).
  let virtualImageProgress = 0;
  if (pageState === "processing" && currentImageStartRef.current !== null) {
    const elapsed = (Date.now() - currentImageStartRef.current) / 1000;
    virtualImageProgress = Math.min(
      MAX_VIRTUAL_IMAGE_PROGRESS,
      elapsed / Math.max(avgSecsPerImage, 0.1),
    );
  }

  const progress =
    images.length > 0
      ? ((doneCount + errorCount + virtualImageProgress) / images.length) * 100
      : 0;

  const remainingImages =
    images.length > 0
      ? Math.max(0, images.length - doneCount - errorCount - virtualImageProgress)
      : 0;
  const etaSeconds =
    pageState === "processing" && images.length > 0
      ? remainingImages * avgSecsPerImage
      : null;

  // ── Start processing on mount ───────────────────────────────────────────────

  const cancelledRef = useRef(false);

  // Tick every 250ms while processing to drive ETA countdown + progress bar.
  useEffect(() => {
    if (pageState !== "processing") return;
    const id = window.setInterval(() => setNowTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [pageState]);

  // Sync local image statuses from the Zustand store. This is essential when
  // the current ProcessingPage instance was re-mounted after a previous
  // instance's run() started — only the store is the shared source of truth
  // for status, since the previous instance's setLocalImages calls are
  // orphaned. It is also harmless during a normal single-mount run because the
  // store values match what run() just wrote to local state.
  useEffect(() => {
    if (storeImages.length === 0) return;
    setLocalImages((prev) => {
      if (prev.length === 0) return prev;
      let changed = false;
      const next = prev.map((p) => {
        const s = storeImages.find((i) => i.id === p.id);
        if (!s) return p;
        if (p.status === s.status && p.error === s.error) return p;
        changed = true;
        return { ...p, status: s.status, error: s.error };
      });
      return changed ? next : prev;
    });
  }, [storeImages]);

  // If a background run() finished while we were re-mounted, transition to
  // "done" so the footer shows "View Results". We detect this via the store:
  // isProcessing flipped false AND every image is terminal.
  useEffect(() => {
    if (storeIsProcessing) return;
    if (storeImages.length === 0) return;
    if (pageState !== "processing") return;
    const allTerminal = storeImages.every(
      (img) => img.status === "done" || img.status === "error",
    );
    if (allTerminal) setPageState("done");
  }, [storeIsProcessing, storeImages, pageState]);

  useEffect(() => {
    const sessionBatchId = loadBatchId();
    if (!sessionBatchId) {
      setPageState("error");
      setError("No processing session found. Please go back and upload images again.");
      return;
    }

    // Always hydrate the visible images list from session storage so the page
    // renders cards with thumbnails even if the run() was started by an earlier
    // (now unmounted) instance of this component.
    const stored = loadProcessingFiles();
    if (stored.length === 0) {
      setPageState("error");
      setError("No images found. Please go back and upload images again.");
      return;
    }
    setLocalImages((prev) =>
      prev.length > 0
        ? prev
        : stored.map((f) => ({
            id: f.id,
            filename: f.name,
            blobUrl: f.blobUrl,
            status: "pending",
          })),
    );

    // Module-level guard ensures createBatch + the inference loop fire at most
    // once per session batch id, even if the component re-mounts. On a blocked
    // re-mount we still want to render progress, so we reflect the Zustand
    // store (which the original run() is updating) and return without starting
    // a second run.
    if (_startedSessionBatchIds.has(sessionBatchId)) {
      // If Zustand knows progress, advance to processing so the UI shows cards
      // and the progress bar. Final "done" transition is handled by the
      // Zustand-driven effect below.
      setPageState((prev) => (prev === "loading" ? "processing" : prev));
      return;
    }
    _startedSessionBatchIds.add(sessionBatchId);

    async function run() {
      const organism = loadOrganism();

      // ── 2. Initialize entries ───────────────────────────────────────────────
      const entries: ImageEntry[] = stored.map((f) => ({
        id: f.id,
        filename: f.name,
        blobUrl: f.blobUrl,
        status: "pending",
      }));

      startProcessing(stored.length);
      setLocalImages(entries);
      setImages(
        stored.map((f) => ({ id: f.id, filename: f.name, status: "pending" })),
      );
      setPageState("creating_batch");

      // ── 3. Create DB batch ─────────────────────────────────────────────────
      // `storeProcessingFiles` (UploadPage) clears any stale db_batch_id, so
      // we always create a fresh one here. The module-level _startedSessionBatchIds
      // guard ensures this effect body only runs once per session batch id.
      let newDbBatchId = "";
      let configSnapshot: Record<string, unknown> = {};
      try {
        const { createBatch, getConfig } = await import("@/services/api");
        // Fetch current config to store as snapshot; non-fatal if this fails
        try {
          const currentConfig = await getConfig();
          // Strip the 'model' path from the snapshot — it is not meaningful to show
          const { model: _model, ...rest } = currentConfig;
          configSnapshot = rest;
        } catch {
          // Config fetch failed — proceed with empty snapshot
        }
        const detail = await createBatch({
          organism_type: organism,
          mode: "upload",
          device: (configSnapshot.device as string) ?? "cpu",
          config_snapshot: configSnapshot,
          total_image_count: stored.length,
        });
        newDbBatchId = detail.id;
        storeDbBatchId(newDbBatchId);
        storeProcessingConfig(configSnapshot);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to create analysis batch: ${msg}`);
        finishProcessing();
        setPageState("error");
        return;
      }

      // ── 4. Process each image sequentially ───────────────────────────────────
      setPageState("processing");
      const startTime = Date.now();

      // Collect results directly from the loop so we are NOT dependent on
      // React state / refs at the completion step. If this instance is
      // unmounted mid-run (React strict-mode remount, HMR), setLocalImages
      // updates are silently dropped, and imagesRef stops syncing — reading
      // state there would write an empty results array to sessionStorage
      // and ResultViewer would redirect back to "/".
      const runResults: Array<{ id: string; filename: string; result?: DetectionResult; error?: string }> = [];

      // Process images one at a time
      for (let i = 0; i < stored.length; i++) {
        // Honour cancellation
        if (cancelledRef.current) break;

        const file = stored[i];
        const entry = entries[i];

        // Mark as processing + start the per-image timer so the virtual
        // progress bar + ETA can advance while inference runs.
        currentImageStartRef.current = Date.now();
        setLocalImages((prev) =>
          prev.map((img) =>
            img.id === entry.id ? { ...img, status: "processing" } : img,
          ),
        );
        updateImage(entry.id, { status: "processing" });

        try {
          // Reconstruct File from blob URL
          const resp = await fetch(file.blobUrl);
          const blob = await resp.blob();
          const fileObj = new File([blob], file.name, { type: file.type });

          // Run inference — pass the DB batch ID so overlay paths are stable
          if (cancelledRef.current) break;
          const result = await inferSingleEgg(fileObj, newDbBatchId);

          // Skip DB write if cancelled while waiting for network
          if (cancelledRef.current) break;

          // Persist to DB
          const { addImageResult } = await import("@/services/api");
          await addImageResult(newDbBatchId, {
            filename: result.filename,
            count: result.count,
            avg_confidence: result.avg_confidence,
            elapsed_seconds: result.elapsed_seconds,
            annotations: result.annotations,
            overlay_url: result.overlay_url,
          });

          // Record actual duration so future ETA estimates converge.
          completedDurationsRef.current.push(result.elapsed_seconds);

          // Accumulate for sessionStorage persistence (resilient to unmount).
          runResults.push({ id: entry.id, filename: entry.filename, result });

          // Mark done
          setLocalImages((prev) =>
            prev.map((img) =>
              img.id === entry.id ? { ...img, status: "done", result } : img,
            ),
          );
          updateImage(entry.id, {
            status: "done",
            count: result.count,
            avgConfidence: result.avg_confidence,
            elapsedSeconds: result.elapsed_seconds,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          runResults.push({ id: entry.id, filename: entry.filename, error: msg });
          setLocalImages((prev) =>
            prev.map((img) =>
              img.id === entry.id
                ? { ...img, status: "error", error: msg }
                : img,
            ),
          );
          updateImage(entry.id, { status: "error", error: msg });
        } finally {
          currentImageStartRef.current = null;
        }
      }

      if (cancelledRef.current) {
        navigate("/");
        return;
      }

      const elapsed = (Date.now() - startTime) / 1000;
      setTotalElapsed(elapsed);

      // ── 5. Mark batch as complete + fetch detail ───────────────────────────────
      try {
        const { completeBatch, getAnalysisDetail } = await import("@/services/api");
        await completeBatch(newDbBatchId);
        // Store full batch detail so ResultViewer can render overlays with correct image IDs
        const detail = await getAnalysisDetail(newDbBatchId);
        storeBatchDetail({
          id: detail.id,
          total_count: detail.total_count,
          total_elapsed_secs: detail.total_elapsed_secs,
          avg_confidence: detail.avg_confidence,
          images: detail.images,
        });
      } catch {
        // Non-fatal — the batch exists even if completion fails
      }

      // ── 6. Build results for session storage ─────────────────────────────────
      // Use the loop-local runResults array (not React state) so this works
      // correctly even if this component instance was unmounted mid-run.
      const doneResults = runResults.filter((r) => r.result !== undefined);
      const storedResults = doneResults.map((r) => ({
        id: r.id,
        filename: r.filename,
        result: r.result!,
      }));
      storeProcessingResults(storedResults);

      const total_count = doneResults.reduce((sum, r) => sum + (r.result?.count ?? 0), 0);
      storeBatchSummary({
        total_count,
        total_elapsed_seconds: elapsed,
      });

      finishProcessing();
      setPageState("done");
    }

    run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleCancel() {
    cancelledRef.current = true;
    resetStore();
    clearProcessingSession();
    navigate("/");
  }

  function handleViewResults() {
    resetStore();
    // Keep phenotyping_processing_files — ResultViewer uses the raw blob URLs
    // to render the original images with client-side bbox overlays.
    sessionStorage.removeItem("phenotyping_processing_organism");
    sessionStorage.removeItem("phenotyping_processing_batch_id");
    navigate("/analyze/results");
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (pageState === "loading" || pageState === "creating_batch") {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-3">
            <Microscope className="h-5 w-5 animate-pulse text-primary" />
            <h1 className="text-lg font-semibold">
              {pageState === "creating_batch" ? "Preparing analysis…" : "Loading…"}
            </h1>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span>{pageState === "creating_batch" ? "Creating analysis record…" : "Loading images…"}</span>
          </div>
        </div>
      </div>
    );
  }

  if (pageState === "error" && images.length === 0) {
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
          <Button variant="outline" onClick={handleCancel}>
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  const allDone = images.length > 0 && images.every((img) => img.status === "done");

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-3">
          {pageState === "processing" ? (
            <Microscope className="h-5 w-5 animate-pulse text-primary" />
          ) : anyError ? (
            <AlertCircle className="h-5 w-5 text-destructive" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          )}
          <h1 className="text-lg font-semibold">
            {pageState === "processing"
              ? "Processing images…"
              : anyError
              ? "Completed with errors"
              : "Analysis complete"}
          </h1>
        </div>
        {pageState === "processing" && (
          <Button variant="outline" size="sm" onClick={handleCancel} className="transition-colors duration-150 hover:bg-accent active:scale-[0.99]">
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
                {pageState === "processing"
                  ? `Analyzing image ${Math.min(doneCount + errorCount + 1, images.length)} of ${images.length}`
                  : allDone
                  ? `All ${images.length} images processed`
                  : `${doneCount} of ${images.length} images processed`}
              </span>
              <span className="font-mono tabular-nums font-medium">{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="h-2 w-full" />
            {pageState === "processing" && etaSeconds !== null && (
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

          {pageState === "done" && (
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
              {totalElapsed > 0 && (
                <span className="text-muted-foreground">Total time: {totalElapsed.toFixed(1)}s</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Per-image list ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-2xl space-y-2">
          {images.map((img) => {
            // Per-image ETA:
            //  • processing → avg minus elapsed on the current image (clamped ≥ 0)
            //  • pending    → full per-image average
            //  • done/error → undefined (card renders elapsed / error text)
            let perImageEta: number | undefined;
            if (img.status === "processing") {
              const startedAt = currentImageStartRef.current;
              const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;
              perImageEta = Math.max(0, avgSecsPerImage - elapsed);
            } else if (img.status === "pending") {
              perImageEta = avgSecsPerImage;
            }
            return <StatusCard key={img.id} entry={img} etaSeconds={perImageEta} />;
          })}
        </div>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      {pageState === "done" && (
        <footer className="flex items-center justify-end gap-3 border-t px-6 py-4">
          <Button variant="outline" onClick={handleCancel} className="transition-colors duration-150 hover:bg-accent active:scale-[0.99]">
            New Analysis
          </Button>
          <Button onClick={handleViewResults} className="transition-colors duration-150 active:scale-[0.99]">
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
