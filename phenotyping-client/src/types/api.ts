// API types — canonical definitions matching api-contract.mdc

export type Organism = 'egg' | 'larvae' | 'pupae' | 'neonate';

// ── Auth (BE-020 / FE-029) ────────────────────────────────────────────────────

export interface UserOut {
    id: string; // UUID
    email: string;
    name: string | null;
    created_at: string; // ISO 8601
}

export interface AuthResponse {
    user: UserOut;
    access_token: string;
    refresh_token: string;
    token_type: 'bearer';
    access_expires_in: number; // seconds
}

export interface TokenPair {
    access_token: string;
    refresh_token: string;
    token_type: 'bearer';
    access_expires_in: number;
}

/** Stable error codes returned in 401 responses by the auth backend. */
export type AuthErrorCode =
    | 'token_expired'
    | 'token_invalid'
    | 'token_revoked'
    | 'invalid_credentials'
    | 'email_taken';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export interface BBox {
    label: string;
    bbox: [number, number, number, number]; // [x1, y1, x2, y2]
    confidence: number;
    /** Whether this box was drawn by the user (default: undefined = model origin) */
    origin?: 'model' | 'user';
    /** ISO-8601 timestamp when the box was created or last edited */
    edited_at?: string;
}

export interface DetectionResult {
    filename: string;
    organism: Organism;
    count: number;
    avg_confidence: number;
    elapsed_seconds: number;
    annotations: BBox[];
    overlay_url: string; // URL to the locally saved overlay image, never base64
}

export interface BatchDetectionResult {
    results: DetectionResult[];
    total_count: number;
    total_elapsed_seconds: number;
}

export type Device = 'cpu' | `cuda:${string}`;

export interface EggConfig {
    model: string;
    device: Device;
    tile_size: number;
    overlap: number;
    confidence_threshold: number;
    min_box_area: number;
    dedup_mode: 'center_zone' | 'edge_nms';
    edge_margin: number;
    nms_iou_threshold: number;
    batch_size: number;
}

// ── Larvae (BE-030) ──────────────────────────────────────────────────────────

export type MwisScoreMetric = 'confidence_x_area' | 'confidence';
export type CenterlineMethod = 'pipeline_compat' | 'hybrid' | 'legacy_dijkstra';

export interface LarvaeConfig {
    model: string | null;
    device: Device;
    tile_size: number;
    overlap: number;
    confidence_threshold: number;
    min_mask_size: number;
    mwis_overlap_threshold: number;
    mwis_score_metric: MwisScoreMetric;
    batch_size: number;
    /** Calibration object width in mm (default: 405) */
    calibration_object_w_mm: number;
    /** Calibration object height in mm (default: 317) */
    calibration_object_h_mm: number;
    /** Toggle weight (mg) prediction during measurement */
    enable_weight: boolean;
    /** Centerline extraction method (default: 'hybrid') */
    centerline_method?: CenterlineMethod;
    /** Hybrid prune threshold: branch length / total skeleton length (default 0.15) */
    centerline_min_branch_ratio?: number;
    /** Number of resampled points along the centerline (default 100) */
    centerline_n_output_points?: number;
    /** B-spline smoothing factor; null = scipy default (s = N) */
    centerline_smoothness?: number | null;
}

/** A 2D pixel-space point. */
export type Point2D = [number, number];

/** Polygon as ≥3 (x, y) vertices. */
export type LarvaePolygon = Point2D[];

export type DetectionOrigin = 'model' | 'user';

export interface LarvaeAnnotation {
    label: 'larvae';
    polygon: LarvaePolygon;
    bbox: [number, number, number, number]; // [x1, y1, x2, y2]
    confidence: number;
    area_px: number;
    origin: DetectionOrigin;
    /** Operator-corrected polygon; supersedes `polygon` when present. */
    edited_polygon?: LarvaePolygon | null;
    edited_at?: string | null; // ISO-8601
}

export type CalibrationStatus = 'detected' | 'manual' | 'failed';

export interface CalibrationCorners {
    image_id?: string | null;
    /** TL, TR, BR, BL (4 points). */
    auto_corners?: [Point2D, Point2D, Point2D, Point2D] | null;
    edited_corners?: [Point2D, Point2D, Point2D, Point2D] | null;
    mm_per_px_x?: number | null;
    mm_per_px_y?: number | null;
    calibration_object_w_mm?: number | null;
    calibration_object_h_mm?: number | null;
    detection_status: CalibrationStatus;
}

