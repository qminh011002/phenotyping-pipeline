// Processing session — stores selected files and results in sessionStorage.
// Used to pass state between UploadPage and ProcessingPage / ResultPage.

import type { AnalysisMode, BBox, DetectionResult } from '@/types/api';

const KEY_FILES = 'phenotyping_processing_files';
const KEY_RESULTS = 'phenotyping_processing_results';
const KEY_ORGANISM = 'phenotyping_processing_organism';
const KEY_BATCH_ID = 'phenotyping_processing_batch_id';
const KEY_DB_BATCH_ID = 'phenotyping_processing_db_batch_id';
const KEY_BATCH_SUMMARY = 'phenotyping_processing_batch_summary';
const KEY_BATCH_DETAIL = 'phenotyping_processing_batch_detail';
const KEY_CONFIG = 'phenotyping_processing_config';
const KEY_CLASSES = 'phenotyping_processing_classes';
const KEY_ANALYSIS_MODE = 'phenotyping_processing_analysis_mode';
const KEY_APPEND_TARGET = 'phenotyping_processing_append_target';

/** An existing batch that the current upload adds images to. */
export interface AppendTarget {
    batchId: string;
    batchName: string;
    /** Images already in the batch when the append started — the offset
     *  between the batch's processed count and this run's file list. */
    baseCount: number;
}

export interface StoredFile {
    id: string;
    name: string;
    type: string;
    size: number;
    blobUrl: string;
}

export interface StoredResult {
    id: string;
    filename: string;
    result: DetectionResult;
}

export interface StoredBatchSummary {
    total_count: number;
    total_elapsed_seconds: number;
}

export interface StoredImageDetail {
    id: string;
    original_filename: string;
    status: string;
    count: number | null;
    avg_confidence: number | null;
    elapsed_secs: number | null;
    overlay_path: string | null;
    error_message: string | null;
    created_at: string;
    /** Model annotations at inference time — persisted since migration 008. */
    annotations?: BBox[] | null;
    /** User-edited annotations (FS-009); supersedes model annotations if present */
    edited_annotations?: BBox[] | null;
}

export interface StoredBatchDetail {
    id: string;
    name: string;
    total_count: number | null;
    total_elapsed_secs: number | null;
    avg_confidence: number | null;
    images: StoredImageDetail[];
    /** Class names persisted on the batch row; optional for back-compat. */
    classes?: string[];
    /** Lifecycle state: 'processing' | 'draft' | 'completed' | 'failed'. Optional for back-compat. */
    status?: string;
}

// ── Store files before navigating to processing page ─────────────────────────

// In-memory cache: id -> File. Survives tab navigation (module-level), not reload.
// Lets processingManager skip the fetch(blobUrl)->blob() roundtrip on the hot path.
const _fileCache = new Map<string, File>();

export function getCachedFile(id: string): File | undefined {
    return _fileCache.get(id);
}

function releaseStoredFiles(): void {
    const files = loadProcessingFiles();
    files.forEach((f) => URL.revokeObjectURL(f.blobUrl));
    _fileCache.clear();
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', releaseStoredFiles);
}

export function storeProcessingFiles(
    files: Array<{ id: string; file: File }>,
    organism: string,
    batchId: string,
): void {
    // Revoke any prior blob URLs and clear cache from a previous batch
    const prior = loadProcessingFiles();
    prior.forEach((f) => URL.revokeObjectURL(f.blobUrl));
    _fileCache.clear();

    const stored: StoredFile[] = files.map(({ id, file }) => {
        _fileCache.set(id, file);
        return {
            id,
            name: file.name,
            type: file.type,
            size: file.size,
            blobUrl: URL.createObjectURL(file),
        };
    });
    sessionStorage.setItem(KEY_FILES, JSON.stringify(stored));
    sessionStorage.setItem(KEY_ORGANISM, organism);
    sessionStorage.setItem(KEY_BATCH_ID, batchId);
    // Clear any per-run artifacts from a prior Process click so a new run can
    // never inherit a stale db batch id (which would 404) or stale results.
    sessionStorage.removeItem(KEY_RESULTS);
    sessionStorage.removeItem(KEY_DB_BATCH_ID);
    sessionStorage.removeItem(KEY_BATCH_SUMMARY);
    sessionStorage.removeItem(KEY_BATCH_DETAIL);
    // KEY_CLASSES is intentionally NOT cleared here — AnalyzePage writes it
    // before navigating into the upload flow.
}

// ── Retrieve stored files ────────────────────────────────────────────────────

export function loadProcessingFiles(): StoredFile[] {
    try {
        const raw = sessionStorage.getItem(KEY_FILES);
        return raw ? JSON.parse(raw) : [];
    } catch (err) {
        console.warn('loadProcessingFiles: corrupted sessionStorage payload', err);
        return [];
    }
}

// ── Retrieve stored results ──────────────────────────────────────────────────

export function loadProcessingResults(): StoredResult[] {
    try {
        const raw = sessionStorage.getItem(KEY_RESULTS);
        return raw ? JSON.parse(raw) : [];
    } catch (err) {
        console.warn('loadProcessingResults: corrupted sessionStorage payload', err);
        return [];
    }
}

