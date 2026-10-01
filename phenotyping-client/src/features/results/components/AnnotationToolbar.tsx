// Capability-driven annotation toolbar.
//
// Same component for every organism. Tools the active organism's model
// doesn't support render but go disabled with a tooltip explaining why,
// so the toolbar layout never changes between organisms.

import {
    Eraser,
    MousePointer2,
    Pencil,
    Redo2,
    RotateCcw,
    Ruler,
    Spline,
    SquareDashed,
    Undo2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Organism } from '@/types/api';
import { cn } from '@/lib/utils';

import { TOOL_CAPABILITIES, disabledReason, type ToolCapability } from '../toolCapabilities';

export type AnnotationToolId =
    | 'select'
    | 'move'
    | 'addBox'
    | 'resize'
    | 'delete'
    | 'erase'
    | 'addPolygon'
    | 'editVertex'
    | 'smooth'
    | 'editCalibration'
    | 'undo'
    | 'redo'
    | 'reset';

interface ToolDef {
    id: AnnotationToolId;
    label: string;
    /** What the tool does, shown under the label in the tooltip. */
    hint: string;
    /** Keyboard shortcut shown in the tooltip. */
    shortcut?: string;
    Icon: typeof MousePointer2;
    /** Capability key on `ToolCapability`; ``null`` means the tool is universal. */
    capability: keyof ToolCapability | null;
    /** Visual grouping — separators are inserted between groups. */
    group: 'navigate' | 'draw' | 'measure' | 'history';
}

const TOOLS: ToolDef[] = [
    // Universal "Select / pan" tool — enters the default edit mode for the
    // active organism (bbox-select for egg/neonate, polygon-edit for larvae).
    {
        id: 'select',
        label: 'Select',
        hint: 'Select, move and reshape · drag empty space to pan',
        shortcut: 'V',
        Icon: MousePointer2,
        capability: null,
        group: 'navigate',
    },
    {
        id: 'addBox',
        label: 'Add box',
        hint: 'Drag to draw a new box',
        shortcut: 'D',
        Icon: SquareDashed,
        capability: 'bbox',
        group: 'draw',
    },
    {
        id: 'addPolygon',
        label: 'Polygon',
        hint: 'Click to place points · Enter to finish',
        shortcut: 'D',
        Icon: Pencil,
        capability: 'polygon',
        group: 'draw',
    },
    {
        id: 'erase',
        label: 'Erase',
        hint: 'Click a detection to delete it',
        shortcut: 'E',
        Icon: Eraser,
        capability: null,
        group: 'draw',
    },
    {
        id: 'smooth',
        label: 'Smooth',
        hint: 'Simplify the selected outline',
        Icon: Spline,
        capability: 'polygon',
        group: 'draw',
    },
    {
        id: 'editCalibration',
        label: 'Calibrate',
        hint: 'Adjust the calibration rectangle',
        Icon: Ruler,
        capability: 'calibration',
        group: 'measure',
    },
    {
        id: 'undo',
        label: 'Undo',
        hint: 'Undo the last edit',
        shortcut: 'Ctrl Z',
        Icon: Undo2,
        capability: null,
        group: 'history',
    },
    {
        id: 'redo',
        label: 'Redo',
        hint: 'Redo',
        shortcut: 'Ctrl ⇧ Z',
        Icon: Redo2,
        capability: null,
        group: 'history',
    },
    {
        id: 'reset',
        label: 'Reset',
        hint: 'Discard edits and restore the model output',
        Icon: RotateCcw,
        capability: null,
        group: 'history',
    },
];

interface AnnotationToolbarProps {
    organism: Organism;
    activeTool?: AnnotationToolId | null;
    /** Per-tool override — disable individual tools regardless of capability. */
    forceDisabled?: Partial<Record<AnnotationToolId, boolean>>;
    onSelectTool?: (id: AnnotationToolId) => void;
    /** Vertical rail (default for the editor) or horizontal bar. */
    orientation?: 'vertical' | 'horizontal';
    className?: string;
}

export function AnnotationToolbar({
    organism,
    activeTool,
    forceDisabled,
    onSelectTool,
    orientation = 'horizontal',
    className,
}: AnnotationToolbarProps) {
    const caps = TOOL_CAPABILITIES[organism];
    const vertical = orientation === 'vertical';

    return (
        <div
            role="toolbar"
            aria-label="Annotation toolbar"
            aria-orientation={orientation}
            className={cn(
                'floating-panel flex items-center gap-1 p-1 pb-1.5',
                vertical && 'flex-col',
                className,
            )}
        >
            {TOOLS.map((tool, idx) => {
                const capDisabled = tool.capability !== null && !caps[tool.capability];
                const overrideDisabled = forceDisabled?.[tool.id] ?? false;
                const disabled = capDisabled || overrideDisabled;
                const isActive = activeTool === tool.id;
                const prevGroup = idx > 0 ? TOOLS[idx - 1].group : tool.group;
                const showSeparator = idx > 0 && prevGroup !== tool.group;
                const button = (
                    <Button
                        key={tool.id}
                        type="button"
                        variant={isActive ? 'default' : 'outline'}
                        size="icon"
                        disabled={disabled}
                        aria-label={tool.label}
                        aria-pressed={isActive}
                        data-tool-id={tool.id}
                        className="size-8"
                        onClick={
                            disabled || !onSelectTool ? undefined : () => onSelectTool(tool.id)
                        }
                    >
                        <tool.Icon className="size-4" />
                    </Button>
                );
                return (
                    <span
                        key={tool.id}
                        className={cn('inline-flex items-center', vertical && 'flex-col')}
                    >
                        {showSeparator && (
                            <span
                                aria-hidden
                                className={cn(
                                    'shrink-0 bg-border',
                                    vertical ? 'my-1 h-px w-5' : 'mx-1 h-5 w-px',
                                )}
                            />
                        )}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                {/* Tooltip needs a focusable child even when disabled. */}
                                <span className="inline-flex">{button}</span>
                            </TooltipTrigger>
                            <TooltipContent side={vertical ? 'right' : 'bottom'}>
                                {capDisabled ? (
                                    disabledReason(tool.capability!, organism)
                                ) : (
                                    <span className="flex items-center gap-2">
                                        <span>
                                            <span className="font-medium">{tool.label}</span>
                                            <span className="ml-1.5 opacity-70">{tool.hint}</span>
                                        </span>
                                        {tool.shortcut && (
                                            <span className="rounded-sm border border-current/25 px-1 font-mono text-[10px] opacity-80">
                                                {tool.shortcut}
                                            </span>
                                        )}
                                    </span>
                                )}
                            </TooltipContent>
                        </Tooltip>
                    </span>
                );
            })}
        </div>
    );
}
