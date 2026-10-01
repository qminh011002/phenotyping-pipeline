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
//
// A run either creates a new batch or appends to an existing one (the upload
// page stores an "append target" in the session). Appending re-opens the
// batch on the server; everything after that is the same loop.

import {
    addImageResult,
    appendToBatch,
    completeBatch,
    createBatch,
    failBatch,
    getActiveBatch,
    getAnalysisDetail,
    getBboxConfig,
    getPolygonConfig,
    inferSingle,
    inferSingleLarvae,
    inferSinglePupae,
    measureLarvae,
} from './api';
import type { AnalysisMode, Organism } from '@/types/api';
import {
    clearProcessingSession,
    getCachedFile,
    loadAnalysisMode,
    loadAppendTarget,
    loadDbBatchId,
    loadOrganism,
    loadProcessingFiles,
    loadProjectClasses,
    storeAppendTarget,
    storeBatchDetail,
    storeBatchSummary,
    storeDbBatchId,
    storeProcessingConfig,
    storeProcessingResults,
    type StoredFile,
} from '@/features/upload/lib/processingSession';
import { queryClient } from '@/lib/queryClient';
import { useProcessingStore, type ImageStatus } from '@/stores/processingStore';
import { startStageTracker } from './stageTracker';
import type { DetectionResult } from '@/types/api';

function setStage(stage: string | null): void {
    const store = useProcessingStore.getState();
    store.setStage(stage);
    if (stage) {
        store.addLiveLog({ level: 'INFO', message: stage.replace(/…$/, '') });
    }
}

/** What a cancelled run leaves behind. */
export type CancelMode =
    /** Throw the run away: a new batch is marked failed, an append is undone. */
    | 'discard'
    /** Keep the images already processed and open them for review. */
    | 'keep';

interface RuntimeState {
    running: boolean;
    dbBatchId: string | null;
    cancelled: boolean;
    cancelMode: CancelMode;
    /** Hold before the next image. The image in flight always finishes. */
    paused: boolean;
    /** Wakes the loop out of a pause (resume or cancel). */
    wake: (() => void) | null;
    /** Aborts the requests of the image in flight. */
    abort: AbortController | null;
    // Tracks any in-flight resume probe so concurrent callers share one promise.
    resumeProbe: Promise<boolean> | null;
    organism: Organism;
}

const runtime: RuntimeState = {
    running: false,
    dbBatchId: null,
    cancelled: false,
    cancelMode: 'discard',
    paused: false,
    wake: null,
    abort: null,
    resumeProbe: null,
    organism: 'egg',
};

export function isManagerRunning(): boolean {
    return runtime.running;
}

export function getRunningBatchId(): string | null {
    return runtime.dbBatchId;
}

function isPolygonOrganism(organism: Organism): organism is 'larvae' | 'pupae' {
    return organism === 'larvae' || organism === 'pupae';
}

// ── Public entry points ────────────────────────────────────────────────────

/**
 * Start a brand-new run from files already persisted to sessionStorage by
 * UploadPage. Idempotent: if a run is already in flight, this is a no-op.
 */
