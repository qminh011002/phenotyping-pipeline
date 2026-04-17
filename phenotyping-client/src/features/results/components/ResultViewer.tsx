// ResultViewer — full page for viewing inference results.
// Renders the RAW uploaded image (from the browser blob URL stored in
// sessionStorage) with client-side bbox overlays drawn from
// result.annotations. The backend-generated overlay PNG is only used
// for the Download button — never displayed.
//
// Annotation Editor (FS-009):
// - "Edit" toggle in header activates the AnnotationEditor slot.
// - Edit mode: boxes are rendered by AnnotationEditor (not OverlayImage's SVG).
// - User-drawn boxes are NOT filtered by confidence threshold.
// - Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo.
// - D toggles draw mode; Escape cancels/deselects.
// - Save edits persists to DB; Reset-to-model clears with confirmation.

import { useState, useEffect, useCallback, useMemo, useReducer } from "react";
import { useNavigate } from "react-router-dom";
import { Download, ArrowLeft, Save, Pencil, PencilOff, RotateCcw, Undo2, Redo2, Plus, Eye, Hand } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/common/EmptyState";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { OverlayImage } from "./OverlayImage";
import { AnnotationEditor } from "./AnnotationEditor";
import { StatBoard } from "./StatBoard";
import { ResultNavigation } from "./ResultNavigation";
import type { BBox, DetectionResult } from "@/types/api";
import {
  loadProcessingResults,
  loadProcessingFiles,
  loadBatchSummary,
  loadBatchDetail,
  loadProcessingConfig,
  storeBatchDetail,
} from "@/features/upload/lib/processingSession";
import { getAnalysesOverlayUrl, getAnalysesRawUrl, getAnalysisDetail, putEditedAnnotations, renameBatch, resetEditedAnnotations } from "@/services/api";
import { InlineEditableText } from "@/components/common/InlineEditableText";
import { cn } from "@/lib/utils";
import { editorHistoryReducer, canUndo, canRedo } from "../lib/editorHistory";
import { boxesEqual } from "../lib/bboxMath";

interface ResultViewerProps {
  className?: string;
}

