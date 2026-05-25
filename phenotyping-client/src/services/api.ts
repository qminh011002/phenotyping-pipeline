// Typed API functions — one per backend endpoint.
// All functions are async and return fully typed responses.
// Uses the http client defined in http.ts.

import { getBaseUrl } from './http';
import { http } from './http';
import { getAccessToken } from '@/stores/authStore';
import type {
    ActiveBatchResponse,
    AnalysisBatchDetail,
    AnalysisImageDetail,
    AnalysisListResponse,
    AssignmentsResponse,
    AssignResultResponse,
    BatchDetectionResult,
    CalibrationCorners,
    CalibrationUpdate,
    CenterlineMethod,
    CustomModelListResponse,
    CustomModelResponse,
    DashboardStats,
    DetectionResult,
    EggConfig,
    FailBatchResponse,
    HealthResponse,
    LarvaeBatchDetail,
    LarvaeConfig,
    LarvaeDetectionResult,
    LarvaeMeasurementResult,
    LogEntry,
    MeasureLarvaeRequest,
    Organism,
    PolygonsUpdate,
    PolygonsUpdateResponse,
    SamModelListResponse,
    SamModelResponse,
} from '@/types/api';

// ── Health ─────────────────────────────────────────────────────────────────

/** GET /health — liveness check */
export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
    return http.get<HealthResponse>('health', signal);
}

/** GET /ping — lightweight latency check */
export async function ping() {
    return http.get<{ pong: boolean }>('ping');
}

// ── Inference ───────────────────────────────────────────────────────────────

/** POST /inference/egg — run egg detection on a single image */
export async function inferSingleEgg(file: File, batchId?: string): Promise<DetectionResult> {
    return http.postFormData<DetectionResult>(
        'inference/egg',
        'file',
        file,
        batchId ? { batch_id: batchId } : undefined,
    );
}

/** POST /inference/egg/batch — run egg detection on multiple images */
export async function inferBatchEgg(files: File[]): Promise<BatchDetectionResult> {
    return http.postFormDataMulti<BatchDetectionResult>('inference/egg/batch', 'files', files);
}

/** POST /inference/neonate — run neonate detection on a single image */
export async function inferSingleNeonate(file: File, batchId?: string): Promise<DetectionResult> {
    return http.postFormData<DetectionResult>(
        'inference/neonate',
        'file',
        file,
        batchId ? { batch_id: batchId } : undefined,
    );
}

/** POST /inference/neonate/batch — run neonate detection on multiple images */
export async function inferBatchNeonate(files: File[]): Promise<BatchDetectionResult> {
    return http.postFormDataMulti<BatchDetectionResult>('inference/neonate/batch', 'files', files);
}

/** Run single-image inference against the endpoint for the given organism. */
export async function inferSingle(
    organism: Organism,
    file: File,
    batchId?: string,
): Promise<DetectionResult> {
    if (organism === 'neonate') return inferSingleNeonate(file, batchId);
    return inferSingleEgg(file, batchId);
}

/** POST /inference/larvae — run larvae segmentation on a single image. */
export async function inferSingleLarvae(
    file: File,
    batchId?: string,
): Promise<LarvaeDetectionResult> {
    return http.postFormData<LarvaeDetectionResult>(
        'inference/larvae',
        'file',
        file,
        batchId ? { batch_id: batchId } : undefined,
    );
}

/** POST /inference/pupae — run pupae segmentation on a single image.
 *
 * Pupae uses the same polygon + MWIS + SAM pipeline as larvae and shares the
 * `larvae_detection` / `larvae_calibration` / `larvae_measurement` DB tables,
 * so the response shape is identical to `LarvaeDetectionResult` apart from
 * the `organism` and `label` discriminants.
 */
export async function inferSinglePupae(
    file: File,
    batchId?: string,
): Promise<LarvaeDetectionResult> {
    return http.postFormData<LarvaeDetectionResult>(
        'inference/pupae',
        'file',
        file,
        batchId ? { batch_id: batchId } : undefined,
    );
}

// ── Overlay URLs ───────────────────────────────────────────────────────────────

/**
 * Return the URL for a recorded overlay image from the analyses DB.
 * Uses the /analyses/{batch_id}/images/{image_id}/overlay endpoint.
 * Call this for overlays of saved batches (from the Recorded page / detail view).
 *
 * Returns a base-relative path. Callers must route it through `http.getBlob`
 * (or another helper that prepends the base via `_url`); `<img src>` won't
 * work because the route requires Bearer auth.
 */
