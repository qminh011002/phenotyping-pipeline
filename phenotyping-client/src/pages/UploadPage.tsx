import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Upload,
  X,
  Plus,
  Settings,
  Check,
  ArrowLeft,
  ArrowUpFromLine,
  FileIcon,
  FolderIcon,
  Image as ImageIcon,
  Camera,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { storeProcessingFiles, generateBatchId } from "@/features/upload/lib/processingSession";
import { useProcessingStore } from "@/stores/processingStore";
import { startProcessingFromSession, isManagerRunning } from "@/services/processingManager";
import { ConfigPanel } from "@/features/upload/components/ConfigPanel";
import { cn } from "@/lib/utils";

interface FileEntry {
  id: string;
  file: File;
  previewUrl: string;
}

const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/tiff", "image/tif", "image/bmp"]);

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function genId() {
  return Math.random().toString(36).slice(2);
}

async function fileToPreview(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Thumbnail ─────────────────────────────────────────────────────────────────

interface ThumbnailProps {
  entry: FileEntry;
  onRemove: (id: string) => void;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
  anySelected?: boolean;
}

function Thumbnail({ entry, onRemove, isSelected, onToggleSelect, anySelected }: ThumbnailProps) {
  return (
    <div className="group relative flex flex-col items-center gap-1">
      <div
        className={cn(
          "relative h-[120px] w-[120px] overflow-hidden rounded-md border bg-muted transition-shadow duration-200 hover:shadow-md",
          isSelected
            ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
            : "border-border",
        )}
      >
        <img
          src={entry.previewUrl}
          alt={entry.file.name}
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
          loading="lazy"
        />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(entry.id); }}
          className="absolute right-1 top-1 rounded-md bg-black/60 p-1 text-white opacity-0 transition-opacity duration-150 hover:bg-black/80 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
          aria-label={`Remove ${entry.file.name}`}
        >
          <X className="h-3 w-3" />
        </button>
        {(anySelected || isSelected) && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleSelect?.(entry.id); }}
            className={cn(
              "absolute left-1 top-1 rounded border-2 p-0.5 transition-all duration-150",
              isSelected
                ? "border-primary bg-primary text-primary-foreground opacity-100"
                : "border-white/60 bg-black/30 text-white opacity-0 group-hover:opacity-100 hover:border-white/80",
            )}
            aria-label={isSelected ? "Deselect image" : "Select image"}
          >
            {isSelected && <Check className="h-2.5 w-2.5" />}
          </button>
        )}
      </div>
      <span className="max-w-[120px] truncate text-xs text-muted-foreground" title={entry.file.name}>
        {entry.file.name}
      </span>
    </div>
  );
}

function AddMoreCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[148px] w-[120px] flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label="Add more images"
    >
      <Plus className="h-6 w-6" />
      <span className="text-xs">Add more</span>
    </button>
  );
}

// ── Drop Zone (empty state) ──────────────────────────────────────────────────

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

  const onDrop_ = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files).filter((f) => SUPPORTED_TYPES.has(f.type));
      if (files.length > 0) onDrop(files);
    },
    [onDrop],
  );

  return (
    <div
      onDragOver={stop}
      onDragEnter={stop}
      onDragLeave={stop}
      onDrop={onDrop_}
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-16 text-center transition-all duration-200 ease-out",
        isDragOver
          ? "border-primary bg-primary/5 text-primary"
          : "border-muted-foreground/30 text-muted-foreground",
      )}
      aria-label="Drop zone for image upload"
    >
      <div className="rounded-full bg-muted p-4">
        <ArrowUpFromLine className="h-7 w-7 text-foreground" />
      </div>
      <div>
        <p className="text-base font-medium text-foreground">
          {isDragOver ? "Drop images here" : "Drag and drop file(s) to upload, or:"}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={onPick}>
          <FileIcon className="mr-2 h-4 w-4" />
          Select File(s)
        </Button>
        <Button variant="outline" onClick={onPickFolder}>
          <FolderIcon className="mr-2 h-4 w-4" />
          Select Folder
        </Button>
      </div>
      <div className="mt-2">
        <p className="mb-2 text-xs text-muted-foreground">Supported Formats</p>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-md border bg-muted/30 px-4 py-2 text-xs">
          <span className="flex items-center gap-1">
            <ImageIcon className="h-3.5 w-3.5" />
            <span className="font-medium">Images</span>
            <span className="text-muted-foreground">.jpg, .png, .bmp, .tiff</span>
          </span>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">*Max size of 20MB per image.</p>
      </div>
    </div>
  );
}

