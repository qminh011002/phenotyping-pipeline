// LarvaePolygonEditor — interactive larvae / pupae polygon viewer + editor.
//
// Drives all polygon rendering off the parent's working polygon set (the
// parent owns history via usePolygonEdits) and adds the edit interactions:
//   - vertex drag (handles render only on the selected polygon)
//   - polygon body drag to move it
//   - edge click → insert vertex, right-click vertex → delete vertex
//   - draw tool → click to drop vertices, double-click / Enter / click the
//     first point to close, Backspace or right-click to step back, Esc to cancel
//   - erase tool → click a polygon to delete it
//   - wheel zoom, drag-to-pan, Space-drag / middle-drag to pan from any tool
//
// Rendering is arranged so that the common high-frequency events touch as
// little as possible:
//   - each polygon is a memoised element whose `points` string is cached per
//     polygon array, so hover / selection / zoom never re-serialise the
//     vertex lists of the other few hundred polygons;
//   - the dim-everything-but-the-polygons mask is static; hovering adds one
//     extra dim layer with a two-polygon mask instead of rebuilding it;
//   - pan and drag previews mutate the DOM directly and commit to React
//     state once, on release.

import {
    memo,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from 'react';

import { Trash2 } from 'lucide-react';

import { http } from '@/services/http';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

import type { LarvaeMeasurement, LarvaePolygon, Point2D } from '@/types/api';

import { CanvasHint, SaveIndicator, ZoomControls } from '../components/ViewerChrome';
import {
    findClosestEdge,
    hasSelfIntersection,
    isValidPolygon,
    MIN_EDGE_LENGTH_PX,
    MIN_POLYGON_VERTICES,
    sqDist,
} from './polygonOps';
import type { WorkingPolygon } from './usePolygonEdits';
import { CalibrationCornerHandles } from './CalibrationCornerEditor';
import type { Corners } from './calibrationMath';

const MIN_SCALE = 0.03;
const MAX_SCALE = 12;
const ZOOM_FACTOR = 1.15;
/** Click within this image-space distance of an edge → insert vertex. */
const EDGE_HIT_PX = 6;
/** Below this image-space displacement, a polygon pointerdown is treated as a click. */
const POLYGON_DRAG_THRESHOLD_PX = 4;

const POLYGON_COLOR = '#00FFFF';

export type LarvaePolygonTool = 'select' | 'draw' | 'erase';

interface LarvaePolygonEditorProps {
    rawSrc: string;
    polygons: WorkingPolygon[];
    selectedDetectionId: string | null;
    onSelect: (id: string | null) => void;
    /** Parent-owned tool — flips between select / draw / erase via toolbar or shortcut. */
    tool: LarvaePolygonTool;
    /** Called when the user drops the draw mode (cancel or close). */
    onToolChange?: (tool: LarvaePolygonTool) => void;
    /** True while a move/vertex drag is active; parent delays autosave until false. */
    onInteractionChange?: (active: boolean) => void;

    onMoveVertex: (detectionId: string, vertexIdx: number, next: Point2D) => void;
    /** Translate every vertex of a polygon by (dx, dy) in image space. */
    onTranslatePolygon: (detectionId: string, dx: number, dy: number) => void;
    onInsertVertex: (detectionId: string, edgeIdx: number, point: Point2D) => number;
    onDeleteVertex: (detectionId: string, vertexIdx: number) => boolean;
    onAddPolygon: (polygon: LarvaePolygon) => string;
    /** Delete the polygon (floating edit panel, erase tool). */
    onDeletePolygon?: (detectionId: string) => void;
    /** Measurements indexed by detection_id — used to populate the edit panel. */
    measurements?: LarvaeMeasurement[];
    /** Draw each measured centerline over its polygon. */
    showCenterlines?: boolean;
    /** Whether an autosave is currently in flight — drives the SAVING indicator. */
    saveInProgress?: boolean;
    /** True between a completed edit gesture and the autosave request starting. */
    savePending?: boolean;
    /** Optional preview polygon (e.g. RDP slider live-preview) for selectedDetectionId. */
    previewPolygon?: LarvaePolygon | null;

    /**
     * When set, render a green calibration rectangle with 4 draggable corner
     * handles. Polygon interactions are disabled while corners are visible
     * (click-to-select still works on polygons; vertex edits are blocked).
     */
    calibrationCorners?: Corners | null;
    onCalibrationCornersChange?: (next: Corners) => void;

    /**
     * When false, hide the polygon overlay layer (and the dim spotlight) so
     * the user sees the raw underlying image. Matches OverlayImage's
     * `dimEnabled` behavior for egg/neonate — bound to Ctrl/Cmd-hold in the
     * parent. Defaults to true.
     */
    overlayVisible?: boolean;
    /** Wires the eye toggle in the zoom bar; omit to hide the toggle. */
    onToggleOverlay?: () => void;

    onDimensions?: (w: number, h: number) => void;
    className?: string;
}

interface DragState {
    detectionId: string;
    vertexIdx: number;
    startPoint: Point2D;
    currentPoint: Point2D;
    startPolygon: LarvaePolygon;
}

interface PolygonDragState {
    detectionId: string;
    /** Image-space pointer coords at pointerdown. */
    startPoint: Point2D;
    dx: number;
    dy: number;
    /** Image-space distance from pointerdown — used to gate click vs drag. */
    moved: number;
}

// ── Points-string cache ─────────────────────────────────────────────────────
// A polygon array is immutable once created (edits replace it), so its SVG
// `points` attribute can be computed once and reused by the shape, the mask
// and the drag overlay.
const pointsCache = new WeakMap<LarvaePolygon, string>();

function pointsFor(poly: LarvaePolygon): string {
    let cached = pointsCache.get(poly);
    if (cached === undefined) {
        let out = '';
        for (let i = 0; i < poly.length; i++) {
            if (i > 0) out += ' ';
            out += poly[i][0];
            out += ',';
            out += poly[i][1];
        }
        cached = out;
        pointsCache.set(poly, cached);
    }
    return cached;
}

// ── Memoised polygon element ────────────────────────────────────────────────

type ShapeState = 'idle' | 'hovered' | 'selected' | 'erase-target';

interface PolygonShapeProps {
    id: string;
    polygon: LarvaePolygon;
    state: ShapeState;
    hidden: boolean;
    invalid: boolean;
    cursor: string;
    registerNode: (id: string, node: SVGPolygonElement | null) => void;
    onPointerDown: (e: ReactPointerEvent<SVGElement>, id: string) => void;
    onPointerUp: (e: ReactPointerEvent<SVGElement>, id: string) => void;
    onEnter: (id: string) => void;
    onLeave: (id: string) => void;
}

const PolygonShape = memo(function PolygonShape({
    id,
    polygon,
    state,
    hidden,
    invalid,
    cursor,
    registerNode,
    onPointerDown,
    onPointerUp,
    onEnter,
    onLeave,
}: PolygonShapeProps) {
    const erasing = state === 'erase-target';
    const color = erasing || invalid ? 'var(--destructive)' : POLYGON_COLOR;
    return (
        <polygon
            ref={(node) => registerNode(id, node)}
            data-polygon-id={id}
            points={pointsFor(polygon)}
            fill={erasing ? 'var(--destructive)' : POLYGON_COLOR}
            fillOpacity={state === 'idle' ? 0.3 : 0.45}
            stroke={color}
            strokeWidth={state === 'selected' || erasing ? 2 : 1}
            vectorEffect="non-scaling-stroke"
            // While body-dragging, the main-SVG copy is hidden; an overlay
            // <svg> renders the moving copy on its own GPU layer. The node
            // still receives pointer events (capture is on it) but the
            // browser skips painting it.
            visibility={hidden ? 'hidden' : 'visible'}
            style={{ cursor }}
            onMouseEnter={() => onEnter(id)}
            onMouseLeave={() => onLeave(id)}
            onPointerDown={(e) => onPointerDown(e, id)}
            onPointerUp={(e) => onPointerUp(e, id)}
        />
    );
});

/** Every polygon as a black cut-out — the static part of the dim mask. */
const MaskCutouts = memo(function MaskCutouts({ polygons }: { polygons: WorkingPolygon[] }) {
    return (
        <>
            {polygons.map((wp) => (
                <polygon key={wp.detection_id} points={pointsFor(wp.polygon)} fill="black" />
            ))}
        </>
    );
});

const Centerlines = memo(function Centerlines({
    measurements,
    visibleIds,
}: {
    measurements: LarvaeMeasurement[];
    visibleIds: Set<string>;
}) {
    return (
        <g pointerEvents="none">
            {measurements.map((m) => {
                if (m.is_stale || !m.centerline || m.centerline.length < 2) return null;
                if (!visibleIds.has(m.detection_id)) return null;
                return (
                    <polyline
                        key={m.detection_id}
                        points={m.centerline.map(([x, y]) => `${x},${y}`).join(' ')}
                        fill="none"
                        stroke="white"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                        opacity={0.9}
                    />
                );
            })}
        </g>
    );
});

export function LarvaePolygonEditor({
    rawSrc,
    polygons,
    selectedDetectionId,
    onSelect,
    tool,
    onToolChange,
    onInteractionChange,
    onMoveVertex,
    onTranslatePolygon,
    onInsertVertex,
    onDeleteVertex,
    onAddPolygon,
    onDeletePolygon,
    measurements,
    showCenterlines = false,
    saveInProgress = false,
    savePending = false,
    previewPolygon,
    calibrationCorners,
    onCalibrationCornersChange,
    overlayVisible = true,
    onToggleOverlay,
    onDimensions,
    className,
}: LarvaePolygonEditorProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    /** Wrapper around the raster <img> — CSS-transformed for pan/zoom. */
    const imgWrapRef = useRef<HTMLDivElement | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    /**
     * Inner <g> inside the SVG that carries pan/zoom as an SVG transform.
     * Keeping the transform on a <g> (instead of the wrapping <div>) means
     * the browser re-rasterizes vector paths at every zoom level — polygons
     * stay crisp. The <g>'s CTM is also our image-space ↔ screen-space map.
     */
    const gRef = useRef<SVGGElement | null>(null);
    /** Stable, unique mask id (avoids collisions when two editors mount). */
    const maskId = useId().replace(/:/g, '');
    const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
    const [imageError, setImageError] = useState(false);
    const [objectUrl, setObjectUrl] = useState<string | null>(null);
    const [hoverId, setHoverId] = useState<string | null>(null);

    const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
    const { scale, tx, ty } = view;
    /** Latest committed view, readable from event handlers without re-binding. */
    const viewRef = useRef(view);
    viewRef.current = view;
    /** Inverse-zoom radius for vertex handles so they look ~6px regardless of zoom. */
    const handleR = 6 / scale;

    const panRef = useRef<{
        x: number;
        y: number;
        tx: number;
        ty: number;
        /** Space / middle-button pans never count as a "click on empty space". */
        forced: boolean;
    } | null>(null);
    /** Live tx/ty during a pan drag — written by the DOM, committed to state on pointerup. */
    const livePanRef = useRef<{ tx: number; ty: number } | null>(null);
    const panRafRef = useRef<number | null>(null);
    const [spaceHeld, setSpaceHeld] = useState(false);
    const [panning, setPanning] = useState(false);

    const vertexDragRef = useRef<DragState | null>(null);
    const [vertexDragging, setVertexDragging] = useState(false);
    /**
     * Polygon-body drag state — kept in a ref so pointermove handlers see the
     * latest position without re-renders per frame.
     */
    const polygonDragRef = useRef<PolygonDragState | null>(null);
    const [polygonDragging, setPolygonDragging] = useState(false);
    /**
     * Detection id of the polygon being **body-dragged** (not just selected).
     * When non-null:
     *   - The polygon (and its handles) in the main SVG is hidden via
     *     `visibility="hidden"`. Pointer capture continues to receive events.
     *   - A copy of the polygon is rendered in a separate overlay <svg> that
     *     has its own GPU compositing layer (`will-change: transform`).
     *   - Per-frame movement is applied as a CSS transform on the overlay
     *     element — compositor-only update, no re-rasterization of either
     *     the main SVG or the overlay's cached layer.
     * Mutating an SVG attribute on a child invalidates the parent SVG's
     * backing store every frame; this avoids that.
     */
    const [draggingPolygonId, setDraggingPolygonId] = useState<string | null>(null);
    /** Overlay SVG element ref — owns the dragged-polygon copy. */
    const dragOverlayRef = useRef<SVGSVGElement | null>(null);
    /**
     * rAF handle for the SVG pointermove → vertex/polygon drag preview path.
     * Pointermove can fire faster than 60 Hz on high-rate input devices;
     * coalescing into a single rAF tick caps the preview cost at one paint
     * per frame.
     */
    const dragRafRef = useRef<number | null>(null);
    /** Whichever drag is currently active — used to hide the spotlight mask. */
    const draggingActive = vertexDragging || polygonDragging;
    const polygonNodeRefs = useRef(new Map<string, SVGPolygonElement>());
    const handleNodeRefs = useRef(new Map<string, Map<number, SVGRectElement>>());
    /** Vertices the user has clicked while in draw mode. Image coords. */
    const [drawingVertices, setDrawingVertices] = useState<LarvaePolygon>([]);
    const [drawCursor, setDrawCursor] = useState<Point2D | null>(null);
    const drawCursorRafRef = useRef<number | null>(null);
    const pendingDrawCursorRef = useRef<Point2D | null>(null);

    const polygonById = useMemo(() => {
        const map = new Map<string, WorkingPolygon>();
        for (const wp of polygons) map.set(wp.detection_id, wp);
        return map;
    }, [polygons]);

    // ── Image load ──────────────────────────────────────────────────────────
    const onDimensionsRef = useRef(onDimensions);
    onDimensionsRef.current = onDimensions;
    useEffect(() => {
        let cancelled = false;
        let url: string | null = null;
        const controller = new AbortController();
        setImageError(false);
        http.getBlob(rawSrc, controller.signal)
            .then((blob) => {
                if (cancelled) return;
                url = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                    if (cancelled) return;
                    setObjectUrl(url);
                    setDims({ w: img.naturalWidth, h: img.naturalHeight });
                    onDimensionsRef.current?.(img.naturalWidth, img.naturalHeight);
                };
                img.onerror = () => {
                    if (cancelled) return;
                    setImageError(true);
                };
                img.src = url;
            })
            .catch(() => {
                if (cancelled) return;
                setImageError(true);
            });
        return () => {
            cancelled = true;
            controller.abort();
            if (url) URL.revokeObjectURL(url);
            setObjectUrl(null);
        };
    }, [rawSrc]);

    // ── Fit to the viewport ─────────────────────────────────────────────────
    const fitToScreen = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect || !dims || rect.width === 0 || rect.height === 0) return;
        // Leave a margin so the image doesn't sit under the floating chrome.
        const pad = 24;
        const fit = Math.min((rect.width - pad * 2) / dims.w, (rect.height - pad * 2) / dims.h);
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit));
        setView({
            scale: next,
            tx: (rect.width - dims.w * next) / 2,
            ty: (rect.height - dims.h * next) / 2,
        });
    }, [dims]);

    // Every newly loaded image opens fitted (before paint, so there is no
    // flash of a 100% top-left crop).
    useLayoutEffect(() => {
        fitToScreen();
    }, [fitToScreen]);

    // ── Cancel in-progress draw on tool/image change ────────────────────────
    useEffect(() => {
        if (tool !== 'draw') {
            setDrawingVertices([]);
            setDrawCursor(null);
        }
    }, [tool]);

    useEffect(() => {
        // Cancel transient state when the image swaps.
        return () => {
            vertexDragRef.current = null;
            setVertexDragging(false);
            polygonDragRef.current = null;
            setPolygonDragging(false);
            setDraggingPolygonId(null);
            setHoverId(null);
            if (dragRafRef.current != null) {
                cancelAnimationFrame(dragRafRef.current);
                dragRafRef.current = null;
            }
            if (drawCursorRafRef.current != null) {
                cancelAnimationFrame(drawCursorRafRef.current);
                drawCursorRafRef.current = null;
            }
            pendingDragPointRef.current = null;
            dragCtmInverseRef.current = null;
            const overlay = dragOverlayRef.current;
            if (overlay) overlay.style.transform = '';
            onInteractionChange?.(false);
            setDrawingVertices([]);
            setDrawCursor(null);
        };
    }, [rawSrc, onInteractionChange]);

    /** Map a clientX/Y from a React event to image pixel space. */
    const clientToImage = useCallback((clientX: number, clientY: number): Point2D | null => {
        const g = gRef.current;
        if (!g) return null;
        const ctm = g.getScreenCTM();
        if (!ctm) return null;
        const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
        return [p.x, p.y];
    }, []);

    const setPolygonNodeRef = useCallback((id: string, node: SVGPolygonElement | null) => {
        if (node) polygonNodeRefs.current.set(id, node);
        else polygonNodeRefs.current.delete(id);
    }, []);

    const setHandleNodeRef = useCallback((id: string, idx: number, node: SVGRectElement | null) => {
        const existing = handleNodeRefs.current.get(id);
        if (!node) {
            existing?.delete(idx);
            if (existing?.size === 0) handleNodeRefs.current.delete(id);
            return;
        }
        const next = existing ?? new Map<number, SVGRectElement>();
        next.set(idx, node);
        handleNodeRefs.current.set(id, next);
    }, []);

    const setPolygonTranslatePreview = useCallback((dx: number, dy: number) => {
        // The dragged polygon is rendered in a separate overlay <svg>.
        // Movement is applied as a CSS transform on the overlay element —
        // compositor-only. The CSS unit is screen pixels, whereas dx/dy are
        // in image-space user units; multiply by the current zoom.
        const overlay = dragOverlayRef.current;
        if (!overlay) return;
        const s = viewRef.current.scale;
        overlay.style.transform = dx !== 0 || dy !== 0 ? `translate(${dx * s}px, ${dy * s}px)` : '';
    }, []);

    const setVertexPreview = useCallback((drag: DragState) => {
        const r = 6 / viewRef.current.scale;
        const nextPolygon = drag.startPolygon.slice();
        nextPolygon[drag.vertexIdx] = drag.currentPoint;
        polygonNodeRefs.current
            .get(drag.detectionId)
            ?.setAttribute('points', nextPolygon.map(([x, y]) => `${x},${y}`).join(' '));
        const handle = handleNodeRefs.current.get(drag.detectionId)?.get(drag.vertexIdx);
        if (handle) {
            handle.setAttribute('x', String(drag.currentPoint[0] - r));
            handle.setAttribute('y', String(drag.currentPoint[1] - r));
        }
    }, []);

    const resetVertexPreview = useCallback((drag: DragState) => {
        const r = 6 / viewRef.current.scale;
        polygonNodeRefs.current
            .get(drag.detectionId)
            ?.setAttribute('points', pointsFor(drag.startPolygon));
        const handle = handleNodeRefs.current.get(drag.detectionId)?.get(drag.vertexIdx);
        if (handle) {
            handle.setAttribute('x', String(drag.startPoint[0] - r));
            handle.setAttribute('y', String(drag.startPoint[1] - r));
        }
    }, []);

    // ── Drag perf helpers ───────────────────────────────────────────────────
    /**
     * Inverse CTM cached at drag-start so per-frame coordinate mapping
     * doesn't call getScreenCTM() (which can force a style flush when there
     * are pending DOM mutations). Valid because nothing changes the <g>'s
     * transform while a drag is in progress.
     */
    const dragCtmInverseRef = useRef<DOMMatrix | null>(null);

    const beginDragPerfMode = useCallback(() => {
        const ctm = gRef.current?.getScreenCTM();
        dragCtmInverseRef.current = ctm ? ctm.inverse() : null;
        const svg = svgRef.current;
        if (svg) svg.style.willChange = 'transform';
    }, []);

    const endDragPerfMode = useCallback(() => {
        dragCtmInverseRef.current = null;
        const svg = svgRef.current;
        if (svg) svg.style.willChange = '';
        // Reset the overlay element's CSS transform so a future drag starts
        // from translate(0, 0). The draggingPolygonId state itself is cleared
        // by the caller in the same commit that re-renders the main-SVG
        // polygon at its new position — avoiding a one-frame double image.
        const overlay = dragOverlayRef.current;
        if (overlay) overlay.style.transform = '';
    }, []);

    const clientToImageFast = useCallback((clientX: number, clientY: number): Point2D | null => {
        const inv = dragCtmInverseRef.current;
        if (!inv) return null;
        const p = new DOMPoint(clientX, clientY).matrixTransform(inv);
        return [p.x, p.y];
    }, []);

    // ── Zoom ────────────────────────────────────────────────────────────────
    /** Zoom by `factor` keeping the container-space point (cx, cy) fixed. */
    const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
        setView((prev) => {
            const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor));
            if (next === prev.scale) return prev;
            const k = next / prev.scale;
            return { scale: next, tx: cx - k * (cx - prev.tx), ty: cy - k * (cy - prev.ty) };
        });
    }, []);

    const zoomCentered = useCallback(
        (factor: number) => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (rect) zoomAt(factor, rect.width / 2, rect.height / 2);
        },
        [zoomAt],
    );

    // React's synthetic onWheel is passive, so preventDefault() needs a native
    // listener. Wheel events are coalesced into one zoom step per frame —
    // trackpads emit several per frame, and each state update re-renders.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        let steps = 0;
        let point = { x: 0, y: 0 };
        let raf: number | null = null;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            steps += e.deltaY < 0 ? 1 : -1;
            point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            if (raf !== null) return;
            raf = requestAnimationFrame(() => {
                raf = null;
                const n = steps;
                steps = 0;
                if (n !== 0) zoomAt(Math.pow(ZOOM_FACTOR, n), point.x, point.y);
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            el.removeEventListener('wheel', onWheel);
            if (raf !== null) cancelAnimationFrame(raf);
        };
    }, [zoomAt]);

    // Keyboard: + / − / 0 zoom, Space to pan from any tool.
    useEffect(() => {
        function isTyping(target: EventTarget | null) {
            return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
        }
        function onKeyDown(e: KeyboardEvent) {
            if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                zoomCentered(ZOOM_FACTOR);
            } else if (e.key === '-') {
                e.preventDefault();
                zoomCentered(1 / ZOOM_FACTOR);
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
        function onKeyUp(e: KeyboardEvent) {
            if (e.code === 'Space') setSpaceHeld(false);
        }
        const clear = () => setSpaceHeld(false);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', clear);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', clear);
        };
    }, [zoomCentered, fitToScreen]);

    // ── Pan ─────────────────────────────────────────────────────────────────
    function beginPan(e: ReactPointerEvent<HTMLDivElement>, forced: boolean) {
        panRef.current = { x: e.clientX, y: e.clientY, tx, ty, forced };
        setPanning(true);
        // Promote the SVG to its own GPU layer for the duration of the pan so
        // the per-frame style.transform delta is just a layer translate, not a
        // re-raster of every polygon + mask.
        const svg = svgRef.current;
        if (svg) svg.style.willChange = 'transform';
    }

    /** Space-drag / middle-drag: pan from any tool, even over a polygon. */
    function startForcedPan(e: ReactPointerEvent<HTMLDivElement>) {
        if (!(e.button === 1 || (e.button === 0 && spaceHeld))) return;
        if (vertexDragRef.current || polygonDragRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        containerRef.current?.setPointerCapture?.(e.pointerId);
        beginPan(e, true);
    }

    function startPan(e: ReactPointerEvent<HTMLDivElement>) {
        if (e.button !== 0 || panRef.current) return;
        if (vertexDragRef.current) return;
        const target = e.target as Element;
        // Polygon, vertex, edge interactions handle their own pointer events.
        if (
            target.closest('[data-polygon-id]') ||
            target.closest('[data-vertex-idx]') ||
            target.closest('[data-edge-idx]') ||
            target.closest('[data-editor-chrome]')
        ) {
            return;
        }
        if (tool === 'draw') return;
        target.setPointerCapture?.(e.pointerId);
        beginPan(e, false);
    }

    function continuePan(e: ReactPointerEvent<HTMLDivElement>) {
        const drag = panRef.current;
        if (!drag) return;
        livePanRef.current = {
            tx: drag.tx + (e.clientX - drag.x),
            ty: drag.ty + (e.clientY - drag.y),
        };
        // Skip React re-render during pan — mutate transforms directly and
        // commit once on pointerup.
        if (panRafRef.current == null) {
            panRafRef.current = requestAnimationFrame(() => {
                panRafRef.current = null;
                const live = livePanRef.current;
                if (!live) return;
                const img = imgWrapRef.current;
                if (img) {
                    img.style.transform = `translate(${live.tx}px, ${live.ty}px) scale(${scale})`;
                }
                // Pan-only fast path for the SVG: push a delta translate as a
                // CSS transform on the <svg> element — the browser slides the
                // cached raster of the whole vector tree instead of redrawing
                // every polygon and the mask each frame.
                const svg = svgRef.current;
                if (svg) svg.style.transform = `translate(${live.tx - tx}px, ${live.ty - ty}px)`;
            });
        }
    }

    function endPan(e: ReactPointerEvent<HTMLDivElement>) {
        const drag = panRef.current;
        if (!drag) return;
        panRef.current = null;
        setPanning(false);
        if (panRafRef.current != null) {
            cancelAnimationFrame(panRafRef.current);
            panRafRef.current = null;
        }
        const live = livePanRef.current;
        livePanRef.current = null;
        const svg = svgRef.current;
        if (svg) {
            svg.style.transform = '';
            svg.style.willChange = '';
        }
        // Treat a near-zero drag on empty area as deselect.
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) {
            if (!drag.forced && tool === 'select') onSelect(null);
            const img = imgWrapRef.current;
            if (img) img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
            return;
        }
        // Commit the final translate; the SVG's delta transform was cleared
        // above in the same frame, so the vectors don't jump.
        if (live) setView((prev) => ({ ...prev, tx: live.tx, ty: live.ty }));
    }

    // ── Drag preview rAF coalescing ─────────────────────────────────────────
    /**
     * Latest pointer position during a vertex or polygon-body drag. Written
     * every pointermove but applied to the DOM at most once per frame.
     */
    const pendingDragPointRef = useRef<Point2D | null>(null);

    const flushDragPreview = useCallback(() => {
        dragRafRef.current = null;
        const point = pendingDragPointRef.current;
        pendingDragPointRef.current = null;
        if (!point) return;
        const vertexDrag = vertexDragRef.current;
        if (vertexDrag && dims) {
            const x = Math.max(0, Math.min(dims.w, point[0]));
            const y = Math.max(0, Math.min(dims.h, point[1]));
            vertexDrag.currentPoint = [x, y];
            setVertexPreview(vertexDrag);
            return;
        }
        const polyDrag = polygonDragRef.current;
        if (polyDrag) {
            const dx = point[0] - polyDrag.startPoint[0];
            const dy = point[1] - polyDrag.startPoint[1];
            polyDrag.dx = dx;
            polyDrag.dy = dy;
            polyDrag.moved = Math.hypot(dx, dy);
            if (polyDrag.moved > POLYGON_DRAG_THRESHOLD_PX) {
                // Move the polygon into the overlay <svg> so subsequent
                // movement is a CSS transform on a separately-composited
                // layer; these setters are no-ops after the first frame.
                setPolygonDragging(true);
                setDraggingPolygonId(polyDrag.detectionId);
                setPolygonTranslatePreview(dx, dy);
            }
        }
    }, [dims, setPolygonTranslatePreview, setVertexPreview]);

    // ── Polygon body pointer interactions ──────────────────────────────────
    // pointerdown on the polygon body either starts a translate-drag or seeds
    // a "click intent" so pointerup can resolve to select / insert-vertex.
    // Pointer events (not onClick) so click and drag can be told apart.
    const handlePolygonPointerDown = (e: ReactPointerEvent<SVGElement>, id: string) => {
        if (e.button !== 0) return;
        if (tool === 'erase') {
            e.stopPropagation();
            onDeletePolygon?.(id);
            setHoverId(null);
            return;
        }
        if (tool !== 'select') return;
        e.stopPropagation();
        const point = clientToImage(e.clientX, e.clientY);
        if (!point) return;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        polygonDragRef.current = { detectionId: id, startPoint: point, dx: 0, dy: 0, moved: 0 };
        setPolygonDragging(false);
        setPolygonTranslatePreview(0, 0);
        beginDragPerfMode();
        onInteractionChange?.(true);
    };

    const finishPolygonPointer = (e: ReactPointerEvent<SVGElement>, id: string) => {
        // Flush any pending coalesced pointermove so `drag.dx/dy/moved`
        // reflect the user's last pointer sample, then cancel rAF.
        if (dragRafRef.current != null) {
            cancelAnimationFrame(dragRafRef.current);
            flushDragPreview();
        }
        const drag = polygonDragRef.current;
        polygonDragRef.current = null;
        if (drag) endDragPerfMode();
        const wasDragging = drag !== null && drag.moved > POLYGON_DRAG_THRESHOLD_PX;
        setPolygonDragging(false);
        // Removing the overlay copy commits in the same batch as the parent's
        // `onTranslatePolygon` update — no visible flicker.
        setDraggingPolygonId(null);
        if (wasDragging && drag) {
            onTranslatePolygon(drag.detectionId, drag.dx, drag.dy);
            onInteractionChange?.(false);
            return;
        }
        if (drag) onInteractionChange?.(false);
        if (tool !== 'select') return;

        // Treat as a click — select, or insert vertex if near an edge.
        const wp = polygonById.get(id);
        const point = clientToImage(e.clientX, e.clientY);
        if (wp && id === selectedDetectionId && point) {
            const near = findClosestEdge(wp.polygon, point, EDGE_HIT_PX);
            if (near) {
                onInsertVertex(id, near.edgeIdx, near.projection);
                return;
            }
        }
        onSelect(id);
    };

    const handlePolygonEnter = (id: string) => {
        // Freeze hover state while a drag is in progress — otherwise crossing
        // another polygon fires mouseenter → state change mid-drag.
        if (polygonDragRef.current || vertexDragRef.current || panRef.current) return;
        if (tool === 'draw') return;
        setHoverId(id);
    };

    const handlePolygonLeave = (id: string) => {
        if (polygonDragRef.current || vertexDragRef.current || panRef.current) return;
        setHoverId((cur) => (cur === id ? null : cur));
    };

    // Stable wrappers so the memoised polygon elements don't re-render when
    // these handlers' closures change (selection, tool, view…).
    const latest = useRef({
        down: handlePolygonPointerDown,
        up: finishPolygonPointer,
        enter: handlePolygonEnter,
        leave: handlePolygonLeave,
    });
    latest.current = {
        down: handlePolygonPointerDown,
        up: finishPolygonPointer,
        enter: handlePolygonEnter,
        leave: handlePolygonLeave,
    };
    const onShapeDown = useCallback(
        (e: ReactPointerEvent<SVGElement>, id: string) => latest.current.down(e, id),
        [],
    );
    const onShapeUp = useCallback(
        (e: ReactPointerEvent<SVGElement>, id: string) => latest.current.up(e, id),
        [],
    );
    const onShapeEnter = useCallback((id: string) => latest.current.enter(id), []);
    const onShapeLeave = useCallback((id: string) => latest.current.leave(id), []);

    // ── Vertex pointer handlers ─────────────────────────────────────────────
    function handleVertexPointerDown(
        e: ReactPointerEvent<SVGElement>,
        wp: WorkingPolygon,
        vertexIdx: number,
    ) {
        if (tool !== 'select') return;
        if (e.button !== 0) return; // right-click → context menu deletes
        e.stopPropagation();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        vertexDragRef.current = {
            detectionId: wp.detection_id,
            vertexIdx,
            startPoint: wp.polygon[vertexIdx],
            currentPoint: wp.polygon[vertexIdx],
            startPolygon: wp.polygon,
        };
        setVertexDragging(true);
        beginDragPerfMode();
        onInteractionChange?.(true);
    }

    function handleVertexContextMenu(
        e: React.MouseEvent<SVGElement>,
        wp: WorkingPolygon,
        vertexIdx: number,
    ) {
        e.preventDefault();
        e.stopPropagation();
        if (tool !== 'select') return;
        onDeleteVertex(wp.detection_id, vertexIdx);
    }

    // ── SVG pointer for vertex drag + draw rubber-band ──────────────────────
    function handleSvgPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
        // Active drag — use the cached inverse CTM (set at drag start) and
        // coalesce DOM writes to one per animation frame.
        if (vertexDragRef.current || polygonDragRef.current) {
            const point = clientToImageFast(e.clientX, e.clientY);
            if (!point) return;
            pendingDragPointRef.current = point;
            if (dragRafRef.current == null) {
                dragRafRef.current = requestAnimationFrame(flushDragPreview);
            }
            return;
        }
        if (tool === 'draw' && !panRef.current) {
            const point = clientToImage(e.clientX, e.clientY);
            if (!point) return;
            pendingDrawCursorRef.current = point;
            if (drawCursorRafRef.current == null) {
                drawCursorRafRef.current = requestAnimationFrame(() => {
                    drawCursorRafRef.current = null;
                    setDrawCursor(pendingDrawCursorRef.current);
                });
            }
        }
    }

    function cancelPendingDragRaf() {
        if (dragRafRef.current != null) {
            cancelAnimationFrame(dragRafRef.current);
            dragRafRef.current = null;
        }
        pendingDragPointRef.current = null;
    }

    function finishVertexDrag() {
        const vertexDrag = vertexDragRef.current;
        if (!vertexDrag) return;
        // Flush any pending rAF-coalesced move so `currentPoint` reflects the
        // user's last pointer position before we commit.
        if (dragRafRef.current != null) flushDragPreview();
        vertexDragRef.current = null;
        cancelPendingDragRaf();
        endDragPerfMode();
        const [sx, sy] = vertexDrag.startPoint;
        const [cx, cy] = vertexDrag.currentPoint;
        if (sx !== cx || sy !== cy) {
            onMoveVertex(vertexDrag.detectionId, vertexDrag.vertexIdx, [cx, cy]);
        } else {
            resetVertexPreview(vertexDrag);
        }
        setVertexDragging(false);
        onInteractionChange?.(false);
    }

    function cancelActiveDrag() {
        cancelPendingDragRaf();
        const vertexDrag = vertexDragRef.current;
        const polygonDrag = polygonDragRef.current;
        if (vertexDrag || polygonDrag) endDragPerfMode();
        if (vertexDrag) {
            resetVertexPreview(vertexDrag);
            vertexDragRef.current = null;
            setVertexDragging(false);
            onInteractionChange?.(false);
        }
        if (polygonDrag) {
            polygonDragRef.current = null;
            setPolygonDragging(false);
            setDraggingPolygonId(null);
            onInteractionChange?.(false);
        }
    }

    function handleSvgClick(e: React.MouseEvent<SVGSVGElement>) {
        if (tool !== 'draw' || spaceHeld) return;
        // Clicks that hit handles stopPropagation before reaching here.
        const point = clientToImage(e.clientX, e.clientY);
        if (!point || !dims) return;
        const next: Point2D = [
            Math.max(0, Math.min(dims.w, point[0])),
            Math.max(0, Math.min(dims.h, point[1])),
        ];
        // Reject duplicate / too-close vertices.
        const last = drawingVertices[drawingVertices.length - 1];
        if (last && sqDist(last, next) < MIN_EDGE_LENGTH_PX * MIN_EDGE_LENGTH_PX) return;
        setDrawingVertices((prev) => [...prev, next]);
    }

    const commitDraw = useCallback(() => {
        if (drawingVertices.length < MIN_POLYGON_VERTICES) {
            setDrawingVertices([]);
            setDrawCursor(null);
            onToolChange?.('select');
            return;
        }
        // Commit immediately and select — the floating edit panel handles
        // confirm/delete from there.
        const newId = onAddPolygon(drawingVertices);
        setDrawingVertices([]);
        setDrawCursor(null);
        onToolChange?.('select');
        if (newId) onSelect(newId);
    }, [drawingVertices, onAddPolygon, onToolChange, onSelect]);

    // Enter while a polygon is selected (and not drawing) → finish editing it.
    useEffect(() => {
        if (tool === 'draw') return;
        if (!selectedDetectionId) return;
        if (calibrationCorners) return;
        function onKeyDown(e: KeyboardEvent) {
            const target = e.target;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                onSelect(null);
            }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [tool, selectedDetectionId, calibrationCorners, onSelect]);

    // Draw mode keys: Enter closes, Backspace steps back, Esc cancels.
    useEffect(() => {
        if (tool !== 'draw') return;
        function onKeyDown(e: KeyboardEvent) {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                commitDraw();
            } else if (e.key === 'Backspace' || e.key === 'Delete') {
                e.preventDefault();
                // Runs before the panel's window handler, which would otherwise
                // treat Backspace as "delete the selected polygon".
                e.stopImmediatePropagation();
                setDrawingVertices((prev) => prev.slice(0, -1));
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                setDrawingVertices([]);
                setDrawCursor(null);
                onToolChange?.('select');
            }
        }
        // Capture phase so this sees the key before bubbling window handlers.
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [tool, commitDraw, onToolChange]);

    // ── Selected polygon edit-panel inputs ─────────────────────────────────
    const selectedIndex = useMemo(() => {
        if (!selectedDetectionId) return null;
        const idx = polygons.findIndex((p) => p.detection_id === selectedDetectionId);
        return idx >= 0 ? idx + 1 : null;
    }, [polygons, selectedDetectionId]);

    const selectedMeasurement = useMemo(() => {
        if (!selectedDetectionId || !measurements) return null;
        return measurements.find((m) => m.detection_id === selectedDetectionId) ?? null;
    }, [measurements, selectedDetectionId]);

    const selectedPolygon = selectedDetectionId ? polygonById.get(selectedDetectionId) : undefined;
    const hoveredPolygon = hoverId ? polygonById.get(hoverId) : undefined;
    const showEditPanel = !!selectedPolygon && tool === 'select' && !calibrationCorners;
    const draggingPolygon = draggingPolygonId ? (polygonById.get(draggingPolygonId) ?? null) : null;

    const centerlineIds = useMemo(() => new Set(polygons.map((p) => p.detection_id)), [polygons]);

    const cursor =
        panning || vertexDragging
            ? 'grabbing'
            : spaceHeld
              ? 'grab'
              : tool === 'draw'
                ? 'crosshair'
                : tool === 'erase'
                  ? 'default'
                  : 'grab';
    const idleShapeCursor = spaceHeld ? 'grab' : 'pointer';

    return (
        <div
            ref={containerRef}
            className={cn(
                'canvas-grid relative h-full w-full overflow-hidden select-none',
                className,
            )}
            onPointerDownCapture={startForcedPan}
            onPointerDown={startPan}
            onPointerMove={continuePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onContextMenu={(e) => {
                // Right-click while drawing steps back one point.
                if (tool !== 'draw') return;
                e.preventDefault();
                setDrawingVertices((prev) => prev.slice(0, -1));
            }}
            data-testid="larvae-polygon-editor"
            style={{ cursor }}
        >
            {imageError && (
                <div className="absolute inset-0 grid place-items-center text-sm text-destructive">
                    Could not load image
                </div>
            )}
            {!imageError && !objectUrl && (
                <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
                    Loading image…
                </div>
            )}

            {/* Zoom controls + saving indicator */}
            <div
                data-editor-chrome
                className="pointer-events-none absolute bottom-3 left-3 z-20 flex items-center gap-2"
            >
                <ZoomControls
                    scale={scale}
                    onZoomIn={() => zoomCentered(ZOOM_FACTOR)}
                    onZoomOut={() => zoomCentered(1 / ZOOM_FACTOR)}
                    onFit={fitToScreen}
                    overlayVisible={overlayVisible}
                    onToggleOverlay={onToggleOverlay}
                />
                <SaveIndicator saving={saveInProgress} pending={savePending} />
            </div>

            {tool === 'draw' && (
                <div className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2">
                    <CanvasHint>
                        {drawingVertices.length < MIN_POLYGON_VERTICES
                            ? `Click to add points · ${MIN_POLYGON_VERTICES - drawingVertices.length} more needed`
                            : 'Click the first point or press Enter to finish'}
                        <span className="text-border">|</span>
                        <span className="kbd">Bksp</span> undo point
                        <span className="kbd">Esc</span> cancel
                    </CanvasHint>
                </div>
            )}
            {tool === 'erase' && (
                <div className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2">
                    <CanvasHint>
                        Click a detection to delete it
                        <span className="text-border">|</span>
                        <span className="kbd">Ctrl Z</span> undo
                        <span className="kbd">Esc</span> done
                    </CanvasHint>
                </div>
            )}

            {showEditPanel && (
                <div
                    data-editor-chrome
                    className="floating-panel pointer-events-auto absolute top-3 right-3 z-20 w-56 p-3"
                >
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-semibold tabular-nums">
                            #{selectedIndex ?? '—'}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                            {selectedPolygon.origin === 'user'
                                ? 'Drawn by hand'
                                : 'Model detection'}
                        </span>
                    </div>
                    <dl className="mb-3 space-y-1 text-xs">
                        <PanelStatRow label="Length (mm)" value={selectedMeasurement?.length_mm} />
                        <PanelStatRow label="Area (mm²)" value={selectedMeasurement?.area_mm2} />
                        <PanelStatRow
                            label="Max W (mm)"
                            value={selectedMeasurement?.max_width_mm}
                        />
                        <PanelStatRow label="Weight (mg)" value={selectedMeasurement?.weight_mg} />
                    </dl>
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            className="flex-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => {
                                if (!selectedDetectionId) return;
                                onDeletePolygon?.(selectedDetectionId);
                                onSelect(null);
                            }}
                        >
                            <Trash2 />
                            Delete
                        </Button>
                        <Button size="sm" className="flex-1" onClick={() => onSelect(null)}>
                            Done
                            <span className="kbd border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">
                                ↵
                            </span>
                        </Button>
                    </div>
                </div>
            )}

            {dims && objectUrl && (
                <>
                    {/* Raster image — CSS transform on its own wrapper. */}
                    <div
                        ref={imgWrapRef}
                        style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            transformOrigin: '0 0',
                            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                            width: dims.w,
                            height: dims.h,
                            willChange: 'transform',
                        }}
                    >
                        <img
                            src={objectUrl}
                            alt=""
                            width={dims.w}
                            height={dims.h}
                            draggable={false}
                            style={{ display: 'block' }}
                        />
                    </div>

                    {/*
                      Vector overlay — full-viewport SVG, transform on inner
                      <g>. overflow:visible so content outside the SVG box
                      still renders while the element is CSS-translated
                      during a pan; the container's overflow-hidden clips.
                    */}
                    <svg
                        ref={svgRef}
                        width="100%"
                        height="100%"
                        style={{
                            position: 'absolute',
                            inset: 0,
                            overflow: 'visible',
                            // Ctrl/Cmd-hold (or the eye toggle) reveals the raw
                            // image. Pointer events go off too so the hidden
                            // polygons don't eat clicks.
                            opacity: overlayVisible ? 1 : 0,
                            pointerEvents: overlayVisible ? undefined : 'none',
                            transition: 'opacity 120ms ease-out',
                        }}
                        onPointerMove={handleSvgPointerMove}
                        onPointerUp={finishVertexDrag}
                        onPointerCancel={cancelActiveDrag}
                        onClick={handleSvgClick}
                        onDoubleClick={() => {
                            if (tool === 'draw') commitDraw();
                        }}
                    >
                        <g ref={gRef} transform={`translate(${tx} ${ty}) scale(${scale})`}>
                            <defs>
                                {/* Static: the image minus every polygon. */}
                                <mask id={`dim-${maskId}`}>
                                    <rect x={0} y={0} width={dims.w} height={dims.h} fill="white" />
                                    <MaskCutouts polygons={polygons} />
                                </mask>
                                {/* Hover spotlight: everything except the
                                    hovered (and selected) polygon. */}
                                <mask id={`spot-${maskId}`}>
                                    <rect x={0} y={0} width={dims.w} height={dims.h} fill="white" />
                                    {hoveredPolygon && (
                                        <polygon
                                            points={pointsFor(hoveredPolygon.polygon)}
                                            fill="black"
                                        />
                                    )}
                                    {selectedPolygon && selectedPolygon !== hoveredPolygon && (
                                        <polygon
                                            points={pointsFor(selectedPolygon.polygon)}
                                            fill="black"
                                        />
                                    )}
                                </mask>
                            </defs>
                            {/*
                              Dim layers. Skipped during an active drag: the
                              dragged polygon's cut-out would lag behind it,
                              and re-rastering the mask per frame is the
                              dominant cost on dense scenes.
                            */}
                            {!draggingActive && (
                                <rect
                                    x={0}
                                    y={0}
                                    width={dims.w}
                                    height={dims.h}
                                    fill="black"
                                    opacity={0.4}
                                    mask={`url(#dim-${maskId})`}
                                    pointerEvents="none"
                                />
                            )}
                            {!draggingActive && hoveredPolygon && tool !== 'erase' && (
                                <rect
                                    x={0}
                                    y={0}
                                    width={dims.w}
                                    height={dims.h}
                                    fill="black"
                                    opacity={0.3}
                                    mask={`url(#spot-${maskId})`}
                                    pointerEvents="none"
                                />
                            )}

                            {/* Polygons */}
                            {polygons.map((wp) => {
                                const id = wp.detection_id;
                                const isSelected = id === selectedDetectionId;
                                const isHovered = id === hoverId;
                                const showPreview =
                                    isSelected && previewPolygon && previewPolygon.length >= 3;
                                const rendered = showPreview
                                    ? (previewPolygon as LarvaePolygon)
                                    : wp.polygon;
                                return (
                                    <PolygonShape
                                        key={id}
                                        id={id}
                                        polygon={rendered}
                                        state={
                                            isHovered && tool === 'erase'
                                                ? 'erase-target'
                                                : isSelected
                                                  ? 'selected'
                                                  : isHovered
                                                    ? 'hovered'
                                                    : 'idle'
                                        }
                                        hidden={draggingPolygonId === id}
                                        invalid={isSelected && hasSelfIntersection(rendered)}
                                        cursor={
                                            isSelected && !spaceHeld
                                                ? polygonDragging
                                                    ? 'grabbing'
                                                    : 'move'
                                                : idleShapeCursor
                                        }
                                        registerNode={setPolygonNodeRef}
                                        onPointerDown={onShapeDown}
                                        onPointerUp={onShapeUp}
                                        onEnter={onShapeEnter}
                                        onLeave={onShapeLeave}
                                    />
                                );
                            })}

                            {showCenterlines && measurements && (
                                <Centerlines
                                    measurements={measurements}
                                    visibleIds={centerlineIds}
                                />
                            )}

                            {/* Vertex handles for the selected polygon only. */}
                            {selectedPolygon && tool === 'select' && !calibrationCorners && (
                                <g
                                    visibility={
                                        draggingPolygonId === selectedPolygon.detection_id
                                            ? 'hidden'
                                            : 'visible'
                                    }
                                >
                                    {selectedPolygon.polygon.map((v, i) => (
                                        <rect
                                            key={i}
                                            ref={(node) =>
                                                setHandleNodeRef(
                                                    selectedPolygon.detection_id,
                                                    i,
                                                    node,
                                                )
                                            }
                                            data-vertex-idx={i}
                                            x={v[0] - handleR}
                                            y={v[1] - handleR}
                                            width={handleR * 2}
                                            height={handleR * 2}
                                            fill="white"
                                            stroke="#1f2937"
                                            strokeWidth={1}
                                            vectorEffect="non-scaling-stroke"
                                            style={{ cursor: 'move' }}
                                            onPointerDown={(e) =>
                                                handleVertexPointerDown(e, selectedPolygon, i)
                                            }
                                            onContextMenu={(e) =>
                                                handleVertexContextMenu(e, selectedPolygon, i)
                                            }
                                        />
                                    ))}
                                </g>
                            )}

                            {/* Calibration corner handles (FE-034). */}
                            {calibrationCorners && onCalibrationCornersChange && (
                                <CalibrationCornerHandles
                                    corners={calibrationCorners}
                                    onChange={onCalibrationCornersChange}
                                    handleR={handleR * 1.4}
                                    imageWidth={dims.w}
                                    imageHeight={dims.h}
                                    ctmRef={gRef}
                                />
                            )}

                            {/* Draw-mode crosshair following the cursor. */}
                            {tool === 'draw' && drawCursor && (
                                <g pointerEvents="none">
                                    <line
                                        x1={0}
                                        y1={drawCursor[1]}
                                        x2={dims.w}
                                        y2={drawCursor[1]}
                                        stroke="white"
                                        strokeWidth={1}
                                        strokeDasharray="6 4"
                                        opacity={0.8}
                                        vectorEffect="non-scaling-stroke"
                                    />
                                    <line
                                        x1={drawCursor[0]}
                                        y1={0}
                                        x2={drawCursor[0]}
                                        y2={dims.h}
                                        stroke="white"
                                        strokeWidth={1}
                                        strokeDasharray="6 4"
                                        opacity={0.8}
                                        vectorEffect="non-scaling-stroke"
                                    />
                                </g>
                            )}

                            {/* In-progress draw polyline. */}
                            {tool === 'draw' && drawingVertices.length > 0 && (
                                <g>
                                    <polyline
                                        points={[
                                            ...drawingVertices,
                                            ...(drawCursor ? [drawCursor] : []),
                                        ]
                                            .map(([x, y]) => `${x},${y}`)
                                            .join(' ')}
                                        fill="color-mix(in oklab, var(--primary) 18%, transparent)"
                                        stroke="var(--primary)"
                                        strokeWidth={1.5}
                                        strokeDasharray="4 3"
                                        vectorEffect="non-scaling-stroke"
                                        pointerEvents="none"
                                    />
                                    {drawingVertices.map((v, i) => {
                                        const isCloser =
                                            i === 0 &&
                                            drawingVertices.length >= MIN_POLYGON_VERTICES;
                                        const r = isCloser ? handleR * 1.7 : handleR;
                                        return (
                                            <rect
                                                key={`draw:${i}`}
                                                x={v[0] - r}
                                                y={v[1] - r}
                                                width={r * 2}
                                                height={r * 2}
                                                fill={
                                                    isCloser
                                                        ? 'var(--background)'
                                                        : 'var(--primary)'
                                                }
                                                stroke="var(--primary)"
                                                strokeWidth={isCloser ? 2 : 1}
                                                vectorEffect="non-scaling-stroke"
                                                style={{ cursor: isCloser ? 'pointer' : 'default' }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (isCloser) commitDraw();
                                                }}
                                            >
                                                {isCloser && (
                                                    <title>
                                                        Click to close polygon (or press Enter)
                                                    </title>
                                                )}
                                            </rect>
                                        );
                                    })}
                                </g>
                            )}
                        </g>
                    </svg>

                    {/*
                      Drag-overlay <svg> — renders a copy of the polygon
                      currently being body-dragged on its own GPU compositing
                      layer. The main SVG stays static during the drag;
                      per-frame movement is a CSS transform on this element.
                    */}
                    <svg
                        ref={dragOverlayRef}
                        width="100%"
                        height="100%"
                        style={{
                            position: 'absolute',
                            inset: 0,
                            overflow: 'visible',
                            pointerEvents: 'none',
                            willChange: draggingPolygon ? 'transform' : 'auto',
                            visibility: draggingPolygon ? 'visible' : 'hidden',
                        }}
                        aria-hidden
                    >
                        {draggingPolygon && (
                            <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
                                <polygon
                                    points={pointsFor(draggingPolygon.polygon)}
                                    fill={POLYGON_COLOR}
                                    fillOpacity={0.45}
                                    stroke={POLYGON_COLOR}
                                    strokeWidth={2}
                                    vectorEffect="non-scaling-stroke"
                                />
                            </g>
                        )}
                    </svg>
                </>
            )}
        </div>
    );
}

/** Validate a polygon for "can we save this safely?" (≥3 vertices, non-empty). */
export function canCommitPolygon(poly: LarvaePolygon): boolean {
    return isValidPolygon(poly);
}

function PanelStatRow({
    label,
    value,
    digits = 2,
}: {
    label: string;
    value: number | null | undefined;
    digits?: number;
}) {
    return (
        <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">
                {value == null ? '—' : value.toFixed(digits)}
            </dd>
        </div>
    );
}