export async function startProcessingFromSession(): Promise<void> {
    if (runtime.running) return;
    runtime.running = true;
    const stored = loadProcessingFiles();
    if (stored.length === 0) {
        runtime.running = false;
        return;
    }

    const store = useProcessingStore.getState();
    store.startProcessing(stored.length);
    store.setImages(stored.map((f) => ({ id: f.id, filename: f.name, status: 'pending' })));

    // Run in background — caller (UploadPage) navigates immediately.
    void runNewBatch(stored).catch((err) => {
        console.error('runNewBatch failed', err);
        runtime.running = false;
    });
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
                await storeCompletedDetail(batch.id);
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
            // When appending, the batch's processed count includes the images
            // it already had; this run's files start after that offset.
            const appendTarget = loadAppendTarget();
            const baseCount = appendTarget?.batchId === batch.id ? appendTarget.baseCount : 0;
            const doneInRun = Math.max(0, batch.processed_image_count - baseCount);
            store.setActiveBatch(batch.id, doneInRun, stored.length);
            store.setAppendingToName(appendTarget?.batchId === batch.id ? batch.name : null);
            store.setImages(
                stored.map((f, i) => ({
                    id: f.id,
                    filename: f.name,
                    status: i < doneInRun ? 'done' : 'pending',
                })),
            );
            runtime.dbBatchId = batch.id;
            runtime.organism = (batch.organism_type ?? loadOrganism()) as Organism;
            store.setOrganism(runtime.organism);
            store.setAnalysisMode(loadAnalysisMode());
            startStageTracker();
            void runProcessLoop(stored, doneInRun, batch.id, runtime.organism);
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

/**
 * Stop the run now. The image in flight is aborted — its request is dropped
 * and the server stops working on it — rather than left to finish.
 *
 * `discard` throws the run away; `keep` finalises the batch with the images
 * already processed (falling back to `discard` when there are none).
 */
export function cancelProcessing(mode: CancelMode = 'discard'): void {
    if (!runtime.running || runtime.cancelled) return;
    runtime.cancelled = true;
    runtime.cancelMode = mode;
    useProcessingStore.getState().setCancelling(true);
    setStage(mode === 'keep' ? 'Stopping — keeping processed images…' : 'Cancelling…');
    runtime.abort?.abort();
    wakeLoop();
}

/**
 * Stop the run of `batchId`, wherever it is being driven from.
 *
 * The run this tab drives goes through `cancelProcessing`. Any other — another
 * tab or device, or a run orphaned by a reload — is ended on the server,
 * which also stops the image it is still inferring.
 */
export async function stopBatchRun(batchId: string, mode: CancelMode): Promise<void> {
    if (runtime.running && runtime.dbBatchId === batchId) {
        cancelProcessing(mode);
        return;
    }
    if (mode === 'keep') {
        await completeBatch(batchId, { stoppedEarly: true });
    } else {
        await failBatch(batchId, 'User cancelled');
    }
    // This tab may still hold the remains of that run (an interrupted batch
    // found on load): it is over now.
    const store = useProcessingStore.getState();
    if (store.activeBatchId === batchId || store.interruptedBatch?.id === batchId) {
        store.reset();
        clearProcessingSession();
    }
    queryClient.removeQueries({ queryKey: ['analysis-detail', batchId] });
    void queryClient.invalidateQueries({ queryKey: ['running-batches'] });
    void queryClient.invalidateQueries({ queryKey: ['recorded-batches'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
}

/**
 * Pause before the next image. Aborting the image in flight would throw away
 * minutes of work on a measured run, so it is allowed to finish first; the
 * store reads `pausing` until then, `paused` after.
 */
export function pauseProcessing(): void {
    if (!runtime.running || runtime.cancelled || runtime.paused) return;
    runtime.paused = true;
    useProcessingStore.getState().setPauseState('pausing');
}

export function resumeProcessing(): void {
    if (!runtime.paused) return;
    runtime.paused = false;
    const store = useProcessingStore.getState();
    // Resuming a pause that never took hold needs no log line.
    if (store.pauseState === 'paused') store.addLiveLog({ level: 'INFO', message: 'Resumed' });
    store.setPauseState('running');
    wakeLoop();
}

function wakeLoop(): void {
    const wake = runtime.wake;
    runtime.wake = null;
    wake?.();
}

/** Park the loop while the run is paused. Returns at once when it is not. */
async function holdWhilePaused(): Promise<void> {
    if (!runtime.paused || runtime.cancelled) return;
    useProcessingStore.getState().setPauseState('paused');
    setStage('Paused');
    await new Promise<void>((resolve) => {
        runtime.wake = resolve;
    });
}

/** User chose to discard an interrupted batch. Marks it failed and clears state.
 *
 * (For a batch that was interrupted while images were being *added*, the
 * backend restores it to its previous state instead of failing it.)
 */
export function discardInterruptedBatch(): void {
    const info = useProcessingStore.getState().interruptedBatch;
    if (info) {
        failBatch(info.id, 'User discarded interrupted batch').catch((err) => {
            console.warn('failBatch (discard) failed:', err);
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
        await storeCompletedDetail(info.id);
    } catch {
        /* non-fatal */
    }
    useProcessingStore.getState().reset();
}

// ── Internal ──────────────────────────────────────────────────────────────

/** Fetch the batch's image list (no annotation payloads) into the session so
 *  the result viewer can open on it. Returns the image ids in batch order. */
async function storeCompletedDetail(batchId: string): Promise<string[]> {
    const detail = await getAnalysisDetail(batchId, undefined, { includeAnnotations: false });
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
    return detail.images.map((img) => img.id);
}

/**
 * The inference settings the server will actually use for this organism,
 * flattened for the batch's `config_snapshot`.
 */
async function loadConfigSnapshot(
    organism: Organism,
    mode: AnalysisMode,
): Promise<Record<string, unknown>> {
    try {
        if (isPolygonOrganism(organism)) {
            const { model: _model, sam, ...rest } = await getPolygonConfig(organism);
            const countOnly = mode === 'count';
            return {
                ...rest,
                count_only: countOnly,
                // What this run does, not just what the config allows.
                sam_enabled: !countOnly && (sam?.enabled ?? true),
            };
        }
        const { model: _model, ...rest } = await getBboxConfig(organism);
        return rest;
    } catch {
        /* non-fatal — proceed with a minimal snapshot */
        return isPolygonOrganism(organism) ? { count_only: mode === 'count' } : {};
    }
}

async function runNewBatch(stored: StoredFile[]): Promise<void> {
    runtime.running = true;
    runtime.cancelled = false;
    startStageTracker();
    const store = useProcessingStore.getState();
    const organism = loadOrganism() as Organism;
    const mode = loadAnalysisMode();
    const appendTarget = loadAppendTarget();
    runtime.organism = organism;
    store.setOrganism(organism);
    store.setAnalysisMode(mode);
    store.setAppendingToName(appendTarget?.batchName ?? null);

    setStage('Loading configuration…');
    const configSnapshot = await loadConfigSnapshot(organism, mode);

    let dbBatchId: string;
    try {
        if (appendTarget) {
            setStage(`Adding ${stored.length} image${stored.length === 1 ? '' : 's'} to batch…`);
            const detail = await appendToBatch(appendTarget.batchId, {
                additional_image_count: stored.length,
                config_snapshot: configSnapshot,
            });
            dbBatchId = detail.id;
            // The server's count is authoritative for the resume offset.
            storeAppendTarget({
                batchId: detail.id,
                batchName: detail.name,
                baseCount: detail.processed_image_count,
            });
        } else {
            setStage('Creating analysis batch…');
            const projectName = useProcessingStore.getState().projectName?.trim();
            const detail = await createBatch({
                organism_type: organism,
                mode: 'upload',
                device: (configSnapshot.device as string) ?? 'cpu',
                config_snapshot: configSnapshot,
                total_image_count: stored.length,
                // Pass the user-entered project name so it lands in the DB and shows
                // up in /recorded. Omit when blank so the backend still falls back to
                // its auto-generated default ("<Organism> analysis · <date>").
                ...(projectName ? { name: projectName } : {}),
                classes: loadProjectClasses(),
            });
            dbBatchId = detail.id;
        }
        storeDbBatchId(dbBatchId);
        storeProcessingConfig(configSnapshot);
        store.setActiveBatch(dbBatchId, 0, stored.length);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const userMsg =
            msg.includes('409') || msg.includes('already processing')
                ? 'A batch is already processing. Please wait for it to finish.'
                : appendTarget
                  ? `Failed to add images to the batch: ${msg}`
                  : `Failed to create analysis batch: ${msg}`;
        store.setError(userMsg);
        store.finishProcessing();
        runtime.running = false;
        return;
    }

    runtime.dbBatchId = dbBatchId;
    await runProcessLoop(stored, 0, dbBatchId, organism);
}

/** What one image contributes to the store once it has been processed. */
interface ImageOutcome {
    status: ImageStatus;
    count: number;
    avgConfidence: number;
    elapsedSeconds: number;
    backendImageId: string;
    /** Bbox organisms only — cached so the result viewer needn't refetch. */
    result?: DetectionResult;
}

// ── Per-image pipelines ───────────────────────────────────────────────────

async function processBboxImage(
    fileObj: File,
    dbBatchId: string,
    label: string,
    signal: AbortSignal,
): Promise<ImageOutcome | null> {
    // Backend drives per-image stages (decode/tile/detect/dedup/draw/save)
    // via the stages WS — those overwrite this label as they arrive.
    setStage(`Uploading — ${label}…`);
    const result = await inferSingle(runtime.organism, fileObj, dbBatchId, signal);
    if (runtime.cancelled) return null;

    setStage(`Persisting result — ${label}…`);
    const { image_id } = await addImageResult(
        dbBatchId,
        {
            filename: result.filename,
            count: result.count,
            avg_confidence: result.avg_confidence,
            elapsed_seconds: result.elapsed_seconds,
            annotations: result.annotations,
            overlay_url: result.overlay_url,
        },
        signal,
    );
    return {
        status: 'done',
        count: result.count,
        avgConfidence: result.avg_confidence,
        elapsedSeconds: result.elapsed_seconds,
        backendImageId: image_id,
        result,
    };
}

// Larvae and pupae share one pipeline shape (polygon + MWIS, same DB tables,
// same calibration / measurement endpoints); only the inference endpoint
// differs.
//
// Count mode (default):
//   1. POST /inference/{organism}?count_only=true → detections, no SAM
//   2. POST /analyses/{batch_id}/images           → image row + detections +
//                                                   the calibration that
//                                                   inference already found
//   …and that's it. Sizes are measured on demand in the result viewer.
//
// Measure mode adds SAM during step 1 and then:
//   3. POST /measure/larvae?image_id=…            → only when calibration
//      succeeded; otherwise the image is flagged `needs_calibration` and the
//      batch moves on.
async function processPolygonImage(
    fileObj: File,
    dbBatchId: string,
    label: string,
    filename: string,
    signal: AbortSignal,
): Promise<ImageOutcome | null> {
    const store = useProcessingStore.getState();
    const countOnly = store.analysisMode === 'count';

    setStage(`${countOnly ? 'Counting' : 'Inferring'} — ${label}…`);
    const infer = runtime.organism === 'pupae' ? inferSinglePupae : inferSingleLarvae;
    const result = await infer(fileObj, dbBatchId, countOnly, signal);
    if (runtime.cancelled) return null;

    setStage(`Persisting result — ${label}…`);
    // The shared /analyses/{batch_id}/images endpoint takes a generic
    // `annotations: list[dict]`. Polygon annotations carry polygons alongside
    // bbox/confidence — they ride through the same field.
    const { image_id } = await addImageResult(
        dbBatchId,
        {
            filename: result.filename,
            count: result.count,
            avg_confidence: result.avg_confidence,
            elapsed_seconds: result.elapsed_seconds,
            annotations: result.annotations as unknown as Array<{
                label: string;
                bbox: [number, number, number, number];
                confidence: number;
            }>,
            overlay_url: result.overlay_url,
            calibration: result.calibration ?? null,
            sam_refined: result.sam_refined ?? false,
        },
        signal,
    );

    let status: ImageStatus = 'done';
    if (!countOnly) {
        const calibrationOk =
            result.calibration != null && result.calibration.detection_status !== 'failed';
        if (!calibrationOk) {
            status = 'needs_calibration';
            store.addLiveLog({
                level: 'WARN',
                message: `${filename}: auto-calibration failed — needs manual calibration`,
            });
        } else if (!runtime.cancelled && result.count > 0) {
            setStage(`Measuring — ${label}…`);
            try {
                await measureLarvae(image_id, {}, signal);
            } catch (err) {
                // The image is already stored; a cancel just skips its sizes.
                if (runtime.cancelled) return null;
                const msg = err instanceof Error ? err.message : String(err);
                store.addLiveLog({
                    level: 'WARN',
                    message: `${filename}: measurement error — ${msg}`,
                });
            }
        }
    }

    return {
        status,
        count: result.count,
        avgConfidence: result.avg_confidence,
        elapsedSeconds: result.elapsed_seconds,
        backendImageId: image_id,
    };
}

// ── The loop ──────────────────────────────────────────────────────────────

async function runProcessLoop(
    stored: StoredFile[],
    startFrom: number,
    dbBatchId: string,
    organism: Organism,
): Promise<void> {
    runtime.running = true;
    runtime.cancelled = false;
    runtime.cancelMode = 'discard';
    runtime.paused = false;
    const store = useProcessingStore.getState();
    const startTime = Date.now();
    const total = stored.length;
    const polygon = isPolygonOrganism(organism);
    const cachedResults: Array<{ id: string; filename: string; result: DetectionResult }> = [];
    let totalCount = 0;
    let firstImageId: string | null = null;

    for (let i = startFrom; i < stored.length; i++) {
        await holdWhilePaused();
        if (runtime.cancelled) break;

        const file = stored[i];
        const abort = new AbortController();
        runtime.abort = abort;
        const label = `${file.name} (${i + 1}/${total})`;
        store.setCurrentImageStart(Date.now());
        store.updateImage(file.id, { status: 'processing' });

        try {
            setStage(`Loading image — ${label}…`);
            let fileObj = getCachedFile(file.id);
            if (!fileObj) {
                const resp = await fetch(file.blobUrl);
                if (!resp.ok) throw new Error(`source image unavailable (${resp.status})`);
                const blob = await resp.blob();
                fileObj = new File([blob], file.name, { type: file.type });
            }
            if (runtime.cancelled) break;

            const outcome = polygon
                ? await processPolygonImage(fileObj, dbBatchId, label, file.name, abort.signal)
                : await processBboxImage(fileObj, dbBatchId, label, abort.signal);
            if (outcome === null) break; // cancelled mid-image

            firstImageId ??= outcome.backendImageId;
            totalCount += outcome.count;
            store.pushCompletedDuration(outcome.elapsedSeconds);
            store.incrementProcessed();
            store.updateImage(file.id, {
                status: outcome.status,
                count: outcome.count,
                avgConfidence: outcome.avgConfidence,
                elapsedSeconds: outcome.elapsedSeconds,
                backendImageId: outcome.backendImageId,
            });
            if (outcome.result) {
                cachedResults.push({ id: file.id, filename: file.name, result: outcome.result });
            }
        } catch (err) {
            if (runtime.cancelled) break;
            const msg = err instanceof Error ? err.message : String(err);
            store.updateImage(file.id, { status: 'error', error: msg });
            store.addLiveLog({ level: 'ERROR', message: `${file.name}: ${msg}` });
        } finally {
            store.setCurrentImageStart(null);
            runtime.abort = null;
        }
    }

    // Stopped early. Nothing processed leaves nothing worth keeping, so
    // "keep" falls back to discarding the run.
    const stoppedEarly = runtime.cancelled;
    const keep =
        stoppedEarly &&
        // Read through a cast: TS narrowed the field at the reset above and
        // cannot see cancelProcessing() changing it while the loop awaited.
        (runtime.cancelMode as CancelMode) === 'keep' &&
        useProcessingStore.getState().processedCount > 0;
    runtime.paused = false;
    if (stoppedEarly && !keep) {
        try {
            await failBatch(dbBatchId, 'User cancelled');
        } catch {
            /* non-fatal */
        }
        useProcessingStore.getState().reset();
        clearProcessingSession();
        void queryClient.invalidateQueries({ queryKey: ['recorded-batches'] });
        runtime.running = false;
        runtime.dbBatchId = null;
        runtime.cancelled = false;
        return;
    }

    const elapsed = (Date.now() - startTime) / 1000;
    store.setTotalElapsed(elapsed);

    setStage('Finalizing batch…');
    try {
        await completeBatch(dbBatchId, { stoppedEarly });
        setStage('Loading results…');
        const imageIds = await storeCompletedDetail(dbBatchId);
        // A resumed run may not have processed anything itself; open on the
        // batch's first image then.
        firstImageId ??= imageIds[0] ?? null;
    } catch {
        /* non-fatal */
    }
    // The batch changed under any view that cached it — most visibly after
    // an append, where a cached detail would not know the new images.
    queryClient.removeQueries({ queryKey: ['analysis-detail', dbBatchId] });
    void queryClient.invalidateQueries({ queryKey: ['recorded-batches'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });

    if (!polygon) storeProcessingResults(cachedResults);
    storeBatchSummary({ total_count: totalCount, total_elapsed_seconds: elapsed });

    store.setCompletedBatch(dbBatchId, firstImageId);
    runtime.running = false;
    runtime.dbBatchId = null;
    runtime.cancelled = false;
}

// Quick liveness probe — blob URLs become invalid after a tab reload.
async function blobUrlsLookAlive(stored: StoredFile[]): Promise<boolean> {
    // Find the first not-yet-processed entry; that's the one we'd actually fetch.
    // Probing index 0 is fine as a heuristic — if the document survived, all
    // URLs are alive; if it didn't, none are.
    const probe = stored[0];
    if (!probe) return false;
    try {
        const r = await fetch(probe.blobUrl, { method: 'GET' });
        return r.ok;
    } catch {
        return false;
    }
}
