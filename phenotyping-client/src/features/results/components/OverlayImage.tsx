// OverlayImage — Konva-backed image viewer + bounding-box editor.
//
// A single Konva Stage owns the image, the boxes, zoom/pan and (when the
// `editor` prop is provided) the edit interactions: select / move / resize /
// draw / erase.
//
// Rendering is arranged so the cost of a frame does not grow with the number
// of React nodes (egg images routinely carry 1,000+ boxes):
//   - every box is stroked by ONE Konva Shape (a single canvas path), on a
//     non-listening layer, culled to the viewport;
//   - only the hovered and the selected box exist as real Konva nodes — those
//     are the only ones that can be dragged, resized or clicked;
//   - "which box is under the pointer" is an AABB scan over plain arrays, so
//     hovering never re-renders or re-binds listeners on the other boxes;
//   - the dim/spotlight is one more Shape; pan, zoom and box drags mutate the
//     stage imperatively and commit to React once.

import {
    memo,
    useCallback,
    useDeferredValue,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from 'react';
import { Trash2 } from 'lucide-react';
import Konva from 'konva';
import type { Context } from 'konva/lib/Context';
import type { KonvaEventObject } from 'konva/lib/Node';
import { Image as KonvaImage, Layer, Line, Rect, Shape, Stage, Transformer } from 'react-konva';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { http } from '@/services/http';
import type { BBox } from '@/types/api';

import { clampBox, enforceMinSize, MIN_BOX_SIZE, normalizeBox, pickBoxAt } from '../lib/bboxMath';
import { CanvasHint, SaveIndicator, ZoomControls } from './ViewerChrome';

// ── Props ──────────────────────────────────────────────────────────────────

export type OverlayImageTool = 'drag' | 'draw' | 'erase';

export interface OverlayImageEditor {
    /**
     * drag  = select / move / resize, drag empty space to pan;
     * draw  = rubber-band a new box (pan with Space or the middle button);
     * erase = click a box to delete it, drag to pan.
     */
    mode: OverlayImageTool;
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
    /** An autosave request is in flight. */
    saveInProgress?: boolean;
    /** An edit is waiting for the autosave debounce. */
    savePending?: boolean;
    /**
     * When false, boxes and the dim overlay are hidden so the raw image is
     * visible (Ctrl/Cmd-hold or the eye toggle). Defaults to true.
     */
    overlayVisible?: boolean;
    /** Wires the eye toggle in the zoom bar; omit to hide the toggle. */
    onToggleOverlay?: () => void;
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
}

// ── Tunables ───────────────────────────────────────────────────────────────

const MIN_SCALE = 0.02;
const MAX_SCALE = 20;
const ZOOM_FACTOR = 1.15;

// All non-selected boxes share one yellow stroke (model + user). Selection
// stays blue so it remains distinguishable; the erase target turns red.
const STROKE_BOX = '#facc15'; // tailwind yellow-400
const STROKE_SELECTED = '#3b82f6';
const FILL_SELECTED = 'rgba(59,130,246,0.10)';
const STROKE_ERASE = '#ef4444';
const FILL_ERASE = 'rgba(239,68,68,0.28)';

/** Stroke widths in screen pixels (constant at every zoom level). */
const STROKE_PX = 1.5;
const STROKE_ACTIVE_PX = 2.5;

// Default dim is "darker" by design — emphasizes the boxes on busy scenes.
// Hover adds a second pass that darkens everything *except* the hovered box,
// producing a soft spotlight without per-box CPU work.
const DIM_OPACITY_BASE = 0.5;
const DIM_OPACITY_HOVER = 0.6; // additional dim on top of base when hovering

const HANDLE_PX = 10;

/** Breathing room around a fitted image, in screen pixels. */
const FIT_MARGIN = 12;
/** Extra left inset while editing, so the fitted image clears the tool rail. */
const FIT_RAIL_INSET = 52;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Load an HTMLImageElement from `src`, going through the authed http client
 * so backend-served images carry the Bearer header (`<img src=...>` can't
 * attach the token itself).
 *
 * Yields an HTMLImageElement whose `src` is an `object:` URL backed by the
 * fetched bytes. The caller is responsible for releasing the URL — Konva's
 * KonvaImage hangs on to the element for the component lifetime, so we
 * revoke when the effect that called this loader cleans up.
 */
async function loadImageEl(
    src: string,
    signal?: AbortSignal,
): Promise<{ img: HTMLImageElement; objectUrl: string }> {
    const blob = await http.getBlob(src, signal);
    const objectUrl = URL.createObjectURL(blob);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            const onAbort = () => {
                el.onload = null;
                el.onerror = null;
                el.src = '';
                reject(new DOMException('aborted', 'AbortError'));
            };
            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }
            el.onload = () => {
                signal?.removeEventListener('abort', onAbort);
                resolve(el);
            };
            el.onerror = (err) => {
                signal?.removeEventListener('abort', onAbort);
                reject(err);
            };
            el.src = objectUrl;
        });
        return { img, objectUrl };
    } catch (err) {
        URL.revokeObjectURL(objectUrl);
        throw err;
    }
}