export function getAnalysesOverlayUrl(batchId: string, imageId: string): string {
    return `/analyses/${batchId}/images/${imageId}/overlay`;
}

/**
 * Return the URL for a recorded raw (un-annotated) image from the analyses
 * DB. Uses /analyses/{batch_id}/images/{image_id}/raw. Use this when
 * rendering client-side bbox overlays so we don't stack them on top of the
 * server-rendered annotated PNG.
 *
 * Returns a base-relative path. Callers must route it through `http.getBlob`
 * (or another helper that prepends the base via `_url`); `<img src>` won't
 * work because the route requires Bearer auth.
 */
export function getAnalysesRawUrl(batchId: string, imageId: string): string {
    return `/analyses/${batchId}/images/${imageId}/raw`;
}

/**
 * Return the absolute URL for a processing-session overlay image.
 * Uses the /inference/results/{batch_id}/{filename}/overlay endpoint.
 * Call this for overlays during the active processing session (before DB persistence).
 */
export function getOverlayUrl(batchId: string, filename: string): string {
    // If batchId already looks like a full relative path (starts with "/"), it's the
    // stored overlay_path from the database — use it directly without appending filename.
    if (batchId.startsWith('/')) {
        return `${getBaseUrl().replace(/\/$/, '')}${batchId}`;
    }
    return `${getBaseUrl().replace(/\/$/, '')}/inference/results/${batchId}/${filename}/overlay.png`;
}

// ── Config ──────────────────────────────────────────────────────────────────

/** GET /config — return current egg inference config */
export async function getConfig(signal?: AbortSignal): Promise<EggConfig> {
    return http.get<EggConfig>('config', signal);
}

/** PUT /config — update egg inference config */
export async function updateConfig(updates: Partial<EggConfig>): Promise<EggConfig> {
    return http.put<EggConfig>('config', updates);
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
    name?: string;
    classes?: string[];
}): Promise<AnalysisBatchDetail> {
    return http.post<AnalysisBatchDetail>('analyses', data);
}

/** PATCH /analyses/{batch_id} — rename a batch */
export async function renameBatch(batchId: string, name: string): Promise<AnalysisBatchDetail> {
    return http.patch<AnalysisBatchDetail>(`analyses/${batchId}`, { name });
}

/** POST /analyses/{batch_id}/images — record a single image's inference result */
export async function addImageResult(
    batchId: string,
    data: {
        filename: string;
        count: number;
        avg_confidence: number;
        elapsed_seconds: number;
        annotations: Array<{
            label: string;
            bbox: [number, number, number, number];
            confidence: number;
        }>;
        overlay_url: string;
    },
): Promise<{ status: string; batch_id: string }> {
    return http.post<{ status: string; batch_id: string }>(`analyses/${batchId}/images`, data);
}

/** POST /analyses/{batch_id}/complete — finish processing; batch enters 'draft' state */
export async function completeBatch(batchId: string): Promise<AnalysisBatchDetail> {
    return http.post<AnalysisBatchDetail>(`analyses/${batchId}/complete`);
}

/** POST /analyses/{batch_id}/finish — save a draft to Records (draft → completed) */
export async function finishBatch(batchId: string): Promise<AnalysisBatchDetail> {
    return http.post<AnalysisBatchDetail>(`analyses/${batchId}/finish`);
}

/** GET /analyses/active — get the currently-processing batch */
export async function getActiveBatch(): Promise<ActiveBatchResponse> {
    return http.get<ActiveBatchResponse>('analyses/active');
}

/** POST /analyses/{batch_id}/fail — mark a batch as failed */
export async function failBatch(batchId: string, reason: string): Promise<FailBatchResponse> {
    return http.post<FailBatchResponse>(`analyses/${batchId}/fail`, { reason });
}

/** GET /analyses — list batches with pagination and optional filters */
export async function listAnalyses(
    params: {
        page?: number;
        pageSize?: number;
        q?: string;
        organism?: string;
        /** Restrict to the given statuses. Records page passes ["completed"]. */
        statuses?: string[];
    },
    signal?: AbortSignal,
): Promise<AnalysisListResponse> {
    const qs = new URLSearchParams();
    if (params.page !== undefined) qs.set('page', String(params.page));
    if (params.pageSize !== undefined) qs.set('page_size', String(params.pageSize));
    if (params.q) qs.set('q', params.q);
    if (params.organism) qs.set('organism', params.organism);
    if (params.statuses && params.statuses.length > 0) {
        for (const s of params.statuses) qs.append('status', s);
    }
    const query = qs.toString();
    return http.get<AnalysisListResponse>(`analyses${query ? `?${query}` : ''}`, signal);
}

