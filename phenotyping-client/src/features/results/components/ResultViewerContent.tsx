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
  editMode: boolean;
  editorTool: "drag" | "draw";
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
  onUndo: () => void;
}

export function ResultViewerContent({
  currentImageRecordId,
  currentIndex,
  currentResult,
  confidenceThreshold,
  ctrlHeld,
  editMode,
  editorTool,
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
          onBackgroundClick={onBackgroundClick}
          onDimensions={onDimensions}
          editor={
            editMode && currentImageRecordId
              ? {
                  mode: editorTool,
                  selectedIndex: selectedIdx,
                  confidenceThreshold,
                  onSelect,
                  onCommit,
                }
              : undefined
          }
        />

        {editMode && currentImageRecordId && (
          <ResultViewerEditToolbar
            editorTool={editorTool}
            redoAvailable={redoAvailable}
            undoAvailable={undoAvailable}
            onOpenResetDialog={onOpenResetDialog}
            onRedo={onRedo}
            onSelectDragTool={onSelectDragTool}
            onToggleDrawTool={onToggleDrawTool}
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
