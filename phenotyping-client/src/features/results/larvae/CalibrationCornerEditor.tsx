// CalibrationCornerEditor (FE-034)
//
// Overlay shown on top of the polygon-editor SVG layer when the user is
// dragging the four calibration corners. Renders 4 draggable SVG circles +
// connecting lines, with a live mm-per-px preview readout below.

import { useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Button } from '@/components/ui/button';

import type { Point2D } from '@/types/api';

import { CORNER_LABELS, computeFactors, type Corners } from './calibrationMath';

interface CalibrationCornerEditorProps {
    /** Initial corners in image-pixel space (TL, TR, BR, BL). */
    initialCorners: Corners;
    realWmm: number;
    realHmm: number;
    saving?: boolean;
    onSave: (corners: Corners) => void;
    onCancel: () => void;
    /** Inverse of stage scale, so handles stay ~constant size on screen. */
    handleR?: number;
    /** Image dimensions for clamping. */
    imageWidth: number;
    imageHeight: number;
    /** Fired when corners change so the parent can update its readout overlay. */
    onCornersChange?: (c: Corners) => void;
}

interface DragState {
    cornerIdx: 0 | 1 | 2 | 3;
}

/**
 * Renders just the SVG handle group (caller is responsible for the wrapping
 * `<svg>` element so it composes with whatever pan/zoom transform the parent
 * already applies). Returns null content when no parent svg is in scope; pair
 * with `CalibrationCornerEditorChrome` for the floating Save/Cancel buttons.
 */
export function CalibrationCornerHandles({
    corners,
    onChange,
    handleR = 6,
    imageWidth,
    imageHeight,
    ctmRef,
}: {
    corners: Corners;
    onChange: (next: Corners) => void;
    handleR?: number;
    imageWidth: number;
    imageHeight: number;
    /** Element whose CTM maps image-space coords → screen coords. */
    ctmRef: React.RefObject<SVGGraphicsElement | null>;
}) {
    const [drag, setDrag] = useState<DragState | null>(null);

    const clientToImage = useCallback(
        (clientX: number, clientY: number): Point2D | null => {
            const el = ctmRef.current;
            if (!el) return null;
            const ctm = el.getScreenCTM();
            if (!ctm) return null;
            const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
            return [p.x, p.y];
        },
        [ctmRef],
    );

    const handlePointerDown = (
        e: ReactPointerEvent<SVGCircleElement>,
        idx: 0 | 1 | 2 | 3,
    ) => {
        e.stopPropagation();
        e.preventDefault();
        (e.target as SVGCircleElement).setPointerCapture(e.pointerId);
        setDrag({ cornerIdx: idx });
    };

    const handlePointerMove = (e: ReactPointerEvent<SVGCircleElement>) => {
        if (!drag) return;
        const p = clientToImage(e.clientX, e.clientY);
        if (!p) return;
        const x = Math.max(0, Math.min(imageWidth, p[0]));
        const y = Math.max(0, Math.min(imageHeight, p[1]));
        const next = corners.slice() as Corners;
        next[drag.cornerIdx] = [x, y];
        onChange(next);
    };

    const handlePointerUp = (e: ReactPointerEvent<SVGCircleElement>) => {
        if (drag) {
            (e.target as SVGCircleElement).releasePointerCapture?.(e.pointerId);
            setDrag(null);
        }
    };

    const polyPoints = corners.map(([x, y]) => `${x},${y}`).join(' ');

    return (
        <g data-calibration-corner-editor>
            <polygon
                points={polyPoints}
                fill="rgba(34,197,94,0.18)"
                stroke="rgb(34,197,94)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
            />
            {corners.map(([x, y], i) => (
                <g key={i}>
                    <circle
                        cx={x}
                        cy={y}
                        r={handleR}
                        fill="white"
                        stroke="rgb(22,163,74)"
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: 'grab', touchAction: 'none' }}
                        onPointerDown={(e) =>
                            handlePointerDown(e, i as 0 | 1 | 2 | 3)
                        }
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                    />
                    <text
                        x={x}
                        y={y - handleR - 4}
                        textAnchor="middle"
                        fontSize={handleR * 1.6}
                        fontWeight={600}
                        fill="rgb(22,163,74)"
                        stroke="white"
                        strokeWidth={0.4}
                        paintOrder="stroke"
                        pointerEvents="none"
                    >
                        {CORNER_LABELS[i]}
                    </text>
                </g>
            ))}
        </g>
    );
}

/** Floating chrome (preview readout + Re-detect / Save / Cancel) shown above the image. */
export function CalibrationCornerEditorChrome({
    corners,
    realWmm,
    realHmm,
    saving = false,
    onSave,
    onCancel,
    onRedetect,
    redetecting = false,
}: Pick<
    CalibrationCornerEditorProps,
    'realWmm' | 'realHmm' | 'saving' | 'onSave' | 'onCancel'
> & {
    corners: Corners;
    onRedetect?: () => void;
    redetecting?: boolean;
}) {
    const factors = computeFactors(corners, realWmm, realHmm);
    return (
        <div className="pointer-events-auto flex flex-col items-center gap-2 rounded-lg border bg-card p-3 shadow-sm">
            <div className="flex items-center gap-4 text-xs">
                <span className="text-muted-foreground">Live preview:</span>
                <span className="font-mono tabular-nums">
                    x {factors ? factors.mm_per_px_x.toFixed(4) : '—'} mm/px
                </span>
                <span className="font-mono tabular-nums">
                    y {factors ? factors.mm_per_px_y.toFixed(4) : '—'} mm/px
                </span>
            </div>
            <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
                    Cancel
                </Button>
                {onRedetect && (
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={onRedetect}
                        disabled={redetecting || saving}
                        title="Re-run auto-calibration on the green rectangle"
                    >
                        {redetecting ? 'Re-detecting…' : 'Re-detect'}
                    </Button>
                )}
                <Button
                    size="sm"
                    onClick={() => onSave(corners)}
                    disabled={!factors || saving}
                >
                    {saving ? 'Saving…' : 'Save calibration'}
                </Button>
            </div>
        </div>
    );
}
