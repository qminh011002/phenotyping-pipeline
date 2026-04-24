// OverlayImage — Konva-backed image viewer + annotation editor.
// A single Konva Stage owns the image, bbox rendering, zoom/pan, and (when
// the `editor` prop is provided) interactive editing: move / resize / draw /
// delete. Using one Stage instead of two SVGs means hit testing is unified
// and panning/zooming is handled by Konva's native transform (compositor-
// accelerated canvas, no per-pixel React renders).

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { CloudUpload, Minus, Plus } from 'lucide-react';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import {
    Circle,
    Group,
    Image as KonvaImage,
    Layer,
    Line,
    Rect,
    Shape,
    Stage,
    Transformer,
} from 'react-konva';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { BBox } from '@/types/api';
import { clampBox, enforceMinSize, MIN_BOX_SIZE, normalizeBox } from '../lib/bboxMath';

// ── Props ──────────────────────────────────────────────────────────────────

export interface OverlayImageEditor {
    /** drag = select/move/resize; draw = rubber-band new box (pan disabled). */
    mode: 'drag' | 'draw';
    /** Index into `annotations` of the selected box; null = none. */
    selectedIndex: number | null;
    /** Confidence threshold — model-origin boxes below this are hidden. */
    confidenceThreshold: number;
    /** Default class label assigned to user-drawn boxes. */
    defaultClass?: string;
    onSelect: (index: number | null) => void;
    /** Commit a finished gesture (once, on pointerup). */
    onCommit: (boxes: BBox[]) => void;
}

interface OverlayImageProps {
    src: string;
    alt?: string;
    annotations?: BBox[];
    className?: string;
    saveInProgress?: boolean;
    /**
     * When true, the two-level dim overlay is rendered. Hidden during active
     * drag/resize/draw and in draw mode so the user sees the raw pixels.
     */
    dimEnabled?: boolean;
    /**
     * When true (default), each box renders its class-name label above the
     * top-left corner. The label font size is computed from the current zoom
     * so screen size stays close to constant (softly inverse — see
     * LABEL_SCREEN_PX / LABEL_SCALE_EXPONENT below).
     */
    labelsVisible?: boolean;
    /**
     * Fired when the user clicks the empty background (pointerdown → up with
     * no drag). Used by the parent to deselect on empty-area clicks.
     */
    onBackgroundClick?: () => void;
    onDimensions?: (width: number, height: number) => void;
    /**
     * When provided, the component is in edit mode: boxes are interactive,
     * selection + resize handles + draw + delete are enabled.
     */
    editor?: OverlayImageEditor;
    /**
     * When true, render every non-selected box via a single rasterized canvas
     * instead of per-box Konva.Rect nodes. Big perf win at 1k+ boxes; same
     * pixels at natural image resolution. Defaults to false until proven on
     * the dense neonate-egg case.
     */
    useOffscreen?: boolean;
}

// ── Tunables ───────────────────────────────────────────────────────────────

const MIN_SCALE = 0.02;
const MAX_SCALE = 20;
const ZOOM_FACTOR = 1.15;
// Smaller = more wheel ticks per doubling. Roboflow-like finesse.
const WHEEL_ZOOM_SENSITIVITY = 0.0006;

const STROKE_MODEL = '#22c55e';
const STROKE_USER = '#f59e0b';
const STROKE_SELECTED = '#3b82f6';
const FILL_SELECTED = 'rgba(59,130,246,0.10)';

const DIM_OPACITY_BASE = 0.5;
const DIM_OPACITY_HOVER = 0.3; // additional dim on top of base

// The dim effect punches one destination-out rect per visible box — fine at
// tens or hundreds, but a real cost in the thousands. Above this count we
// drop the dim layer entirely: with that many boxes the scene is already
// saturated and the highlight effect adds no information.
const DIM_MAX_BOXES = 500;

const HANDLE_PX = 10;

// ── Label tunables ─────────────────────────────────────────────────────────
// Labels live in image coordinates but should look ~constant on screen.
// `screen_px = fontSize_image * scale`, so to make the *screen* size shrink
// when the user zooms in (and grow when they zoom out) we set
//   fontSize_image = LABEL_SCREEN_PX / scale^LABEL_SCALE_EXPONENT
// with the exponent slightly above 1 — "softly inverse": at 200% zoom labels
// are a touch smaller than baseline, at 50% zoom a touch larger.
const LABEL_SCREEN_PX = 10;
const LABEL_FG = '#f59e0b';

// ── Helpers ────────────────────────────────────────────────────────────────

