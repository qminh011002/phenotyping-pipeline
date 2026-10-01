// Body of the bbox (egg / neonate) result viewer: the canvas with its tool
// rail, the filmstrip under it, and the stats inspector on the right.

import { memo, useCallback, useMemo } from 'react';

import type { BBox, DetectionResult, Organism } from '@/types/api';

import { AnnotationToolbar, type AnnotationToolId } from './AnnotationToolbar';
import { Filmstrip, type FilmstripItem } from './Filmstrip';
import { OverlayImage, type OverlayImageTool } from './OverlayImage';
import { StatBoard } from './StatBoard';

interface ResultViewerContentProps {
    organism: Organism;
    /** Batch the images belong to — null only in the session-storage fallback. */
    batchId: string | null;
    currentImageRecordId: string | null;
    currentIndex: number;
    currentResult: DetectionResult;
    confidenceThreshold: number;
    /** False while Ctrl/Cmd is held or the eye toggle is off. */
    overlayVisible: boolean;
    defaultClass: string | undefined;
    editMode: boolean;
    editorTool: OverlayImageTool;
    filmstripItems: FilmstripItem[];
    filmstripCollapsed: boolean;
    modelBoxes: BBox[];
    processingConfig: Record<string, unknown> | null;
    redoAvailable: boolean;
    savingEdits: boolean;
    savePending: boolean;
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
    onNavigate: (index: number) => void;
    onOpenResetDialog: () => void;
    onRedo: () => void;
    onSelectTool: (tool: OverlayImageTool) => void;
    onToggleFilmstrip: () => void;
    onToggleOverlay: () => void;
    onUndo: () => void;
}

export const ResultViewerContent = memo(function ResultViewerContent({
    organism,
    batchId,
    currentImageRecordId,
    currentIndex,
    currentResult,
    confidenceThreshold,
    overlayVisible,
    defaultClass,
    editMode,
    editorTool,
    filmstripItems,
    filmstripCollapsed,
    modelBoxes,
    processingConfig,
    redoAvailable,
    savingEdits,
    savePending,
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
    onNavigate,
    onOpenResetDialog,
    onRedo,
    onSelectTool,
    onToggleFilmstrip,
    onToggleOverlay,
    onUndo,
}: ResultViewerContentProps) {
    const editing = editMode && currentImageRecordId !== null;

    const overlayEditor = useMemo(
        () =>
            editing
                ? {
                      mode: editorTool,
                      selectedIndex: selectedIdx,
                      confidenceThreshold,
                      defaultClass,
                      onSelect,
                      onCommit,
                  }
                : undefined,
        [confidenceThreshold, defaultClass, editing, editorTool, onCommit, onSelect, selectedIdx],
    );

    return (
        <div className="flex min-h-0 flex-1">
            <div className="relative flex min-w-0 flex-1 flex-col">
                <div className="relative min-h-0 flex-1">
                    <OverlayImage
                        key={
                            editing
                                ? `edit-${currentImageRecordId}-${currentIndex}`
                                : `view-${currentIndex}`
                        }
                        src={rawSrc}
                        alt={currentResult.filename}
                        annotations={editing ? sessionBoxes : viewBoxes}
                        saveInProgress={savingEdits}
                        savePending={savePending}
                        overlayVisible={overlayVisible}
                        onToggleOverlay={onToggleOverlay}
                        onBackgroundClick={onBackgroundClick}
                        onDimensions={onDimensions}
                        editor={overlayEditor}
                    />

                    {editing && (
                        <BboxToolRail
                            organism={organism}
                            editorTool={editorTool}
                            redoAvailable={redoAvailable}
                            undoAvailable={undoAvailable}
                            onOpenResetDialog={onOpenResetDialog}
                            onRedo={onRedo}
                            onSelectTool={onSelectTool}
                            onUndo={onUndo}
                        />
                    )}
                </div>

                {batchId && (
                    <Filmstrip
                        batchId={batchId}
                        items={filmstripItems}
                        currentIndex={currentIndex}
                        onNavigate={onNavigate}
                        collapsed={filmstripCollapsed}
                        onToggleCollapsed={onToggleFilmstrip}
                    />
                )}
            </div>

            <aside className="w-80 shrink-0 border-l border-border bg-card" data-result-aside>
                <StatBoard
                    result={currentResult}
                    organism={organism}
                    config={processingConfig}
                    visibleAnnotations={visibleAnnotations}
                    confidenceThreshold={confidenceThreshold}
                    onConfidenceChange={onConfidenceChange}
                    editMode={editing}
                    modelBoxes={modelBoxes}
                    sessionBoxes={sessionBoxes}
                />
            </aside>
        </div>
    );
});

const TOOL_BY_ID: Partial<Record<AnnotationToolId, OverlayImageTool>> = {
    select: 'drag',
    addBox: 'draw',
    erase: 'erase',
};

const ID_BY_TOOL: Record<OverlayImageTool, AnnotationToolId> = {
    drag: 'select',
    draw: 'addBox',
    erase: 'erase',
};

// Tool rail — the shared AnnotationToolbar, mapped onto the bbox editor's
// three modes (drag = select / move / resize, draw = rubber-band a new box,
// erase = click to delete) plus history.
function BboxToolRail({
    organism,
    editorTool,
    redoAvailable,
    undoAvailable,
    onOpenResetDialog,
    onRedo,
    onSelectTool,
    onUndo,
}: {
    organism: Organism;
    editorTool: OverlayImageTool;
    redoAvailable: boolean;
    undoAvailable: boolean;
    onOpenResetDialog: () => void;
    onRedo: () => void;
    onSelectTool: (tool: OverlayImageTool) => void;
    onUndo: () => void;
}) {
    const handleSelect = useCallback(
        (id: AnnotationToolId) => {
            switch (id) {
                case 'undo':
                    onUndo();
                    return;
                case 'redo':
                    onRedo();
                    return;
                case 'reset':
                    onOpenResetDialog();
                    return;
                default: {
                    const tool = TOOL_BY_ID[id];
                    if (tool) onSelectTool(tool);
                }
            }
        },
        [onSelectTool, onUndo, onRedo, onOpenResetDialog],
    );

    const forceDisabled = useMemo<Partial<Record<AnnotationToolId, boolean>>>(
        () => ({ undo: !undoAvailable, redo: !redoAvailable }),
        [undoAvailable, redoAvailable],
    );

    return (
        <div className="absolute left-3 top-3 z-20">
            <AnnotationToolbar
                organism={organism}
                orientation="vertical"
                activeTool={ID_BY_TOOL[editorTool]}
                forceDisabled={forceDisabled}
                onSelectTool={handleSelect}
            />
        </div>
    );
}
