// Processing store — shared Zustand state for the processing toast and global indicator.
// Tracks per-image progress across the app while the user navigates away.
//
// The actual processing loop lives in services/processingManager.ts. This store
// is the single source of truth that both the manager (writer) and the UI
// (readers: ProcessingPage, ProcessingIndicator, etc.) talk through.

import { create } from "zustand";

export type ImageStatus = "pending" | "processing" | "done" | "error";

export interface ProcessingImage {
  id: string;
  filename: string;
  status: ImageStatus;
  count?: number;
  avgConfidence?: number;
  elapsedSeconds?: number;
  error?: string;
}

export interface InterruptedBatchInfo {
  id: string;
  name: string;
  processedCount: number;
  totalImages: number;
}

interface ProcessingStore {
  isProcessing: boolean;
  totalImages: number;
  images: ProcessingImage[];
  toastId: string | null;

  // FS-012: persistent processing state
  activeBatchId: string | null;
  processedCount: number;
  isRestoredFromBackend: boolean;
  // "completed" means the batch finished while the user was on another page
  completedBatchId: string | null;

  // Runtime fields written by the manager — used to render ETA / errors / etc.
  currentImageStartMs: number | null;
  completedDurations: number[];
  totalElapsedSeconds: number;
  error: string | null;
  interruptedBatch: InterruptedBatchInfo | null;

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
  setCompletedBatch: (batchId: string | null) => void;

  // Runtime updaters used by the manager
  setCurrentImageStart: (ms: number | null) => void;
  pushCompletedDuration: (seconds: number) => void;
  setTotalElapsed: (seconds: number) => void;
  setError: (msg: string | null) => void;
  setInterruptedBatch: (info: InterruptedBatchInfo | null) => void;
}

export const useProcessingStore = create<ProcessingStore>((set) => ({
  isProcessing: false,
  totalImages: 0,
  images: [],
  toastId: null,
  activeBatchId: null,
  processedCount: 0,
  isRestoredFromBackend: false,
  completedBatchId: null,
  currentImageStartMs: null,
  completedDurations: [],
  totalElapsedSeconds: 0,
  error: null,
  interruptedBatch: null,

  startProcessing: (totalImages) =>
    set({
      isProcessing: true,
      totalImages,
      images: [],
      toastId: null,
      completedBatchId: null,
      error: null,
      interruptedBatch: null,
      completedDurations: [],
      totalElapsedSeconds: 0,
      processedCount: 0,
    }),

  setImages: (images) => set({ images }),

  updateImage: (id, update) =>
    set((state) => ({
      images: state.images.map((img) => (img.id === id ? { ...img, ...update } : img)),
    })),

  finishProcessing: () => set({ isProcessing: false, currentImageStartMs: null }),

  reset: () =>
    set({
      isProcessing: false,
      totalImages: 0,
      images: [],
      toastId: null,
      activeBatchId: null,
      processedCount: 0,
      isRestoredFromBackend: false,
      completedBatchId: null,
      currentImageStartMs: null,
      completedDurations: [],
      totalElapsedSeconds: 0,
      error: null,
      interruptedBatch: null,
    }),

  setToastId: (toastId) => set({ toastId }),

  setActiveBatch: (batchId, processedCount, totalImages) =>
    set({
      isProcessing: true,
      activeBatchId: batchId,
      processedCount,
      totalImages,
    }),

  incrementProcessed: () =>
    set((state) => ({ processedCount: state.processedCount + 1 })),

  markRestoredFromBackend: () => set({ isRestoredFromBackend: true }),

  setCompletedBatch: (batchId) =>
    set({ completedBatchId: batchId, isProcessing: false, currentImageStartMs: null }),

  setCurrentImageStart: (ms) => set({ currentImageStartMs: ms }),

  pushCompletedDuration: (seconds) =>
    set((state) => ({ completedDurations: [...state.completedDurations, seconds] })),

  setTotalElapsed: (seconds) => set({ totalElapsedSeconds: seconds }),

  setError: (msg) => set({ error: msg }),

  setInterruptedBatch: (info) =>
    set({ interruptedBatch: info, isProcessing: false }),
}));