function loadImageEl(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

function isVisible(b: BBox, threshold: number): boolean {
    return b.origin === 'user' || b.confidence >= threshold;
}

// ── Component ──────────────────────────────────────────────────────────────

export function OverlayImage({
    src,
    alt = 'Overlay',
    annotations = [],
    className,
    saveInProgress = false,
    dimEnabled = true,
    labelsVisible = true,
    onBackgroundClick,
    onDimensions,
    editor,
    useOffscreen = false,
}: OverlayImageProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<Konva.Stage>(null);
    const transformerRef = useRef<Konva.Transformer>(null);
    const selectedRectRef = useRef<Konva.Rect>(null);
    const deleteHandleRef = useRef<Konva.Group>(null);

    const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);
    const [imageError, setImageError] = useState(false);
    const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
    const [scale, setScale] = useState(1);
    const [hoverIdx, setHoverIdx] = useState<number | null>(null);
    // Transient preview boxes during a body drag or rubber-band draw.
    const [rubberBand, setRubberBand] = useState<[number, number, number, number] | null>(null);
    // True while a drag / resize / rubber-band is in flight — hides the dim layer.
    const [interacting, setInteracting] = useState(false);
    // Cursor in image coords — drives the draw-mode crosshair.
    const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

    const editing = editor !== undefined;
    const mode = editor?.mode ?? 'drag';
    const selectedIndex = editor?.selectedIndex ?? null;
    const confidenceThreshold = editor?.confidenceThreshold ?? 0;
    // Defer the threshold for the expensive raster + box filter. The slider in
    // the parent stays at 60 fps because React drops intermediate values that
    // arrive before the previous raster finishes — only the latest surviving
    // threshold rebuilds the canvas.
    const deferredThreshold = useDeferredValue(confidenceThreshold);

    const renderBoxes = annotations;

    // ── Load image ──────────────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        setImageEl(null);
        setImageError(false);
        setHoverIdx(null);
        if (!src) return;
        loadImageEl(src)
            .then((img) => {
                if (cancelled) return;
                setImageEl(img);
                onDimensions?.(img.naturalWidth, img.naturalHeight);
            })
            .catch(() => {
                if (cancelled) return;
                setImageError(true);
            });
        return () => {
            cancelled = true;
        };
    }, [src, onDimensions]);

    // ── Track container size ────────────────────────────────────────────────
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const measure = () => {
            setStageSize({ width: el.clientWidth, height: el.clientHeight });
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // ── Fit-to-screen whenever image or container size changes ──────────────
    const fitToScreen = useCallback(() => {
        const stage = stageRef.current;
        if (!stage || !imageEl || stageSize.width === 0 || stageSize.height === 0) return;
        const iw = imageEl.naturalWidth;
        const ih = imageEl.naturalHeight;
        const fit = Math.min(stageSize.width / iw, stageSize.height / ih, 1);
        stage.scale({ x: fit, y: fit });
        // Center image in stage.
        stage.position({
            x: (stageSize.width - iw * fit) / 2,
            y: (stageSize.height - ih * fit) / 2,
        });
        stage.batchDraw();
        setScale(fit);
    }, [imageEl, stageSize.height, stageSize.width]);

    useEffect(() => {
        fitToScreen();
    }, [fitToScreen]);

    // ── Attach Transformer to the selected rect ─────────────────────────────
    useEffect(() => {
        const tr = transformerRef.current;
        const rect = selectedRectRef.current;
        if (!tr) return;
        if (editing && mode === 'drag' && rect && selectedIndex !== null) {
            tr.nodes([rect]);
            tr.getLayer()?.batchDraw();
        } else {
            tr.nodes([]);
            tr.getLayer()?.batchDraw();
        }
    }, [editing, mode, selectedIndex, renderBoxes]);

    // ── Zoom (wheel) — rAF-coalesced so fast scrolls don't queue frames ─────
    const wheelAccumRef = useRef<{
        deltaY: number;
        pointer: { x: number; y: number } | null;
    }>({ deltaY: 0, pointer: null });
    const wheelRafRef = useRef<number | null>(null);

    const handleWheel = useCallback((e: KonvaEventObject<WheelEvent>) => {
        e.evt.preventDefault();
        const stage = stageRef.current;
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;

        // Accumulate deltaY; commit once per animation frame.
        wheelAccumRef.current.deltaY += e.evt.deltaY;
        wheelAccumRef.current.pointer = { x: pointer.x, y: pointer.y };

        if (wheelRafRef.current !== null) return;
        wheelRafRef.current = requestAnimationFrame(() => {
            wheelRafRef.current = null;
            const { deltaY, pointer: p } = wheelAccumRef.current;
            wheelAccumRef.current.deltaY = 0;
            wheelAccumRef.current.pointer = null;
            if (!p) return;

            const oldScale = stage.scaleX();
            // Clamp the accumulated delta so a single frame can't over-zoom.
            const delta = Math.max(-240, Math.min(240, deltaY));
            const factor = Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY);
            const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor));
            if (newScale === oldScale) return;

            const mousePointTo = {
                x: (p.x - stage.x()) / oldScale,
                y: (p.y - stage.y()) / oldScale,
            };
            stage.scale({ x: newScale, y: newScale });
            stage.position({
                x: p.x - mousePointTo.x * newScale,
                y: p.y - mousePointTo.y * newScale,
            });
            stage.batchDraw();
            setScale(newScale);
        });
    }, []);

    useEffect(() => {
        return () => {
            if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current);
        };
    }, []);

    // ── Zoom buttons ────────────────────────────────────────────────────────
    const zoomByFactor = useCallback((factor: number) => {
        const stage = stageRef.current;
        if (!stage) return;
        const oldScale = stage.scaleX();
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor));
        if (newScale === oldScale) return;
        // Zoom around stage center.
        const cx = stage.width() / 2;
        const cy = stage.height() / 2;
        const mousePointTo = {
            x: (cx - stage.x()) / oldScale,
            y: (cy - stage.y()) / oldScale,
        };
        stage.scale({ x: newScale, y: newScale });
        stage.position({
            x: cx - mousePointTo.x * newScale,
            y: cy - mousePointTo.y * newScale,
        });
        stage.batchDraw();
        setScale(newScale);
    }, []);

    const handleZoomIn = useCallback(() => zoomByFactor(ZOOM_FACTOR), [zoomByFactor]);
    const handleZoomOut = useCallback(() => zoomByFactor(1 / ZOOM_FACTOR), [zoomByFactor]);

    // ── Keyboard shortcuts for zoom/fit ─────────────────────────────────────
    useEffect(() => {
        function handleKeyDown(e: KeyboardEvent) {
            const inputFocused =
                e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
            if (inputFocused) return;
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                handleZoomIn();
            } else if (e.key === '-') {
                e.preventDefault();
                handleZoomOut();
            } else if (e.key === '0') {
                e.preventDefault();
                fitToScreen();
            }
        }
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [fitToScreen, handleZoomIn, handleZoomOut]);

    // ── Pointer → image-space helper ────────────────────────────────────────
    const getImagePointer = useCallback(() => {
        const stage = stageRef.current;
        if (!stage) return null;
        const pointer = stage.getPointerPosition();
        if (!pointer) return null;
        const inv = stage.getAbsoluteTransform().copy().invert();
        return inv.point(pointer);
    }, []);

    // ── Background click (deselect) ─────────────────────────────────────────
    // Konva gives us this reliably: a click on the Stage (target === stage)
    // means nothing else was clicked.
    const backgroundDownPos = useRef<{ x: number; y: number } | null>(null);
    const backgroundMoved = useRef(false);

    const handleStageMouseDown = useCallback((e: KonvaEventObject<MouseEvent | TouchEvent>) => {
        const stage = stageRef.current;
        if (!stage) return;
        // Only track as background press if the target is the stage itself
        // (not a shape).
        if (e.target === stage) {
            const p = stage.getPointerPosition();
            backgroundDownPos.current = p ? { x: p.x, y: p.y } : null;
            backgroundMoved.current = false;
        } else {
            backgroundDownPos.current = null;
        }
    }, []);

    const handleStageMouseMove = useCallback(() => {
        const stage = stageRef.current;
        if (!stage) return;
        // Track cursor for the draw-mode crosshair on every move, not only while
        // pressing. This is what makes the crosshair follow the pointer from the
        // moment the user enters draw mode.
        if (mode === 'draw') {
            const pt = getImagePointer();
            if (pt) setCursor(pt);
        }
        if (backgroundDownPos.current) {
            const p = stage.getPointerPosition();
            if (!p) return;
            const dx = p.x - backgroundDownPos.current.x;
            const dy = p.y - backgroundDownPos.current.y;
            if (Math.hypot(dx, dy) > 3) backgroundMoved.current = true;
        }
    }, [getImagePointer, mode]);

    // Reset cursor when leaving draw mode or the stage.
    useEffect(() => {
        if (mode !== 'draw') setCursor(null);
    }, [mode]);

    const handleStageMouseUp = useCallback(() => {
        if (backgroundDownPos.current && !backgroundMoved.current) {
            onBackgroundClick?.();
        }
        backgroundDownPos.current = null;
        backgroundMoved.current = false;
    }, [onBackgroundClick]);

    // ── Draw mode: rubber-band ──────────────────────────────────────────────
    const drawStartRef = useRef<{ x: number; y: number } | null>(null);

    const handleStageMouseDownDraw = useCallback(
        (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
            if (!editing || mode !== 'draw') return;
            const stage = stageRef.current;
            if (!stage) return;
            const evtButton = 'button' in e.evt ? e.evt.button : 0;
            if (evtButton !== 0) return;
            const pt = getImagePointer();
            if (!pt) return;
            drawStartRef.current = pt;
            setRubberBand([pt.x, pt.y, pt.x, pt.y]);
            setInteracting(true);
        },
        [editing, mode, getImagePointer],
    );

    const handleStageMouseMoveDraw = useCallback(() => {
        if (!editing || mode !== 'draw' || !drawStartRef.current) return;
        const pt = getImagePointer();
        if (!pt) return;
        const { x: sx, y: sy } = drawStartRef.current;
        setRubberBand([sx, sy, pt.x, pt.y]);
    }, [editing, mode, getImagePointer]);

    const handleStageMouseUpDraw = useCallback(() => {
        if (!editing || mode !== 'draw' || !drawStartRef.current || !editor) return;
        const pt = getImagePointer();
        if (!pt || !imageEl) {
            drawStartRef.current = null;
            setRubberBand(null);
            setInteracting(false);
            return;
        }
        const { x: sx, y: sy } = drawStartRef.current;
        drawStartRef.current = null;
        setRubberBand(null);
        setInteracting(false);
        const [nx1, ny1, nx2, ny2] = normalizeBox(sx, sy, pt.x, pt.y);
        const enforced = enforceMinSize(nx1, ny1, nx2, ny2);
        if (!enforced) return;
        const clamped = clampBox(enforced, imageEl.naturalWidth, imageEl.naturalHeight);
        const newBox: BBox = {
            label: editor.defaultClass ?? 'object',
            bbox: clamped,
            confidence: 1.0,
            origin: 'user',
            edited_at: new Date().toISOString(),
        };
        const next = [...annotations, newBox];
        editor.onCommit(next);
        editor.onSelect(next.length - 1);
    }, [editing, mode, editor, getImagePointer, imageEl, annotations]);

    // ── Box drag (move) ─────────────────────────────────────────────────────
    const handleBoxDragStart = useCallback(
        (index: number) => {
            if (!editing || mode !== 'drag' || !editor) return;
            editor.onSelect(index);
            setInteracting(true);
        },
        [editing, mode, editor],
    );

    const handleBoxDragMove = useCallback(
        (index: number, e: KonvaEventObject<DragEvent>) => {
            if (!editing || !imageEl) return;
            // Clamp to image bounds. Konva moves the rect imperatively each frame,
            // so we DON'T call setState here — that would trigger React renders on
            // every pointermove. The bbox is read back from the node on dragEnd.
            const node = e.target;
            const [x1, y1, x2, y2] = annotations[index].bbox;
            const w = x2 - x1;
            const h = y2 - y1;
            const nx = Math.max(0, Math.min(imageEl.naturalWidth - w, node.x()));
            const ny = Math.max(0, Math.min(imageEl.naturalHeight - h, node.y()));
            if (nx !== node.x()) node.x(nx);
            if (ny !== node.y()) node.y(ny);
            // Keep the delete icon pinned to the box top-left as it moves.
            deleteHandleRef.current?.position({ x: nx, y: ny });
        },
        [editing, imageEl, annotations],
    );

    const handleBoxDragEnd = useCallback(
        (index: number, e: KonvaEventObject<DragEvent>) => {
            if (!editing || !editor || !imageEl) {
                setInteracting(false);
                return;
            }
            const node = e.target;
            const [x1, y1, x2, y2] = annotations[index].bbox;
            const w = x2 - x1;
            const h = y2 - y1;
            const nx = Math.max(0, Math.min(imageEl.naturalWidth - w, node.x()));
            const ny = Math.max(0, Math.min(imageEl.naturalHeight - h, node.y()));
            const next = annotations.slice();
            next[index] = {
                ...next[index],
                bbox: [nx, ny, nx + w, ny + h],
                origin: 'user',
                edited_at: new Date().toISOString(),
            };
            setInteracting(false);
            editor.onCommit(next);
        },
        [editing, editor, imageEl, annotations],
    );

    // ── Transformer resize (selected box) ───────────────────────────────────
    const handleTransformStart = useCallback(() => {
        setInteracting(true);
    }, []);

    // Fires continuously during resize — keep the delete icon pinned to the
    // rect's (possibly-moving) top-left corner.
    const handleTransform = useCallback(() => {
        const rect = selectedRectRef.current;
        const handle = deleteHandleRef.current;
        if (!rect || !handle) return;
        // During transform the rect's scale is !=1; compute the true top-left.
        const sx = rect.scaleX();
        const sy = rect.scaleY();
        const w = rect.width() * sx;
        const h = rect.height() * sy;
        // When scale goes negative (flipped), offset origin accordingly.
        const x = rect.x() + (w < 0 ? w : 0);
        const y = rect.y() + (h < 0 ? h : 0);
        handle.position({ x, y });
    }, []);

    const handleTransformEnd = useCallback(() => {
        if (!editing || !editor || selectedIndex === null || !imageEl) {
            setInteracting(false);
            return;
        }
        const rect = selectedRectRef.current;
        if (!rect) {
            setInteracting(false);
            return;
        }
        // Read the transformed geometry and bake scale back into width/height.
        const scaleX = rect.scaleX();
        const scaleY = rect.scaleY();
        const newW = Math.max(MIN_BOX_SIZE, rect.width() * scaleX);
        const newH = Math.max(MIN_BOX_SIZE, rect.height() * scaleY);
        let nx1 = rect.x();
        let ny1 = rect.y();
        let nx2 = nx1 + newW;
        let ny2 = ny1 + newH;
        [nx1, ny1, nx2, ny2] = clampBox(
            [nx1, ny1, nx2, ny2],
            imageEl.naturalWidth,
            imageEl.naturalHeight,
        );
        rect.scaleX(1);
        rect.scaleY(1);
        rect.width(nx2 - nx1);
        rect.height(ny2 - ny1);
        rect.x(nx1);
        rect.y(ny1);

        const next = annotations.slice();
        next[selectedIndex] = {
            ...next[selectedIndex],
            bbox: [nx1, ny1, nx2, ny2],
            origin: 'user',
            edited_at: new Date().toISOString(),
        };
        setInteracting(false);
        editor.onCommit(next);
    }, [editing, editor, selectedIndex, imageEl, annotations]);

    // ── Delete selected (handled via button inside selected box) ────────────
    const handleDeleteSelected = useCallback(() => {
        if (!editing || !editor || selectedIndex === null) return;
        const next = annotations.filter((_, i) => i !== selectedIndex);
        editor.onCommit(next);
        editor.onSelect(null);
    }, [editing, editor, selectedIndex, annotations]);

    // ── Derived geometry ────────────────────────────────────────────────────
    const imageSize = imageEl
        ? { width: imageEl.naturalWidth, height: imageEl.naturalHeight }
        : null;

    // Visible boxes after confidence filter.
    const visibleBoxesWithIdx = useMemo(() => {
        return renderBoxes
            .map((b, i) => ({ box: b, index: i }))
            .filter(({ box }) => isVisible(box, deferredThreshold));
    }, [renderBoxes, deferredThreshold]);

    // Rasterize all non-selected boxes off the main thread via a Web Worker
    // that writes into an OffscreenCanvas and transfers back an ImageBitmap.
    // The main thread never allocates the full-resolution canvas or strokes
    // thousands of rects, so the slider / zoom / pan stay at 60 fps no matter
    // how many boxes there are. Stale responses are dropped by request id.
    const [rasterBitmap, setRasterBitmap] = useState<ImageBitmap | null>(null);
    const workerRef = useRef<Worker | null>(null);
    const latestReqIdRef = useRef(0);

    useEffect(() => {
        const worker = new Worker(
            new URL('../lib/rasterizeBoxes.worker.ts', import.meta.url),
            { type: 'module' },
        );
        workerRef.current = worker;
        worker.onmessage = (
            e: MessageEvent<{ id: number; bitmap: ImageBitmap }>,
        ) => {
            if (e.data.id !== latestReqIdRef.current) {
                // Stale — close the bitmap to free its GPU memory.
                e.data.bitmap.close();
                return;
            }
            setRasterBitmap((prev) => {
                prev?.close();
                return e.data.bitmap;
            });
        };
        return () => {
            worker.terminate();
            workerRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!useOffscreen || !imageEl || !workerRef.current) {
            setRasterBitmap((prev) => {
                prev?.close();
                return null;
            });
            return;
        }
        const id = ++latestReqIdRef.current;
        workerRef.current.postMessage({
            id,
            imageWidth: imageEl.naturalWidth,
            imageHeight: imageEl.naturalHeight,
            boxes: renderBoxes,
            excludeIndex: editing && mode === 'drag' ? selectedIndex : null,
            confidenceThreshold: deferredThreshold,
            strokeModel: STROKE_MODEL,
            strokeUser: STROKE_USER,
            strokeWidth: 1,
            ssaa: 2,
            // Labels are drawn separately in screen space via a single Konva
            // Shape so they stay the same size on screen across zoom levels.
            labelFontSize: 0,
        });
    }, [useOffscreen, imageEl, renderBoxes, selectedIndex, editing, mode, deferredThreshold]);

    // Edit-mode click-to-select when non-selected boxes are inside the raster
    // (they have no individual Konva nodes to listen on). AABB test in reverse
    // order so top-drawn boxes win, matching the per-Rect path's z-order.
    const handleRasterClick = useCallback(() => {
        if (!editing || mode !== 'drag' || !editor) return;
        const pt = getImagePointer();
        if (!pt) return;
        for (let i = visibleBoxesWithIdx.length - 1; i >= 0; i--) {
            const { box, index } = visibleBoxesWithIdx[i];
            if (index === selectedIndex) continue;
            const [x1, y1, x2, y2] = box.bbox;
            if (pt.x >= x1 && pt.x <= x2 && pt.y >= y1 && pt.y <= y2) {
                editor.onSelect(index);
                return;
            }
        }
        editor.onSelect(null);
    }, [editing, mode, editor, getImagePointer, visibleBoxesWithIdx, selectedIndex]);

    // Dim is hidden during interaction, in draw mode, and when the box count
    // exceeds DIM_MAX_BOXES (the destination-out compositing becomes the hot
    // loop otherwise).
    const showDim =
        dimEnabled &&
        !interacting &&
        mode !== 'draw' &&
        visibleBoxesWithIdx.length <= DIM_MAX_BOXES;

    const hovered = hoverIdx !== null ? renderBoxes[hoverIdx] : null;

    const stageDraggable = editing ? mode === 'drag' : true;

    const cursorStyle = mode === 'draw' ? 'crosshair' : stageDraggable ? 'grab' : 'default';

    const invScale = 1 / Math.max(scale, 0.001);
    const handleSize = HANDLE_PX * invScale;

    // With useOffscreen: non-selected boxes live inside rasterCanvas, so the
    // per-box <Rect> loop only needs to render the selected one (for its
    // Transformer + drag handlers). Without useOffscreen: render all of them
    // as before.
    const rectBoxes = useOffscreen
        ? visibleBoxesWithIdx.filter(
              ({ index }) => editing && mode === 'drag' && index === selectedIndex,
          )
        : visibleBoxesWithIdx;

    return (
        <div className={cn('h-full', className)}>
            <div
                ref={containerRef}
                className="relative h-full overflow-hidden bg-muted/20 select-none"
                style={{ cursor: cursorStyle }}
            >
                {/* Zoom controls */}
                <div className="pointer-events-none absolute bottom-4 left-4 z-20">
                    <div className="pointer-events-auto flex items-center rounded-[12px] border border-cyan-400/40 bg-card/70 px-1.5 py-1 text-cyan-50 shadow-[0_14px_40px_rgba(0,0,0,0.32)] backdrop-blur-md">
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Zoom out (-)"
                            onClick={handleZoomOut}
                            className="h-8 w-8 rounded-[10px] text-cyan-300 hover:bg-cyan-500/12 hover:text-cyan-100 disabled:text-cyan-900"
                        >
                            <Minus className="h-4 w-4" />
                        </Button>
                        <div className="min-w-16 px-0.5 text-center font-mono text-[1.05rem] font-semibold tabular-nums tracking-[-0.03em] text-slate-100">
                            {Math.round(scale * 100)}%
                        </div>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Zoom in (+)"
                            onClick={handleZoomIn}
                            className="h-8 w-8 rounded-[10px] text-cyan-300 hover:bg-cyan-500/12 hover:text-cyan-100 disabled:text-cyan-900"
                        >
                            <Plus className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            title="Reset to fit the viewport (0)"
                            onClick={fitToScreen}
                            className="h-8 rounded-[10px] px-2.5 text-[11px] font-bold tracking-[0.12em] text-cyan-300 hover:bg-cyan-500/12 hover:text-cyan-100"
                        >
                            RESET
                        </Button>
                        {saveInProgress && (
                            <div className="ml-1 flex items-center gap-1 rounded-[10px] border border-cyan-400/25 bg-cyan-500/8 px-2 py-1 text-[11px] font-semibold tracking-[0.08em] text-cyan-100">
                                <CloudUpload className="h-3.5 w-3.5 animate-pulse" />
                                <span>SAVING</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Placeholders */}
                {!src && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                        <svg
                            className="h-10 w-10"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.5}
                                d="M3 16l5-5 4 4 5-5 4 4M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z"
                            />
                        </svg>
                        <p className="text-sm">Raw image unavailable</p>
                        <p className="max-w-xs text-center text-xs text-muted-foreground/70">
                            Re-run the analysis so the uploaded file is available for display.
                        </p>
                    </div>
                )}
                {src && !imageEl && !imageError && (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <Skeleton className="h-full w-full" />
                    </div>
                )}
                {imageError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                        <svg
                            className="h-10 w-10"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.5}
                                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                        </svg>
                        <p className="text-sm">Failed to load image</p>
                        <p className="text-xs text-muted-foreground/60">{alt}</p>
                    </div>
                )}

                {/* Konva Stage */}
                {imageEl && imageSize && stageSize.width > 0 && stageSize.height > 0 && (
                    <Stage
                        ref={stageRef}
                        width={stageSize.width}
                        height={stageSize.height}
                        draggable={stageDraggable}
                        onWheel={handleWheel}
                        onMouseDown={(e) => {
                            handleStageMouseDown(e);
                            handleStageMouseDownDraw(e);
                        }}
                        onMouseMove={() => {
                            handleStageMouseMove();
                            handleStageMouseMoveDraw();
                        }}
                        onMouseUp={() => {
                            handleStageMouseUp();
                            handleStageMouseUpDraw();
                        }}
                        onTouchStart={(e) => {
                            handleStageMouseDown(e);
                            handleStageMouseDownDraw(e);
                        }}
                        onTouchMove={() => {
                            handleStageMouseMove();
                            handleStageMouseMoveDraw();
                        }}
                        onTouchEnd={() => {
                            handleStageMouseUp();
                            handleStageMouseUpDraw();
                        }}
                    >
                        {/* Image layer */}
                        <Layer listening={false} imageSmoothingEnabled={false}>
                            <KonvaImage
                                image={imageEl}
                                width={imageSize.width}
                                height={imageSize.height}
                                imageSmoothingEnabled={false}
                            />
                        </Layer>

                        {/* Dim layer — one rect covering the image with holes punched out
                over every visible box via destination-out. */}
                        {showDim && (
                            <Layer listening={false}>
                                <Group>
                                    <Rect
                                        x={0}
                                        y={0}
                                        width={imageSize.width}
                                        height={imageSize.height}
                                        fill="black"
                                        opacity={DIM_OPACITY_BASE}
                                    />
                                    {visibleBoxesWithIdx.map(({ box, index }) => {
                                        const [x1, y1, x2, y2] = box.bbox;
                                        return (
                                            <Rect
                                                key={`dim-${index}`}
                                                x={x1}
                                                y={y1}
                                                width={Math.max(0, x2 - x1)}
                                                height={Math.max(0, y2 - y1)}
                                                fill="black"
                                                globalCompositeOperation="destination-out"
                                            />
                                        );
                                    })}
                                </Group>
                                {hovered && (
                                    <Group>
                                        <Rect
                                            x={0}
                                            y={0}
                                            width={imageSize.width}
                                            height={imageSize.height}
                                            fill="black"
                                            opacity={DIM_OPACITY_HOVER}
                                        />
                                        <Rect
                                            x={hovered.bbox[0]}
                                            y={hovered.bbox[1]}
                                            width={Math.max(0, hovered.bbox[2] - hovered.bbox[0])}
                                            height={Math.max(0, hovered.bbox[3] - hovered.bbox[1])}
                                            fill="black"
                                            globalCompositeOperation="destination-out"
                                        />
                                    </Group>
                                )}
                            </Layer>
                        )}

                        {/* Draw-mode crosshair */}
                        {editing && mode === 'draw' && cursor && (
                            <Layer listening={false}>
                                <Line
                                    points={[0, cursor.y, imageSize.width, cursor.y]}
                                    stroke="white"
                                    strokeWidth={1}
                                    strokeScaleEnabled={false}
                                    dash={[6, 4]}
                                    opacity={0.8}
                                />
                                <Line
                                    points={[cursor.x, 0, cursor.x, imageSize.height]}
                                    stroke="white"
                                    strokeWidth={1}
                                    strokeScaleEnabled={false}
                                    dash={[6, 4]}
                                    opacity={0.8}
                                />
                            </Layer>
                        )}

                        {/* Boxes layer — interactive when editing, display-only otherwise */}
                        <Layer>
                            {/* Rasterized non-selected boxes (useOffscreen path).
                  One KonvaImage node for thousands of strokes. Click is
                  routed to an AABB hit test so edit-mode selection works. */}
                            {useOffscreen && rasterBitmap && (
                                <KonvaImage
                                    image={rasterBitmap as unknown as HTMLImageElement}
                                    width={imageSize.width}
                                    height={imageSize.height}
                                    listening={editing && mode === 'drag'}
                                    onClick={handleRasterClick}
                                    onTap={handleRasterClick}
                                    perfectDrawEnabled={false}
                                    shadowForStrokeEnabled={false}
                                />
                            )}
                            {rectBoxes.map(({ box, index }) => {
                                const [x1, y1, x2, y2] = box.bbox;
                                const w = Math.max(0, x2 - x1);
                                const h = Math.max(0, y2 - y1);
                                const isSelected = editing && selectedIndex === index;
                                const stroke = isSelected
                                    ? STROKE_SELECTED
                                    : box.origin === 'user'
                                      ? STROKE_USER
                                      : STROKE_MODEL;
                                const isHover = hoverIdx === index;
                                const commonProps = {
                                    x: x1,
                                    y: y1,
                                    width: w,
                                    height: h,
                                    fill: isSelected ? FILL_SELECTED : 'transparent',
                                    stroke,
                                    strokeWidth: isHover || isSelected ? 2 : 1,
                                    strokeScaleEnabled: false,
                                    // Konva perf flags — skip extra drawing passes we don't need.
                                    perfectDrawEnabled: false,
                                    shadowForStrokeEnabled: false,
                                };
                                if (editing && mode === 'drag') {
                                    return (
                                        <Rect
                                            key={`box-${index}`}
                                            ref={isSelected ? selectedRectRef : undefined}
                                            {...commonProps}
                                            draggable
                                            onMouseEnter={() => setHoverIdx(index)}
                                            onMouseLeave={() =>
                                                setHoverIdx((p) => (p === index ? null : p))
                                            }
                                            onClick={() => editor?.onSelect(index)}
                                            onTap={() => editor?.onSelect(index)}
                                            onDragStart={() => handleBoxDragStart(index)}
                                            onDragMove={(e) => handleBoxDragMove(index, e)}
                                            onDragEnd={(e) => handleBoxDragEnd(index, e)}
                                        />
                                    );
                                }
                                // View / draw mode: non-interactive hover detect (only in view).
                                return (
                                    <Rect
                                        key={`box-${index}`}
                                        {...commonProps}
                                        listening={!editing}
                                        onMouseEnter={() => !editing && setHoverIdx(index)}
                                        onMouseLeave={() =>
                                            !editing && setHoverIdx((p) => (p === index ? null : p))
                                        }
                                    />
                                );
                            })}

                            {/* Transformer — resize handles for the selected box */}
                            {editing && mode === 'drag' && (
                                <Transformer
                                    ref={transformerRef}
                                    rotateEnabled={false}
                                    keepRatio={false}
                                    borderStroke={STROKE_SELECTED}
                                    anchorStroke={STROKE_SELECTED}
                                    anchorFill="white"
                                    anchorSize={HANDLE_PX}
                                    ignoreStroke
                                    flipEnabled={false}
                                    boundBoxFunc={(_oldBox, newBox) => {
                                        if (
                                            Math.abs(newBox.width) < MIN_BOX_SIZE ||
                                            Math.abs(newBox.height) < MIN_BOX_SIZE
                                        )
                                            return _oldBox;
                                        return newBox;
                                    }}
                                    onTransformStart={handleTransformStart}
                                    onTransform={handleTransform}
                                    onTransformEnd={handleTransformEnd}
                                />
                            )}

                            {/* Delete handle for selected box */}
                            {editing &&
                                mode === 'drag' &&
                                selectedIndex !== null &&
                                renderBoxes[selectedIndex] && (
                                    <DeleteHandle
                                        groupRef={deleteHandleRef}
                                        x={renderBoxes[selectedIndex].bbox[0]}
                                        y={renderBoxes[selectedIndex].bbox[1]}
                                        size={handleSize * 1.6}
                                        onClick={handleDeleteSelected}
                                    />
                                )}

                            {/* Class-name labels (above each visible box). Rendered last so
                  they sit on top of strokes; non-listening so they never
                  interfere with selection / drag hit testing. Density-gated:
                  skipped entirely when there are too many boxes to read or
                  the effective on-screen font size is sub-readable — this
                  drops the text-layout cost that dominates dense scenes. */}
                            {labelsVisible && (
                                <Shape
                                    listening={false}
                                    perfectDrawEnabled={false}
                                    // Scene cache key: force a re-draw when zoom or the
                                    // visible set changes. The sceneFunc closure reads
                                    // fresh refs each invocation anyway.
                                    sceneFunc={(context) => {
                                        const stage = stageRef.current;
                                        if (!stage) return;
                                        const ctx = context._context as CanvasRenderingContext2D;
                                        const tx = stage.x();
                                        const ty = stage.y();
                                        const s = stage.scaleX();
                                        ctx.save();
                                        // Draw in SCREEN space so font size stays constant
                                        // regardless of zoom.
                                        ctx.setTransform(1, 0, 0, 1, 0, 0);
                                        ctx.font = `bold ${LABEL_SCREEN_PX}px sans-serif`;
                                        // Bottom baseline so `y` is the text's bottom
                                        // edge — makes "sit on top of the box" trivial.
                                        ctx.textBaseline = 'bottom';
                                        ctx.fillStyle = LABEL_FG;
                                        const LABEL_GAP = 2;
                                        for (let i = 0; i < visibleBoxesWithIdx.length; i++) {
                                            const { box } = visibleBoxesWithIdx[i];
                                            const [x1, y1] = box.bbox;
                                            const sx = x1 * s + tx;
                                            const sy = y1 * s + ty;
                                            // Sit the text's bottom LABEL_GAP pixels above
                                            // the box top. Flip inside when the label would
                                            // clip off the top of the viewport.
                                            const yText =
                                                sy - LABEL_GAP < LABEL_SCREEN_PX
                                                    ? sy + LABEL_SCREEN_PX + LABEL_GAP
                                                    : sy - LABEL_GAP;
                                            ctx.fillText(box.label || 'object', sx, yText);
                                        }
                                        ctx.restore();
                                    }}
                                />
                            )}

                            {/* Rubber-band while drawing */}
                            {editing &&
                                mode === 'draw' &&
                                rubberBand &&
                                (() => {
                                    const [rx1, ry1, rx2, ry2] = normalizeBox(
                                        rubberBand[0],
                                        rubberBand[1],
                                        rubberBand[2],
                                        rubberBand[3],
                                    );
                                    return (
                                        <Rect
                                            x={rx1}
                                            y={ry1}
                                            width={Math.max(0, rx2 - rx1)}
                                            height={Math.max(0, ry2 - ry1)}
                                            fill={FILL_SELECTED}
                                            stroke={STROKE_SELECTED}
                                            strokeWidth={1.5}
                                            strokeScaleEnabled={false}
                                            dash={[4, 3]}
                                            listening={false}
                                        />
                                    );
                                })()}
                        </Layer>
                    </Stage>
                )}
            </div>
        </div>
    );
}

