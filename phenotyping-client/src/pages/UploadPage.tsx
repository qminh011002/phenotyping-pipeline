// UploadPage — pick the images for a run and choose how they are processed.
//
// Two entry points share this page:
//   /analyze/upload?type=larvae&mode=upload            → new batch
//   /analyze/upload?batch=<id>                         → add images to an
//                                                        existing batch
// In both cases the files are handed to the processing manager, which owns
// the inference loop from there.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    AlertTriangle,
    ArrowLeft,
    ArrowRight,
    ArrowUpFromLine,
    Camera,
    Check,
    FileIcon,
    FolderIcon,
    Image as ImageIcon,
    ImagePlus,
    Plus,
    Settings2,
    Trash2,
    Upload,
    X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useBackTo } from '@/hooks/useBackTo';
import { batchPath, isBatchPagePath } from '@/features/recorded/lib/paths';

import { OrganismBadge, PaginationBar } from '@/components/common';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { FlowSteps } from '@/features/analyze/components/FlowSteps';
import { AnalysisModePicker } from '@/features/upload/components/AnalysisModePicker';
import { ConfigPanel } from '@/features/upload/components/ConfigPanel';
import { LarvaeConfigPanel } from '@/features/upload/components/LarvaeConfigPanel';
import {
    generateBatchId,
    storeAnalysisMode,
    storeAppendTarget,
    storeProcessingFiles,
} from '@/features/upload/lib/processingSession';
import { formatBytes, pluralize } from '@/lib/format';
import { isPolygonOrganism, organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';
import { useBoot } from '@/providers/BootProvider';
import { getAnalysisDetail, getBboxConfig, getPolygonConfig } from '@/services/api';
import { isManagerRunning, startProcessingFromSession } from '@/services/processingManager';
import { useProcessingStore } from '@/stores/processingStore';
import type { AnalysisMode, EggConfig, LarvaeConfig, Organism } from '@/types/api';

interface FileEntry {
    id: string;
    file: File;
    previewUrl: string;
}

const SUPPORTED_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/tiff',
    'image/tif',
    'image/bmp',
]);

const ORGANISMS = new Set<Organism>(['egg', 'neonate', 'larvae', 'pupae']);

function genId() {
    return Math.random().toString(36).slice(2);
}

const stemOf = (filename: string) => filename.replace(/\.[^.]+$/, '');

// Thumbnail size/quality — intentionally low. Users identify images by filename;
// the preview just needs to be recognizable, not sharp. Keeping these small
// prevents lag when loading a 500MB+ folder of full-resolution photos.
const THUMB_MAX_EDGE = 300;
const THUMB_QUALITY = 0.5;
const THUMB_CONCURRENCY = 4;
const THUMB_MIN_SIZE = 116;
const GRID_GAP_PX = 12;
const MAX_GRID_ROWS = 4;
const DEFAULT_GRID_COLUMNS = 6;

async function makeThumbnail(file: File): Promise<string> {
    try {
        // Ask the decoder for a small bitmap directly: decoding a 20 MP photo
        // at full size just to shrink it costs ~80 MB and most of the time.
        const bitmap = await createImageBitmap(file, {
            resizeWidth: THUMB_MAX_EDGE,
            resizeQuality: 'low',
        });
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context unavailable');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const blob: Blob | null = await new Promise((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', THUMB_QUALITY),
        );
        if (!blob) throw new Error('toBlob returned null');
        return URL.createObjectURL(blob);
    } catch {
        // Fallback: use the original file directly. Still cheap — just a blob ref.
        return URL.createObjectURL(file);
    }
}

