// API types — canonical definitions matching api-contract.mdc

export type Organism = "egg" | "larvae" | "pupae" | "neonate";

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export interface BBox {
  label: string;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  confidence: number;
  /** Whether this box was drawn by the user (default: undefined = model origin) */
  origin?: "model" | "user";
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

export type Device = "cpu" | `cuda:${string}`;

export interface EggConfig {
  model: string;
  device: Device;
  tile_size: number;
  overlap: number;
  confidence_threshold: number;
  min_box_area: number;
  dedup_mode: "center_zone" | "edge_nms";
  edge_margin: number;
  nms_iou_threshold: number;
  batch_size: number;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  model_loaded: boolean;
  device: Device;
  cuda_available: boolean;
  uptime_seconds: number;
  version: string;
}

// ── App Settings ─────────────────────────────────────────────────────────────

export interface AppSettingsResponse {
  image_storage_dir: string;
  data_dir: string;
}

export interface StorageSettingsResponse {
  image_storage_dir: string;
}

export interface StorageSettingsUpdate {
  image_storage_dir: string;
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
  /** User-edited annotations; if present, supersedes annotations for display. */
  edited_annotations?: BBox[] | null;
}

export interface AnalysisImageDetail extends AnalysisImageSummary {
  /** Full image detail includes edited_annotations explicitly. */
}

export interface AnalysisBatchSummary {
  id: string; // UUID
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
  is_default: boolean;
  model_filename: string;
  custom_model: CustomModelResponse | null;
}

export interface AssignmentsResponse {
  assignments: Record<Organism, OrganismAssignment>;
}

export interface AssignResultResponse {
  organism: Organism;
  custom_model_id: string | null;
  model_filename: string;
}

// ── Log streaming ─────────────────────────────────────────────────────────────

export type LogStreamMessage =
  | { type: "log"; data: LogEntry }
  | { type: "heartbeat"; data: null };
