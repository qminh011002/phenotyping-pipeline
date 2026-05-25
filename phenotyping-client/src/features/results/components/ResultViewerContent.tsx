import { memo, useCallback, useMemo } from 'react';

import { cn } from '@/lib/utils';

import type { BBox, DetectionResult, Organism } from '@/types/api';

import { AnnotationToolbar, type AnnotationToolId } from './AnnotationToolbar';
import { OverlayImage } from './OverlayImage';
import { StatBoard } from './StatBoard';

interface ResultViewerContentProps {
    organism: Organism;
    currentImageRecordId: string | null;
    currentIndex: number;
    currentResult: DetectionResult;
    confidenceThreshold: number;
    ctrlHeld: boolean;
    defaultClass: string | undefined;
    editMode: boolean;
    editorTool: 'drag' | 'draw';
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
    onSave?: () => void;
    saveDirty?: boolean;
}

export const ResultViewerContent = memo(function ResultViewerContent({
    organism,
    currentImageRecordId,
    currentIndex,
    currentResult,
    confidenceThreshold,
    ctrlHeld,
    defaultClass,
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
    const overlayEditor = useMemo(
        () =>
            editMode && currentImageRecordId
                ? {
                      mode: editorTool,
                      selectedIndex: selectedIdx,
                      confidenceThreshold,
                      defaultClass,
                      onSelect,
                      onCommit,
                  }
                : undefined,
        [
            confidenceThreshold,
            currentImageRecordId,
            defaultClass,
            editMode,
            editorTool,
            onCommit,
            onSelect,
            selectedIdx,
        ],
    );

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
                    // Keep boxes vector-rendered so their edges stay sharp at every
                    // zoom level. The raster path scales a bitmap of the strokes, which
                    // makes the boxes look soft when zooming.
                    useOffscreen={false}
                    onBackgroundClick={onBackgroundClick}
                    onDimensions={onDimensions}
                    editor={overlayEditor}
                />

                {editMode && currentImageRecordId && (
                    <BboxToolbar
                        organism={organism}
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

            <aside className="w-80 shrink-0 overflow-hidden bg-card" data-result-aside>
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
});

// Bbox toolbar — wraps the unified AnnotationToolbar, mapping all bbox-tool
// clicks to the existing two-mode editor (drag = unified select/move/resize/
// delete; draw = rubber-band new box).
function BboxToolbar({
    organism,
    editorTool,
    redoAvailable,
    undoAvailable,
    onOpenResetDialog,
    onRedo,
    onSelectDragTool,
    onToggleDrawTool,
    onUndo,
}: {
    organism: Organism;
    editorTool: 'drag' | 'draw';
    redoAvailable: boolean;
    undoAvailable: boolean;
    onOpenResetDialog: () => void;
    onRedo: () => void;
    onSelectDragTool: () => void;
    onToggleDrawTool: () => void;
    onUndo: () => void;
    onSave?: () => void;
}) {
    const activeTool: AnnotationToolId | null =
        editorTool === 'draw' ? 'addBox' : 'select';

    const handleSelect = useCallback(
        (id: AnnotationToolId) => {
            switch (id) {
                case 'select':
                    onSelectDragTool();
                    return;
                case 'addBox':
                    if (editorTool !== 'draw') onToggleDrawTool();
                    return;
                case 'undo':
                    onUndo();
                    return;
                case 'redo':
                    onRedo();
                    return;
                case 'reset':
                    onOpenResetDialog();
                    return;
                default:
                    return;
            }
        },
        [editorTool, onSelectDragTool, onToggleDrawTool, onUndo, onRedo, onOpenResetDialog],
    );

    const forceDisabled: Partial<Record<AnnotationToolId, boolean>> = {
        undo: !undoAvailable,
        redo: !redoAvailable,
    };

    // Hide the toolbar entirely while drawing a new box. Esc (or finishing
    // the box) brings it back; the fade keeps the transition gentle.
    const drawing = editorTool === 'draw';

    return (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2">
            <div
                className={cn(
                    'transition-opacity duration-200 ease-out',
                    drawing
                        ? 'pointer-events-none opacity-0'
                        : 'pointer-events-auto opacity-100',
                )}
            >
                <AnnotationToolbar
                    organism={organism}
                    activeTool={activeTool}
                    forceDisabled={forceDisabled}
                    onSelectTool={handleSelect}
                />
            </div>
        </div>
    );
}