// ── Store results after processing ───────────────────────────────────────────

// The cached results are an optimisation only — the result viewer fetches any
// image's annotations it doesn't find here. Dense batches (thousands of boxes
// per image) can exceed the sessionStorage quota, so a failed write just
// drops the cache instead of throwing into the processing loop.
function setItemOrDrop(key: string, value: unknown): void {
    try {
        sessionStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
        sessionStorage.removeItem(key);
        console.warn(`sessionStorage write for ${key} skipped`, err);
    }
}

export function storeProcessingResults(results: StoredResult[]): void {
    setItemOrDrop(KEY_RESULTS, results);
}

// ── Store DB batch ID ─────────────────────────────────────────────────────

export function storeDbBatchId(dbBatchId: string): void {
    sessionStorage.setItem(KEY_DB_BATCH_ID, dbBatchId);
}

// ── Retrieve DB batch ID ──────────────────────────────────────────────────

export function loadDbBatchId(): string {
    return sessionStorage.getItem(KEY_DB_BATCH_ID) ?? '';
}

// ── Store batch summary ───────────────────────────────────────────────────

export function storeBatchSummary(summary: StoredBatchSummary): void {
    sessionStorage.setItem(KEY_BATCH_SUMMARY, JSON.stringify(summary));
}

// ── Retrieve batch summary ────────────────────────────────────────────────

export function loadBatchSummary(): StoredBatchSummary | null {
    try {
        const raw = sessionStorage.getItem(KEY_BATCH_SUMMARY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

// ── Retrieve session metadata ───────────────────────────────────────────────

export function loadOrganism(): string {
    return sessionStorage.getItem(KEY_ORGANISM) ?? 'egg';
}

export function loadBatchId(): string {
    return sessionStorage.getItem(KEY_BATCH_ID) ?? '';
}

// ── Store / Load batch detail ─────────────────────────────────────────────────

export function storeBatchDetail(detail: StoredBatchDetail): void {
    setItemOrDrop(KEY_BATCH_DETAIL, detail);
}

export function loadBatchDetail(): StoredBatchDetail | null {
    try {
        const raw = sessionStorage.getItem(KEY_BATCH_DETAIL);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function storeProcessingConfig(config: Record<string, unknown>): void {
    sessionStorage.setItem(KEY_CONFIG, JSON.stringify(config));
}

export function loadProcessingConfig(): Record<string, unknown> | null {
    try {
        const raw = sessionStorage.getItem(KEY_CONFIG);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

// ── Clear session ───────────────────────────────────────────────────────────

export function clearProcessingSession(): void {
    // Revoke blob URLs to free memory
    releaseStoredFiles();
    sessionStorage.removeItem(KEY_FILES);
    sessionStorage.removeItem(KEY_RESULTS);
    sessionStorage.removeItem(KEY_ORGANISM);
    sessionStorage.removeItem(KEY_BATCH_ID);
    sessionStorage.removeItem(KEY_DB_BATCH_ID);
    sessionStorage.removeItem(KEY_BATCH_SUMMARY);
    sessionStorage.removeItem(KEY_BATCH_DETAIL);
    sessionStorage.removeItem(KEY_CONFIG);
    sessionStorage.removeItem(KEY_CLASSES);
    sessionStorage.removeItem(KEY_ANALYSIS_MODE);
    sessionStorage.removeItem(KEY_APPEND_TARGET);
}

// ── Analysis mode (larvae / pupae) ──────────────────────────────────────────
// Count-only is the default: SAM refinement and measurement are deferred to
// the result viewer, where the operator runs them on demand.

export function storeAnalysisMode(mode: AnalysisMode): void {
    sessionStorage.setItem(KEY_ANALYSIS_MODE, mode);
}

export function loadAnalysisMode(): AnalysisMode {
    return sessionStorage.getItem(KEY_ANALYSIS_MODE) === 'measure' ? 'measure' : 'count';
}

// ── Append target ───────────────────────────────────────────────────────────

export function storeAppendTarget(target: AppendTarget | null): void {
    if (target === null) sessionStorage.removeItem(KEY_APPEND_TARGET);
    else sessionStorage.setItem(KEY_APPEND_TARGET, JSON.stringify(target));
}

export function loadAppendTarget(): AppendTarget | null {
    try {
        const raw = sessionStorage.getItem(KEY_APPEND_TARGET);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<AppendTarget>;
        if (typeof parsed.batchId !== 'string') return null;
        return {
            batchId: parsed.batchId,
            batchName: typeof parsed.batchName === 'string' ? parsed.batchName : '',
            baseCount: typeof parsed.baseCount === 'number' ? parsed.baseCount : 0,
        };
    } catch {
        return null;
    }
}

// ── Project class names (frozen for the batch) ──────────────────────────────

export function storeProjectClasses(classes: string[]): void {
    sessionStorage.setItem(KEY_CLASSES, JSON.stringify(classes));
}

export function loadProjectClasses(): string[] {
    try {
        const raw = sessionStorage.getItem(KEY_CLASSES);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((s): s is string => typeof s === 'string')
            : [];
    } catch {
        return [];
    }
}

// ── Generate a batch ID ─────────────────────────────────────────────────────

export function generateBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
