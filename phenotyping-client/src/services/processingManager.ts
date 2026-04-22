// Processing manager — owns the per-batch inference loop as a module-level
// singleton. The UI (ProcessingPage, ProcessingIndicator, UploadPage) reads
// state from useProcessingStore; only this module mutates the loop's runtime.
//
// Why this exists: keeping the loop inside ProcessingPage's useEffect tied
// the worker lifetime to a React component, which produced two problems:
//   1. Navigating away then back re-mounted the page and triggered a second,
//      parallel runProcessing call against the same DB batch.
//   2. The badge / Upload page had no clean way to show live status without
//      duplicating state.
// Lifting it out gives a single owner with idempotent start, plus a stable
// place for the cancel signal.

import {
  addImageResult,
  completeBatch,
  createBatch,
  failBatch,
  getActiveBatch,
  getAnalysisDetail,
  getConfig,
  inferSingle,
} from "./api";
import type { Organism } from "@/types/api";
import {
  clearProcessingSession,
  loadDbBatchId,
  loadOrganism,
  loadProcessingFiles,
  loadProjectClasses,
  storeBatchDetail,
  storeBatchSummary,
  storeDbBatchId,
  storeProcessingConfig,
  storeProcessingResults,
  type StoredFile,
} from "@/features/upload/lib/processingSession";
import { useProcessingStore } from "@/stores/processingStore";
import { startStageTracker } from "./stageTracker";
import type { DetectionResult } from "@/types/api";

function setStage(stage: string | null): void {
  useProcessingStore.getState().setStage(stage);
}

interface RuntimeState {
  running: boolean;
  dbBatchId: string | null;
  cancelled: boolean;
  // Tracks any in-flight resume probe so concurrent callers share one promise.
  resumeProbe: Promise<boolean> | null;
  organism: Organism;
}

const runtime: RuntimeState = {
  running: false,
  dbBatchId: null,
  cancelled: false,
  resumeProbe: null,
  organism: "egg",
};

export function isManagerRunning(): boolean {
  return runtime.running;
}

export function getRunningBatchId(): string | null {
  return runtime.dbBatchId;
}

// ── Public entry points ────────────────────────────────────────────────────

/**
 * Start a brand-new run from files already persisted to sessionStorage by
 * UploadPage. Idempotent: if a run is already in flight, this is a no-op.
 */
export async function startProcessingFromSession(): Promise<void> {
  if (runtime.running) return;
  const stored = loadProcessingFiles();
  if (stored.length === 0) return;

  const store = useProcessingStore.getState();
  store.startProcessing(stored.length);
  store.setImages(
    stored.map((f) => ({ id: f.id, filename: f.name, status: "pending" })),
  );

  // Run in background — caller (UploadPage) navigates immediately.
  void runNewBatch(stored);
}

/**
 * Reconcile UI state with the backend's notion of an active batch. Called by
 * ProcessingPage on mount. Returns true if it took ownership of state.
 *
 * - If a loop is already running locally → no-op.
 * - If backend reports an active batch and we have matching session files →
 *   resume the loop from the last-processed index.
 * - If backend reports active but session files are gone (different tab,
 *   reload, etc.) → mark interrupted.
 * - If backend reports no active batch → no-op (caller falls back to its own
 *   logic, e.g. "navigate to /analyze").
 */
