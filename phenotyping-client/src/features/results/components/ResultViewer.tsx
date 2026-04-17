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

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { toast } from "sonner";

import type { BBox, DetectionResult } from "@/types/api";
import {
  loadBatchSummary,
  loadBatchDetail,
  loadProcessingFiles,
  loadProcessingConfig,
  loadProcessingResults,
  storeBatchDetail,
} from "@/features/upload/lib/processingSession";
import {
  getAnalysesOverlayUrl,
  getAnalysesRawUrl,
  getAnalysisDetail,
  putEditedAnnotations,
  renameBatch,
  resetEditedAnnotations,
} from "@/services/api";
import { cn } from "@/lib/utils";

import { boxesEqual } from "../lib/bboxMath";
import { canRedo, canUndo, editorHistoryReducer } from "../lib/editorHistory";

import { ResultViewerContent } from "./ResultViewerContent";
import { ResultViewerDialogs } from "./ResultViewerDialogs";
import { ResultViewerHeader } from "./ResultViewerHeader";

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
  const editMode = true;
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
  const previousImageIdRef = useRef<string | null>(null);

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
    const imageId = currentImageRecord?.id ?? null;
    if (previousImageIdRef.current === imageId) return;
    previousImageIdRef.current = imageId;
    setSelectedIdx(null);
    setEditorTool("drag");
    dispatchHistory({ type: "reset", boxes: baselineBoxes });
  }, [baselineBoxes, currentImageRecord?.id]);

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
    if (pendingNavIdx === null) return;

    if (pendingNavIdx === -1) {
      setPendingNavIdx(null);
      navigate("/");
      return;
    }

    setCurrentIndex(pendingNavIdx);
    setPendingNavIdx(null);
  }, [navigate, pendingNavIdx]);

  const cancelDirtyNav = useCallback(() => {
    setDirtyNavDialogOpen(false);
    setPendingNavIdx(null);
  }, []);

  // ── Save edits ──────────────────────────────────────────────────────────
  const handleSaveEdits = useCallback(async () => {
    if (!batchDetail || !currentImageRecord || !isDirty) return;
    const batchId = batchDetail.id;
    const imageId = currentImageRecord.id;
    const boxesToSave = sessionBoxes;
    setSavingEdits(true);
    try {
      await putEditedAnnotations(batchId, imageId, boxesToSave);
      const updated = await getAnalysisDetail(batchId);
      setBatchDetail(updated);
      storeBatchDetail(updated);
    } catch {
      toast.error("Failed to auto-save edits");
    } finally {
      setSavingEdits(false);
    }
  }, [batchDetail, currentImageRecord, isDirty, sessionBoxes]);

  useEffect(() => {
    if (!editMode || savingEdits || !isDirty) return;
    void handleSaveEdits();
  }, [editMode, handleSaveEdits, isDirty, savingEdits]);

  // ── Reset to model ──────────────────────────────────────────────────────
  const handleResetToModel = useCallback(async () => {
    if (!batchDetail || !currentImageRecord) return;
    setResetDialogOpen(false);
    try {
      await resetEditedAnnotations(batchDetail.id, currentImageRecord.id);
      const updated = await getAnalysisDetail(batchDetail.id);
      setBatchDetail(updated);
      storeBatchDetail(updated);
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

  const handleBack = useCallback(() => {
    if (isDirty) {
      setPendingNavIdx(-1);
      setDirtyNavDialogOpen(true);
      return;
    }

    navigate("/");
  }, [isDirty, navigate]);

  const handleRenameBatch = useCallback(
    async (next: string) => {
      if (!batchDetail) return;

      const updated = await renameBatch(batchDetail.id, next);
      const nextDetail = { ...batchDetail, name: updated.name };
      setBatchDetail(nextDetail);
      storeBatchDetail(nextDetail);
    },
    [batchDetail],
  );

  const handleSelectDragTool = useCallback(() => {
    setEditorTool("drag");
  }, []);

  const handleToggleDrawTool = useCallback(() => {
    setEditorTool((tool) => (tool === "draw" ? "drag" : "draw"));
    setSelectedIdx(null);
  }, []);

  const handleUndo = useCallback(() => {
    dispatchHistory({ type: "undo" });
    setSelectedIdx(null);
  }, []);

  const handleRedo = useCallback(() => {
    dispatchHistory({ type: "redo" });
    setSelectedIdx(null);
  }, []);

  const handleSaveToRecords = useCallback(() => {
    const detail = loadBatchDetail();
    if (detail) {
      navigate(`/recorded?batch=${detail.id}`);
      return;
    }

    navigate("/recorded");
  }, [navigate]);

  const handleDownload = useCallback(() => {
    if (!currentResult || !overlayDownloadSrc) return;

    fetch(overlayDownloadSrc)
      .then((response) => response.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${currentResult.filename.replace(/\.[^.]+$/, "")}_overlay.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toast.success("Download started");
      })
      .catch(() => toast.error("Failed to download overlay image"));
  }, [currentResult, overlayDownloadSrc]);

  const handleImageDimensions = useCallback((width: number, height: number) => {
    setImgW(width);
    setImgH(height);
  }, []);

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

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <ResultViewerHeader
        batchDetail={batchDetail}
        batchSummary={batchSummary}
        currentIndex={currentIndex}
        currentResult={currentResult}
        results={results}
        canEdit={Boolean(batchDetail && currentImageRecord)}
        editMode={editMode}
        isDirty={isDirty}
        onBack={handleBack}
        onNavigate={handleNavigate}
        onRename={handleRenameBatch}
        onSaveToRecords={handleSaveToRecords}
        onDownload={handleDownload}
      />

      <ResultViewerContent
        currentImageRecordId={currentImageRecord?.id ?? null}
        currentIndex={currentIndex}
        currentResult={currentResult}
        confidenceThreshold={confidenceThreshold}
        ctrlHeld={ctrlHeld}
        editMode={editMode}
        editorTool={editorTool}
        imgW={imgW}
        imgH={imgH}
        modelBoxes={modelBoxes}
        processingConfig={processingConfig}
        redoAvailable={redoAvailable}
        savingEdits={savingEdits}
        selectedIdx={selectedIdx}
        sessionBoxes={sessionBoxes}
        rawSrc={rawSrc}
        undoAvailable={undoAvailable}
        viewBoxes={viewBoxes}
        visibleAnnotations={visibleAnnotations}
        onBackgroundClick={
          editMode && editorTool === "drag"
            ? () => setSelectedIdx(null)
            : undefined
        }
        onDimensions={handleImageDimensions}
        onSelect={setSelectedIdx}
        onCommit={handleEditorCommit}
        onConfidenceChange={setConfidenceThreshold}
        onOpenResetDialog={() => setResetDialogOpen(true)}
        onRedo={handleRedo}
        onSelectDragTool={handleSelectDragTool}
        onToggleDrawTool={handleToggleDrawTool}
        onUndo={handleUndo}
      />

      <ResultViewerDialogs
        dirtyNavDialogOpen={dirtyNavDialogOpen}
        resetDialogOpen={resetDialogOpen}
        onDirtyNavOpenChange={setDirtyNavDialogOpen}
        onResetDialogOpenChange={setResetDialogOpen}
        onKeepEditing={cancelDirtyNav}
        onDiscardEdits={confirmDirtyNav}
        onCancelReset={() => setResetDialogOpen(false)}
        onConfirmReset={handleResetToModel}
      />
    </div>
  );
}
