import type { BBox, DetectionResult } from "@/types/api";

import { OverlayImage } from "./OverlayImage";
import { ResultViewerEditToolbar } from "./ResultViewerEditToolbar";
import { StatBoard } from "./StatBoard";

interface ResultViewerContentProps {
  currentImageRecordId: string | null;
  currentIndex: number;
  currentResult: DetectionResult;
  confidenceThreshold: number;
  ctrlHeld: boolean;
  defaultClass: string | undefined;
  editMode: boolean;
  editorTool: "drag" | "draw";
  labelsVisible: boolean;
  modelBoxes: BBox[];
  processingConfig: Record<string, unknown> | null;
  redoAvailable: boolean;
  savingEdits: boolean;
  selectedIdx: number | null;
  sessionBoxes: BBox[];
  rawSrc: string;
  undoAvailable: boolean;
  viewBoxes: BBox[];
  visibleAnnotations: BBox[];
  onBackgroundClick: (() => void) | undefined;
  onDimensions: (width: number, height: number) => void;
  onSelect: (index: number | null) => void;
  onCommit: (boxes: BBox[]) => void;
  onConfidenceChange: (value: number) => void;
  onOpenResetDialog: () => void;
  onRedo: () => void;
  onSelectDragTool: () => void;
  onToggleDrawTool: () => void;
  onToggleLabels: () => void;
  onUndo: () => void;
}

export function ResultViewerContent({
  currentImageRecordId,
  currentIndex,
  currentResult,
  confidenceThreshold,
  ctrlHeld,
  defaultClass,
  editMode,
  editorTool,
  labelsVisible,
  modelBoxes,
  processingConfig,
  redoAvailable,
  savingEdits,
  selectedIdx,
  sessionBoxes,
  rawSrc,
  undoAvailable,
  viewBoxes,
  visibleAnnotations,
  onBackgroundClick,
  onDimensions,
  onSelect,
  onCommit,
  onConfidenceChange,
  onOpenResetDialog,
  onRedo,
  onSelectDragTool,
  onToggleDrawTool,
  onToggleLabels,
  onUndo,
}: ResultViewerContentProps) {
  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="relative flex-1 overflow-hidden border-r">
        <OverlayImage
          key={
            editMode && currentImageRecordId
              ? `edit-${currentImageRecordId}-${currentIndex}`
              : `view-${currentIndex}`
          }
          src={rawSrc}
          alt={currentResult.filename}
          annotations={editMode && currentImageRecordId ? sessionBoxes : viewBoxes}
          saveInProgress={savingEdits}
          dimEnabled={!ctrlHeld}
          labelsVisible={labelsVisible}
          // Dense scenes (>500 boxes) rasterize non-selected boxes into a
          // single canvas to keep zoom/pan/hover snappy. Sparse scenes stay
          // on the per-Rect path which has richer hover behavior.
          useOffscreen={
            (editMode && currentImageRecordId ? sessionBoxes : viewBoxes).length > 500
          }
          onBackgroundClick={onBackgroundClick}
          onDimensions={onDimensions}
          editor={
            editMode && currentImageRecordId
              ? {
                  mode: editorTool,
                  selectedIndex: selectedIdx,
                  confidenceThreshold,
                  defaultClass,
                  onSelect,
                  onCommit,
                }
              : undefined
          }
        />

        {editMode && currentImageRecordId && (
          <ResultViewerEditToolbar
            editorTool={editorTool}
            labelsVisible={labelsVisible}
            redoAvailable={redoAvailable}
            undoAvailable={undoAvailable}
            onOpenResetDialog={onOpenResetDialog}
            onRedo={onRedo}
            onSelectDragTool={onSelectDragTool}
            onToggleDrawTool={onToggleDrawTool}
            onToggleLabels={onToggleLabels}
            onUndo={onUndo}
          />
        )}
      </div>

      <aside className="w-80 shrink-0 overflow-hidden bg-card">
        <StatBoard
          result={currentResult}
          config={processingConfig}
          visibleAnnotations={visibleAnnotations}
          confidenceThreshold={confidenceThreshold}
          onConfidenceChange={onConfidenceChange}
          editMode={editMode}
          modelBoxes={modelBoxes}
          sessionBoxes={sessionBoxes}
        />
      </aside>
    </div>
  );
}