export async function resumeActiveBatchIfAny(): Promise<boolean> {
  if (runtime.running) return true;
  if (runtime.resumeProbe) return runtime.resumeProbe;

  runtime.resumeProbe = (async () => {
    let active;
    try {
      active = await getActiveBatch();
    } catch {
      return false;
    }
    if (!active.active || !active.batch) return false;

    const batch = active.batch;
    const store = useProcessingStore.getState();
    store.setActiveBatch(batch.id, batch.processed_image_count, batch.total_image_count);
    store.markRestoredFromBackend();

    if (batch.processed_image_count >= batch.total_image_count) {
      // Already done on the server — finalize & route to results.
      try {
        await completeBatch(batch.id);
        const detail = await getAnalysisDetail(batch.id);
        storeBatchDetail({
          id: detail.id,
          name: detail.name,
          total_count: detail.total_count,
          total_elapsed_secs: detail.total_elapsed_secs,
          avg_confidence: detail.avg_confidence,
          images: detail.images,
          classes: detail.classes,
          status: detail.status,
        });
        storeDbBatchId(batch.id);
      } catch {
        // non-fatal
      }
      store.setCompletedBatch(batch.id);
      return true;
    }

    const stored = loadProcessingFiles();
    const sessionDbId = loadDbBatchId();
    const canResume =
      stored.length > 0 && sessionDbId === batch.id && (await blobUrlsLookAlive(stored));

    if (canResume) {
      store.setImages(
        stored.map((f, i) => ({
          id: f.id,
          filename: f.name,
          status: i < batch.processed_image_count ? "done" : "pending",
        })),
      );
      runtime.dbBatchId = batch.id;
      runtime.organism = (batch.organism_type ?? loadOrganism()) as Organism;
      startStageTracker();
      void runProcessLoop(stored, batch.processed_image_count, batch.id);
      return true;
    }

    store.setInterruptedBatch({
      id: batch.id,
      name: batch.name,
      processedCount: batch.processed_image_count,
      totalImages: batch.total_image_count,
    });
    return true;
  })().finally(() => {
    runtime.resumeProbe = null;
  });

  return runtime.resumeProbe;
}

/** Cancel the running loop. Resolves once the loop reaches a safe point. */
export function cancelProcessing(): void {
  runtime.cancelled = true;
}

/** User chose to discard an interrupted batch. Marks it failed and clears state. */
export function discardInterruptedBatch(): void {
  const info = useProcessingStore.getState().interruptedBatch;
  if (info) {
    failBatch(info.id, "User discarded interrupted batch").catch(() => {
      /* non-fatal */
    });
  }
  useProcessingStore.getState().reset();
  clearProcessingSession();
}

/** User chose to view results of an interrupted batch. */
export async function finalizeInterruptedBatch(): Promise<void> {
  const info = useProcessingStore.getState().interruptedBatch;
  if (!info) return;
  storeDbBatchId(info.id);
  try {
    await completeBatch(info.id);
  } catch {
    /* may already be complete */
  }
  try {
    const detail = await getAnalysisDetail(info.id);
    storeBatchDetail({
      id: detail.id,
      name: detail.name,
      total_count: detail.total_count,
      total_elapsed_secs: detail.total_elapsed_secs,
      avg_confidence: detail.avg_confidence,
      images: detail.images,
      classes: detail.classes,
    });
  } catch {
    /* non-fatal */
  }
  useProcessingStore.getState().reset();
}

// ── Internal ──────────────────────────────────────────────────────────────

async function runNewBatch(stored: StoredFile[]): Promise<void> {
  runtime.running = true;
  runtime.cancelled = false;
  startStageTracker();
  const store = useProcessingStore.getState();
  const organism = loadOrganism() as Organism;
  runtime.organism = organism;

  setStage("Loading configuration…");
  let configSnapshot: Record<string, unknown> = {};
  try {
    const currentConfig = await getConfig();
    const { model: _model, ...rest } = currentConfig as unknown as Record<string, unknown>;
    configSnapshot = rest;
  } catch {
    /* non-fatal — proceed with empty snapshot */
  }

  setStage("Creating analysis batch…");
  let dbBatchId: string;
  try {
    const detail = await createBatch({
      organism_type: organism,
      mode: "upload",
      device: (configSnapshot.device as string) ?? "cpu",
      config_snapshot: configSnapshot,
      total_image_count: stored.length,
      classes: loadProjectClasses(),
    });
    dbBatchId = detail.id;
    storeDbBatchId(dbBatchId);
    storeProcessingConfig(configSnapshot);
    store.setActiveBatch(dbBatchId, 0, stored.length);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const userMsg =
      msg.includes("409") || msg.includes("already processing")
        ? "A batch is already processing. Please wait for it to finish."
        : `Failed to create analysis batch: ${msg}`;
    store.setError(userMsg);
    store.finishProcessing();
    runtime.running = false;
    return;
  }

  runtime.dbBatchId = dbBatchId;
  await runProcessLoop(stored, 0, dbBatchId);
}