// Recursively walk a FileSystemDirectoryHandle and collect image Files.
// Uses the async iterator exposed by the File System Access API.
async function collectFilesFromDirectory(
    dir: FileSystemDirectoryHandle,
    out: File[],
): Promise<void> {
    const iter = (
        dir as unknown as {
            values: () => AsyncIterable<FileSystemHandle>;
        }
    ).values();
    for await (const handle of iter) {
        if (handle.kind === 'file') {
            try {
                const file = await (handle as FileSystemFileHandle).getFile();
                if (SUPPORTED_TYPES.has(file.type)) out.push(file);
            } catch {
                // skip unreadable files
            }
        } else if (handle.kind === 'directory') {
            await collectFilesFromDirectory(handle as FileSystemDirectoryHandle, out);
        }
    }
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
    onProgress?: (done: number) => void,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    let done = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
            done++;
            onProgress?.(done);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// ── Thumbnail tile ────────────────────────────────────────────────────────────

interface TileProps {
    entry: FileEntry;
    selected: boolean;
    onRemove: (id: string) => void;
    onOpen: (id: string) => void;
    onToggleSelect: (id: string) => void;
}

const Tile = memo(function Tile({ entry, selected, onRemove, onOpen, onToggleSelect }: TileProps) {
    return (
        <div className="group relative flex min-w-0 flex-col gap-1.5">
            <div
                role="button"
                tabIndex={0}
                onClick={() => onOpen(entry.id)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen(entry.id);
                    }
                }}
                className={cn(
                    'relative aspect-square w-full cursor-zoom-in overflow-hidden rounded-lg border bg-muted transition-[border-color,box-shadow] duration-150',
                    'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    selected
                        ? 'border-primary ring-2 ring-primary/40'
                        : 'border-border hover:border-foreground/25',
                )}
                aria-label={`Preview ${entry.file.name}`}
            >
                <img
                    src={entry.previewUrl}
                    alt={entry.file.name}
                    className="h-full w-full object-cover"
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                />
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleSelect(entry.id);
                    }}
                    className={cn(
                        'absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-md border transition-opacity duration-150',
                        'focus:outline-none focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        selected
                            ? 'border-primary bg-primary text-primary-foreground opacity-100'
                            : 'border-white/70 bg-black/35 text-white opacity-0 group-hover:opacity-100',
                    )}
                    aria-label={
                        selected ? `Deselect ${entry.file.name}` : `Select ${entry.file.name}`
                    }
                    aria-pressed={selected}
                >
                    {selected && <Check className="size-3" />}
                </button>
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove(entry.id);
                    }}
                    className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-md bg-black/55 text-white opacity-0 transition-opacity duration-150 hover:bg-black/75 focus:outline-none focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 group-hover:opacity-100"
                    aria-label={`Remove ${entry.file.name}`}
                >
                    <X className="size-3" />
                </button>
            </div>
            <span
                className="block w-full truncate text-center text-[11px] text-muted-foreground"
                title={`${entry.file.name} · ${formatBytes(entry.file.size)}`}
            >
                {entry.file.name}
            </span>
        </div>
    );
});

function AddMoreTile({ onClick }: { onClick: () => void }) {
    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <button
                type="button"
                onClick={onClick}
                className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-input text-muted-foreground transition-colors duration-150 hover:border-primary/60 hover:bg-primary/5 hover:text-foreground focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label="Add more images"
            >
                <Plus className="size-5" />
                <span className="text-xs">Add more</span>
            </button>
            <span className="block text-[11px] select-none">&nbsp;</span>
        </div>
    );
}

// ── Drop zone (empty state) ──────────────────────────────────────────────────

interface DropZoneProps {
    isDragOver: boolean;
    onDrop: (files: File[]) => void;
    onPick: () => void;
    onPickFolder: () => void;
}

