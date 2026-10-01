// Floating chrome shared by the bbox and polygon editors: zoom controls,
// the autosave indicator, and the contextual hint pill.

import type { ReactNode } from 'react';
import { CloudUpload, Eye, EyeOff, Maximize, Minus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ZoomControlsProps {
    /** Current zoom, 1 = 100%. */
    scale: number;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFit: () => void;
    /** Detections overlay visibility toggle (optional). */
    overlayVisible?: boolean;
    onToggleOverlay?: () => void;
    className?: string;
}

export function ZoomControls({
    scale,
    onZoomIn,
    onZoomOut,
    onFit,
    overlayVisible,
    onToggleOverlay,
    className,
}: ZoomControlsProps) {
    return (
        <div className={cn('floating-panel pointer-events-auto flex items-center p-1', className)}>
            <Button
                variant="ghost"
                size="icon-sm"
                title="Zoom out (−)"
                aria-label="Zoom out"
                onClick={onZoomOut}
                className="size-7 text-muted-foreground hover:text-foreground"
            >
                <Minus />
            </Button>
            <div
                className="min-w-12 px-1 text-center font-mono text-xs font-medium text-foreground tabular-nums"
                aria-live="polite"
            >
                {Math.round(scale * 100)}%
            </div>
            <Button
                variant="ghost"
                size="icon-sm"
                title="Zoom in (+)"
                aria-label="Zoom in"
                onClick={onZoomIn}
                className="size-7 text-muted-foreground hover:text-foreground"
            >
                <Plus />
            </Button>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <Button
                variant="ghost"
                size="icon-sm"
                title="Fit to window (0)"
                aria-label="Fit to window"
                onClick={onFit}
                className="size-7 text-muted-foreground hover:text-foreground"
            >
                <Maximize />
            </Button>
            {onToggleOverlay && (
                <Button
                    variant="ghost"
                    size="icon-sm"
                    title={overlayVisible ? 'Hide detections (or hold Ctrl)' : 'Show detections'}
                    aria-label={overlayVisible ? 'Hide detections' : 'Show detections'}
                    aria-pressed={!overlayVisible}
                    onClick={onToggleOverlay}
                    className={cn(
                        'size-7',
                        overlayVisible
                            ? 'text-muted-foreground hover:text-foreground'
                            : 'bg-muted text-foreground',
                    )}
                >
                    {overlayVisible ? <Eye /> : <EyeOff />}
                </Button>
            )}
        </div>
    );
}

/** "Saving" / "Save queued" pill; fades out when idle. */
export function SaveIndicator({ saving, pending = false }: { saving: boolean; pending?: boolean }) {
    const visible = saving || pending;
    return (
        <div
            className={cn(
                'floating-panel pointer-events-none flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-opacity duration-200 ease-out',
                visible ? 'opacity-100' : 'opacity-0',
            )}
            aria-hidden={!visible}
        >
            <CloudUpload className="size-3.5 animate-pulse text-primary" />
            <span>{saving ? 'Saving' : 'Save queued'}</span>
        </div>
    );
}

/** Pill that explains what the active tool expects next. */
export function CanvasHint({ children }: { children: ReactNode }) {
    return (
        <div className="floating-panel pointer-events-none flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
            {children}
        </div>
    );
}