function isVisible(b: BBox, threshold: number): boolean {
    return b.origin === 'user' || b.confidence >= threshold;
}

function isTyping(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
    );
}

// ── Component ──────────────────────────────────────────────────────────────

export const OverlayImage = memo(function OverlayImage({
    src,
    alt = 'Overlay',
    annotations = [],
    className,
    saveInProgress = false,
    savePending = false,
    overlayVisible = true,
    onToggleOverlay,
    onBackgroundClick,
    onDimensions,
    editor,
}: OverlayImageProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<Konva.Stage>(null);
    const transformerRef = useRef<Konva.Transformer>(null);
    const selectedRectRef = useRef<Konva.Rect>(null);

    const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);
    const [imageError, setImageError] = useState(false);
    const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
    const [scale, setScale] = useState(1);
    const [hoverIdx, setHoverIdx] = useState<number | null>(null);
    // Transient preview while rubber-banding a new box.
    const [rubberBand, setRubberBand] = useState<[number, number, number, number] | null>(null);
    // True while a drag / resize / rubber-band is in flight — hides the dim layer.
    const [interacting, setInteracting] = useState(false);
    // Cursor in image coords — drives the draw-mode crosshair.
    const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
    const cursorRafRef = useRef<number | null>(null);
    const cursorRafQueued = useRef(false);
    // Space held → the next drag pans, whatever the tool.
    const [spaceHeld, setSpaceHeld] = useState(false);
    const [panning, setPanning] = useState(false);

    const editing = editor !== undefined;
    const mode: OverlayImageTool = editor?.mode ?? 'drag';
    const selectedIndex = editor?.selectedIndex ?? null;
    const confidenceThreshold = editor?.confidenceThreshold ?? 0;
    // Defer the threshold for the box filter. The slider in the parent stays
    // at 60 fps because React drops intermediate values that arrive before
    // the previous pass finishes.
    const deferredThreshold = useDeferredValue(confidenceThreshold);

    // Never hide the overlay out from under an active gesture.
    const overlayShown = overlayVisible || interacting;

    // Latest onDimensions ref so reload only fires on src change.
    const onDimensionsRef = useRef(onDimensions);
    useEffect(() => {
        onDimensionsRef.current = onDimensions;
    }, [onDimensions]);

    // ── Load image ──────────────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        let createdObjectUrl: string | null = null;
        setImageEl(null);
        setImageError(false);
        setHoverIdx(null);
        if (!src) return;
        loadImageEl(src, controller.signal)
            .then(({ img, objectUrl }) => {
                if (cancelled) {
                    URL.revokeObjectURL(objectUrl);
                    return;
                }
                createdObjectUrl = objectUrl;
                setImageEl(img);
                onDimensionsRef.current?.(img.naturalWidth, img.naturalHeight);
            })
            .catch((err) => {
                if (cancelled) return;
                if (err instanceof DOMException && err.name === 'AbortError') return;
                setImageError(true);
            });
        return () => {
            cancelled = true;
            controller.abort();
            if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
        };
    }, [src]);

    // ── Track container size ────────────────────────────────────────────────
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        let rafId = 0;
        const measure = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            setStageSize((prev) =>
                prev.width === w && prev.height === h ? prev : { width: w, height: h },
            );
        };
        measure();
        const debounced = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                measure();
            });
        };
        const ro = new ResizeObserver(debounced);
        ro.observe(el);
        return () => {
            ro.disconnect();
            if (rafId) cancelAnimationFrame(rafId);
        };
    }, []);

    // ── Fit-to-screen ───────────────────────────────────────────────────────
    // Once the user has zoomed or panned, a container resize (window resize,
    // filmstrip toggle) leaves their view alone instead of snapping back.
    const userAdjustedRef = useRef(false);
    const fittedImageRef = useRef<HTMLImageElement | null>(null);

    const fitToScreen = useCallback((): boolean => {
        const stage = stageRef.current;
        if (!stage || !imageEl || stageSize.width === 0 || stageSize.height === 0) return false;
        const iw = imageEl.naturalWidth;
        const ih = imageEl.naturalHeight;
        // Fit inside the area the floating chrome leaves free.
        const left = FIT_MARGIN + (editing ? FIT_RAIL_INSET : 0);
        const availW = Math.max(1, stageSize.width - left - FIT_MARGIN);
        const availH = Math.max(1, stageSize.height - 2 * FIT_MARGIN);
        const fit = Math.min(availW / iw, availH / ih, 1);
        stage.scale({ x: fit, y: fit });
        // Center the image in that area.
        stage.position({
            x: left + (availW - iw * fit) / 2,
            y: FIT_MARGIN + (availH - ih * fit) / 2,
        });
        stage.batchDraw();
        setScale(fit);
        userAdjustedRef.current = false;
        return true;
    }, [imageEl, stageSize.height, stageSize.width, editing]);

    useEffect(() => {
        if (!imageEl) return;
        if (fittedImageRef.current === imageEl && userAdjustedRef.current) return;
        if (fitToScreen()) fittedImageRef.current = imageEl;
    }, [fitToScreen, imageEl]);

    // ── Pointer → image-space helper ────────────────────────────────────────
    const getImagePointer = useCallback(() => {
        const stage = stageRef.current;
        if (!stage) return null;
        const pointer = stage.getPointerPosition();
        if (!pointer) return null;
        const inv = stage.getAbsoluteTransform().copy().invert();
        return inv.point(pointer);
    }, []);

    // ── Visible boxes + hover hit-test ──────────────────────────────────────
    /** Indices into `annotations` that pass the confidence filter. */
    const visible = useMemo(() => {
        const out: number[] = [];
        for (let i = 0; i < annotations.length; i++) {
            if (isVisible(annotations[i], deferredThreshold)) out.push(i);
        }
        return out;
    }, [annotations, deferredThreshold]);

    // The latest box set for event handlers that outlive a render.
    const boxesRef = useRef<{ annotations: BBox[]; visible: number[] }>({
        annotations,
        visible,
    });
    /** Whether the pointer is currently over the stage. */
    const pointerInsideRef = useRef(false);

    const hoverAllowed = overlayShown && mode !== 'draw' && !interacting;

    const updateHover = useCallback(() => {
        const pt = pointerInsideRef.current ? getImagePointer() : null;
        const { annotations: boxes, visible: indices } = boxesRef.current;
        const next = pt ? pickBoxAt(boxes, indices, pt.x, pt.y) : null;
        setHoverIdx((prev) => (prev === next ? prev : next));
    }, [getImagePointer]);

    // A delete / undo / filter change shifts indices under a stationary
    // pointer — re-resolve the hover before the next paint so the highlight
    // never lands on the wrong box.
    useLayoutEffect(() => {
        boxesRef.current = { annotations, visible };
        if (hoverAllowed) updateHover();
        else setHoverIdx(null);
    }, [annotations, visible, hoverAllowed, updateHover]);

    const hoverIndex =
        hoverAllowed && hoverIdx !== null && hoverIdx < annotations.length ? hoverIdx : null;

    // ── Attach Transformer to the selected rect ─────────────────────────────
    useEffect(() => {
        const tr = transformerRef.current;
        const rect = selectedRectRef.current;
        if (!tr) return;
        if (editing && mode === 'drag' && rect && selectedIndex !== null) {
            tr.nodes([rect]);
        } else {
            tr.nodes([]);
        }
        tr.getLayer()?.batchDraw();
    }, [editing, mode, selectedIndex, annotations, visible, overlayShown]);

    // ── Zoom (wheel) ─────────────────────────────────────────────────────────
    // One fixed ZOOM_FACTOR step per wheel event, keyed only on scroll
    // direction (magnitude ignored), matching LarvaePolygonEditor so every
    // organism zooms at the same speed. Events are coalesced per animation
    // frame; the applied zoom equals stepping per-event: ZOOM_FACTOR^(steps).
    const wheelAccumRef = useRef<{
        steps: number;
        pointer: { x: number; y: number } | null;
    }>({ steps: 0, pointer: null });
    const wheelRafRef = useRef<number | null>(null);

    const zoomAt = useCallback((factor: number, at: { x: number; y: number }) => {
        const stage = stageRef.current;
        if (!stage) return;
        const oldScale = stage.scaleX();
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor));
        if (newScale === oldScale) return;
        const anchor = {
            x: (at.x - stage.x()) / oldScale,
            y: (at.y - stage.y()) / oldScale,
        };
        stage.scale({ x: newScale, y: newScale });
        stage.position({
            x: at.x - anchor.x * newScale,
            y: at.y - anchor.y * newScale,
        });
        stage.batchDraw();
        userAdjustedRef.current = true;
        setScale(newScale);
    }, []);

    const handleWheel = useCallback(
        (e: KonvaEventObject<WheelEvent>) => {
            e.evt.preventDefault();
            const stage = stageRef.current;
            if (!stage) return;
            const pointer = stage.getPointerPosition();
            if (!pointer) return;

            // Accumulate signed step count (in = +1, out = -1); commit per frame.
            wheelAccumRef.current.steps += e.evt.deltaY < 0 ? 1 : -1;
            wheelAccumRef.current.pointer = { x: pointer.x, y: pointer.y };

            if (wheelRafRef.current !== null) return;
            wheelRafRef.current = requestAnimationFrame(() => {
                wheelRafRef.current = null;
                const { steps, pointer: p } = wheelAccumRef.current;
                wheelAccumRef.current.steps = 0;
                wheelAccumRef.current.pointer = null;
                if (!p || steps === 0) return;
                zoomAt(Math.pow(ZOOM_FACTOR, steps), p);
            });
        },
        [zoomAt],
    );

    useEffect(() => {
        return () => {
            if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current);
            if (cursorRafRef.current !== null) cancelAnimationFrame(cursorRafRef.current);
        };
    }, []);

    // ── Zoom buttons ────────────────────────────────────────────────────────
    const zoomCentered = useCallback(
        (factor: number) => {
            const stage = stageRef.current;
            if (!stage) return;
            zoomAt(factor, { x: stage.width() / 2, y: stage.height() / 2 });
        },
        [zoomAt],
    );

    const handleZoomIn = useCallback(() => zoomCentered(ZOOM_FACTOR), [zoomCentered]);
    const handleZoomOut = useCallback(() => zoomCentered(1 / ZOOM_FACTOR), [zoomCentered]);

    // ── Keyboard: zoom / fit / Space-to-pan ─────────────────────────────────
    useEffect(() => {
        function handleKeyDown(e: KeyboardEvent) {
            if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                handleZoomIn();
            } else if (e.key === '-') {
                e.preventDefault();
                handleZoomOut();
            } else if (e.key === '0') {
                e.preventDefault();
                fitToScreen();
            } else if (e.code === 'Space') {
                // Don't hijack Space while a button has focus (it activates it).
                if (e.target instanceof HTMLButtonElement) return;
                e.preventDefault();
                setSpaceHeld(true);
            }
        }
        function handleKeyUp(e: KeyboardEvent) {
            if (e.code === 'Space') setSpaceHeld(false);
        }
        const clear = () => setSpaceHeld(false);
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', clear);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', clear);
        };
    }, [fitToScreen, handleZoomIn, handleZoomOut]);

    // ── Forced pan (Space-drag / middle-drag) ───────────────────────────────
    // Captured on the container before Konva sees the press, so it pans from
    // any tool — including draw mode and when the pointer is over a box.
    const forcedPanRef = useRef<{
        pointerId: number;
        x: number;
        y: number;
        stageX: number;
        stageY: number;
    } | null>(null);

    function startForcedPan(e: ReactPointerEvent<HTMLDivElement>) {
        if (!(e.button === 1 || (e.button === 0 && spaceHeld))) return;
        if ((e.target as Element).closest('[data-editor-chrome]')) return;
        const stage = stageRef.current;
        if (!stage || interacting) return;
        e.preventDefault();
        e.stopPropagation();
        containerRef.current?.setPointerCapture?.(e.pointerId);
        forcedPanRef.current = {
            pointerId: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            stageX: stage.x(),
            stageY: stage.y(),
        };
        setPanning(true);
    }

    /** The compat mousedown that follows a forced-pan pointerdown must not reach Konva. */
    function swallowForcedPanMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
        if (!forcedPanRef.current) return;
        e.preventDefault();
        e.stopPropagation();
    }

    function continueForcedPan(e: ReactPointerEvent<HTMLDivElement>) {
        const pan = forcedPanRef.current;
        const stage = stageRef.current;
        if (!pan || !stage || e.pointerId !== pan.pointerId) return;
        stage.position({
            x: pan.stageX + (e.clientX - pan.x),
            y: pan.stageY + (e.clientY - pan.y),
        });
        stage.batchDraw();
    }

    function endForcedPan(e: ReactPointerEvent<HTMLDivElement>) {
        const pan = forcedPanRef.current;
        if (!pan || e.pointerId !== pan.pointerId) return;
        forcedPanRef.current = null;
        containerRef.current?.releasePointerCapture?.(e.pointerId);
        userAdjustedRef.current = true;
        setPanning(false);
    }

    // ── Draw-mode crosshair ─────────────────────────────────────────────────
    const updateCursorFromPointer = useCallback(() => {
        cursorRafQueued.current = false;
        const pt = getImagePointer();
        if (pt) setCursor(pt);
    }, [getImagePointer]);

    const queueCursorUpdate = useCallback(() => {
        if (cursorRafQueued.current) return;
        cursorRafQueued.current = true;
        cursorRafRef.current = requestAnimationFrame(updateCursorFromPointer);
    }, [updateCursorFromPointer]);

    useEffect(() => {
        if (mode !== 'draw') setCursor(null);
    }, [mode]);

    // ── Commit helpers ──────────────────────────────────────────────────────
    const deleteBox = useCallback(
        (index: number) => {
            if (!editor) return;
            setHoverIdx(null);
            editor.onCommit(annotations.filter((_, i) => i !== index));
            editor.onSelect(null);
        },
        [editor, annotations],
    );

    // ── Draw mode: rubber-band ──────────────────────────────────────────────
    const drawStartRef = useRef<{ x: number; y: number } | null>(null);

    const finishDraw = useCallback(() => {
        const start = drawStartRef.current;
        if (!start) return;
        drawStartRef.current = null;
        setRubberBand(null);
        setInteracting(false);
        const pt = getImagePointer();
        if (!pt || !imageEl || !editor) return;
        const [nx1, ny1, nx2, ny2] = normalizeBox(start.x, start.y, pt.x, pt.y);
        const enforced = enforceMinSize(nx1, ny1, nx2, ny2);
        if (!enforced) return;
        const clamped = clampBox(enforced, imageEl.naturalWidth, imageEl.naturalHeight);
        // Autosave on action end: commit + select the new box immediately.
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
    }, [editor, getImagePointer, imageEl, annotations]);

    // Releasing outside the canvas still finishes the box.
    const drawing = rubberBand !== null;
    useEffect(() => {
        if (!drawing) return;
        window.addEventListener('mouseup', finishDraw);
        window.addEventListener('touchend', finishDraw);
        return () => {
            window.removeEventListener('mouseup', finishDraw);
            window.removeEventListener('touchend', finishDraw);
        };
    }, [drawing, finishDraw]);

    // Leaving draw mode mid-gesture (Esc) drops the rubber band.
    useEffect(() => {
        if (mode === 'draw' || !drawStartRef.current) return;
        drawStartRef.current = null;
        setRubberBand(null);
        setInteracting(false);
    }, [mode]);

    // ── Stage pointer handlers ──────────────────────────────────────────────
    // A press that starts on the stage itself (no node under it) and does not
    // move is a "click": on a box it selects (drag) or deletes (erase), on
    // empty space it deselects.
    const backgroundDownPos = useRef<{ x: number; y: number } | null>(null);
    const backgroundMoved = useRef(false);

    const handleStageDown = useCallback(
        (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
            const stage = stageRef.current;
            if (!stage) return;
            pointerInsideRef.current = true;
            if (e.target === stage) {
                const p = stage.getPointerPosition();
                backgroundDownPos.current = p ? { x: p.x, y: p.y } : null;
                backgroundMoved.current = false;
            } else {
                backgroundDownPos.current = null;
            }
            if (!editing || mode !== 'draw') return;
            const button = 'button' in e.evt ? e.evt.button : 0;
            if (button !== 0) return;
            const pt = getImagePointer();
            if (!pt) return;
            drawStartRef.current = pt;
            setRubberBand([pt.x, pt.y, pt.x, pt.y]);
            setInteracting(true);
        },
        [editing, mode, getImagePointer],
    );

    const handleStageMove = useCallback(() => {
        const stage = stageRef.current;
        if (!stage) return;
        pointerInsideRef.current = true;
        if (mode === 'draw') {
            // The crosshair follows the pointer from the moment the user
            // enters draw mode, not only while pressing.
            queueCursorUpdate();
            const start = drawStartRef.current;
            if (start) {
                const pt = getImagePointer();
                if (pt) setRubberBand([start.x, start.y, pt.x, pt.y]);
            }
            return;
        }
        if (backgroundDownPos.current) {
            const p = stage.getPointerPosition();
            if (p) {
                const dx = p.x - backgroundDownPos.current.x;
                const dy = p.y - backgroundDownPos.current.y;
                if (Math.hypot(dx, dy) > 3) backgroundMoved.current = true;
            }
        }
        if (hoverAllowed) updateHover();
    }, [mode, hoverAllowed, updateHover, queueCursorUpdate, getImagePointer]);

    const handleStageLeave = useCallback(() => {
        pointerInsideRef.current = false;
        setHoverIdx(null);
    }, []);

    const handleStageUp = useCallback(() => {
        const clicked = backgroundDownPos.current !== null && !backgroundMoved.current;
        backgroundDownPos.current = null;
        backgroundMoved.current = false;
        if (editing && mode === 'draw') {
            finishDraw();
            return;
        }
        if (!clicked) return;
        const pt = overlayShown ? getImagePointer() : null;
        const hit = pt ? pickBoxAt(annotations, visible, pt.x, pt.y) : null;
        if (hit !== null) {
            if (!editor) return;
            if (mode === 'erase') deleteBox(hit);
            else editor.onSelect(hit);
            return;
        }
        onBackgroundClick?.();
    }, [
        editing,
        mode,
        finishDraw,
        overlayShown,
        getImagePointer,
        annotations,
        visible,
        editor,
        deleteBox,
        onBackgroundClick,
    ]);

    const handleStageDragEnd = useCallback((e: KonvaEventObject<DragEvent>) => {
        if (e.target === stageRef.current) userAdjustedRef.current = true;
    }, []);

    // Enter ⇒ finish editing the selected box (deselect).
    useEffect(() => {
        if (!editing || !editor || selectedIndex === null) return;
        const onKey = (e: KeyboardEvent) => {
            if (isTyping(e.target)) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                editor.onSelect(null);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [editing, editor, selectedIndex]);

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
            // Clamp to image bounds. Konva moves the rect imperatively each
            // frame, so we DON'T set state here. The bbox is read back from
            // the node on dragEnd.
            const node = e.target;
            const [x1, y1, x2, y2] = annotations[index].bbox;
            const w = x2 - x1;
            const h = y2 - y1;
            const nx = Math.max(0, Math.min(imageEl.naturalWidth - w, node.x()));
            const ny = Math.max(0, Math.min(imageEl.naturalHeight - h, node.y()));
            if (nx !== node.x()) node.x(nx);
            if (ny !== node.y()) node.y(ny);
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

    // ── Derived geometry ────────────────────────────────────────────────────
    const imageW = imageEl?.naturalWidth ?? 0;
    const imageH = imageEl?.naturalHeight ?? 0;

    /** The selected box, when it has its own node (drag mode, passes the filter). */
    const selectedNodeIndex =
        editing &&
        mode === 'drag' &&
        overlayShown &&
        selectedIndex !== null &&
        annotations[selectedIndex] !== undefined &&
        isVisible(annotations[selectedIndex], deferredThreshold)
            ? selectedIndex
            : null;

    // The erase target is marked in red; the spotlight would only make a
    // sweep across a dense image flicker.
    const hovered = hoverIndex !== null && mode !== 'erase' ? annotations[hoverIndex] : null;

    // Every box except the selected one, as a single stroked path. Depends
    // only on the box set and the selection — hovering never repaints it.
    const boxesSceneFunc = useCallback(
        (context: Context, shape: Konva.Shape) => {
            const stage = shape.getStage();
            if (!stage) return;
            const ctx = context._context as CanvasRenderingContext2D;
            const s = stage.scaleX();
            // Visible part of the image, with a little slack for the stroke.
            const pad = 2 / s;
            const vx1 = -stage.x() / s - pad;
            const vy1 = -stage.y() / s - pad;
            const vx2 = vx1 + stage.width() / s + 2 * pad;
            const vy2 = vy1 + stage.height() / s + 2 * pad;
            ctx.save();
            ctx.lineWidth = STROKE_PX / s;
            ctx.strokeStyle = STROKE_BOX;
            ctx.beginPath();
            for (let i = 0; i < visible.length; i++) {
                const index = visible[i];
                if (index === selectedNodeIndex) continue;
                const b = annotations[index].bbox;
                if (b[2] < vx1 || b[0] > vx2 || b[3] < vy1 || b[1] > vy2) continue;
                const w = b[2] - b[0];
                const h = b[3] - b[1];
                if (w > 0 && h > 0) ctx.rect(b[0], b[1], w, h);
            }
            ctx.stroke();
            ctx.restore();
        },
        [annotations, visible, selectedNodeIndex],
    );

    // Base dim: fill the image with semi-transparent black, then
    // destination-out every visible box so the boxes appear clear. Depends
    // only on the box set — hovering never repaints it.
    const dimSceneFunc = useCallback(
        (context: Context) => {
            const ctx = context._context as CanvasRenderingContext2D;
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = `rgba(0, 0, 0, ${DIM_OPACITY_BASE})`;
            ctx.fillRect(0, 0, imageW, imageH);
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'rgba(0, 0, 0, 1)';
            ctx.beginPath();
            for (let i = 0; i < visible.length; i++) {
                const b = annotations[visible[i]].bbox;
                const w = b[2] - b[0];
                const h = b[3] - b[1];
                if (w > 0 && h > 0) ctx.rect(b[0], b[1], w, h);
            }
            // Non-zero winding: overlapping boxes stay cleared.
            ctx.fill('nonzero');
            ctx.restore();
        },
        [annotations, visible, imageW, imageH],
    );

    // Hover spotlight, on its own layer: a second, darker veil over the whole
    // image with a hole at the hovered box. Two canvas calls per hover change.
    const spotlightSceneFunc = useCallback(
        (context: Context) => {
            if (!hovered) return;
            const ctx = context._context as CanvasRenderingContext2D;
            const [hx1, hy1, hx2, hy2] = hovered.bbox;
            ctx.save();
            ctx.fillStyle = `rgba(0, 0, 0, ${DIM_OPACITY_HOVER})`;
            ctx.beginPath();
            ctx.rect(0, 0, imageW, imageH);
            ctx.rect(hx1, hy1, Math.max(0, hx2 - hx1), Math.max(0, hy2 - hy1));
            ctx.fill('evenodd');
            ctx.restore();
        },
        [hovered, imageW, imageH],
    );

    // Dim is hidden during interaction and in draw mode so the user sees raw
    // pixels while editing.
    const showDim = overlayShown && !interacting && mode !== 'draw';

    // Boxes that exist as real Konva nodes: the selected one (transformer +
    // drag) and the hovered one (drag / click target, or the erase target).
    // Keyed by index so a hovered node survives becoming the selected node
    // mid-drag.
    const activeIndices: number[] = [];
    if (selectedNodeIndex !== null) activeIndices.push(selectedNodeIndex);
    if (hoverIndex !== null && hoverIndex !== selectedNodeIndex) activeIndices.push(hoverIndex);

    const stageDraggable = editing ? mode !== 'draw' : true;

    const cursorStyle = panning
        ? 'grabbing'
        : spaceHeld
          ? 'grab'
          : mode === 'draw'
            ? 'crosshair'
            : editing && mode === 'erase'
              ? hoverIndex !== null
                  ? 'pointer'
                  : 'default'
              : hoverIndex !== null && !interacting
                ? 'move'
                : 'grab';

    const selectedBox = selectedNodeIndex !== null ? annotations[selectedNodeIndex] : null;

    return (
        <div className={cn('h-full', className)}>
            <div
                ref={containerRef}
                className="canvas-grid relative h-full overflow-hidden select-none"
                style={{ cursor: cursorStyle }}
                onPointerDownCapture={startForcedPan}
                onMouseDownCapture={swallowForcedPanMouseDown}
                onPointerMove={continueForcedPan}
                onPointerUp={endForcedPan}
                onPointerCancel={endForcedPan}
                data-testid="bbox-editor"
            >
                {/* Edit panel — selected box */}
                {selectedBox && selectedNodeIndex !== null && (
                    <div
                        data-editor-chrome
                        className="floating-panel pointer-events-auto absolute top-3 right-3 z-20 w-56 p-3"
                    >
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-sm font-semibold tabular-nums">
                                #{selectedNodeIndex + 1}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                                {selectedBox.origin === 'user'
                                    ? 'Edited by hand'
                                    : 'Model detection'}
                            </span>
                        </div>
                        <dl className="mb-3 space-y-1 text-xs">
                            <div className="flex items-center justify-between gap-2">
                                <dt className="text-muted-foreground">Size (px)</dt>
                                <dd className="font-mono tabular-nums">
                                    {Math.round(selectedBox.bbox[2] - selectedBox.bbox[0])} ×{' '}
                                    {Math.round(selectedBox.bbox[3] - selectedBox.bbox[1])}
                                </dd>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                                <dt className="text-muted-foreground">Confidence</dt>
                                <dd className="font-mono tabular-nums">
                                    {(selectedBox.confidence * 100).toFixed(1)}%
                                </dd>
                            </div>
                        </dl>
                        <div className="flex items-center gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                className="flex-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => deleteBox(selectedNodeIndex)}
                            >
                                <Trash2 />
                                Delete
                            </Button>
                            <Button
                                size="sm"
                                className="flex-1"
                                onClick={() => editor?.onSelect(null)}
                            >
                                Done
                                <span className="kbd border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">
                                    ↵
                                </span>
                            </Button>
                        </div>
                    </div>
                )}

                {/* Zoom controls + saving indicator */}
                <div
                    data-editor-chrome
                    className="pointer-events-none absolute bottom-3 left-3 z-20 flex items-center gap-2"
                >
                    <ZoomControls
                        scale={scale}
                        onZoomIn={handleZoomIn}
                        onZoomOut={handleZoomOut}
                        onFit={fitToScreen}
                        overlayVisible={overlayVisible}
                        onToggleOverlay={onToggleOverlay}
                    />
                    <SaveIndicator saving={saveInProgress} pending={savePending} />
                </div>

                {/* What the active tool expects next */}
                {editing && mode === 'draw' && (
                    <div className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2">
                        <CanvasHint>
                            Drag to draw a box
                            <span className="text-border">|</span>
                            <span className="kbd">Space</span> pan
                            <span className="kbd">Esc</span> cancel
                        </CanvasHint>
                    </div>
                )}
                {editing && mode === 'erase' && (
                    <div className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2">
                        <CanvasHint>
                            Click a box to delete it
                            <span className="text-border">|</span>
                            <span className="kbd">Ctrl Z</span> undo
                            <span className="kbd">Esc</span> done
                        </CanvasHint>
                    </div>
                )}

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
                    <div className="absolute inset-0 flex items-center justify-center p-10">
                        <Skeleton className="h-full w-full rounded-xl" />
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
                {imageEl && stageSize.width > 0 && stageSize.height > 0 && (
                    <Stage
                        ref={stageRef}
                        width={stageSize.width}
                        height={stageSize.height}
                        draggable={stageDraggable}
                        onWheel={handleWheel}
                        onMouseDown={handleStageDown}
                        onMouseMove={handleStageMove}
                        onMouseUp={handleStageUp}
                        onMouseLeave={handleStageLeave}
                        onTouchStart={handleStageDown}
                        onTouchMove={handleStageMove}
                        onTouchEnd={handleStageUp}
                        onDragEnd={handleStageDragEnd}
                    >
                        {/* Image layer */}
                        <Layer listening={false} imageSmoothingEnabled={false}>
                            <KonvaImage
                                image={imageEl}
                                width={imageW}
                                height={imageH}
                                imageSmoothingEnabled={false}
                                perfectDrawEnabled={false}
                            />
                        </Layer>

                        {/* Dim, then the hover spotlight on a layer of its own */}
                        {showDim && (
                            <Layer listening={false}>
                                <Shape perfectDrawEnabled={false} sceneFunc={dimSceneFunc} />
                            </Layer>
                        )}
                        {showDim && (
                            <Layer listening={false}>
                                <Shape
                                    perfectDrawEnabled={false}
                                    visible={hovered !== null}
                                    sceneFunc={spotlightSceneFunc}
                                />
                            </Layer>
                        )}

                        {/* Draw-mode crosshair */}
                        {editing && mode === 'draw' && cursor && (
                            <Layer listening={false}>
                                <Line
                                    points={[0, cursor.y, imageW, cursor.y]}
                                    stroke="white"
                                    strokeWidth={1.5}
                                    strokeScaleEnabled={false}
                                    dash={[6, 4]}
                                    opacity={0.8}
                                    perfectDrawEnabled={false}
                                />
                                <Line
                                    points={[cursor.x, 0, cursor.x, imageH]}
                                    stroke="white"
                                    strokeWidth={1.5}
                                    strokeScaleEnabled={false}
                                    dash={[6, 4]}
                                    opacity={0.8}
                                    perfectDrawEnabled={false}
                                />
                            </Layer>
                        )}

                        {/* Every box, one path. Never listens — hit-testing is
                            done on the plain arrays. */}
                        {overlayShown && (
                            <Layer listening={false}>
                                <Shape perfectDrawEnabled={false} sceneFunc={boxesSceneFunc} />
                            </Layer>
                        )}

                        {/* Interactive layer — hovered / selected box, handles,
                            rubber band. A handful of nodes at most. */}
                        <Layer>
                            {activeIndices.map((index) => {
                                const [x1, y1, x2, y2] = annotations[index].bbox;
                                const isSelected = index === selectedNodeIndex;
                                const erasing = editing && mode === 'erase';
                                const common = {
                                    x: x1,
                                    y: y1,
                                    width: Math.max(0, x2 - x1),
                                    height: Math.max(0, y2 - y1),
                                    strokeWidth: STROKE_ACTIVE_PX,
                                    strokeScaleEnabled: false,
                                    perfectDrawEnabled: false,
                                    shadowForStrokeEnabled: false,
                                };
                                if (editing && mode === 'drag') {
                                    return (
                                        <Rect
                                            key={`box-${index}`}
                                            ref={isSelected ? selectedRectRef : undefined}
                                            {...common}
                                            fill={isSelected ? FILL_SELECTED : 'transparent'}
                                            stroke={isSelected ? STROKE_SELECTED : STROKE_BOX}
                                            draggable
                                            onClick={() => editor?.onSelect(index)}
                                            onTap={() => editor?.onSelect(index)}
                                            onDragStart={() => handleBoxDragStart(index)}
                                            onDragMove={(e) => handleBoxDragMove(index, e)}
                                            onDragEnd={(e) => handleBoxDragEnd(index, e)}
                                        />
                                    );
                                }
                                // Erase / view mode: highlight only. Clicks are
                                // resolved by the stage-level hit test.
                                return (
                                    <Rect
                                        key={`box-${index}`}
                                        {...common}
                                        fill={erasing ? FILL_ERASE : 'transparent'}
                                        stroke={erasing ? STROKE_ERASE : STROKE_BOX}
                                        listening={false}
                                    />
                                );
                            })}

                            {/* Transformer — resize handles for the selected box */}
                            {editing && mode === 'drag' && overlayShown && (
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
                                    boundBoxFunc={(oldBox, newBox) => {
                                        if (
                                            Math.abs(newBox.width) < MIN_BOX_SIZE ||
                                            Math.abs(newBox.height) < MIN_BOX_SIZE
                                        )
                                            return oldBox;
                                        return newBox;
                                    }}
                                    onTransformStart={handleTransformStart}
                                    onTransformEnd={handleTransformEnd}
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
                                            perfectDrawEnabled={false}
                                        />
                                    );
                                })()}
                        </Layer>
                    </Stage>
                )}
            </div>
        </div>
    );
});
