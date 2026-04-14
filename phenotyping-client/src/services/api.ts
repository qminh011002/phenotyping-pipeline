// Typed API functions — one per backend endpoint.
// All functions are async and return fully typed responses.
// Uses the http client defined in http.ts.

import { getBaseUrl } from "./http";
import { http } from "./http";
import type {
  AnalysisBatchDetail,
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
export async function inferSingleEgg(file: File): Promise<DetectionResult> {
  return http.postFormData<DetectionResult>("inference/egg", "file", file);
}

/** POST /inference/egg/batch — run egg detection on multiple images */
export async function inferBatchEgg(files: File[]): Promise<BatchDetectionResult> {
  return http.postFormDataMulti<BatchDetectionResult>("inference/egg/batch", "files", files);
}

/**
 * Return the absolute URL for a previously processed overlay image.
 * The overlay_url from DetectionResult is relative; this builds the full URL.
 */
export function getOverlayUrl(batchId: string, filename: string): string {
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
