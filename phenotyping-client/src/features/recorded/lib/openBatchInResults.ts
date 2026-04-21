// openBatchInResults — bridge from the "recorded" flow into the result viewer.
//
// ResultViewer reads from sessionStorage (KEY_RESULTS / KEY_BATCH_DETAIL / …)
// because the original upload flow populates it during the processing loop.
// When the user opens a saved batch from `/recorded` we have the same
// information available via `getAnalysisDetail` — we just need to translate it
// into the shape ResultViewer expects, write it into sessionStorage, then
// navigate.
//
// Two entry points share the same bridge:
// - `Continue` in the header: open all images, start at index 0
// - A card click: open all images but pre-select the clicked one so the
//   viewer lands on it. The ResultViewer navigation UI still works, so the
//   user can flip through neighbours after landing.
//
// We deliberately do NOT write KEY_FILES — there are no local File blobs for
// a saved batch. ResultViewer's `rawSrc` already falls back to the backend
// `getAnalysesRawUrl(batchId, imageId)` whenever `batchDetail` is present,
// so raw previews work without blob URLs.

import type {
  AnalysisBatchDetail,
  AnalysisImageSummary,
  BBox,
  DetectionResult,
  Organism,
} from "@/types/api";
import {
  storeBatchDetail,
  storeDbBatchId,
  storeProcessingConfig,
  storeProcessingResults,
  storeBatchSummary,
  type StoredBatchDetail,
  type StoredImageDetail,
  type StoredResult,
} from "@/features/upload/lib/processingSession";

const KEY_START_INDEX = "phenotyping_processing_start_index";

function toBBoxArray(value: unknown): BBox[] {
  if (!Array.isArray(value)) return [];
  // Persisted annotations may be any-shaped; trust the backend and cast.
  return value as BBox[];
}

function toDetectionResult(
  batchId: string,
  organism: Organism,
  img: AnalysisImageSummary,
): DetectionResult {
  return {
    filename: img.original_filename,
    organism,
    count: img.count ?? 0,
    avg_confidence: img.avg_confidence ?? 0,
    elapsed_seconds: img.elapsed_secs ?? 0,
    annotations: toBBoxArray(img.annotations),
    // Use the analyses overlay URL — the resolver already serves the file.
    overlay_url: img.overlay_path
      ? `/analyses/${batchId}/images/${img.id}/overlay`
      : "",
  };
}

function toStoredImageDetail(img: AnalysisImageSummary): StoredImageDetail {
  return {
    id: img.id,
    original_filename: img.original_filename,
    status: img.status,
    count: img.count,
    avg_confidence: img.avg_confidence,
    elapsed_secs: img.elapsed_secs,
    overlay_path: img.overlay_path,
    error_message: img.error_message,
    created_at: img.created_at,
    annotations: img.annotations ?? null,
    edited_annotations: img.edited_annotations ?? null,
  };
}

export interface OpenBatchOptions {
  /**
   * If set, ResultViewer will open on this image index instead of 0. Ignored
   * when `singleImageId` is provided (single-image mode only ever has one
   * entry, so the index is always 0).
   */
  startIndex?: number;
  /**
   * When set, only the image with this ID is loaded into the viewer — the
   * prev/next navigation won't let the operator step past it. Used when the
   * user clicks a specific card in BatchDetail: they explicitly asked for
   * one image, not the whole batch.
   */
  singleImageId?: string;
}

/**
 * Populate sessionStorage from `detail` so `/analyze/results` can render it,
 * then return `true`. The caller is responsible for the actual navigation.
 */
export function openBatchInResults(
  detail: AnalysisBatchDetail,
  options: OpenBatchOptions = {},
): boolean {
  const organism = (detail.organism_type as Organism) ?? "egg";

  // Filter down to the requested single image when `singleImageId` is set.
  // Fall back to the full list if the ID doesn't match (shouldn't happen —
  // callers read it straight out of `detail.images`).
  const sourceImages =
    options.singleImageId !== undefined
      ? detail.images.filter((img) => img.id === options.singleImageId)
      : detail.images;
  const filteredImages = sourceImages.length > 0 ? sourceImages : detail.images;

  const storedResults: StoredResult[] = filteredImages.map((img) => ({
    id: img.id,
    filename: img.original_filename,
    result: toDetectionResult(detail.id, organism, img),
  }));

  if (storedResults.length === 0) return false;

  const storedDetail: StoredBatchDetail = {
    id: detail.id,
    name: detail.name,
    total_count: detail.total_count,
    total_elapsed_secs: detail.total_elapsed_secs,
    avg_confidence: detail.avg_confidence,
    images: filteredImages.map(toStoredImageDetail),
    classes: detail.classes,
  };

  // There are no local File blobs when opening a saved batch; wipe any
  // leftover entries from a prior upload session so ResultViewer falls
  // through to the backend raw-URL path cleanly.
  sessionStorage.removeItem("phenotyping_processing_files");

  storeProcessingResults(storedResults);
  storeBatchDetail(storedDetail);
  storeDbBatchId(detail.id);
  storeBatchSummary({
    total_count: detail.total_count ?? 0,
    total_elapsed_seconds: detail.total_elapsed_secs ?? 0,
  });
  if (detail.config_snapshot && typeof detail.config_snapshot === "object") {
    storeProcessingConfig(detail.config_snapshot as Record<string, unknown>);
  }

  // Single-image mode: there is only one entry, so startIndex is moot.
  if (
    options.singleImageId === undefined &&
    typeof options.startIndex === "number" &&
    options.startIndex > 0
  ) {
    const clamped = Math.min(
      Math.max(0, options.startIndex),
      storedResults.length - 1,
    );
    sessionStorage.setItem(KEY_START_INDEX, String(clamped));
  } else {
    sessionStorage.removeItem(KEY_START_INDEX);
  }

  return true;
}

/**
 * One-shot read of the start index written by `openBatchInResults`. The value
 * is consumed on read — subsequent calls return null.
 */
export function consumeStartIndex(): number | null {
  const raw = sessionStorage.getItem(KEY_START_INDEX);
  if (raw === null) return null;
  sessionStorage.removeItem(KEY_START_INDEX);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