/** GET /analyses/{batch_id} — return full batch detail with all images.
 *
 * Pass `{ includeAnnotations: false }` for a lighter payload that omits the
 * per-image bbox arrays — used by views that don't render boxes (e.g. the
 * BatchDetail card grid). Default includes annotations.
 */
export async function getAnalysisDetail(
    batchId: string,
    signal?: AbortSignal,
    options?: { includeAnnotations?: boolean },
): Promise<AnalysisBatchDetail> {
    const path =
        options?.includeAnnotations === false
            ? `analyses/${batchId}?include_annotations=false`
            : `analyses/${batchId}`;
    return http.get<AnalysisBatchDetail>(path, signal);
}

/** GET /analyses/{batch_id}/images/{image_id} — single-image detail with annotations.
 *
 * Used by ResultViewer to lazy-fetch annotations one image at a time, so
 * batches with many images don't pay an O(N) cost upfront.
 */
export async function getImageDetail(
    batchId: string,
    imageId: string,
    signal?: AbortSignal,
): Promise<AnalysisImageDetail> {
    return http.get<AnalysisImageDetail>(`analyses/${batchId}/images/${imageId}`, signal);
}

/** DELETE /analyses/{batch_id} — delete a batch and its overlay files */
export async function deleteAnalysis(batchId: string): Promise<void> {
    await http.delete(`analyses/${batchId}`);
}

/**
 * POST /analyses/{batch_id}/download — build a ZIP of overlay images + an
 * .xlsx summary. Returns the raw response so the caller can pull a Blob and
 * the suggested filename from Content-Disposition.
 */
export async function downloadBatchArchive(
    batchId: string,
    imageIds: string[] | null,
): Promise<{ blob: Blob; filename: string }> {
    const url = `${getBaseUrl().replace(/\/$/, '')}/analyses/${batchId}/download`;
    const token = getAccessToken();
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ image_ids: imageIds ?? null }),
    });
    if (!response.ok) {
        let detail: string | null = null;
        try {
            const json = (await response.json()) as { detail?: string };
            detail = json.detail ?? null;
        } catch {
            detail = response.statusText || null;
        }
        throw new Error(detail ?? `Download failed (${response.status})`);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? `batch-${batchId}.zip`;
    const blob = await response.blob();
    return { blob, filename };
}

// ── Dashboard ───────────────────────────────────────────────────────────────

/** GET /dashboard/stats — return aggregate statistics for the home page */
export async function getDashboardStats(signal?: AbortSignal): Promise<DashboardStats> {
    return http.get<DashboardStats>('dashboard/stats', signal);
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
        origin?: 'model' | 'user';
        edited_at?: string;
    }>,
    signal?: AbortSignal,
): Promise<AnalysisImageDetail> {
    return http.put<AnalysisImageDetail>(
        `analyses/${batchId}/images/${imageId}/annotations`,
        { edited_annotations: editedAnnotations },
        signal,
    );
}

/**
 * DELETE /analyses/{batch_id}/images/{image_id}/annotations
 * Reset edited annotations to the model's original output.
 */
export async function resetEditedAnnotations(batchId: string, imageId: string): Promise<void> {
    await http.delete(`analyses/${batchId}/images/${imageId}/annotations`);
}

// ── Custom Models ─────────────────────────────────────────────────────────────

/** POST /models/upload — upload a custom .pt model file */
export async function uploadCustomModel(
    organism: Organism,
    file: File,
): Promise<CustomModelResponse> {
    return http.postFormData<CustomModelResponse>(`models/${organism}/upload`, 'file', file);
}

/** GET /models/custom — list all uploaded custom models */
export async function listCustomModels(
    organism?: Organism,
    signal?: AbortSignal,
): Promise<CustomModelListResponse> {
    const query = organism ? `?organism=${encodeURIComponent(organism)}` : '';
    return http.get<CustomModelListResponse>(`models/custom${query}`, signal);
}

/** GET /models/assignments — get current model assignments for all organisms */
export async function getModelAssignments(signal?: AbortSignal): Promise<AssignmentsResponse> {
    return http.get<AssignmentsResponse>('models/assignments', signal);
}