export function ResultViewer({ className }: ResultViewerProps) {
  const navigate = useNavigate();

  const [results, setResults] = useState<DetectionResult[]>([]);
  const [rawUrlByName, setRawUrlByName] = useState<Record<string, string>>({});
  const [batchDetail, setBatchDetail] = useState<ReturnType<typeof loadBatchDetail>>(null);
  const [processingConfig, setProcessingConfig] = useState<Record<string, unknown> | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [batchSummary] = useState(() => loadBatchSummary());
  const [loading, setLoading] = useState(true);
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(0);
  const [imgW, setImgW] = useState(0);
  const [imgH, setImgH] = useState(0);

  // ── Editor state (FS-009) ─────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  /**
   * Active tool within edit mode.
   * - "drag": the unified Drag tool — click a box to select it, drag its body
   *   to move, drag a corner/side handle to resize, drag empty area to pan,
   *   click empty area to deselect.
   * - "draw": rubber-band a new box; pan disabled.
   */
  const [editorTool, setEditorTool] = useState<"drag" | "draw">("drag");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [history, dispatchHistory] = useReducer(editorHistoryReducer, {
    past: [],
    present: [],
    future: [],
  });
  const [savingEdits, setSavingEdits] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [dirtyNavDialogOpen, setDirtyNavDialogOpen] = useState(false);
  /** Index the user wants to navigate to while dirty */
  const [pendingNavIdx, setPendingNavIdx] = useState<number | null>(null);
  /** Ctrl/Cmd held — in non-edit mode this temporarily hides the dim overlay. */
  const [ctrlHeld, setCtrlHeld] = useState(false);

  // Load results, raw file URLs, and batch detail
  useEffect(() => {
    const stored = loadProcessingResults();
    const storedDetail = loadBatchDetail();
    const storedConfig = loadProcessingConfig();
    const storedFiles = loadProcessingFiles();
    if (stored.length === 0) {
      navigate("/", { replace: true });
      return;
    }
    setResults(stored.map((r) => r.result));
    setBatchDetail(storedDetail);
    setProcessingConfig(storedConfig);
    setRawUrlByName(
      Object.fromEntries(storedFiles.map((f) => [f.name, f.blobUrl])),
    );
    setLoading(false);
  }, [navigate]);

  const currentResult = results[currentIndex] ?? null;

  // ── Image record lookup ─────────────────────────────────────────────────
  const currentImageRecord = useMemo(() => {
    if (!currentResult || !batchDetail) return null;
    return batchDetail.images.find(
      (img) => img.original_filename === currentResult.filename,
    ) ?? null;
  }, [currentResult, batchDetail]);

  // ── Effective boxes (edited vs model) ───────────────────────────────────
  const modelBoxes = useMemo(() => currentResult?.annotations ?? [], [currentResult]);
  const editedBoxes = useMemo(() => currentImageRecord?.edited_annotations ?? null, [currentImageRecord]);

  /** The "true" baseline — edited if saved, otherwise model. */
  const baselineBoxes = useMemo((): BBox[] => {
    return editedBoxes ?? modelBoxes;
  }, [editedBoxes, modelBoxes]);

  /** History boxes (in-session edits, uncommitted). */
  const sessionBoxes = history.present;

  /** Boxes to render in view mode (filtered). Edit mode renders inside the editor. */
  const viewBoxes = useMemo((): BBox[] => {
    // View mode shows the persisted baseline (edited if saved, otherwise model),
    // with the confidence threshold applied to model-origin boxes only.
    return baselineBoxes.filter(
      (b) => b.origin === "user" || b.confidence >= confidenceThreshold,
    );
  }, [baselineBoxes, confidenceThreshold]);

  // ── Sync session boxes when image changes ───────────────────────────────
  useEffect(() => {
    setSelectedIdx(null);
    setEditorTool("drag");
    dispatchHistory({ type: "reset", boxes: baselineBoxes });
  }, [currentIndex, baselineBoxes]);

  // ── isDirty ─────────────────────────────────────────────────────────────
  const isDirty = useMemo(
    () => !boxesEqual(sessionBoxes, baselineBoxes),
    [sessionBoxes, baselineBoxes],
  );

  // ── Navigate with dirty guard ───────────────────────────────────────────
  const handleNavigate = useCallback(
    (index: number) => {
      if (isDirty) {
        setPendingNavIdx(index);
        setDirtyNavDialogOpen(true);
        return;
      }
      setCurrentIndex(index);
    },
    [isDirty],
  );

  const confirmDirtyNav = useCallback(() => {
    setDirtyNavDialogOpen(false);
    if (pendingNavIdx !== null) {
      setCurrentIndex(pendingNavIdx);
      setPendingNavIdx(null);
    }
  }, [pendingNavIdx]);

  const cancelDirtyNav = useCallback(() => {
    setDirtyNavDialogOpen(false);
    setPendingNavIdx(null);
  }, []);

  // ── Save edits ──────────────────────────────────────────────────────────
  const handleSaveEdits = useCallback(async () => {
    if (!batchDetail || !currentImageRecord || !isDirty) return;
    setSavingEdits(true);
    try {
      await putEditedAnnotations(batchDetail.id, currentImageRecord.id, sessionBoxes);
      // Refresh batch detail from server
      const updated = await getAnalysisDetail(batchDetail.id);
      setBatchDetail(updated);
      // Reset history to the new saved baseline — no undo past this point.
      dispatchHistory({ type: "reset", boxes: sessionBoxes });
      toast.success("Edits saved");
    } catch {
      toast.error("Failed to save edits");
    } finally {
      setSavingEdits(false);
    }
  }, [batchDetail, currentImageRecord, isDirty, sessionBoxes]);

  // ── Reset to model ──────────────────────────────────────────────────────
  const handleResetToModel = useCallback(async () => {
    if (!batchDetail || !currentImageRecord) return;
    setResetDialogOpen(false);
    try {
      await resetEditedAnnotations(batchDetail.id, currentImageRecord.id);
      const updated = await getAnalysisDetail(batchDetail.id);
      setBatchDetail(updated);
      dispatchHistory({ type: "reset", boxes: modelBoxes });
      setSelectedIdx(null);
      toast.success("Reset to model output");
    } catch {
      toast.error("Failed to reset");
    }
  }, [batchDetail, currentImageRecord, modelBoxes]);

  // ── Editor changes ──────────────────────────────────────────────────────
  // Called once per finished gesture (drag-end / commit). The editor handles
  // its own transient drag state internally so we don't pollute history.
  const handleEditorCommit = useCallback(
    (newBoxes: BBox[]) => {
      dispatchHistory({ type: "apply", boxes: newBoxes });
    },
    [],
  );

  // ── Ctrl/Cmd-hold → reveal raw image (non-edit mode only) ─────────────
  useEffect(() => {
    const update = (e: KeyboardEvent) => setCtrlHeld(e.ctrlKey || e.metaKey);
    const clear = () => setCtrlHeld(false);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  useEffect(() => {
    if (!editMode) return;

    function onKeyDown(e: KeyboardEvent) {
      const inputFocused =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (inputFocused) return;

      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (selectedIdx !== null) {
          const next = sessionBoxes.filter((_, i) => i !== selectedIdx);
          dispatchHistory({ type: "apply", boxes: next });
          setSelectedIdx(null);
        }
        return;
      }

      if (mod && e.shiftKey && e.key === ("z" as unknown as KeyboardEvent["key"])) {
        e.preventDefault();
        dispatchHistory({ type: "redo" });
        setSelectedIdx(null);
        return;
      }

      if (mod && e.key === "z") {
        e.preventDefault();
        dispatchHistory({ type: "undo" });
        setSelectedIdx(null);
        return;
      }

      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        setEditorTool((t) => (t === "draw" ? "drag" : "draw"));
        setSelectedIdx(null);
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        if (editorTool !== "drag") {
          setEditorTool("drag");
        } else {
          setSelectedIdx(null);
        }
        return;
      }

      if (mod && e.key === "s") {
        e.preventDefault();
        if (isDirty && !savingEdits) handleSaveEdits();
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editMode, selectedIdx, sessionBoxes, editorTool, isDirty, savingEdits, handleSaveEdits]);

  // ── Enter/exit edit mode ────────────────────────────────────────────────
  const handleToggleEdit = useCallback(() => {
    if (editMode && isDirty) {
      toast.warning("Save or discard your edits before exiting edit mode");
      return;
    }
    setEditMode((v) => !v);
    setEditorTool("drag");
    setSelectedIdx(null);
  }, [editMode, isDirty]);

  // ── Overlay download URL ─────────────────────────────────────────────────
  const overlayDownloadSrc = useMemo(() => {
    if (!currentResult || !batchDetail) return "";
    const imageRecord = currentImageRecord;
    if (!imageRecord || !imageRecord.overlay_path) return "";
    return getAnalysesOverlayUrl(batchDetail.id, imageRecord.id);
  }, [currentResult, batchDetail, currentImageRecord]);

  // ── Raw image URL ───────────────────────────────────────────────────────
  const rawSrc = useMemo(() => {
    if (!currentResult) return "";
    if (batchDetail) {
      const imageRecord = currentImageRecord;
      if (imageRecord) return getAnalysesRawUrl(batchDetail.id, imageRecord.id);
    }
    return rawUrlByName[currentResult.filename] ?? "";
  }, [currentResult, batchDetail, currentImageRecord, rawUrlByName]);

  // ── StatBoard visible annotations ───────────────────────────────────────
  const visibleAnnotations = useMemo((): BBox[] => {
    const source = editMode ? sessionBoxes : baselineBoxes;
    return source.filter(
      (b) => b.origin === "user" || b.confidence >= confidenceThreshold,
    );
  }, [editMode, sessionBoxes, baselineBoxes, confidenceThreshold]);

  // ── Undo/redo availability ───────────────────────────────────────────────
  const undoAvailable = canUndo(history);
  const redoAvailable = canRedo(history);

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <div className="flex items-center gap-3 text-muted-foreground">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span>Loading results…</span>
        </div>
      </div>
    );
  }

  if (!currentResult) {
    return (
      <div className={cn("flex h-full flex-col", className)}>
        <EmptyState
          icon={Download}
          title="No results found"
          description="The session data may have expired. Start a new analysis to see results."
          actionLabel="Start New Analysis"
          onAction={() => navigate("/")}
        />
      </div>
    );
  }

  const isBatch = results.length > 1;

  return (
    <div className={cn("flex h-full flex-col", className)}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (isDirty) {
                setPendingNavIdx(-1); // -1 signals "back"
                setDirtyNavDialogOpen(true);
              } else {
                navigate("/");
              }
            }}
            title="Back to home"
            className="h-8 w-8"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>

          {/* Batch name — inline editable; available the moment processing finishes. */}
          {batchDetail && (
            <h1 className="text-lg font-semibold">
              <InlineEditableText
                value={batchDetail.name}
                onSave={async (next) => {
                  const updated = await renameBatch(batchDetail.id, next);
                  const nextDetail = { ...batchDetail, name: updated.name };
                  setBatchDetail(nextDetail);
                  storeBatchDetail(nextDetail);
                }}
                ariaLabel="Rename batch"
              />
            </h1>
          )}

          {isBatch && (
            <>
              <ResultNavigation
                results={results}
                currentIndex={currentIndex}
                onNavigate={handleNavigate}
              />
              {batchSummary && (
                <span className="ml-4 text-sm text-muted-foreground">
                  <span className="font-mono font-semibold text-foreground">
                    {batchSummary.total_count}
                  </span>{" "}
                  eggs ·{" "}
                  <span className="font-mono">
                    {batchSummary.total_elapsed_seconds.toFixed(1)}s
                  </span>
                </span>
              )}
            </>
          )}

          {!isBatch && !batchDetail && (
            <h1 className="text-lg font-semibold">{currentResult.filename}</h1>
          )}

          {/* Mode badge — single source of truth for what the user is doing */}
          {batchDetail && currentImageRecord && (
            editMode ? (
              <Badge
                variant="default"
                className="ml-2 gap-1 bg-blue-600 hover:bg-blue-600/90"
              >
                <Pencil className="h-3 w-3" />
                {editorTool === "draw" ? "Drawing" : "Editing"}
                {isDirty && <span className="ml-0.5">•</span>}
              </Badge>
            ) : (
              <Badge variant="secondary" className="ml-2 gap-1">
                <Eye className="h-3 w-3" />
                View
              </Badge>
            )
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* ── Editor toolbar (visible when batchDetail exists) ── */}
          {batchDetail && currentImageRecord && (
            <>
              {!editMode ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleToggleEdit}
                  className="gap-2"
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </Button>
              ) : (
                <div className="flex items-center gap-1 rounded-md border bg-card px-2 py-1">
                  {/* Drag tool — select, move, resize boxes; drag empty area
                      to pan; click empty area to deselect. */}
                  <Button
                    variant={editorTool === "drag" ? "default" : "ghost"}
                    size="icon"
                    title="Drag tool — select, move & resize boxes; drag background to pan"
                    className="h-7 w-7"
                    onClick={() => setEditorTool("drag")}
                  >
                    <Hand className="h-4 w-4" />
                  </Button>

                  {/* Draw mode toggle */}
                  <Button
                    variant={editorTool === "draw" ? "default" : "ghost"}
                    size="icon"
                    title={editorTool === "draw" ? "Cancel draw (D)" : "Draw new box (D)"}
                    className="h-7 w-7"
                    onClick={() => {
                      setEditorTool((t) => (t === "draw" ? "drag" : "draw"));
                      setSelectedIdx(null);
                    }}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>

                  <div className="mx-1 h-5 w-px bg-border" />

                  {/* Undo */}
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Undo (Ctrl+Z)"
                    className="h-7 w-7"
                    disabled={!undoAvailable}
                    onClick={() => { dispatchHistory({ type: "undo" }); setSelectedIdx(null); }}
                  >
                    <Undo2 className="h-4 w-4" />
                  </Button>

                  {/* Redo */}
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Redo (Ctrl+Shift+Z)"
                    className="h-7 w-7"
                    disabled={!redoAvailable}
                    onClick={() => { dispatchHistory({ type: "redo" }); setSelectedIdx(null); }}
                  >
                    <Redo2 className="h-4 w-4" />
                  </Button>

                  <div className="mx-1 h-5 w-px bg-border" />

                  {/* Reset to model */}
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Reset to model output"
                    className="h-7 w-7"
                    onClick={() => setResetDialogOpen(true)}
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>

                  <div className="mx-1 h-5 w-px bg-border" />

                  {/* Exit edit mode */}
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Exit edit mode"
                    className="h-7 w-7"
                    onClick={handleToggleEdit}
                  >
                    <PencilOff className="h-4 w-4" />
                  </Button>
                </div>
              )}

              {/* Save edits button */}
              {editMode && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSaveEdits}
                  disabled={!isDirty || savingEdits}
                  className="gap-2"
                >
                  <Save className="h-4 w-4" />
                  {savingEdits ? "Saving…" : "Save edits"}
                  {isDirty && <span className="text-xs opacity-80">•</span>}
                </Button>
              )}
            </>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const detail = loadBatchDetail();
              if (detail) navigate(`/recorded?batch=${detail.id}`);
              else navigate("/recorded");
            }}
            className="gap-2"
          >
            <Save className="h-4 w-4" />
            Save to Records
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (!currentResult || !overlayDownloadSrc) return;
              fetch(overlayDownloadSrc)
                .then((r) => r.blob())
                .then((blob) => {
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${currentResult.filename.replace(/\.[^.]+$/, "")}_overlay.png`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  toast.success("Download started");
                })
                .catch(() => toast.error("Failed to download overlay image"));
            }}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            Download
          </Button>
        </div>
      </header>

      {/* ── Content ───────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Image viewer — ~70% */}
        <div className="flex-1 overflow-hidden border-r">
          <OverlayImage
            src={rawSrc}
            alt={currentResult.filename}
            annotations={viewBoxes}
            panDisabled={editMode && editorTool === "draw"}
            dimEnabled={!editMode && !ctrlHeld}
            onBackgroundClick={
              editMode && editorTool === "drag"
                ? () => setSelectedIdx(null)
                : undefined
            }
            onDimensions={(w, h) => { setImgW(w); setImgH(h); }}
            editorSlot={
              editMode && currentImageRecord
                ? ({ scale }) => (
                    <AnnotationEditor
                      key={`${currentImageRecord.id}-${currentIndex}`}
                      annotations={sessionBoxes}
                      width={imgW}
                      height={imgH}
                      selectedIndex={selectedIdx}
                      confidenceThreshold={confidenceThreshold}
                      scale={scale}
                      onSelect={setSelectedIdx}
                      onCommit={handleEditorCommit}
                      mode={editorTool}
                    />
                  )
                : undefined
            }
          />
        </div>

        {/* Side panel — ~30% */}
        <aside className="w-80 shrink-0 overflow-hidden bg-card">
          <StatBoard
            result={currentResult}
            config={processingConfig}
            visibleAnnotations={visibleAnnotations}
            confidenceThreshold={confidenceThreshold}
            onConfidenceChange={setConfidenceThreshold}
            editMode={editMode}
            modelBoxes={modelBoxes}
            sessionBoxes={sessionBoxes}
          />
        </aside>
      </div>

      {/* ── Dialogs ────────────────────────────────────────────────────── */}

      {/* Dirty navigation guard */}
      <AlertDialog open={dirtyNavDialogOpen} onOpenChange={setDirtyNavDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved edits?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved annotation edits. Navigating away will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelDirtyNav}>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmDirtyNav();
                if (pendingNavIdx === -1) {
                  navigate("/");
                }
              }}
            >
              Discard edits
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset to model confirmation */}
      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to model output?</AlertDialogTitle>
            <AlertDialogDescription>
              This will discard all annotation edits and restore the original model detections.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setResetDialogOpen(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleResetToModel}
            >
              Reset to model
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
