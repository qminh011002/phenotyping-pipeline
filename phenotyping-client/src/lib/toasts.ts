/**
 * Inference-specific toast helpers.
 * Use these instead of raw toast() calls so all inference-related notifications
 * follow a consistent format and copy style.
 */
import { toast } from "@/components/ui/sonner";

/** Called after inference finishes successfully — one per image. */
export function toastInferenceComplete(filename: string, count: number, elapsedSeconds: number) {
  const s = elapsedSeconds < 1 ? `${(elapsedSeconds * 1000).toFixed(0)}ms` : `${elapsedSeconds.toFixed(1)}s`;
  toast.success(`${filename}`, {
    description: `${count} egg${count !== 1 ? "s" : ""} detected · ${s}`,
  });
}

/** Called after a batch of images finishes. */
export function toastBatchComplete(totalImages: number, totalCount: number, totalSeconds: number) {
  toast.success(`Batch complete`, {
    description: `${totalImages} image${totalImages !== 1 ? "s" : ""} · ${totalCount} total eggs · ${totalSeconds.toFixed(1)}s`,
  });
}

/** Called when an inference request fails. */
export function toastInferenceError(filename: string, reason?: string) {
  toast.error(filename, {
    description: reason ?? "Inference failed",
  });
}

/** Called when config is saved successfully. */
export function toastConfigSaved() {
  toast.success("Settings saved", {
    description: "Inference config updated for the next analysis run.",
  });
}

/** Called when config save fails. */
export function toastConfigError(reason?: string) {
  toast.error("Save failed", {
    description: reason ?? "Could not update config.",
  });
}