/** PUT /models/{organism}/assign — assign a custom model or revert to default */
export async function assignModel(
    organism: Organism,
    customModelId: string | null,
): Promise<AssignResultResponse> {
    return http.put<AssignResultResponse>(`models/${organism}/assign`, {
        custom_model_id: customModelId,
    });
}

/** DELETE /models/custom/{id} — delete an uploaded custom model */
export async function deleteCustomModel(modelId: string): Promise<void> {
    await http.delete(`models/custom/${modelId}`);
}

// ── SAM models ───────────────────────────────────────────────────────────────

/** GET /sam-models — list installed SAM weight files */
export async function listSamModels(signal?: AbortSignal): Promise<SamModelListResponse> {
    return http.get<SamModelListResponse>('sam-models', signal);
}

/** POST /sam-models/upload — upload a SAM .pt file */
export async function uploadSamModel(file: File): Promise<SamModelResponse> {
    return http.postFormData<SamModelResponse>('sam-models/upload', 'file', file);
}

/** PUT /config/larvae — patch larvae inference config (returns full merged config) */
export async function updateLarvaeConfig(
    update: { centerline_method?: CenterlineMethod; sam_enabled?: boolean },
): Promise<LarvaeConfig> {
    return http.put<LarvaeConfig>('config/larvae', update);
}

/** PUT /sam-models/activate — set the active SAM model */
export async function activateSamModel(filename: string): Promise<SamModelResponse> {
    return http.put<SamModelResponse>('sam-models/activate', { filename });
}

/** DELETE /sam-models/{filename} — delete a SAM weight file (non-builtin, non-active) */
export async function deleteSamModel(filename: string): Promise<void> {
    await http.delete(`sam-models/${encodeURIComponent(filename)}`);
}

// ── Larvae (BE-034) ──────────────────────────────────────────────────────────

/** GET /analyses/{batch_id}/larvae — full larvae batch detail */
export async function getLarvaeBatch(
    batchId: string,
    signal?: AbortSignal,
): Promise<LarvaeBatchDetail> {
    return http.get<LarvaeBatchDetail>(`analyses/${batchId}/larvae`, signal);
}

/** Build a CSV-export filename from a batch name + ISO date. */
export function buildLarvaeCsvFilename(batchName: string, date = new Date()): string {
    const safeName = batchName.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'batch';
    const stamp = date.toISOString().slice(0, 10);
    return `larvae-${safeName}-${stamp}.csv`;
}

/**
 * GET /analyses/{batch_id}/larvae/csv — fetch the full measurement CSV as a
 * Blob (auth-aware via the http client). Returns the suggested filename so
 * the caller can pass it to a `<a download>` element.
 */
export async function downloadLarvaeCsv(
    batchId: string,
    batchName: string,
): Promise<{ blob: Blob; filename: string }> {
    const blob = await http.getBlob(`analyses/${batchId}/larvae/csv`);
    return { blob, filename: buildLarvaeCsvFilename(batchName) };
}

/** POST /calibration/detect?image_id=... — re-run auto calibration. */
export async function detectCalibration(imageId: string): Promise<CalibrationCorners> {
    return http.post<CalibrationCorners>(
        `calibration/detect?image_id=${encodeURIComponent(imageId)}`,
        {},
    );
}

/** PUT /calibration/{image_id} — save manual calibration. */
export async function saveCalibration(
    imageId: string,
    payload: CalibrationUpdate,
): Promise<CalibrationCorners> {
    return http.put<CalibrationCorners>(`calibration/${imageId}`, payload);
}

/** POST /measure/larvae?image_id=... — compute per-larva measurements. */
export async function measureLarvae(
    imageId: string,
    payload: MeasureLarvaeRequest = {},
): Promise<LarvaeMeasurementResult> {
    return http.post<LarvaeMeasurementResult>(
        `measure/larvae?image_id=${encodeURIComponent(imageId)}`,
        payload,
    );
}

/** PUT /analyses/{batch_id}/images/{image_id}/polygons — save polygon edits. */
export async function savePolygonEdits(
    batchId: string,
    imageId: string,
    payload: PolygonsUpdate,
): Promise<PolygonsUpdateResponse> {
    return http.put<PolygonsUpdateResponse>(
        `analyses/${batchId}/images/${imageId}/polygons`,
        payload,
    );
}
