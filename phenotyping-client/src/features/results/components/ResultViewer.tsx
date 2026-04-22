// ResultViewer — full page for viewing inference results.
// Renders the RAW uploaded image (from the browser blob URL stored in
// sessionStorage) with client-side bbox overlays drawn from
// result.annotations. The backend-generated overlay PNG is never
// displayed directly — ZIP export from /recorded uses it.
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
import { Inbox } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { toast } from "sonner";

import type { BBox, DetectionResult } from "@/types/api";
import {
  clearProcessingSession,
  loadBatchSummary,
  loadBatchDetail,
  loadProcessingFiles,
  loadProcessingConfig,
  loadProcessingResults,
  loadProjectClasses,
  storeBatchDetail,
} from "@/features/upload/lib/processingSession";
import { consumeStartIndex } from "@/features/recorded/lib/openBatchInResults";
import {
  finishBatch,
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
  const [labelsVisible, setLabelsVisible] = useState(true);
  // Classes are defined on AnalyzePage and persisted both to the batch row
  // (authoritative) and sessionStorage (used during the live processing
  // round-trip before batchDetail is loaded). Prefer the batch row when
  // present so opening a saved batch from /recorded shows its own classes.
  const [sessionClasses] = useState<string[]>(() => loadProjectClasses());
  const projectClasses =
    batchDetail?.classes && batchDetail.classes.length > 0
      ? batchDetail.classes
      : sessionClasses;
  const defaultClass = projectClasses[0];
  const [history, dispatchHistory] = useReducer(editorHistoryReducer, {
    past: [],
    present: [],
    future: [],
  });
  const [savingEdits, setSavingEdits] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [dirtyNavDialogOpen, setDirtyNavDialogOpen] = useState(false);
  const [quitDialogOpen, setQuitDialogOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
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
    // Bridge from /recorded can pre-select an image — consume it once so
    // refreshing the page after landing doesn't keep re-selecting the
    // same index.
    const startIdx = consumeStartIndex();
    if (startIdx !== null && startIdx >= 0 && startIdx < stored.length) {
      setCurrentIndex(startIdx);
    }
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

    setCurrentIndex(pendingNavIdx);
    setPendingNavIdx(null);
  }, [pendingNavIdx]);

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

      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        setLabelsVisible((v) => !v);
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

  // A batch that's already been saved to Records doesn't need a quit prompt —
  // nothing's in-flight, back just goes back.
  const isSaved = batchDetail?.status === "completed";

  const handleBack = useCallback(() => {
    if (isSaved) {
      navigate("/");
      return;
    }
    setQuitDialogOpen(true);
  }, [isSaved, navigate]);

  const handleQuitWithoutSaving = useCallback(() => {
    setQuitDialogOpen(false);
    // Leave the batch in 'draft' — it stays discoverable via direct URL
    // until the operator either finishes it or deletes it.
    clearProcessingSession();
    navigate("/");
  }, [navigate]);

  const finalizeBatchSave = useCallback(async (): Promise<boolean> => {
    if (!batchDetail) return false;
    if (isDirty && !savingEdits) {
      await handleSaveEdits();
    }
    setFinishing(true);
    try {
      await finishBatch(batchDetail.id);
      clearProcessingSession();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to save batch: ${msg}`);
      return false;
    } finally {
      setFinishing(false);
    }
  }, [batchDetail, handleSaveEdits, isDirty, savingEdits]);

  const handleSaveAndQuit = useCallback(async () => {
    const ok = await finalizeBatchSave();
    if (!ok) return;
    setQuitDialogOpen(false);
    navigate(`/recorded?batch=${batchDetail?.id ?? ""}`);
  }, [batchDetail, finalizeBatchSave, navigate]);

  const handleFinish = useCallback(async () => {
    const ok = await finalizeBatchSave();
    if (!ok) return;
    toast.success("Batch saved to Records");
    navigate(`/recorded?batch=${batchDetail?.id ?? ""}`);
  }, [batchDetail, finalizeBatchSave, navigate]);

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

  const handleToggleLabels = useCallback(() => {
    setLabelsVisible((v) => !v);
  }, []);

  const handleImageDimensions = useCallback(() => {
    // Image dimensions are tracked internally by OverlayImage (Konva).
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={cn("flex h-screen items-center justify-center", className)}>
        <div className="flex items-center gap-3 text-muted-foreground">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span>Loading results…</span>
        </div>
      </div>
    );
  }

  if (!currentResult) {
    return (
      <div className={cn("flex h-screen flex-col", className)}>
        <EmptyState
          icon={Inbox}
          title="No results found"
          description="The session data may have expired. Start a new analysis to see results."
          actionLabel="Start New Analysis"
          onAction={() => navigate("/")}
        />
      </div>
    );
  }

  return (
    <div className={cn("flex h-screen flex-col", className)}>
      <ResultViewerHeader
        batchDetail={batchDetail}
        batchSummary={batchSummary}
        currentIndex={currentIndex}
        currentResult={currentResult}
        results={results}
        canEdit={Boolean(batchDetail && currentImageRecord)}
        editMode={editMode}
        isDirty={isDirty}
        isSaved={isSaved}
        finishing={finishing}
        onBack={handleBack}
        onNavigate={handleNavigate}
        onRename={handleRenameBatch}
        onFinish={handleFinish}
      />

      <ResultViewerContent
        currentImageRecordId={currentImageRecord?.id ?? null}
        currentIndex={currentIndex}
        currentResult={currentResult}
        confidenceThreshold={confidenceThreshold}
        ctrlHeld={ctrlHeld}
        defaultClass={defaultClass}
        editMode={editMode}
        editorTool={editorTool}
        labelsVisible={labelsVisible}
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
        onToggleLabels={handleToggleLabels}
        onUndo={handleUndo}
      />

      <ResultViewerDialogs
        dirtyNavDialogOpen={dirtyNavDialogOpen}
        quitDialogOpen={quitDialogOpen}
        resetDialogOpen={resetDialogOpen}
        onDirtyNavOpenChange={setDirtyNavDialogOpen}
        onQuitDialogOpenChange={setQuitDialogOpen}
        onResetDialogOpenChange={setResetDialogOpen}
        onKeepEditing={cancelDirtyNav}
        onDiscardEdits={confirmDirtyNav}
        onQuitWithoutSaving={handleQuitWithoutSaving}
        onSaveAndQuit={handleSaveAndQuit}
        onCancelReset={() => setResetDialogOpen(false)}
        onConfirmReset={handleResetToModel}
        saveAndQuitDisabled={savingEdits || finishing}
      />
    </div>
  );
}
