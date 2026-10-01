// Processing store — shared Zustand state for the processing toast and global indicator.
// Tracks per-image progress across the app while the user navigates away.
//
// The actual processing loop lives in services/processingManager.ts. This store
// is the single source of truth that both the manager (writer) and the UI
// (readers: ProcessingPage, ProcessingIndicator, etc.) talk through.

import { create } from 'zustand';
import type { AnalysisMode, Organism } from '@/types/api';

export type ImageStatus =
    | 'pending'
    | 'processing'
    | 'done'
    | 'error'
    // Larvae-only: image processed but auto-calibration failed; user needs to
    // supply manual calibration before measurements can run. The batch is not
    // aborted — subsequent images keep going.
    | 'needs_calibration';

export interface ProcessingImage {
    id: string;
    filename: string;
    status: ImageStatus;
    count?: number;
    avgConfidence?: number;
    elapsedSeconds?: number;
    error?: string;
    /** Larvae: backend image_id once registered — used to address calibration / measurements. */
    backendImageId?: string;
}

/** `pausing`: asked to pause, the image in flight is finishing first. */
export type PauseState = 'running' | 'pausing' | 'paused';

export interface InterruptedBatchInfo {
    id: string;
    name: string;
    processedCount: number;
    totalImages: number;
}

export type ProcessingLogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface ProcessingLogEntry {
    id: string;
    timestamp: string;
    level: ProcessingLogLevel;
    message: string;
}

interface ProcessingStore {
    isProcessing: boolean;
    totalImages: number;
    images: ProcessingImage[];
    imageIndexById: Map<string, number>;
    toastId: string | null;

    // Project metadata captured on the Analyze page
    projectName: string | null;
    /** Organism for the active batch — drives which per-image pipeline runs. */
    organism: Organism;
    /**
     * Class names defined on the Analyze page, frozen for the batch. The first
     * entry is the default used when the user draws a new box in the editor.
     */
    classes: string[];
    /** Larvae / pupae: count-only (default) or count + SAM + measure. */
    analysisMode: AnalysisMode;
    /** Name of the existing batch this run adds images to; null for a new batch. */
    appendingToName: string | null;

    // FS-012: persistent processing state
    activeBatchId: string | null;
    processedCount: number;
    isRestoredFromBackend: boolean;
    // "completed" means the batch finished while the user was on another page
    completedBatchId: string | null;
    /** Image to open the result viewer on — the first one this run processed
     *  (for an append, that is the first *new* image, not the batch's first). */
    completedFirstImageId: string | null;

    // Runtime fields written by the manager — used to render ETA / errors / etc.
    pauseState: PauseState;
    /** The run is being stopped; the loop has not unwound yet. */
    cancelling: boolean;
    /** When this tab started (or resumed) driving the run, epoch ms. */
    runStartedAtMs: number | null;
    currentImageStartMs: number | null;
    completedDurations: number[];
    totalElapsedSeconds: number;
    error: string | null;
    interruptedBatch: InterruptedBatchInfo | null;
    // Human-readable description of the current processing phase, streamed from
    // the backend logs WS via stageTracker (or set directly by the manager for
    // client-side phases).
    stage: string | null;
    liveLogs: ProcessingLogEntry[];

    // ── Actions ────────────────────────────────────────────────────────────────

    startProcessing: (totalImages: number) => void;
    setImages: (images: ProcessingImage[]) => void;
    updateImage: (id: string, update: Partial<ProcessingImage>) => void;
    finishProcessing: () => void;
    reset: () => void;
    setToastId: (id: string | null) => void;

    // FS-012: new actions
    setActiveBatch: (batchId: string, processedCount: number, totalImages: number) => void;
    incrementProcessed: () => void;
    markRestoredFromBackend: () => void;
    setCompletedBatch: (batchId: string | null, firstImageId?: string | null) => void;

    // Runtime updaters used by the manager
    setPauseState: (pauseState: PauseState) => void;
    setCancelling: (cancelling: boolean) => void;
    setCurrentImageStart: (ms: number | null) => void;
    pushCompletedDuration: (seconds: number) => void;
    setTotalElapsed: (seconds: number) => void;
    setError: (msg: string | null) => void;
    setInterruptedBatch: (info: InterruptedBatchInfo | null) => void;
    setStage: (stage: string | null) => void;
    addLiveLog: (entry: Omit<ProcessingLogEntry, 'id' | 'timestamp'>) => void;
    clearLiveLogs: () => void;

    setProjectName: (name: string | null) => void;
    setOrganism: (organism: Organism) => void;
    setClasses: (classes: string[]) => void;
    setAnalysisMode: (mode: AnalysisMode) => void;
    setAppendingToName: (name: string | null) => void;
}

