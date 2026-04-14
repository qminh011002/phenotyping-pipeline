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
import { Microscope, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { inferSingleEgg } from "@/services/api";
import type { DetectionResult } from "@/types/api";
import {
  loadProcessingFiles,
  loadOrganism,
  storeProcessingResults,
  storeDbBatchId,
  storeBatchSummary,
  storeBatchDetail,
  clearProcessingSession,
  storeProcessingConfig,
} from "@/features/upload/lib/processingSession";
import { useProcessingStore } from "@/stores/processingStore";

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

// ── Per-image status card ─────────────────────────────────────────────────────

interface StatusCardProps {
  entry: ImageEntry;
}

function StatusCard({ entry }: StatusCardProps) {
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
          {entry.status === "pending" && "Waiting…"}
          {entry.status === "processing" && "Processing…"}
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
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ProcessingPage() {
  const navigate = useNavigate();

  // ── Zustand store ──────────────────────────────────────────────────────────
  const { startProcessing, setImages, updateImage, finishProcessing, reset: resetStore } =
    useProcessingStore();

  // ── Local state for page rendering ─────────────────────────────────────────
  const [images, setLocalImages] = useState<ImageEntry[]>([]);
  const [pageState, setPageState] = useState<PageState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [totalElapsed, setTotalElapsed] = useState(0);

  const doneCount = images.filter((img) => img.status === "done").length;
  const errorCount = images.filter((img) => img.status === "error").length;
  const progress = images.length > 0 ? (doneCount / images.length) * 100 : 0;
  const anyError = errorCount > 0;

  // ── Start processing on mount ───────────────────────────────────────────────

  const startedRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    async function run() {
      // ── 1. Load session data ────────────────────────────────────────────────
      const stored = loadProcessingFiles();

      if (stored.length === 0) {
        setPageState("error");
        setError("No images found. Please go back and upload images again.");
        return;
      }

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

      // ── 3. Create DB batch ───────────────────────────────────────────────────
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

      // Process images one at a time
      for (let i = 0; i < stored.length; i++) {
        // Honour cancellation
        if (cancelledRef.current) break;

        const file = stored[i];
        const entry = entries[i];

        // Mark as processing
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
          setLocalImages((prev) =>
            prev.map((img) =>
              img.id === entry.id
                ? { ...img, status: "error", error: msg }
                : img,
            ),
          );
          updateImage(entry.id, { status: "error", error: msg });
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
      setLocalImages((currentImages) => {
        const doneImages = currentImages.filter((img) => img.status === "done" && img.result);
        const storedResults = doneImages.map((img) => ({
          id: img.id,
          filename: img.filename,
          result: img.result!,
        }));
        storeProcessingResults(storedResults);

        // Persist batch summary so ResultViewer can show totals
        const total_count = doneImages.reduce((sum, img) => sum + (img.result?.count ?? 0), 0);
        storeBatchSummary({
          total_count,
          total_elapsed_seconds: elapsed,
        });

        finishProcessing();
        setPageState("done");
        return currentImages;
      });
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
    // Clear processing-specific data but leave batch summary for ResultViewer
    sessionStorage.removeItem("phenotyping_processing_files");
    sessionStorage.removeItem("phenotyping_processing_results");
    sessionStorage.removeItem("phenotyping_processing_organism");
    sessionStorage.removeItem("phenotyping_processing_batch_id");
    // Keep DB batch ID and batch summary — ResultViewer needs them
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
                  ? `Analyzing image ${doneCount + 1} of ${images.length}`
                  : allDone
                  ? `All ${images.length} images processed`
                  : `${doneCount} of ${images.length} images processed`}
              </span>
              <span className="font-mono tabular-nums font-medium">{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="h-2 w-full" />
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
          {images.map((img) => (
            <StatusCard key={img.id} entry={img} />
          ))}
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