async function runProcessLoop(
  stored: StoredFile[],
  startFrom: number,
  dbBatchId: string,
): Promise<void> {
  runtime.running = true;
  const store = useProcessingStore.getState();
  const startTime = Date.now();
  const runResults: Array<{
    id: string;
    filename: string;
    result?: DetectionResult;
    error?: string;
  }> = [];

  for (let i = startFrom; i < stored.length; i++) {
    if (runtime.cancelled) break;

    const file = stored[i];
    store.setCurrentImageStart(Date.now());
    store.updateImage(file.id, { status: "processing" });

    try {
      setStage(`Loading image — ${file.name} (${i + 1}/${stored.length})…`);
      const resp = await fetch(file.blobUrl);
      if (!resp.ok) throw new Error(`source image unavailable (${resp.status})`);
      const blob = await resp.blob();
      const fileObj = new File([blob], file.name, { type: file.type });

      if (runtime.cancelled) break;
      // Backend now drives per-image stages (decode/tile/detect/dedup/draw/save)
      // via the logs WS — those will overwrite this label below as they arrive.
      setStage(`Uploading — ${file.name} (${i + 1}/${stored.length})…`);
      const result = await inferSingle(runtime.organism, fileObj, dbBatchId);
      if (runtime.cancelled) break;

      setStage(`Persisting result — ${file.name} (${i + 1}/${stored.length})…`);
      await addImageResult(dbBatchId, {
        filename: result.filename,
        count: result.count,
        avg_confidence: result.avg_confidence,
        elapsed_seconds: result.elapsed_seconds,
        annotations: result.annotations,
        overlay_url: result.overlay_url,
      });

      store.pushCompletedDuration(result.elapsed_seconds);
      store.incrementProcessed();
      store.updateImage(file.id, {
        status: "done",
        count: result.count,
        avgConfidence: result.avg_confidence,
        elapsedSeconds: result.elapsed_seconds,
      });
      runResults.push({ id: file.id, filename: file.name, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runResults.push({ id: file.id, filename: file.name, error: msg });
      store.updateImage(file.id, { status: "error", error: msg });
    } finally {
      store.setCurrentImageStart(null);
    }
  }

  if (runtime.cancelled) {
    try {
      await failBatch(dbBatchId, "User cancelled");
    } catch {
      /* non-fatal */
    }
    useProcessingStore.getState().reset();
    clearProcessingSession();
    runtime.running = false;
    runtime.dbBatchId = null;
    runtime.cancelled = false;
    return;
  }

  const elapsed = (Date.now() - startTime) / 1000;
  store.setTotalElapsed(elapsed);

  setStage("Finalizing batch…");
  try {
    await completeBatch(dbBatchId);
    setStage("Loading results…");
    const detail = await getAnalysisDetail(dbBatchId);
    storeBatchDetail({
      id: detail.id,
      name: detail.name,
      total_count: detail.total_count,
      total_elapsed_secs: detail.total_elapsed_secs,
      avg_confidence: detail.avg_confidence,
      images: detail.images,
      classes: detail.classes,
    });
  } catch {
    /* non-fatal */
  }

  const doneResults = runResults.filter((r) => r.result !== undefined);
  storeProcessingResults(
    doneResults.map((r) => ({ id: r.id, filename: r.filename, result: r.result! })),
  );
  storeBatchSummary({
    total_count: doneResults.reduce((s, r) => s + (r.result?.count ?? 0), 0),
    total_elapsed_seconds: elapsed,
  });

  store.setCompletedBatch(dbBatchId);
  runtime.running = false;
  runtime.dbBatchId = null;
}

// Quick liveness probe — blob URLs become invalid after a tab reload.
async function blobUrlsLookAlive(stored: StoredFile[]): Promise<boolean> {
  // Find the first not-yet-processed entry; that's the one we'd actually fetch.
  // Probing index 0 is fine as a heuristic — if the document survived, all
  // URLs are alive; if it didn't, none are.
  const probe = stored[0];
  if (!probe) return false;
  try {
    const r = await fetch(probe.blobUrl, { method: "GET" });
    return r.ok;
  } catch {
    return false;
  }
}