export interface LarvaeDetectionResult {
    filename: string;
    organism: 'larvae';
    count: number;
    avg_confidence: number;
    elapsed_seconds: number;
    annotations: LarvaeAnnotation[];
    overlay_url: string;
    calibration?: CalibrationCorners | null;
}

export interface LarvaeBatchDetectionResult {
    results: LarvaeDetectionResult[];
    total_count: number;
    total_elapsed_seconds: number;
}

export interface LarvaeMeasurement {
    detection_id: string;
    length_mm: number | null;
    min_width_mm: number | null;
    max_width_mm: number | null;
    average_width_mm: number | null;
    area_mm2: number | null;
    volume_mm3: number | null;
    /** Centerline points (~50 entries). Sent only on measurement endpoints. */
    centerline?: Array<[number, number]> | null;
    /** Per-segment widths along the centerline. */
    widths?: number[] | null;
    weight_mg?: number | null;
    /** weight_mg / area_mm2 — computed server-side on read; not persisted. */
    weight_area_ratio?: number | null;
    is_stale: boolean;
    measured_at?: string | null; // ISO-8601
}

export interface WeightStats {
    count: number;
    total_biomass_mg: number | null;
    mean: number | null;
    median: number | null;
    min: number | null;
    max: number | null;
    std: number | null;
    cv: number | null;
    p5: number | null;
    p25: number | null;
    p75: number | null;
    p95: number | null;
    iqr: number | null;
    skewness: number | null;
    kurtosis: number | null;
    avg_weight_area_ratio: number | null;
}

export interface LarvaeMeasurementResult {
    image_id: string;
    calibration: CalibrationCorners | null;
    measurements: LarvaeMeasurement[];
    generated_at: string; // ISO-8601
}

// ── Larvae batch endpoints (BE-034) ──────────────────────────────────────────

/** Persisted detection — adds the row id used to address the polygon edit. */
export interface StoredLarvaeAnnotation extends LarvaeAnnotation {
    detection_id: string;
}

export interface LarvaeImageDetail {
    image_id: string;
    original_filename: string;
    /** User-entered total weight for this image, distributed across measurements. */
    total_weight_mg: number | null;
    overlay_url: string | null;
    /** Warped raw (no marks) used by LarvaePolygonEditor as its backing image. */
    warped_url: string | null;
    raw_url: string | null;
    /** Per-image inference wall time, in seconds. Null on older batches. */
    elapsed_secs: number | null;
    detections: StoredLarvaeAnnotation[];
    calibration: CalibrationCorners | null;
    measurements: LarvaeMeasurement[];
}

export interface LarvaeBatchDetail {
    batch_id: string;
    name: string;
    organism: 'larvae';
    status: string;
    total_image_count: number;
    /** Detection model filename snapshotted at batch creation. Null on legacy batches. */
    detection_model: string | null;
    /** SAM model filename snapshotted at batch creation. Null on legacy batches. */
    sam_model: string | null;
    images: LarvaeImageDetail[];
    weight_stats: WeightStats | null;
}

/** Body for PUT /analyses/images/{image_id}/total-weight */
export interface ImageTotalWeightUpdate {
    total_weight_mg: number | null;
}

export interface ImageTotalWeightResult {
    image_id: string;
    total_weight_mg: number | null;
    measurements_updated: number;
}

/** Body for PUT /calibration/{image_id} — at least one branch required. */
export interface CalibrationUpdate {
    corners?: [Point2D, Point2D, Point2D, Point2D] | null;
    mm_per_px_x?: number | null;
    mm_per_px_y?: number | null;
}

/** Body for POST /measure/larvae?image_id=... */
export interface MeasureLarvaeRequest {
    polygon_overrides?: LarvaePolygon[] | null;
}

export interface PolygonEdit {
    detection_id: string;
    polygon: LarvaePolygon;
}

/** Body for PUT /analyses/{batch_id}/images/{image_id}/polygons */
export interface PolygonsUpdate {
    polygons: PolygonEdit[];
    deleted_detection_ids?: string[];
}

export interface PolygonsUpdateResponse {
    status: 'ok';
    image_id: string;
    updated: number;
    deleted: number;
}

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    context: Record<string, unknown>;
}

export type ModelStatus = 'loaded' | 'missing' | 'error';