function DropZone({ isDragOver, onDrop, onPick, onPickFolder }: DropZoneProps) {
    const stop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    return (
        <div
            onDragOver={stop}
            onDragEnter={stop}
            onDragLeave={stop}
            onDrop={(e) => {
                stop(e);
                const files = Array.from(e.dataTransfer.files).filter((f) =>
                    SUPPORTED_TYPES.has(f.type),
                );
                if (files.length > 0) onDrop(files);
            }}
            className={cn(
                'flex min-h-[26rem] flex-col items-center justify-center gap-5 rounded-xl border border-dashed p-10 text-center transition-colors duration-150',
                isDragOver ? 'border-primary bg-primary/5' : 'border-input bg-card',
            )}
            aria-label="Drop zone for image upload"
        >
            <div
                className={cn(
                    'flex size-14 items-center justify-center rounded-full transition-colors duration-150',
                    isDragOver ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                )}
            >
                <ArrowUpFromLine className="size-6" />
            </div>
            <div className="space-y-1">
                <p className="text-base font-semibold text-foreground">
                    {isDragOver ? 'Drop images to add them' : 'Drop images here'}
                </p>
                <p className="text-sm text-muted-foreground">
                    or choose files or a whole folder from your computer
                </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
                <Button onClick={onPick}>
                    <FileIcon />
                    Select files
                    <span className="kbd ml-1 border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">
                        Ctrl O
                    </span>
                </Button>
                <Button variant="outline" onClick={onPickFolder}>
                    <FolderIcon />
                    Select folder
                </Button>
            </div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ImageIcon className="size-3.5" />
                .jpg · .png · .bmp · .tiff
                <span className="text-border">|</span>
                Max 20 MB per image
            </p>
        </div>
    );
}

// ── Run setup rail ───────────────────────────────────────────────────────────

function SettingRow({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3 text-xs">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono font-medium text-foreground tabular-nums">{value}</dd>
        </div>
    );
}

