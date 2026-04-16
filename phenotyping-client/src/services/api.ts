// Typed API functions — one per backend endpoint.
// All functions are async and return fully typed responses.
// Uses the http client defined in http.ts.

import { getBaseUrl } from "./http";
import { http } from "./http";
import type {
  AnalysisBatchDetail,
  AnalysisImageDetail,
  AnalysisListResponse,
  AppSettingsResponse,
  BatchDetectionResult,
  DashboardStats,
  DetectionResult,
  EggConfig,
  LogEntry,
  StorageSettingsResponse,
  StorageSettingsUpdate,
} from "@/types/api";

// ── Health ─────────────────────────────────────────────────────────────────

/** GET /health — liveness check */
export async function getHealth() {
  return http.get<{ status: "ok" | "degraded"; model_loaded: boolean; device: string; cuda_available: boolean; uptime_seconds: number; version: string }>("health");
}

/** GET /ping — lightweight latency check */
export async function ping() {
  return http.get<{ pong: boolean }>("ping");
}

// ── Inference ───────────────────────────────────────────────────────────────

/** POST /inference/egg — run egg detection on a single image */
export async function inferSingleEgg(file: File, batchId?: string): Promise<DetectionResult> {
  return http.postFormData<DetectionResult>("inference/egg", "file", file, batchId ? { batch_id: batchId } : undefined);
}

/** POST /inference/egg/batch — run egg detection on multiple images */
export async function inferBatchEgg(files: File[]): Promise<BatchDetectionResult> {
  return http.postFormDataMulti<BatchDetectionResult>("inference/egg/batch", "files", files);
}

// ── Overlay URLs ───────────────────────────────────────────────────────────────

/**
 * Return the absolute URL for a recorded overlay image from the analyses DB.
 * Uses the /analyses/{batch_id}/images/{image_id}/overlay endpoint.
 * Call this for overlays of saved batches (from the Recorded page / detail view).
 */
export function getAnalysesOverlayUrl(batchId: string, imageId: string): string {
  return `${getBaseUrl().replace(/\/$/, "")}/analyses/${batchId}/images/${imageId}/overlay`;
}

/**
 * Return the absolute URL for a recorded raw (un-annotated) image from the
 * analyses DB. Uses /analyses/{batch_id}/images/{image_id}/raw. Use this when
 * rendering client-side bbox overlays so we don't stack them on top of the
 * server-rendered annotated PNG.
 */
export function getAnalysesRawUrl(batchId: string, imageId: string): string {
  return `${getBaseUrl().replace(/\/$/, "")}/analyses/${batchId}/images/${imageId}/raw`;
}

/**
 * Return the absolute URL for a processing-session overlay image.
 * Uses the /inference/results/{batch_id}/{filename}/overlay endpoint.
 * Call this for overlays during the active processing session (before DB persistence).
 */
export function getOverlayUrl(batchId: string, filename: string): string {
  // If batchId already looks like a full relative path (starts with "/"), it's the
  // stored overlay_path from the database — use it directly without appending filename.
  if (batchId.startsWith("/")) {
    return `${getBaseUrl().replace(/\/$/, "")}${batchId}`;
  }
  return `${getBaseUrl().replace(/\/$/, "")}/inference/results/${batchId}/${filename}/overlay.png`;
}

// ── Config ──────────────────────────────────────────────────────────────────

/** GET /config — return current egg inference config */
export async function getConfig(): Promise<EggConfig> {
  return http.get<EggConfig>("config");
}

/** PUT /config — update egg inference config */
export async function updateConfig(updates: Partial<EggConfig>): Promise<EggConfig> {
  return http.put<EggConfig>("config", updates);
}

// ── Settings / Storage ─────────────────────────────────────────────────────

/** GET /settings — return full app settings */
export async function getSettings(): Promise<AppSettingsResponse> {
  return http.get<AppSettingsResponse>("settings");
}

/** PUT /settings — update app settings */
export async function updateSettings(updates: StorageSettingsUpdate): Promise<AppSettingsResponse> {
  return http.put<AppSettingsResponse>("settings", updates);
}

