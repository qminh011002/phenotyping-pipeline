// Capability-driven annotation toolbar.
//
// Same component for every organism. Tools the active organism's model
// doesn't support render but go disabled with a tooltip explaining why,
// so the toolbar layout never changes between organisms.

import {
    Hand,
    Plus,
    Pencil,
    Spline,
    Ruler,
    Undo2,
    Redo2,
    RotateCcw,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Organism } from '@/types/api';
import { cn } from '@/lib/utils';

import {
    TOOL_CAPABILITIES,
    disabledReason,
    type ToolCapability,
} from '../toolCapabilities';

export type AnnotationToolId =
    | 'select'
    | 'move'
    | 'addBox'
    | 'resize'
    | 'delete'
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
    Icon: typeof Hand;
    /** Capability key on `ToolCapability`; ``null`` means the tool is universal. */
    capability: keyof ToolCapability | null;
    /** Visual grouping — separators are inserted between groups. */
    group: 'navigate' | 'draw' | 'measure' | 'history';
}

const TOOLS: ToolDef[] = [
    // Universal "Select / pan" tool — enters the default edit mode for the
    // active organism (bbox-select for egg/neonate, polygon-edit for larvae).
    { id: 'select', label: 'Select', Icon: Hand, capability: null, group: 'navigate' },
    { id: 'addBox', label: 'Add box', Icon: Plus, capability: 'bbox', group: 'draw' },
    {
        id: 'addPolygon',
        label: 'Polygon',
        Icon: Pencil,
        capability: 'polygon',
        group: 'draw',
    },
    { id: 'smooth', label: 'Smooth', Icon: Spline, capability: 'polygon', group: 'draw' },
    {
        id: 'editCalibration',
        label: 'Calibrate',
        Icon: Ruler,
        capability: 'calibration',
        group: 'measure',
    },
    { id: 'undo', label: 'Undo', Icon: Undo2, capability: null, group: 'history' },
    { id: 'redo', label: 'Redo', Icon: Redo2, capability: null, group: 'history' },
    { id: 'reset', label: 'Reset', Icon: RotateCcw, capability: null, group: 'history' },
];

interface AnnotationToolbarProps {
    organism: Organism;
    activeTool?: AnnotationToolId | null;
    /** Per-tool override — disable individual tools regardless of capability. */
    forceDisabled?: Partial<Record<AnnotationToolId, boolean>>;
    onSelectTool?: (id: AnnotationToolId) => void;
    className?: string;
}

export function AnnotationToolbar({
    organism,
    activeTool,
    forceDisabled,
    onSelectTool,
    className,
}: AnnotationToolbarProps) {
    const caps = TOOL_CAPABILITIES[organism];

    return (
        <div
            role="toolbar"
            aria-label="Annotation toolbar"
            className={cn(
                'flex items-center gap-0.5 rounded-md border border-border bg-card p-1 shadow-sm',
                className,
            )}
        >
            {TOOLS.map((tool, idx) => {
                const capDisabled =
                    tool.capability !== null && !caps[tool.capability];
                const overrideDisabled = forceDisabled?.[tool.id] ?? false;
                const disabled = capDisabled || overrideDisabled;
                const reason = capDisabled
                    ? disabledReason(tool.capability!, organism)
                    : tool.label;
                const isActive = activeTool === tool.id;
                const prevGroup = idx > 0 ? TOOLS[idx - 1].group : tool.group;
                const showSeparator = idx > 0 && prevGroup !== tool.group;
                const button = (
                    <Button
                        key={tool.id}
                        type="button"
                        variant={isActive ? 'default' : 'ghost'}
                        size="icon"
                        disabled={disabled}
                        aria-label={tool.label}
                        aria-pressed={isActive}
                        data-tool-id={tool.id}
                        className="h-8 w-8"
                        onClick={
                            disabled || !onSelectTool
                                ? undefined
                                : () => onSelectTool(tool.id)
                        }
                    >
                        <tool.Icon className="h-4 w-4" />
                    </Button>
                );
                return (
                    <span key={tool.id} className="inline-flex items-center">
                        {showSeparator && (
                            <span
                                aria-hidden
                                className="mx-1 h-5 w-px shrink-0 bg-border"
                            />
                        )}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                {/* Tooltip needs a focusable child even when disabled. */}
                                <span className="inline-flex">{button}</span>
                            </TooltipTrigger>
                            <TooltipContent>{reason}</TooltipContent>
                        </Tooltip>
                    </span>
                );
            })}
        </div>
    );
}
