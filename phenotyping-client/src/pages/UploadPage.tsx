// Upload page — drop zone, thumbnail grid, file management, and Process.
//
// Flow (from ui-ux-design.mdc):
//   • Drop zone: dashed border, changes color on drag hover
//   • After files added: drop zone shrinks, grid of thumbnails appears
//   • Each thumbnail: 120×120, shows image, filename below, ✕ button on hover
//   • [+] card at end of grid to add more files
//   • Footer bar: file count + total size on left, Process button on right
//   • Config gear: opens Sheet from right side

import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Upload, X, Plus, Settings, FileImage, Microscope, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { storeProcessingFiles, generateBatchId } from "@/features/upload/lib/processingSession";
import { useProcessingStore } from "@/stores/processingStore";
import { startProcessingFromSession, isManagerRunning } from "@/services/processingManager";
import { ConfigPanel } from "@/features/upload/components/ConfigPanel";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

interface FileEntry {
  id: string;
  file: File;
  previewUrl: string;
}

const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/tiff", "image/tif", "image/bmp"]);

// ── Helpers ────────────────────────────────────────────────────────────────────

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
      {/* Image */}
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
        {/* Remove button */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(entry.id); }}
          className="absolute right-1 top-1 rounded-md bg-black/60 p-1 text-white opacity-0 transition-opacity duration-150 hover:bg-black/80 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
          aria-label={`Remove ${entry.file.name}`}
        >
          <X className="h-3 w-3" />
        </button>
        {/* Selection checkbox */}
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
      {/* Filename */}
      <span className="max-w-[120px] truncate text-xs text-muted-foreground" title={entry.file.name}>
        {entry.file.name}
      </span>
    </div>
  );
}

// ── Add-more card ─────────────────────────────────────────────────────────────

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

// ── Drop Zone ─────────────────────────────────────────────────────────────────

interface DropZoneProps {
  isDragOver: boolean;
  onDrop: (files: File[]) => void;
  onPick: () => void;
}

function DropZone({ isDragOver, onDrop, onPick }: DropZoneProps) {
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
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
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop_}
      onClick={onPick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } }}
      className={cn(
        "rounded-xl border-2 border-dashed p-12 text-center transition-all duration-200 ease-out cursor-pointer",
        "hover:bg-muted/40 hover:border-muted-foreground/40",
        "focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-2",
        isDragOver
          ? "border-primary bg-primary/5 text-primary scale-[1.01] shadow-md"
          : "border-muted-foreground/40 text-muted-foreground",
      )}
      aria-label="Drop zone for image upload"
    >
      <div className="rounded-full bg-muted p-4">
        <Upload className="h-8 w-8" />
      </div>
      <div className="mt-4">
        <p className="text-sm font-medium">
          {isDragOver ? "Drop images here" : "Drop images here or click to browse"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Supports: JPG, PNG, TIFF, BMP</p>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const organism = (searchParams.get("type") ?? "egg") as string;
  const organismLabel = organism.charAt(0).toUpperCase() + organism.slice(1);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDragOver, setIsDragOver] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  // ── Drag state ──────────────────────────────────────────────────────────────

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

  // Track drag-over on the whole page (drop zone + thumbnails area)
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      setIsDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      // Only clear when leaving the window entirely
      if (e.relatedTarget === null) setIsDragOver(false);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
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

  // ── File helpers ────────────────────────────────────────────────────────────

  async function addFiles(newFiles: File[]) {
    const valid = newFiles.filter((f) => SUPPORTED_TYPES.has(f.type));
    const previews = await Promise.all(valid.map((f) => fileToPreview(f)));
    const entries: FileEntry[] = valid.map((file, i) => ({
      id: genId(),
      file,
      previewUrl: previews[i],
      status: "pending",
    }));
    setFiles((prev) => [...prev, ...entries]);
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

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = "";
  }

  // ── Processing ──────────────────────────────────────────────────────────────

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
    // Kick the manager off; navigate immediately so the user is never blocked.
    void startProcessingFromSession();
    navigate("/analyze/processing");
  }

  // ── Computed ────────────────────────────────────────────────────────────────

  const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
  const hasFiles = files.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={[...SUPPORTED_TYPES].join(",")}
        multiple
        className="hidden"
        onChange={onFileInputChange}
      />

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Go back"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <Microscope className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">{organismLabel} Analysis — Upload Images</h1>
          </div>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setConfigOpen(true)}
          aria-label="Open inference settings"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </header>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Drop zone — visible when no files */}
        {!hasFiles && (
          <div className="mx-auto max-w-lg">
            <DropZone
              isDragOver={isDragOver}
              onDrop={addFiles}
              onPick={openFilePicker}
            />
          </div>
        )}

        {/* Thumbnail grid + drop zone fallback when has files */}
        {hasFiles && (
          <div className="space-y-4">
            {/* Compact drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const dropped = Array.from(e.dataTransfer.files).filter((f) => SUPPORTED_TYPES.has(f.type));
                if (dropped.length > 0) addFiles(dropped);
                setIsDragOver(false);
              }}
            >
              <DropZone
                isDragOver={isDragOver}
                onDrop={addFiles}
                onPick={openFilePicker}
              />
            </div>

            {/* Thumbnails */}
            <div className="flex flex-wrap gap-4">
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
          </div>
        )}
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="flex items-center justify-between border-t px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileImage className="h-4 w-4" />
          <span>
            {files.length === 0
              ? "No images selected"
              : `${files.length} image${files.length !== 1 ? "s" : ""} · ${formatBytes(totalBytes)}`}
          </span>
        </div>
        <Button
          onClick={handleProcess}
          disabled={!hasFiles}
        >
          Process Images
          <svg className="ml-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </Button>
      </footer>

      {/* ── Config Panel ───────────────────────────────────────────────── */}
      <ConfigPanel
        open={configOpen}
        onOpenChange={setConfigOpen}
      />
    </div>
  );
}