/** GET /settings/storage — return only the image_storage_dir */
export async function getStorageSettings(): Promise<StorageSettingsResponse> {
  return http.get<StorageSettingsResponse>("settings/storage");
}

/** PUT /settings/storage — update the overlay storage directory */
export async function updateStorageSettings(updates: StorageSettingsUpdate): Promise<StorageSettingsResponse> {
  return http.put<StorageSettingsResponse>("settings/storage", updates);
}

// ── Logs ───────────────────────────────────────────────────────────────────

/** GET /logs/recent — return the last N log entries */
export async function getRecentLogs(limit = 200): Promise<{ logs: LogEntry[] }> {
  return http.get<{ logs: LogEntry[] }>(`logs/recent?limit=${limit}`);
}

// ── Analyses ───────────────────────────────────────────────────────────────

/** POST /analyses — create a new analysis batch */
export async function createBatch(data: {
  organism_type: string;
  mode: string;
  device: string;
  config_snapshot: Record<string, unknown>;
  total_image_count: number;
}): Promise<AnalysisBatchDetail> {
  return http.post<AnalysisBatchDetail>("analyses", data);
}

/** POST /analyses/{batch_id}/images — record a single image's inference result */
export async function addImageResult(
  batchId: string,
  data: {
    filename: string;
    count: number;
    avg_confidence: number;
    elapsed_seconds: number;
    annotations: Array<{ label: string; bbox: [number, number, number, number]; confidence: number }>;
    overlay_url: string;
  },
): Promise<{ status: string; batch_id: string }> {
  return http.post<{ status: string; batch_id: string }>(`analyses/${batchId}/images`, data);
}

/** POST /analyses/{batch_id}/complete — mark batch as completed */
export async function completeBatch(batchId: string): Promise<AnalysisBatchDetail> {
  return http.post<AnalysisBatchDetail>(`analyses/${batchId}/complete`);
}

/** GET /analyses — list batches with pagination and optional filters */
export async function listAnalyses(params: {
  page?: number;
  pageSize?: number;
  q?: string;
  organism?: string;
}): Promise<AnalysisListResponse> {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set("page", String(params.page));
  if (params.pageSize !== undefined) qs.set("page_size", String(params.pageSize));
  if (params.q) qs.set("q", params.q);
  if (params.organism) qs.set("organism", params.organism);
  const query = qs.toString();
  return http.get<AnalysisListResponse>(`analyses${query ? `?${query}` : ""}`);
}

/** GET /analyses/{batch_id} — return full batch detail with all images */
export async function getAnalysisDetail(batchId: string): Promise<AnalysisBatchDetail> {
  return http.get<AnalysisBatchDetail>(`analyses/${batchId}`);
}

/** DELETE /analyses/{batch_id} — delete a batch and its overlay files */
export async function deleteAnalysis(batchId: string): Promise<void> {
  await http.delete(`analyses/${batchId}`);
}

// ── Dashboard ───────────────────────────────────────────────────────────────

/** GET /dashboard/stats — return aggregate statistics for the home page */
export async function getDashboardStats(): Promise<DashboardStats> {
  return http.get<DashboardStats>("dashboard/stats");
}

// ── Edited annotations ─────────────────────────────────────────────────────

/**
 * PUT /analyses/{batch_id}/images/{image_id}/annotations
 * Save user-edited bounding boxes for a single image.
 */
export async function putEditedAnnotations(
  batchId: string,
  imageId: string,
  editedAnnotations: Array<{
    label: string;
    bbox: [number, number, number, number];
    confidence: number;
    origin?: "model" | "user";
    edited_at?: string;
  }>,
): Promise<AnalysisImageDetail> {
  return http.put<AnalysisImageDetail>(
    `analyses/${batchId}/images/${imageId}/annotations`,
    { edited_annotations: editedAnnotations },
  );
}

/**
 * DELETE /analyses/{batch_id}/images/{image_id}/annotations
 * Reset edited annotations to the model's original output.
 */
export async function resetEditedAnnotations(
  batchId: string,
  imageId: string,
): Promise<void> {
  await http.delete(`analyses/${batchId}/images/${imageId}/annotations`);
}
