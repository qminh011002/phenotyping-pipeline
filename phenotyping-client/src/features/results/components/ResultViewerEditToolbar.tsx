import { Eye, EyeOff, Hand, Redo2, RotateCcw, Undo2, VectorSquare } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface ResultViewerEditToolbarProps {
    editorTool: 'drag' | 'draw';
    labelsVisible: boolean;
    redoAvailable: boolean;
    undoAvailable: boolean;
    onOpenResetDialog: () => void;
    onRedo: () => void;
    onSelectDragTool: () => void;
    onToggleDrawTool: () => void;
    onToggleLabels: () => void;
    onUndo: () => void;
}

export function ResultViewerEditToolbar({
    editorTool,
    labelsVisible,
    redoAvailable,
    undoAvailable,
    onOpenResetDialog,
    onRedo,
    onSelectDragTool,
    onToggleDrawTool,
    onToggleLabels,
    onUndo,
}: ResultViewerEditToolbarProps) {
    return (
        <div className="pointer-events-none absolute right-4 top-1/2 z-20 -translate-y-1/2">
            <div className="pointer-events-auto flex flex-col items-center gap-2.5">
                <div className="flex flex-col items-center gap-1 rounded-xl border border-white/12 bg-card/70 p-1 shadow-[0_18px_44px_rgba(0,0,0,0.34)] backdrop-blur-md">
                    <Button
                        variant={editorTool === 'drag' ? 'default' : 'ghost'}
                        size="icon-sm"
                        title="Drag tool — select, move & resize boxes; drag background to pan"
                        className={
                            editorTool === 'drag'
                                ? 'h-9 w-9 rounded-lg bg-white text-slate-950 hover:bg-slate-100'
                                : 'h-9 w-9 rounded-lg text-slate-200 hover:bg-white/8 hover:text-white'
                        }
                        onClick={onSelectDragTool}
                    >
                        <Hand className="h-4 w-4" />
                    </Button>

                    <Button
                        variant={editorTool === 'draw' ? 'default' : 'ghost'}
                        size="icon-sm"
                        title={editorTool === 'draw' ? 'Cancel draw (D)' : 'Draw new box (D)'}
                        className={
                            editorTool === 'draw'
                                ? 'h-9 w-9 rounded-lg bg-white text-slate-950 hover:bg-slate-100'
                                : 'h-9 w-9 rounded-lg text-slate-200 hover:bg-white/8 hover:text-white'
                        }
                        onClick={onToggleDrawTool}
                    >
                        <VectorSquare className="h-4 w-4" strokeWidth={2} />
                    </Button>

                    <div className="my-1 h-px w-7 bg-white/10" />

                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title={labelsVisible ? 'Hide class labels (L)' : 'Show class labels (L)'}
                        className="h-9 w-9 rounded-lg text-slate-200 hover:bg-white/8 hover:text-white"
                        onClick={onToggleLabels}
                    >
                        {labelsVisible ? (
                            <Eye className="h-4 w-4" />
                        ) : (
                            <EyeOff className="h-4 w-4" />
                        )}
                    </Button>

                    <div className="my-1 h-px w-7 bg-white/10" />

                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Undo (Ctrl+Z)"
                        className="h-9 w-9 rounded-lg text-slate-200 hover:bg-white/8 hover:text-white"
                        disabled={!undoAvailable}
                        onClick={onUndo}
                    >
                        <Undo2 className="h-4 w-4" />
                    </Button>

                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Redo (Ctrl+Shift+Z)"
                        className="h-9 w-9 rounded-lg text-slate-200 hover:bg-white/8 hover:text-white"
                        disabled={!redoAvailable}
                        onClick={onRedo}
                    >
                        <Redo2 className="h-4 w-4" />
                    </Button>

                    <div className="my-1 h-px w-7 bg-white/10" />

                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Reset to model output"
                        className="h-9 w-9 rounded-lg text-slate-200 hover:bg-white/8 hover:text-white"
                        onClick={onOpenResetDialog}
                    >
                        <RotateCcw className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </div>
    );
}