export default function UploadPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const organism = (searchParams.get("type") ?? "egg") as string;
  const organismLabel = organism.charAt(0).toUpperCase() + organism.slice(1);
  const mode = (searchParams.get("mode") ?? "upload") as "upload" | "camera";
  const modeLabel = mode === "camera" ? "Camera" : "Upload";
  const ModeIcon = mode === "camera" ? Camera : Upload;

  const projectName = useProcessingStore((s) => s.projectName);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDragOver, setIsDragOver] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<
    { current: number; total: number; currentName: string } | null
  >(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        openFilePicker();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => { e.preventDefault(); setIsDragOver(true); };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      if (e.relatedTarget === null) setIsDragOver(false);
    };
    const onDragOver = (e: DragEvent) => { e.preventDefault(); };
    const onDrop = () => setIsDragOver(false);

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  async function addFiles(newFiles: File[]) {
    const valid = newFiles.filter((f) => SUPPORTED_TYPES.has(f.type));
    if (valid.length === 0) return;

    const total = valid.length;
    setUploadProgress({ current: 0, total, currentName: valid[0].name });

    const entries: FileEntry[] = [];
    for (let i = 0; i < valid.length; i++) {
      const file = valid[i];
      const previewUrl = await fileToPreview(file);
      entries.push({ id: genId(), file, previewUrl });
      setUploadProgress({ current: i + 1, total, currentName: file.name });
    }

    setFiles((prev) => [...prev, ...entries]);
    setUploadProgress(null);
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function openFolderPicker() {
    folderInputRef.current?.click();
  }

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = "";
  }

  function handleProcess() {
    if (files.length === 0) return;
    const store = useProcessingStore.getState();
    if (store.isProcessing || isManagerRunning()) {
      toast.error("A batch is already processing", {
        description: "Wait for the current batch to finish or cancel it first.",
        action: { label: "View", onClick: () => navigate("/analyze/processing") },
      });
      return;
    }
    const batchId = generateBatchId();
    storeProcessingFiles(
      files.map((f) => ({ id: f.id, file: f.file })),
      organism,
      batchId,
    );
    void startProcessingFromSession();
    navigate("/analyze/processing");
  }

  const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
  const hasFiles = files.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept={[...SUPPORTED_TYPES].join(",")}
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

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 py-8">
          {/* Breadcrumb: project name · mode */}
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <button
                type="button"
                onClick={() => navigate("/analyze")}
                className="flex items-center gap-1 transition-colors hover:text-foreground"
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <span className="font-medium text-foreground">{projectName ?? "Untitled Project"}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="flex items-center gap-1">
                <ModeIcon className="h-3.5 w-3.5" />
                {modeLabel}
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span>{organismLabel}</span>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setConfigOpen(true)}
              aria-label="Open inference settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>

          {/* Title */}
          <h1 className="mb-6 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ArrowUpFromLine className="h-6 w-6" />
            Upload
          </h1>

          {/* Upload progress bar */}
          {uploadProgress && (
            <div className="mb-6 rounded-lg border bg-muted/30 px-6 py-5">
              <div className="flex flex-col items-center gap-2">
                <p className="text-base font-semibold text-primary">Processing files…</p>
                <p
                  className="max-w-full truncate font-mono text-xs text-muted-foreground"
                  title={uploadProgress.currentName}
                >
                  {uploadProgress.currentName}
                </p>
              </div>
              <Progress
                className="mt-4"
                value={(uploadProgress.current / Math.max(uploadProgress.total, 1)) * 100}
              />
              <p className="mt-2 text-right text-xs text-muted-foreground tabular-nums">
                {uploadProgress.current} / {uploadProgress.total}
              </p>
            </div>
          )}

          {/* Empty state — big drop zone */}
          {!hasFiles && !uploadProgress && (
            <DropZone
              isDragOver={isDragOver}
              onDrop={addFiles}
              onPick={openFilePicker}
              onPickFolder={openFolderPicker}
            />
          )}

          {/* With files — compact strip + left-aligned grid */}
          {hasFiles && (
            <div
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const dropped = Array.from(e.dataTransfer.files).filter((f) => SUPPORTED_TYPES.has(f.type));
                if (dropped.length > 0) addFiles(dropped);
                setIsDragOver(false);
              }}
              className={cn(
                "rounded-lg border transition-colors",
                isDragOver ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              {/* Compact header strip */}
              <div className="flex flex-wrap items-start justify-between gap-4 border-b bg-muted/30 px-5 py-4">
                <div className="flex flex-col gap-1">
                  <h2 className="text-base font-semibold">
                    Drag and drop images to upload.
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <ImageIcon className="h-3.5 w-3.5" />
                      .jpg, .png, .bmp, .tiff
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    *Max size of 20MB per image.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={openFilePicker}>
                    <FileIcon className="mr-2 h-4 w-4" />
                    Select Files
                  </Button>
                  <Button variant="outline" size="sm" onClick={openFolderPicker}>
                    <FolderIcon className="mr-2 h-4 w-4" />
                    Select Folder
                  </Button>
                  <Button size="sm" onClick={handleProcess}>
                    Process Images
                    <svg className="ml-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                  </Button>
                </div>
              </div>

              {/* Thumbnails — left aligned */}
              <div className="flex flex-wrap justify-start gap-4 p-6">
                {files.map((entry) => (
                  <Thumbnail
                    key={entry.id}
                    entry={entry}
                    onRemove={removeFile}
                    isSelected={selectedIds.has(entry.id)}
                    onToggleSelect={toggleSelect}
                    anySelected={selectedIds.size > 0}
                  />
                ))}
                <AddMoreCard onClick={openFilePicker} />
              </div>

              {/* Footnote */}
              <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-muted-foreground">
                <span>
                  {files.length} image{files.length !== 1 ? "s" : ""} · {formatBytes(totalBytes)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfigPanel open={configOpen} onOpenChange={setConfigOpen} />
    </div>
  );
}