export const useProcessingStore = create<ProcessingStore>((set) => ({
    isProcessing: false,
    totalImages: 0,
    images: [],
    imageIndexById: new Map(),
    toastId: null,
    activeBatchId: null,
    processedCount: 0,
    isRestoredFromBackend: false,
    completedBatchId: null,
    completedFirstImageId: null,
    pauseState: 'running',
    cancelling: false,
    runStartedAtMs: null,
    currentImageStartMs: null,
    completedDurations: [],
    totalElapsedSeconds: 0,
    error: null,
    interruptedBatch: null,
    stage: null,
    liveLogs: [],
    projectName: null,
    organism: 'egg',
    classes: [],
    analysisMode: 'count',
    appendingToName: null,

    startProcessing: (totalImages) =>
        set({
            isProcessing: true,
            pauseState: 'running',
            cancelling: false,
            runStartedAtMs: Date.now(),
            totalImages,
            images: [],
            imageIndexById: new Map(),
            toastId: null,
            completedBatchId: null,
            completedFirstImageId: null,
            error: null,
            interruptedBatch: null,
            completedDurations: [],
            totalElapsedSeconds: 0,
            processedCount: 0,
            stage: null,
            liveLogs: [],
        }),

    setImages: (images) =>
        set({
            images,
            imageIndexById: new Map(images.map((img, index) => [img.id, index])),
        }),

    updateImage: (id, update) =>
        set((state) => {
            const index = state.imageIndexById.get(id);
            if (index === undefined) return {};
            const current = state.images[index];
            if (!current) return {};
            const images = state.images.slice();
            images[index] = { ...current, ...update };
            return { images };
        }),

    finishProcessing: () =>
        set({
            isProcessing: false,
            currentImageStartMs: null,
            stage: null,
            pauseState: 'running',
            cancelling: false,
        }),

    reset: () =>
        set({
            isProcessing: false,
            totalImages: 0,
            images: [],
            imageIndexById: new Map(),
            toastId: null,
            activeBatchId: null,
            processedCount: 0,
            isRestoredFromBackend: false,
            completedBatchId: null,
            completedFirstImageId: null,
            pauseState: 'running',
            cancelling: false,
            runStartedAtMs: null,
            currentImageStartMs: null,
            completedDurations: [],
            totalElapsedSeconds: 0,
            error: null,
            interruptedBatch: null,
            stage: null,
            liveLogs: [],
            projectName: null,
            organism: 'egg',
            classes: [],
            analysisMode: 'count',
            appendingToName: null,
        }),

    setToastId: (toastId) => set({ toastId }),

    setActiveBatch: (batchId, processedCount, totalImages) =>
        set((state) => ({
            isProcessing: true,
            activeBatchId: batchId,
            processedCount,
            totalImages,
            runStartedAtMs: state.runStartedAtMs ?? Date.now(),
        })),

    incrementProcessed: () => set((state) => ({ processedCount: state.processedCount + 1 })),

    markRestoredFromBackend: () => set({ isRestoredFromBackend: true }),

    setCompletedBatch: (batchId, firstImageId = null) =>
        set({
            completedBatchId: batchId,
            completedFirstImageId: batchId ? firstImageId : null,
            isProcessing: false,
            currentImageStartMs: null,
            stage: null,
            pauseState: 'running',
            cancelling: false,
        }),

    setPauseState: (pauseState) => set({ pauseState }),

    setCancelling: (cancelling) => set({ cancelling }),

    setCurrentImageStart: (ms) => set({ currentImageStartMs: ms }),

    pushCompletedDuration: (seconds) =>
        set((state) => ({ completedDurations: [...state.completedDurations, seconds] })),

    setTotalElapsed: (seconds) => set({ totalElapsedSeconds: seconds }),

    setError: (msg) => set({ error: msg }),

    setInterruptedBatch: (info) => set({ interruptedBatch: info, isProcessing: false }),

    setStage: (stage) => set({ stage }),

    addLiveLog: (entry) =>
        set((state) => {
            const next: ProcessingLogEntry = {
                ...entry,
                id:
                    typeof crypto !== 'undefined' && 'randomUUID' in crypto
                        ? crypto.randomUUID()
                        : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                timestamp: new Date().toISOString(),
            };
            const liveLogs = [...state.liveLogs, next];
            return { liveLogs: liveLogs.length > 300 ? liveLogs.slice(-300) : liveLogs };
        }),

    clearLiveLogs: () => set({ liveLogs: [] }),

    setProjectName: (projectName) => set({ projectName }),

    setOrganism: (organism) => set({ organism }),

    setClasses: (classes) => set({ classes }),

    setAnalysisMode: (analysisMode) => set({ analysisMode }),

    setAppendingToName: (appendingToName) => set({ appendingToName }),
}));