export interface HealthResponse {
    status: 'ok' | 'degraded';
    /** Egg-only legacy flag retained for older callers; prefer `models_status.egg`. */
    model_loaded: boolean;
    device: Device;
    cuda_available: boolean;
    uptime_seconds: number;
    version: string;
    /** Per-organism load state. Frontend uses this to gate the Project Type cards. */
    models_status: Partial<Record<Organism, ModelStatus>>;
    /** Number of CUDA devices torch can see (0 if no GPU). */
    cuda_device_count: number;
    /** Name of the first CUDA device, or null if no GPU. */
    cuda_device_name: string | null;
    /** Active device per organism (e.g. {egg: "cpu", larvae: "cuda:0"}). */
    devices_per_organism: Partial<Record<Organism, string>>;
}

// ── Analyses ─────────────────────────────────────────────────────────────────

export interface AnalysisImageSummary {
    id: string; // UUID
    original_filename: string;
    status: string;
    count: number | null;
    avg_confidence: number | null;
    elapsed_secs: number | null;
    overlay_path: string | null;
    error_message: string | null;
    created_at: string; // ISO 8601
    /** Model-produced annotations at inference time (read-only baseline). */
    annotations?: BBox[] | null;
    /** User-edited annotations; if present, supersedes annotations for display. */
    edited_annotations?: BBox[] | null;
}

export interface AnalysisImageDetail extends AnalysisImageSummary {
    /** Full image detail includes edited_annotations explicitly. */
}

export interface AnalysisBatchSummary {
    id: string; // UUID
    user_id: string | null; // owner; null only on legacy pre-BE-021 rows
    name: string;
    created_at: string; // ISO 8601
    completed_at: string | null;
    status: string;
    organism_type: string;
    mode: string;
    device: string;
    total_image_count: number;
    total_count: number | null;
    avg_confidence: number | null;
    total_elapsed_secs: number | null;
    processed_image_count: number;
    failed_at: string | null;
    failure_reason: string | null;
    /** Class names defined on the Analyze page; frozen for the batch. */
    classes: string[];
}

export interface AnalysisBatchDetail extends AnalysisBatchSummary {
    config_snapshot: Record<string, unknown>;
    notes: string | null;
    images: AnalysisImageSummary[];
}

export interface AnalysisListResponse {
    items: AnalysisBatchSummary[];
    total: number;
    page: number;
    page_size: number;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export interface DashboardStats {
    total_analyses: number;
    total_images_processed: number;
    total_eggs_counted: number;
    avg_confidence: number | null;
    avg_processing_time: number | null;
    recent_analyses: AnalysisBatchSummary[];
}

// ── Custom Models ────────────────────────────────────────────────────────────

export interface CustomModelResponse {
    id: string;
    organism: Organism;
    original_filename: string;
    file_size_bytes: number;
    uploaded_at: string;
    is_valid: boolean;
}

export interface CustomModelListResponse {
    models: CustomModelResponse[];
}

export interface OrganismAssignment {
    organism: Organism;
    /** True if the active model is the default-folder file (no custom assigned). */
    is_default: boolean;
    /** True if at least one .pt exists in `data/models/<organism>/default/`. */
    has_default: boolean;
    /** Filename of the active model (custom > default). `null` when neither is installed. */
    model_filename: string | null;
    /** Filename of the default-folder model, if any. */
    default_filename: string | null;
    custom_model: CustomModelResponse | null;
}

export interface AssignmentsResponse {
    assignments: Record<Organism, OrganismAssignment>;
}

export interface AssignResultResponse {
    organism: Organism;
    custom_model_id: string | null;
    model_filename: string | null;
}

// ── SAM Models ───────────────────────────────────────────────────────────────

export interface SamModelResponse {
    filename: string;
    file_size_bytes: number;
    uploaded_at: string;
    is_builtin: boolean;
    is_active: boolean;
}

export interface SamModelListResponse {
    models: SamModelResponse[];
    active_filename: string | null;
}

// ── Log streaming ─────────────────────────────────────────────────────────────

export type LogStreamMessage = { type: 'log'; data: LogEntry } | { type: 'heartbeat'; data: null };

// ── Active batch / fail batch ─────────────────────────────────────────────────

export interface ActiveBatchResponse {
    active: boolean;
    batch: AnalysisBatchDetail | null;
}

export interface FailBatchRequest {
    reason: string;
}

export interface FailBatchResponse {
    id: string;
    status: string;
    failed_at: string | null;
    failure_reason: string | null;
}
