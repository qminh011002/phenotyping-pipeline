// Processing store — shared Zustand state for the processing toast.
// Tracks per-image progress across the app while the user navigates away.

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

interface ProcessingStore {
  // Whether a batch is currently being processed
  isProcessing: boolean;

  // Total images in the current batch
  totalImages: number;

  // Per-image statuses (indexed by stored session id)
  images: ProcessingImage[];

  // sonner toast id (so we can dismiss it programmatically)
  toastId: string | null;

  // ── Actions ────────────────────────────────────────────────────────────────

  /** Called when the user starts processing from UploadPage */
  startProcessing: (totalImages: number) => void;

  /** Called after blob URL re-fetch resolves with real filenames */
  setImages: (images: ProcessingImage[]) => void;

  /** Update a single image's status */
  updateImage: (id: string, update: Partial<ProcessingImage>) => void;

  /** Called when all images are done/error */
  finishProcessing: () => void;

  /** Reset everything (e.g. when user cancels) */
  reset: () => void;

  /** Set the sonner toast id so we can dismiss it */
  setToastId: (id: string | null) => void;
}

export const useProcessingStore = create<ProcessingStore>((set) => ({
  isProcessing: false,
  totalImages: 0,
  images: [],
  toastId: null,

  startProcessing: (totalImages) =>
    set({ isProcessing: true, totalImages, images: [], toastId: null }),

  setImages: (images) => set({ images }),

  updateImage: (id, update) =>
    set((state) => ({
      images: state.images.map((img) => (img.id === id ? { ...img, ...update } : img)),
    })),

  finishProcessing: () => set({ isProcessing: false }),

  reset: () => set({ isProcessing: false, totalImages: 0, images: [], toastId: null }),

  setToastId: (toastId) => set({ toastId }),
}));