// ── Delete handle (small red X on NW corner of selected box) ──────────────
// The Group is positioned at the box's top-left (x, y) and children are laid
// out at negative offsets so the icon floats just outside the box. Because
// the group carries the position, callers can move the icon imperatively by
// setting `group.position({x, y})` — used to track the rect during Konva drag.

interface DeleteHandleProps {
    x: number;
    y: number;
    size: number;
    onClick: () => void;
    groupRef?: React.Ref<Konva.Group>;
}

function DeleteHandle({ x, y, size, onClick, groupRef }: DeleteHandleProps) {
    const r = size / 2;
    // Children are positioned relative to the group origin (= box top-left).
    const cx = -r * 0.6;
    const cy = -r * 0.6;
    return (
        <Group
            ref={groupRef}
            x={x}
            y={y}
            onClick={(e) => {
                e.cancelBubble = true;
                onClick();
            }}
            onTap={(e) => {
                e.cancelBubble = true;
                onClick();
            }}
        >
            <Circle
                x={cx}
                y={cy}
                radius={r}
                fill="#ef4444"
                stroke="white"
                strokeWidth={Math.max(1, r * 0.18)}
                strokeScaleEnabled={false}
            />
            <Line
                points={[cx - r * 0.4, cy - r * 0.4, cx + r * 0.4, cy + r * 0.4]}
                stroke="white"
                strokeWidth={Math.max(1, r * 0.22)}
                strokeScaleEnabled={false}
                lineCap="round"
            />
            <Line
                points={[cx + r * 0.4, cy - r * 0.4, cx - r * 0.4, cy + r * 0.4]}
                stroke="white"
                strokeWidth={Math.max(1, r * 0.22)}
                strokeScaleEnabled={false}
                lineCap="round"
            />
        </Group>
    );
}