function SettingsSummary({
    organism,
    config,
    loading,
    mode,
}: {
    organism: Organism;
    config: EggConfig | LarvaeConfig | undefined;
    loading: boolean;
    mode: AnalysisMode;
}) {
    if (loading) {
        return (
            <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
            </div>
        );
    }
    if (!config) {
        return (
            <p className="text-xs text-muted-foreground">
                Could not read the server's settings. The run will use its current configuration.
            </p>
        );
    }
    const polygon = isPolygonOrganism(organism);
    const sam = polygon ? ((config as LarvaeConfig).sam?.enabled ?? true) : false;
    return (
        <dl className="space-y-1.5">
            <SettingRow label="Confidence" value={`≥ ${config.confidence_threshold.toFixed(2)}`} />
            <SettingRow label="Tile size" value={`${config.tile_size} px`} />
            <SettingRow label="Tile overlap" value={`${Math.round(config.overlap * 100)}%`} />
            {polygon && (
                <SettingRow
                    label="SAM refinement"
                    value={mode === 'count' ? 'Skipped' : sam ? 'On' : 'Off'}
                />
            )}
            <SettingRow label="Device" value={String(config.device).toUpperCase()} />
        </dl>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function UploadPage() {
    const navigate = useNavigate();
    const backTo = useBackTo();
    const queryClient = useQueryClient();
    const [searchParams] = useSearchParams();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);

    // ── What is this upload for? ────────────────────────────────────────────
    const appendBatchId = searchParams.get('batch');
    const appendQuery = useQuery({
        queryKey: ['analysis-detail', appendBatchId, { includeAnnotations: false }],
        enabled: Boolean(appendBatchId),
        queryFn: ({ signal }) =>
            getAnalysisDetail(appendBatchId as string, signal, { includeAnnotations: false }),
    });
    const appendBatch = appendQuery.data ?? null;

    const typeParam = searchParams.get('type') as Organism | null;
    const organism: Organism = (
        appendBatch?.organism_type && ORGANISMS.has(appendBatch.organism_type as Organism)
            ? appendBatch.organism_type
            : typeParam && ORGANISMS.has(typeParam)
              ? typeParam
              : 'egg'
    ) as Organism;
    const meta = organismMeta(organism);
    const polygon = isPolygonOrganism(organism);
    const captureMode = (searchParams.get('mode') ?? 'upload') as 'upload' | 'camera';
    const CaptureIcon = captureMode === 'camera' ? Camera : Upload;

    const storeProjectName = useProcessingStore((s) => s.projectName);
    const title = appendBatchId
        ? (appendBatch?.name ?? 'Batch')
        : (storeProjectName ?? 'Untitled project');

    const { modelsStatus } = useBoot();
    const modelStatus = modelsStatus[organism];
    const modelReady = modelStatus === undefined || modelStatus === 'loaded';

    // ── State ───────────────────────────────────────────────────────────────
    const [files, setFiles] = useState<FileEntry[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isDragOver, setIsDragOver] = useState(false);
    const [configOpen, setConfigOpen] = useState(false);
    const [page, setPage] = useState(1);
    const [gridColumns, setGridColumns] = useState(DEFAULT_GRID_COLUMNS);
    const [previewId, setPreviewId] = useState<string | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('count');
    const [uploadProgress, setUploadProgress] = useState<{
        current: number;
        total: number;
        currentName: string;
    } | null>(null);

    // The inference settings the server will use — shown in the rail.
    const configQuery = useQuery<EggConfig | LarvaeConfig>({
        queryKey: ['inference-config', organism],
        queryFn: ({ signal }) =>
            organism === 'larvae' || organism === 'pupae'
                ? getPolygonConfig(organism, signal)
                : getBboxConfig(organism, signal),
        enabled: !appendBatchId || appendBatch !== null,
        staleTime: 0,
    });

    const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
                e.preventDefault();
                openFilePicker();
            }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [openFilePicker]);

    // Window-level drag tracking so the whole page reacts, not just the zone.
    useEffect(() => {
        let depth = 0;
        const onDragEnter = (e: DragEvent) => {
            e.preventDefault();
            depth += 1;
            if (depth === 1) setIsDragOver(true);
        };
        const onDragLeave = (e: DragEvent) => {
            e.preventDefault();
            depth = Math.max(0, depth - 1);
            if (depth === 0) setIsDragOver(false);
        };
        const onDragOver = (e: DragEvent) => {
            e.preventDefault();
        };
        const onDrop = () => {
            depth = 0;
            setIsDragOver(false);
        };

        window.addEventListener('dragenter', onDragEnter);
        window.addEventListener('dragleave', onDragLeave);
        window.addEventListener('dragover', onDragOver);
        window.addEventListener('drop', onDrop);
        return () => {
            window.removeEventListener('dragenter', onDragEnter);
            window.removeEventListener('dragleave', onDragLeave);
            window.removeEventListener('dragover', onDragOver);
            window.removeEventListener('drop', onDrop);
        };
    }, []);

    const hasFiles = files.length > 0;

    // Measure the grid so a page holds a whole number of rows.
    useEffect(() => {
        const grid = gridRef.current;
        if (!grid) return;
        const update = () => {
            const width = grid.clientWidth;
            if (width <= 0) return;
            setGridColumns(
                Math.max(1, Math.floor((width + GRID_GAP_PX) / (THUMB_MIN_SIZE + GRID_GAP_PX))),
            );
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(grid);
        return () => observer.disconnect();
    }, [hasFiles]);

    async function addFiles(newFiles: File[]) {
        const valid = newFiles.filter((f) => SUPPORTED_TYPES.has(f.type));
        if (valid.length === 0) return;

        const total = valid.length;
        setUploadProgress({ current: 0, total, currentName: valid[0].name });

        const previews = await mapWithConcurrency(
            valid,
            THUMB_CONCURRENCY,
            (file) => makeThumbnail(file),
            (done) => {
                const idx = Math.min(done, total - 1);
                setUploadProgress({ current: done, total, currentName: valid[idx].name });
            },
        );

        setFiles((prev) => [
            ...prev,
            ...valid.map((file, i) => ({ id: genId(), file, previewUrl: previews[i] })),
        ]);
        setUploadProgress(null);
    }

    const removeFile = useCallback((id: string) => {
        setFiles((prev) => {
            const target = prev.find((f) => f.id === id);
            if (target) URL.revokeObjectURL(target.previewUrl);
            return prev.filter((f) => f.id !== id);
        });
        setSelectedIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    }, []);

    function removeSelected() {
        setFiles((prev) => {
            for (const f of prev) if (selectedIds.has(f.id)) URL.revokeObjectURL(f.previewUrl);
            return prev.filter((f) => !selectedIds.has(f.id));
        });
        setSelectedIds(new Set());
    }

    function clearAll() {
        setFiles((prev) => {
            for (const f of prev) URL.revokeObjectURL(f.previewUrl);
            return [];
        });
        setSelectedIds(new Set());
    }

    // Release all object URLs when this page unmounts so the browser can free
    // the underlying File refs. Downstream (processingSession) creates its own
    // object URLs for the chosen files, so revoking here is safe.
    const filesRef = useRef(files);
    useEffect(() => {
        filesRef.current = files;
    }, [files]);
    const previewUrlRef = useRef<string | null>(previewUrl);
    useEffect(() => {
        previewUrlRef.current = previewUrl;
    }, [previewUrl]);
    useEffect(() => {
        return () => {
            filesRef.current.forEach((f) => URL.revokeObjectURL(f.previewUrl));
            if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        };
    }, []);

    const toggleSelect = useCallback((id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    async function openFolderPicker() {
        // Prefer the File System Access API — it shows a single silent permission
        // prompt instead of the browser's "Upload N files to this site?" dialog
        // that <input webkitdirectory> triggers. Falls back to the legacy input
        // if the API isn't available (non-Chromium browsers / WebKit Tauri).
        const picker = (
            window as unknown as {
                showDirectoryPicker?: (opts?: {
                    mode?: 'read' | 'readwrite';
                }) => Promise<FileSystemDirectoryHandle>;
            }
        ).showDirectoryPicker;
        if (typeof picker !== 'function') {
            folderInputRef.current?.click();
            return;
        }
        try {
            const dir = await picker({ mode: 'read' });
            const collected: File[] = [];
            await collectFilesFromDirectory(dir, collected);
            if (collected.length > 0) await addFiles(collected);
            else toast.info('No supported images in that folder');
        } catch (err) {
            // User cancelled or permission denied — ignore.
            if ((err as DOMException)?.name !== 'AbortError') {
                console.warn('Folder picker failed:', err);
            }
        }
    }

    function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
        if (e.target.files) void addFiles(Array.from(e.target.files));
        e.target.value = '';
    }

    function handleProcess() {
        if (files.length === 0) return;
        const store = useProcessingStore.getState();
        if (store.isProcessing || isManagerRunning()) {
            toast.error('A batch is already processing', {
                description: 'Wait for the current batch to finish or cancel it first.',
                action: { label: 'View', onClick: () => navigate('/analyze/processing') },
            });
            return;
        }
        storeProcessingFiles(
            files.map((f) => ({ id: f.id, file: f.file })),
            organism,
            generateBatchId(),
        );
        storeAnalysisMode(polygon ? analysisMode : 'count');
        if (appendBatch) {
            storeAppendTarget({
                batchId: appendBatch.id,
                batchName: appendBatch.name,
                baseCount: appendBatch.images.length,
            });
            store.setProjectName(appendBatch.name);
            store.setOrganism(organism);
            // The batch's image list is about to change.
            void queryClient.invalidateQueries({ queryKey: ['analysis-detail', appendBatch.id] });
        } else {
            storeAppendTarget(null);
        }
        void startProcessingFromSession();
        // Replace: the file picker is spent once the run starts, so Back from
        // the run should not land on it.
        navigate('/analyze/processing', { replace: true });
    }

    const totalBytes = useMemo(() => files.reduce((sum, f) => sum + f.file.size, 0), [files]);
    const pageSize = Math.max(gridColumns * MAX_GRID_ROWS, 1);
    const pageCount = Math.max(1, Math.ceil(files.length / pageSize));
    const currentPage = Math.min(page, pageCount);
    const pageStart = (currentPage - 1) * pageSize;
    const pageEnd = Math.min(pageStart + pageSize, files.length);
    const pageFiles = useMemo(() => files.slice(pageStart, pageEnd), [files, pageStart, pageEnd]);
    const showAddMoreTile = currentPage === pageCount && pageFiles.length < pageSize;

    // Clamp page when files change (removals etc.)
    useEffect(() => {
        if (page > pageCount) setPage(pageCount);
    }, [page, pageCount]);

    // Names that already exist in the batch being appended to. The server
    // stores those as "<name>_2" rather than overwriting; say so up front.
    const duplicateNames = useMemo(() => {
        if (!appendBatch) return 0;
        const existing = new Set(appendBatch.images.map((img) => img.original_filename));
        return files.filter((f) => existing.has(stemOf(f.file.name))).length;
    }, [appendBatch, files]);

    const openPreview = useCallback((id: string) => {
        const entry = filesRef.current.find((f) => f.id === id);
        if (!entry) return;
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        // Create a fresh object URL for the ORIGINAL file — full quality, on demand.
        setPreviewUrl(URL.createObjectURL(entry.file));
        setPreviewId(id);
    }, []);

    function closePreview() {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
        setPreviewId(null);
    }

    const previewEntry = previewId ? (files.find((f) => f.id === previewId) ?? null) : null;

    // Back closes this screen: to the batch being extended (either of its
    // views), else to project setup.
    const goBack = () =>
        appendBatchId
            ? backTo(batchPath(appendBatchId), (path) => isBatchPagePath(path, appendBatchId))
            : backTo('/analyze');
    const appendBlocked = appendBatch?.status === 'processing';
    const canProcess = hasFiles && !uploadProgress && modelReady && !appendBlocked;
    const what = hasFiles ? `${files.length} ${pluralize(files.length, 'image')}` : 'images';
    const processLabel = appendBatchId
        ? `Add ${what} to batch`
        : polygon && analysisMode === 'count'
          ? `Count ${what}`
          : `Process ${what}`;

    // ── Append target could not be loaded ───────────────────────────────────
    if (appendBatchId && appendQuery.isError) {
        return (
            <div className="flex h-svh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
                <AlertTriangle className="size-8 text-destructive" aria-hidden />
                <div>
                    <p className="text-base font-semibold">This batch could not be opened</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                        It may have been deleted, or it belongs to another account.
                    </p>
                </div>
                <Button variant="outline" onClick={() => backTo('/recorded')}>
                    <ArrowLeft />
                    Back to Recorded
                </Button>
            </div>
        );
    }
    if (appendBatchId && !appendBatch) {
        return (
            <div className="flex h-svh items-center justify-center bg-background">
                <Spinner />
            </div>
        );
    }

    return (
        <div className="flex h-svh flex-col bg-background">
            {/* Hidden file inputs */}
            <input
                ref={fileInputRef}
                type="file"
                accept={[...SUPPORTED_TYPES].join(',')}
                multiple
                className="hidden"
                onChange={onFileInputChange}
            />
            <input
                ref={folderInputRef}
                type="file"
                // @ts-expect-error — non-standard but widely supported
                webkitdirectory=""
                directory=""
                multiple
                className="hidden"
                onChange={onFileInputChange}
            />

            {/* Top bar */}
            <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-border bg-card px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                    <Button
                        variant="outline"
                        size="icon-sm"
                        onClick={goBack}
                        aria-label={appendBatchId ? 'Back to batch' : 'Back to project setup'}
                    >
                        <ArrowLeft />
                    </Button>
                    <div className="min-w-0">
                        <p className="truncate text-sm font-semibold" title={title}>
                            {title}
                        </p>
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <CaptureIcon className="size-3" aria-hidden />
                            {appendBatchId
                                ? 'Adding images to an existing batch'
                                : captureMode === 'camera'
                                  ? 'Camera'
                                  : 'Upload'}
                        </p>
                    </div>
                    <OrganismBadge organism={organism} className="ml-1" />
                </div>
                <FlowSteps
                    current={2}
                    labels={appendBatchId ? ['Batch', 'Images', 'Review'] : undefined}
                    className="hidden md:flex"
                />
                <div />
            </header>

            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                {/* Images */}
                <main className="min-h-0 flex-1 overflow-y-auto">
                    <div className="mx-auto w-full max-w-6xl px-6 py-6">
                        <div className="mb-5">
                            <h1 className="text-2xl font-semibold tracking-tight">
                                {appendBatchId ? 'Add images' : 'Upload images'}
                            </h1>
                            <p className="mt-1 text-sm text-muted-foreground">
                                {appendBatchId ? (
                                    <>
                                        New images are analysed and added to{' '}
                                        <span className="font-medium text-foreground">
                                            {appendBatch?.name}
                                        </span>{' '}
                                        ({appendBatch?.images.length ?? 0} already in it). Existing
                                        results are left untouched.
                                    </>
                                ) : (
                                    <>
                                        Add the {meta.label.toLowerCase()} images you want to
                                        analyse. Drag and drop, pick files, or choose a folder.
                                    </>
                                )}
                            </p>
                        </div>

                        {uploadProgress && (
                            <div className="panel mb-4 px-4 py-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium">Preparing previews…</p>
                                        <p
                                            className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
                                            title={uploadProgress.currentName}
                                        >
                                            {uploadProgress.currentName}
                                        </p>
                                    </div>
                                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                                        {uploadProgress.current} / {uploadProgress.total}
                                    </span>
                                </div>
                                <Progress
                                    className="mt-2.5 h-1.5"
                                    value={
                                        (uploadProgress.current /
                                            Math.max(uploadProgress.total, 1)) *
                                        100
                                    }
                                />
                            </div>
                        )}

                        {!hasFiles && !uploadProgress && (
                            <DropZone
                                isDragOver={isDragOver}
                                onDrop={(dropped) => void addFiles(dropped)}
                                onPick={openFilePicker}
                                onPickFolder={() => void openFolderPicker()}
                            />
                        )}

                        {hasFiles && (
                            <div
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const dropped = Array.from(e.dataTransfer.files).filter((f) =>
                                        SUPPORTED_TYPES.has(f.type),
                                    );
                                    if (dropped.length > 0) void addFiles(dropped);
                                    setIsDragOver(false);
                                }}
                                className={cn(
                                    'panel overflow-hidden transition-colors duration-150',
                                    isDragOver && 'border-primary bg-primary/5',
                                )}
                            >
                                {/* Toolbar */}
                                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
                                    {selectedIds.size > 0 ? (
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium">
                                                {selectedIds.size} selected
                                            </span>
                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                onClick={removeSelected}
                                            >
                                                <Trash2 />
                                                Remove
                                            </Button>
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => setSelectedIds(new Set())}
                                            >
                                                Clear selection
                                            </Button>
                                        </div>
                                    ) : (
                                        <p className="text-sm">
                                            <span className="font-semibold tabular-nums">
                                                {files.length}
                                            </span>{' '}
                                            {pluralize(files.length, 'image')}
                                            <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                                                {formatBytes(totalBytes)}
                                            </span>
                                        </p>
                                    )}
                                    <div className="flex items-center gap-1">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={openFilePicker}
                                        >
                                            <FileIcon />
                                            Add files
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => void openFolderPicker()}
                                        >
                                            <FolderIcon />
                                            Add folder
                                        </Button>
                                        <Button variant="secondary" size="sm" onClick={clearAll}>
                                            Clear all
                                        </Button>
                                    </div>
                                </div>

                                {/* Thumbnails — responsive square tiles that fill each row */}
                                <div
                                    ref={gridRef}
                                    className="grid grid-cols-[repeat(auto-fill,minmax(116px,1fr))] items-start gap-3 p-4"
                                >
                                    {pageFiles.map((entry) => (
                                        <Tile
                                            key={entry.id}
                                            entry={entry}
                                            selected={selectedIds.has(entry.id)}
                                            onRemove={removeFile}
                                            onOpen={openPreview}
                                            onToggleSelect={toggleSelect}
                                        />
                                    ))}
                                    {showAddMoreTile && <AddMoreTile onClick={openFilePicker} />}
                                </div>

                                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground">
                                    <span className="tabular-nums">
                                        {pageCount > 1
                                            ? `Showing ${pageStart + 1}–${pageEnd} of ${files.length}`
                                            : 'Drop more images anywhere on this panel'}
                                    </span>
                                    {pageCount > 1 && (
                                        <div>
                                            <PaginationBar
                                                page={currentPage}
                                                pageCount={pageCount}
                                                onChange={setPage}
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </main>

                {/* Run setup */}
                <aside className="flex w-full shrink-0 flex-col border-t border-border bg-card lg:w-[340px] lg:border-t-0 lg:border-l">
                    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
                        {polygon && (
                            <section className="space-y-3">
                                <h2 className="eyebrow">Analysis</h2>
                                <AnalysisModePicker
                                    value={analysisMode}
                                    onChange={setAnalysisMode}
                                />
                            </section>
                        )}

                        <section className="space-y-3">
                            <div className="flex items-center justify-between">
                                <h2 className="eyebrow">Inference settings</h2>
                                <Button
                                    variant="outline"
                                    size="xs"
                                    onClick={() => setConfigOpen(true)}
                                    aria-label="Open inference settings"
                                >
                                    <Settings2 />
                                    Edit
                                </Button>
                            </div>
                            <SettingsSummary
                                organism={organism}
                                config={configQuery.data}
                                loading={
                                    configQuery.isPending && configQuery.fetchStatus !== 'idle'
                                }
                                mode={analysisMode}
                            />
                        </section>

                        {!modelReady && (
                            <div className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground">
                                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                                <p>
                                    The {meta.label.toLowerCase()} model isn't loaded on the server,
                                    so this run can't start. Install or assign a model on the Models
                                    page.
                                </p>
                            </div>
                        )}
                        {appendBlocked && (
                            <div className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground">
                                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                                <p>
                                    This batch is processing right now. Wait for it to finish first.
                                </p>
                            </div>
                        )}
                        {duplicateNames > 0 && (
                            <div className="flex gap-2.5 rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                                <ImagePlus className="mt-0.5 size-4 shrink-0" />
                                <p>
                                    {duplicateNames} {pluralize(duplicateNames, 'file')}{' '}
                                    {duplicateNames === 1 ? 'shares its name' : 'share their names'}{' '}
                                    with images already in this batch. They'll be added as new
                                    images (name ending in “_2”), not replace the existing ones.
                                </p>
                            </div>
                        )}
                    </div>

                    <div className="shrink-0 space-y-3 border-t border-border p-5">
                        <dl className="space-y-1 text-xs">
                            <div className="flex justify-between">
                                <dt className="text-muted-foreground">Images</dt>
                                <dd className="font-medium tabular-nums">{files.length}</dd>
                            </div>
                            <div className="flex justify-between">
                                <dt className="text-muted-foreground">Total size</dt>
                                <dd className="font-medium tabular-nums">
                                    {formatBytes(totalBytes)}
                                </dd>
                            </div>
                        </dl>
                        <Button
                            className="w-full"
                            size="lg"
                            disabled={!canProcess}
                            onClick={handleProcess}
                        >
                            {processLabel}
                            <ArrowRight />
                        </Button>
                    </div>
                </aside>
            </div>

            {polygon ? (
                <LarvaeConfigPanel
                    open={configOpen}
                    onOpenChange={setConfigOpen}
                    organism={organism as 'larvae' | 'pupae'}
                    onSaved={(cfg) => queryClient.setQueryData(['inference-config', organism], cfg)}
                />
            ) : (
                <ConfigPanel
                    open={configOpen}
                    onOpenChange={setConfigOpen}
                    organism={organism as 'egg' | 'neonate'}
                    onSaved={() =>
                        void queryClient.invalidateQueries({
                            queryKey: ['inference-config', organism],
                        })
                    }
                />
            )}

            {/* Full-quality preview dialog — loads the ORIGINAL file on demand. */}
            <Dialog
                open={previewEntry !== null}
                onOpenChange={(open) => {
                    if (!open) closePreview();
                }}
            >
                <DialogContent className="max-w-5xl overflow-hidden p-0 sm:max-w-5xl">
                    <DialogTitle className="sr-only">
                        {previewEntry?.file.name ?? 'Image preview'}
                    </DialogTitle>
                    {previewEntry && previewUrl && (
                        <div className="flex flex-col">
                            <div className="canvas-grid flex max-h-[80vh] items-center justify-center overflow-auto p-2">
                                <img
                                    src={previewUrl}
                                    alt={previewEntry.file.name}
                                    className="max-h-[78vh] w-auto object-contain"
                                />
                            </div>
                            <div className="flex items-center justify-between gap-3 border-t border-border bg-card px-5 py-3 text-xs">
                                <span className="truncate font-mono" title={previewEntry.file.name}>
                                    {previewEntry.file.name}
                                </span>
                                <span className="shrink-0 text-muted-foreground tabular-nums">
                                    {formatBytes(previewEntry.file.size)}
                                </span>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
