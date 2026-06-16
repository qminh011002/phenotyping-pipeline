// LarvaePolygonEditor — interactive larvae polygon viewer + editor.
//
// Replaces LarvaePolygonLayer in the result viewer. Drives all polygon
// rendering off the parent's working polygon set (so the parent owns history
// via usePolygonEdits) and adds edit interactions:
//   - vertex drag (handles render only on the selected polygon)
//   - edge click → insert vertex
//   - right-click vertex → delete vertex
//   - draw mode → click to drop vertices, double-click / Enter to close,
//     Esc to cancel
//
// Pan/zoom mirrors LarvaePolygonLayer so view feel is identical.

import {
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from 'react';

import { CloudUpload, Minus, Plus } from 'lucide-react';

import { http } from '@/services/http';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

import type { LarvaeMeasurement, LarvaePolygon, Point2D } from '@/types/api';

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

const MIN_SCALE = 0.1;
const MAX_SCALE = 12;
const ZOOM_FACTOR = 1.15;
/** Click within this image-space distance of an edge → insert vertex. */
const EDGE_HIT_PX = 6;

export type LarvaePolygonTool = 'select' | 'draw';

interface LarvaePolygonEditorProps {
    rawSrc: string;
    polygons: WorkingPolygon[];
    selectedDetectionId: string | null;
    onSelect: (id: string | null) => void;
    /** Parent-owned tool — flips between select and draw via toolbar / shortcut. */
    tool: LarvaePolygonTool;
    /** Called when the user drops the draw mode (cancel or close). */
    onToolChange?: (tool: LarvaePolygonTool) => void;
    /** True while a move/vertex drag is active; parent delays autosave until false. */
    onInteractionChange?: (active: boolean) => void;

    onMoveVertex: (detectionId: string, vertexIdx: number, next: Point2D) => void;
    /** Translate every vertex of a polygon by (dx, dy) in image space. */
    onTranslatePolygon: (detectionId: string, dx: number, dy: number) => void;
    onInsertVertex: (
        detectionId: string,
        edgeIdx: number,
        point: Point2D,
    ) => number;
    onDeleteVertex: (detectionId: string, vertexIdx: number) => boolean;
    onAddPolygon: (polygon: LarvaePolygon) => string;
    /** Delete the polygon (called from the floating edit panel). */
    onDeletePolygon?: (detectionId: string) => void;
    /** Measurements indexed by detection_id — used to populate the edit panel. */
    measurements?: LarvaeMeasurement[];
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

/** Below this image-space displacement, a polygon pointerdown is treated as a click. */
const POLYGON_DRAG_THRESHOLD_PX = 4;

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
    saveInProgress = false,
    savePending = false,
    previewPolygon,
    calibrationCorners,
    onCalibrationCornersChange,
    overlayVisible = true,
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

    const [scale, setScale] = useState(1);
    const [tx, setTx] = useState(0);
    const [ty, setTy] = useState(0);
    /** Inverse-zoom radius for vertex handles so they look ~6px regardless of zoom. */
    const handleR = useMemo(() => 6 / scale, [scale]);
    const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(
        null,
    );
    /** Live tx/ty during a pan drag — written by the DOM, committed to state on pointerup. */
    const livePanRef = useRef<{ tx: number; ty: number } | null>(null);
    const panRafRef = useRef<number | null>(null);

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
     * This is the key fix for slow-drag stutter: mutating an SVG attribute
     * on a child invalidates the parent SVG's backing store every frame.
     */
    const [draggingPolygonId, setDraggingPolygonId] = useState<string | null>(null);
    /** Overlay SVG element ref — owns the dragged-polygon copy. */
    const dragOverlayRef = useRef<SVGSVGElement | null>(null);
    /**
     * rAF handle for the SVG pointermove → vertex/polygon drag preview path.
     * Pointermove can fire faster than 60 Hz on high-rate input devices, and
     * each preview write triggers a full SVG repaint (the spotlight mask is
     * pixel-expensive to update). Coalescing into a single rAF tick caps the
     * preview cost at one paint per frame, mirroring the egg/neonate Konva
     * path's per-frame commit.
     */
    const dragRafRef = useRef<number | null>(null);
    /** Whichever drag is currently active — used to hide the spotlight mask. */
    const draggingActive = vertexDragging || polygonDragging;
    const polygonNodeRefs = useRef(new Map<string, SVGPolygonElement>());
    const maskNodeRefs = useRef(new Map<string, SVGPolygonElement>());
    const handleGroupRefs = useRef(new Map<string, SVGGElement>());
    const handleNodeRefs = useRef(new Map<string, Map<number, SVGRectElement>>());
    /** Vertices the user has clicked while in draw mode. Image coords. */
    const [drawingVertices, setDrawingVertices] = useState<LarvaePolygon>([]);
    const [drawCursor, setDrawCursor] = useState<Point2D | null>(null);

    // ── Image load ──────────────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        let url: string | null = null;
        const controller = new AbortController();
        http.getBlob(rawSrc, controller.signal)
            .then((blob) => {
                if (cancelled) return;
                url = URL.createObjectURL(blob);
                setObjectUrl(url);
                const img = new Image();
                img.onload = () => {
                    if (cancelled) return;
                    setDims({ w: img.naturalWidth, h: img.naturalHeight });
                    onDimensions?.(img.naturalWidth, img.naturalHeight);
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
    }, [rawSrc, onDimensions]);

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
            if (dragRafRef.current != null) {
                cancelAnimationFrame(dragRafRef.current);
                dragRafRef.current = null;
            }
            pendingDragPointRef.current = null;
            // Drop cached CTM + release any promoted compositing layer.
            dragCtmInverseRef.current = null;
            const promotedId = promotedDetectionIdRef.current;
            if (promotedId) {
                promotedDetectionIdRef.current = null;
                const poly = polygonNodeRefs.current.get(promotedId);
                const handles = handleGroupRefs.current.get(promotedId);
                if (poly) poly.style.willChange = '';
                if (handles) handles.style.willChange = '';
            }
            // Clear any leftover transform/visibility on the overlay element.
            const overlay = dragOverlayRef.current;
            if (overlay) overlay.style.transform = '';
            onInteractionChange?.(false);
            setDrawingVertices([]);
            setDrawCursor(null);
        };
    }, [rawSrc, onInteractionChange]);

    /** Map a clientX/Y from a React event to image pixel space. */
    const clientToImage = useCallback(
        (clientX: number, clientY: number): Point2D | null => {
            const g = gRef.current;
            if (!g) return null;
            const ctm = g.getScreenCTM();
            if (!ctm) return null;
            const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
            return [p.x, p.y];
        },
        [],
    );

    function polylineFor(poly: LarvaePolygon): string {
        return poly.map(([x, y]) => `${x},${y}`).join(' ');
    }

    const setPolygonNodeRef = useCallback(
        (id: string, node: SVGPolygonElement | null) => {
            if (node) polygonNodeRefs.current.set(id, node);
            else polygonNodeRefs.current.delete(id);
        },
        [],
    );

    const setMaskNodeRef = useCallback(
        (id: string, node: SVGPolygonElement | null) => {
            if (node) maskNodeRefs.current.set(id, node);
            else maskNodeRefs.current.delete(id);
        },
        [],
    );

    const setHandleGroupRef = useCallback(
        (id: string, node: SVGGElement | null) => {
            if (node) handleGroupRefs.current.set(id, node);
            else handleGroupRefs.current.delete(id);
        },
        [],
    );

    const setHandleNodeRef = useCallback(
        (id: string, idx: number, node: SVGRectElement | null) => {
            const existing = handleNodeRefs.current.get(id);
            if (!node) {
                existing?.delete(idx);
                if (existing?.size === 0) handleNodeRefs.current.delete(id);
                return;
            }
            const next = existing ?? new Map<number, SVGRectElement>();
            next.set(idx, node);
            handleNodeRefs.current.set(id, next);
        },
        [],
    );

    const setPolygonTranslatePreview = useCallback(
        (_detectionId: string, dx: number, dy: number) => {
            // The dragged polygon is rendered in a separate overlay <svg>
            // (see draggingPolygonId state). Movement is applied as a CSS
            // transform on the overlay element — compositor-only, no
            // re-rasterization of the main SVG. The CSS unit is screen
            // pixels, whereas dx/dy are in image-space user units; multiply
            // by the current zoom scale to land them on the right spot.
            const overlay = dragOverlayRef.current;
            if (!overlay) return;
            if (dx !== 0 || dy !== 0) {
                overlay.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
            } else {
                overlay.style.transform = '';
            }
        },
        [scale],
    );

    const setVertexPreview = useCallback(
        (drag: DragState) => {
            const nextPolygon = drag.startPolygon.slice();
            nextPolygon[drag.vertexIdx] = drag.currentPoint;
            const points = polylineFor(nextPolygon);
            polygonNodeRefs.current.get(drag.detectionId)?.setAttribute('points', points);
            // Mask polygon is hidden during drag — skip per-frame update.

            const handle = handleNodeRefs.current
                .get(drag.detectionId)
                ?.get(drag.vertexIdx);
            if (handle) {
                handle.setAttribute('x', String(drag.currentPoint[0] - handleR));
                handle.setAttribute('y', String(drag.currentPoint[1] - handleR));
            }
        },
        [handleR],
    );

    const resetVertexPreview = useCallback(
        (drag: DragState) => {
            const points = polylineFor(drag.startPolygon);
            polygonNodeRefs.current.get(drag.detectionId)?.setAttribute('points', points);
            // Mask was not touched during drag, so it already shows startPolygon.
            const handle = handleNodeRefs.current
                .get(drag.detectionId)
                ?.get(drag.vertexIdx);
            if (handle) {
                handle.setAttribute('x', String(drag.startPoint[0] - handleR));
                handle.setAttribute('y', String(drag.startPoint[1] - handleR));
            }
        },
        [handleR],
    );

    // ── Drag perf helpers ───────────────────────────────────────────────────
    /**
     * Inverse CTM cached at drag-start so per-frame clientToImage doesn't
     * call getScreenCTM() (which can force a style flush when there are
     * pending DOM mutations). The cache is valid because nothing changes
     * the SVG <g>'s transform while a drag is in progress (pan is gated
     * off, zoom requires wheel which user can't do mid-drag).
     */
    const dragCtmInverseRef = useRef<DOMMatrix | null>(null);
    /**
     * Detection id of the polygon currently in a body drag — we promote
     * its SVG nodes to their own compositing layer via `will-change` so
     * the browser GPU-composes the per-frame translate instead of
     * rasterizing the full SVG. Cleared on drag end so the layer is
     * released (will-change is expensive when left on indefinitely).
     */
    const promotedDetectionIdRef = useRef<string | null>(null);

    const refreshDragCtmInverse = useCallback(() => {
        const g = gRef.current;
        if (!g) {
            dragCtmInverseRef.current = null;
            return;
        }
        const ctm = g.getScreenCTM();
        dragCtmInverseRef.current = ctm ? ctm.inverse() : null;
    }, []);

    const clientToImageFast = useCallback(
        (clientX: number, clientY: number): Point2D | null => {
            const inv = dragCtmInverseRef.current;
            if (!inv) return null;
            const p = new DOMPoint(clientX, clientY).matrixTransform(inv);
            return [p.x, p.y];
        },
        [],
    );

    const beginDragPerfMode = useCallback(() => {
        refreshDragCtmInverse();
        // Promote the SVG to its own compositing layer for the duration of
        // the drag — same trick startPan uses (line 540-541). Individual SVG
        // children don't get their own layers, so the existing per-polygon
        // `willChange = 'transform'` hint is a no-op; the only handle the
        // browser respects in SVG is on the root <svg> element.
        const svg = svgRef.current;
        if (svg) svg.style.willChange = 'transform';
    }, [refreshDragCtmInverse]);

    /**
     * Promote a single polygon's visible nodes to their own compositing
     * layer. Called when a body-drag actually starts moving (so we don't
     * pay the layer-promotion cost for click intents that never turn into
     * drags).
     */
    const promoteDetectionLayer = useCallback((detectionId: string) => {
        if (promotedDetectionIdRef.current === detectionId) return;
        promotedDetectionIdRef.current = detectionId;
        const poly = polygonNodeRefs.current.get(detectionId);
        const handles = handleGroupRefs.current.get(detectionId);
        if (poly) poly.style.willChange = 'transform';
        if (handles) handles.style.willChange = 'transform';
        // Disable pointer-events on every OTHER polygon while one is being
        // dragged. SVG `<polygon>` defaults to `visiblePainted` hit-testing —
        // when the dragged polygon visually slides over a complex underlying
        // polygon the browser still computes boundary events on it. Switch
        // it off entirely; pointer capture on the dragged element keeps the
        // drag pipeline working.
        polygonNodeRefs.current.forEach((node, id) => {
            if (id !== detectionId) node.style.pointerEvents = 'none';
        });
    }, []);

    const releaseDetectionLayer = useCallback(() => {
        const id = promotedDetectionIdRef.current;
        promotedDetectionIdRef.current = null;
        if (!id) return;
        const poly = polygonNodeRefs.current.get(id);
        const handles = handleGroupRefs.current.get(id);
        if (poly) poly.style.willChange = '';
        if (handles) handles.style.willChange = '';
        // Restore pointer-events on every polygon.
        polygonNodeRefs.current.forEach((node) => {
            node.style.pointerEvents = '';
        });
    }, []);

    const endDragPerfMode = useCallback(() => {
        dragCtmInverseRef.current = null;
        releaseDetectionLayer();
        // Release the SVG layer hint. Pair with the `willChange = 'transform'`
        // set in beginDragPerfMode (and the same pattern in startPan).
        const svg = svgRef.current;
        if (svg) svg.style.willChange = '';
        // Reset the overlay element's CSS transform so a future drag starts
        // from translate(0, 0). The draggingPolygonId state itself is cleared
        // by the caller (so React removes the overlay copy from the DOM at
        // the same commit that re-renders the main SVG polygon with its new
        // vertex positions — avoiding a one-frame double image).
        const overlay = dragOverlayRef.current;
        if (overlay) overlay.style.transform = '';
    }, [releaseDetectionLayer]);

    // ── Pan / zoom (only when not editing) ──────────────────────────────────
    // React's synthetic onWheel is passive in React 17+, so preventDefault()
    // logs a warning. Attach a native non-passive wheel listener instead.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const direction = e.deltaY < 0 ? 1 : -1;
            const next = Math.min(
                MAX_SCALE,
                Math.max(MIN_SCALE, scale * (direction > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR)),
            );
            if (next === scale) return;
            const rect = el.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const k = next / scale;
            setTx(cx - k * (cx - tx));
            setTy(cy - k * (cy - ty));
            setScale(next);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [scale, tx, ty]);

    const handleZoomIn = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const next = Math.min(MAX_SCALE, scale * ZOOM_FACTOR);
        if (next === scale) return;
        const k = next / scale;
        setTx(cx - k * (cx - tx));
        setTy(cy - k * (cy - ty));
        setScale(next);
    }, [scale, tx, ty]);

    const handleZoomOut = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const next = Math.max(MIN_SCALE, scale / ZOOM_FACTOR);
        if (next === scale) return;
        const k = next / scale;
        setTx(cx - k * (cx - tx));
        setTy(cy - k * (cy - ty));
        setScale(next);
    }, [scale, tx, ty]);

    const fitToScreen = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect || !dims) return;
        const fit = Math.min(rect.width / dims.w, rect.height / dims.h);
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit));
        setScale(next);
        setTx((rect.width - dims.w * next) / 2);
        setTy((rect.height - dims.h * next) / 2);
    }, [dims]);

    function startPan(e: ReactPointerEvent<HTMLDivElement>) {
        if (e.button !== 0) return;
        if (vertexDragRef.current) return;
        const target = e.target as Element;
        // Polygon, vertex, edge interactions handle their own pointer events.
        if (
            target.closest('[data-polygon-id]') ||
            target.closest('[data-vertex-idx]') ||
            target.closest('[data-edge-idx]')
        ) {
            return;
        }
        if (tool === 'draw') return;
        target.setPointerCapture?.(e.pointerId);
        panRef.current = { x: e.clientX, y: e.clientY, tx, ty };
        // Promote the SVG to its own GPU layer for the duration of the pan so
        // the per-frame style.transform delta is just a layer translate, not a
        // re-raster of every polygon + mask.
        const svg = svgRef.current;
        if (svg) svg.style.willChange = 'transform';
    }

    function continuePan(e: ReactPointerEvent<HTMLDivElement>) {
        const drag = panRef.current;
        if (!drag) return;
        const nextTx = drag.tx + (e.clientX - drag.x);
        const nextTy = drag.ty + (e.clientY - drag.y);
        livePanRef.current = { tx: nextTx, ty: nextTy };
        // Skip React re-render during pan — mutate transform directly. We only
        // re-render once on pointerup. SVG hit-testing keeps working because
        // clientToImage reads the live DOM matrix via getScreenCTM().
        if (panRafRef.current == null) {
            panRafRef.current = requestAnimationFrame(() => {
                panRafRef.current = null;
                const live = livePanRef.current;
                if (!live) return;
                const img = imgWrapRef.current;
                if (img) {
                    img.style.transform = `translate(${live.tx}px, ${live.ty}px) scale(${scale})`;
                }
                // Pan-only fast path for the SVG: don't mutate the inner <g>
                // (which would re-rasterize every polygon + the spotlight mask
                // every frame). Instead, push a delta translate as a CSS
                // transform on the <svg> element — browser slides the cached
                // raster of the whole vector tree. On pointerup we clear this
                // and let React commit the new tx/ty into <g> for crisp vectors.
                const svg = svgRef.current;
                if (svg) {
                    const dx = live.tx - tx;
                    const dy = live.ty - ty;
                    svg.style.transform = `translate(${dx}px, ${dy}px)`;
                }
            });
        }
    }

    function endPan(e: ReactPointerEvent<HTMLDivElement>) {
        const drag = panRef.current;
        panRef.current = null;
        if (panRafRef.current != null) {
            cancelAnimationFrame(panRafRef.current);
            panRafRef.current = null;
        }
        const live = livePanRef.current;
        livePanRef.current = null;
        // Treat near-zero drag on empty area as deselect.
        if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) {
            if (tool !== 'draw') onSelect(null);
            return;
        }
        // Commit the final translate to state so future renders use it.
        // Clear the SVG's pan-delta CSS transform in the same frame React
        // commits the new <g> transform — otherwise the delta would stack on
        // top of the new translate and the vectors would jump.
        if (live) {
            const svg = svgRef.current;
            if (svg) {
                svg.style.transform = '';
                svg.style.willChange = '';
            }
            setTx(live.tx);
            setTy(live.ty);
        } else {
            const svg = svgRef.current;
            if (svg) svg.style.willChange = '';
        }
    }

    // ── Drag preview rAF coalescing ─────────────────────────────────────────
    /**
     * Latest pointer position during a vertex or polygon-body drag. Written
     * every pointermove but applied to the DOM at most once per animation
     * frame so a high-rate input device (pen, 240Hz mouse) doesn't trigger
     * one mask re-raster per pointer sample.
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
                if (!polygonDragging) setPolygonDragging(true);
                // Move the polygon into the overlay <svg> so subsequent
                // movement is just a CSS transform on a separately-composited
                // layer. This is the crucial step that stops the main SVG
                // from re-rasterizing every frame during slow drag.
                if (draggingPolygonId !== polyDrag.detectionId) {
                    setDraggingPolygonId(polyDrag.detectionId);
                }
                // Promote the dragged polygon's nodes to their own layer
                // *only once* movement actually starts — that way a click
                // intent (pointerdown without drag) doesn't pay the cost.
                promoteDetectionLayer(polyDrag.detectionId);
                setPolygonTranslatePreview(polyDrag.detectionId, dx, dy);
            }
        }
    }, [
        dims,
        polygonDragging,
        draggingPolygonId,
        promoteDetectionLayer,
        setPolygonTranslatePreview,
        setVertexPreview,
    ]);

    // ── Polygon body pointer interactions ──────────────────────────────────
    // pointerdown on the polygon body either starts a translate-drag (if the
    // polygon is already selected) or seeds a "click intent" so pointerup can
    // resolve to select / insert-vertex. We do this with pointer events rather
    // than onClick because we need to differentiate click vs drag.
    const handlePolygonPointerDown = useCallback(
        (e: ReactPointerEvent<SVGElement>, wp: WorkingPolygon) => {
            if (e.button !== 0) return;
            if (tool !== 'select') return;
            e.stopPropagation();
            const point = clientToImage(e.clientX, e.clientY);
            if (!point) return;
            (e.target as Element).setPointerCapture?.(e.pointerId);
            polygonDragRef.current = {
                detectionId: wp.detection_id,
                startPoint: point,
                dx: 0,
                dy: 0,
                moved: 0,
            };
            setPolygonDragging(false);
            setPolygonTranslatePreview(wp.detection_id, 0, 0);
            // Engage drag perf mode (CTM cache + outline-only polygons).
            beginDragPerfMode();
            onInteractionChange?.(true);
        },
        [
            tool,
            clientToImage,
            setPolygonTranslatePreview,
            beginDragPerfMode,
            onInteractionChange,
        ],
    );

    const finishPolygonPointer = useCallback(
        (e: ReactPointerEvent<SVGElement>, wp: WorkingPolygon) => {
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
            // Remove the overlay <svg> copy of the dragged polygon. React
            // commits this state change in the same batch as the parent's
            // `onTranslatePolygon` update, so the main-SVG polygon is
            // revealed at its new vertex positions on the same frame the
            // overlay disappears — no visible flicker.
            if (draggingPolygonId !== null) setDraggingPolygonId(null);
            if (drag) setPolygonTranslatePreview(drag.detectionId, 0, 0);
            if (wasDragging && drag) {
                onTranslatePolygon(drag.detectionId, drag.dx, drag.dy);
                onInteractionChange?.(false);
                return;
            }
            if (drag) onInteractionChange?.(false);
            if (tool === 'draw') return;

            // Treat as a click — select, or insert vertex if near an edge.
            const isSelected = wp.detection_id === selectedDetectionId;
            const point = clientToImage(e.clientX, e.clientY);
            if (isSelected && point) {
                const near = findClosestEdge(wp.polygon, point, EDGE_HIT_PX);
                if (near) {
                    onInsertVertex(wp.detection_id, near.edgeIdx, near.projection);
                    return;
                }
            }
            onSelect(wp.detection_id);
        },
        [
            tool,
            selectedDetectionId,
            clientToImage,
            flushDragPreview,
            endDragPerfMode,
            onInsertVertex,
            onSelect,
            onTranslatePolygon,
            onInteractionChange,
            setPolygonTranslatePreview,
            draggingPolygonId,
        ],
    );

    // ── Vertex pointer handlers ─────────────────────────────────────────────
    const handleVertexPointerDown = useCallback(
        (
            e: ReactPointerEvent<SVGElement>,
            wp: WorkingPolygon,
            vertexIdx: number,
        ) => {
            if (tool !== 'select') return;
            if (e.button === 2) return; // let context menu handle delete
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
        },
        [tool, beginDragPerfMode, onInteractionChange],
    );

    const handleVertexContextMenu = useCallback(
        (
            e: React.MouseEvent<SVGElement>,
            wp: WorkingPolygon,
            vertexIdx: number,
        ) => {
            e.preventDefault();
            e.stopPropagation();
            if (tool !== 'select') return;
            onDeleteVertex(wp.detection_id, vertexIdx);
        },
        [tool, onDeleteVertex],
    );

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
        if (tool === 'draw') {
            const point = clientToImage(e.clientX, e.clientY);
            if (!point) return;
            setDrawCursor(point);
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
            setPolygonTranslatePreview(polygonDrag.detectionId, 0, 0);
            polygonDragRef.current = null;
            setPolygonDragging(false);
            if (draggingPolygonId !== null) setDraggingPolygonId(null);
            onInteractionChange?.(false);
        }
    }

    function handleSvgPointerUp(_e: ReactPointerEvent<SVGSVGElement>) {
        finishVertexDrag();
    }

    function handleSvgClick(e: React.MouseEvent<SVGSVGElement>) {
        if (tool !== 'draw') return;
        // Ignore clicks that hit polygons / handles — those events stopPropagation.
        const point = clientToImage(e.clientX, e.clientY);
        if (!point || !dims) return;
        const [x, y] = [
            Math.max(0, Math.min(dims.w, point[0])),
            Math.max(0, Math.min(dims.h, point[1])),
        ];
        // Reject duplicate / too-close vertices.
        if (drawingVertices.length > 0) {
            const last = drawingVertices[drawingVertices.length - 1];
            if (sqDist(last, [x, y]) < MIN_EDGE_LENGTH_PX * MIN_EDGE_LENGTH_PX) {
                return;
            }
        }
        setDrawingVertices((prev) => [...prev, [x, y]]);
    }

    function handleSvgDoubleClick(_e: React.MouseEvent<SVGSVGElement>) {
        if (tool !== 'draw') return;
        commitDraw();
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

    // Enter while a polygon is selected (and not drawing) → exit edit mode (save).
    useEffect(() => {
        if (tool === 'draw') return;
        if (!selectedDetectionId) return;
        if (calibrationCorners) return;
        function onKeyDown(e: KeyboardEvent) {
            const target = e.target;
            if (
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement
            ) {
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

    // Enter to close, Esc to cancel.
    useEffect(() => {
        if (tool !== 'draw') return;
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === 'Enter') {
                e.preventDefault();
                commitDraw();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                setDrawingVertices([]);
                setDrawCursor(null);
                onToolChange?.('select');
            }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [tool, commitDraw, onToolChange]);

    // ── Selected polygon edit-panel inputs ─────────────────────────────────
    const selectedIndex = useMemo(() => {
        if (!selectedDetectionId) return null;
        const idx = polygons.findIndex(
            (p) => p.detection_id === selectedDetectionId,
        );
        return idx >= 0 ? idx + 1 : null;
    }, [polygons, selectedDetectionId]);

    const selectedMeasurement = useMemo(() => {
        if (!selectedDetectionId || !measurements) return null;
        return (
            measurements.find((m) => m.detection_id === selectedDetectionId) ?? null
        );
    }, [measurements, selectedDetectionId]);

    const showEditPanel =
        !!selectedDetectionId && tool === 'select' && !calibrationCorners;

    // Memoized snapshot of the polygon currently being body-dragged. Used
    // by the dedicated overlay <svg> below. Recomputes only when the
    // dragging id or polygons array changes — not per-frame.
    const draggingPolygon = useMemo<WorkingPolygon | null>(() => {
        if (!draggingPolygonId) return null;
        return polygons.find((p) => p.detection_id === draggingPolygonId) ?? null;
    }, [draggingPolygonId, polygons]);

    // ── Render helpers ──────────────────────────────────────────────────────
    const cursor = useMemo(() => {
        if (vertexDragging) return 'grabbing';
        if (tool === 'draw') return 'crosshair';
        return panRef.current ? 'grabbing' : 'grab';
    }, [vertexDragging, tool]);

    return (
        <div
            ref={containerRef}
            className={cn(
                'relative h-full w-full overflow-hidden bg-muted/40 select-none',
                className,
            )}
            onPointerDown={startPan}
            onPointerMove={continuePan}
            onPointerUp={endPan}
            data-testid="larvae-polygon-editor"
            style={{ cursor }}
        >
            {imageError && (
                <div className="absolute inset-0 grid place-items-center text-sm text-destructive">
                    Could not load image
                </div>
            )}
            {/* Zoom controls + saving indicator — mirrors OverlayImage's bottom-left bar. */}
            <div className="pointer-events-none absolute bottom-4 left-4 z-20 flex items-center gap-2">
                <div className="pointer-events-auto flex items-center rounded-md border border-border bg-card/90 p-1 shadow-md backdrop-blur">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Zoom out"
                        onClick={handleZoomOut}
                        className="h-7 w-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                        <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <div className="min-w-12 px-1 text-center font-mono text-xs font-semibold tabular-nums text-foreground">
                        {Math.round(scale * 100)}%
                    </div>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Zoom in"
                        onClick={handleZoomIn}
                        className="h-7 w-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </Button>
                    <span className="mx-1 h-4 w-px bg-border" />
                    <Button
                        variant="ghost"
                        size="sm"
                        title="Fit to viewport"
                        onClick={fitToScreen}
                        className="h-7 rounded-sm px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                        Fit
                    </Button>
                </div>
                <div
                    className={cn(
                        'pointer-events-none flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur transition-opacity duration-200 ease-out',
                        saveInProgress || savePending ? 'opacity-100' : 'opacity-0',
                    )}
                    aria-hidden={!saveInProgress && !savePending}
                >
                    <CloudUpload className="h-3.5 w-3.5 animate-pulse text-primary" />
                    <span>{saveInProgress ? 'Saving' : 'Save queued'}</span>
                </div>
            </div>
            {tool === 'draw' && (
                <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-border/60 bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur">
                    {drawingVertices.length < MIN_POLYGON_VERTICES
                        ? `Click to add points · need ${MIN_POLYGON_VERTICES - drawingVertices.length} more · Esc to cancel`
                        : 'Click first point or press Enter to finish · Esc to cancel'}
                </div>
            )}
            {showEditPanel && (
                <div className="pointer-events-auto absolute left-4 top-4 z-20 w-64 rounded-lg border border-border/60 bg-card/90 p-3 text-card-foreground shadow-lg backdrop-blur">
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-semibold tabular-nums">
                            #{selectedIndex ?? '—'}
                        </span>
                        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            Stat ▲
                        </span>
                    </div>
                    <div className="mb-3 space-y-1 text-xs">
                        <PanelStatRow
                            label="Length (mm)"
                            value={selectedMeasurement?.length_mm}
                        />
                        <PanelStatRow
                            label="Area (mm²)"
                            value={selectedMeasurement?.area_mm2}
                        />
                        <PanelStatRow
                            label="Max W (mm)"
                            value={selectedMeasurement?.max_width_mm}
                        />
                        <PanelStatRow
                            label="Weight (mg)"
                            value={selectedMeasurement?.weight_mg}
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="destructive"
                            className="flex-1"
                            onClick={() => {
                                if (!selectedDetectionId) return;
                                onDeletePolygon?.(selectedDetectionId);
                                onSelect(null);
                            }}
                        >
                            Delete
                        </Button>
                        <Button
                            size="sm"
                            className="flex-1"
                            onClick={() => onSelect(null)}
                        >
                            Save (Enter)
                        </Button>
                    </div>
                </div>
            )}
            {dims && objectUrl && (
                <>
                    {/*
                      Raster image — CSS transform on its own wrapper. Bitmap
                      scaling is fine here (and unavoidable past native res).
                    */}
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
                      <g>. Browser re-rasterizes paths each frame so polygons
                      stay sharp at any zoom.
                    */}
                    <svg
                        ref={svgRef}
                        width="100%"
                        height="100%"
                        // overflow:visible disables SVG's per-element viewport
                        // clip so vector content drawn outside the SVG box
                        // still renders. Without this, CSS-translating the
                        // SVG during pan exposes the area where its content
                        // was clipped (dim overlay would only cover part of
                        // the image). Container's overflow-hidden does the
                        // real clipping.
                        style={{
                            position: 'absolute',
                            inset: 0,
                            overflow: 'visible',
                            // Ctrl/Cmd-hold reveals the raw image — match
                            // OverlayImage's dimEnabled behavior. Pointer
                            // events go off too so the polygons don't eat
                            // clicks while hidden.
                            opacity: overlayVisible ? 1 : 0,
                            pointerEvents: overlayVisible ? undefined : 'none',
                            transition: 'opacity 120ms ease-out',
                        }}
                        onPointerMove={handleSvgPointerMove}
                        onPointerUp={handleSvgPointerUp}
                        onPointerCancel={cancelActiveDrag}
                        onClick={handleSvgClick}
                        onDoubleClick={handleSvgDoubleClick}
                    >
                    <g
                        ref={gRef}
                        transform={`translate(${tx} ${ty}) scale(${scale})`}
                    >
                        {/*
                          Spotlight mask: dim overlay covers the whole image,
                          but each polygon is "cut out" so the original image
                          shines through. When the user hovers a polygon, only
                          that one (and the selected one, if any) keeps the
                          cut-out — every other region (including other
                          polygons' interiors) sits under the dim overlay.
                        */}
                        <defs>
                            <mask id={`bright-${maskId}`}>
                                <rect
                                    x={0}
                                    y={0}
                                    width={dims.w}
                                    height={dims.h}
                                    fill="white"
                                />
                                {polygons.map((wp) => {
                                    const isHovered = wp.detection_id === hoverId;
                                    const isSelected =
                                        wp.detection_id === selectedDetectionId;
                                    const bright =
                                        hoverId === null
                                            ? true
                                            : isHovered || isSelected;
                                    if (!bright) return null;
                                    return (
                                        <polygon
                                            key={`mask:${wp.detection_id}`}
                                            ref={(node) =>
                                                setMaskNodeRef(wp.detection_id, node)
                                            }
                                            points={polylineFor(wp.polygon)}
                                            fill="black"
                                        />
                                    );
                                })}
                            </mask>
                        </defs>
                        {/*
                          Dim overlay. Skipped during an active drag because
                          updating the mask polygon's `points` / `transform`
                          forces a full re-raster of the mask each frame —
                          that was the dominant cost of vertex / polygon
                          drag on dense scenes. Egg/neonate uses the same
                          trick (`showDim = !interacting`).
                        */}
                        {!draggingActive && (
                            <rect
                                x={0}
                                y={0}
                                width={dims.w}
                                height={dims.h}
                                fill="black"
                                opacity={0.4}
                                mask={`url(#bright-${maskId})`}
                                pointerEvents="none"
                            />
                        )}
                        {/* Polygons */}
                        {polygons.map((wp) => {
                            const isSelected = wp.detection_id === selectedDetectionId;
                            const isHovered = wp.detection_id === hoverId;
                            const isBeingDragged =
                                draggingPolygonId === wp.detection_id;
                            // Don't dim other polygons on hover — only the
                            // hovered/selected polygon gets a small lift.
                            const fillOpacity = isHovered || isSelected ? 0.45 : 0.32;
                            const showPreview =
                                isSelected && previewPolygon && previewPolygon.length >= 3;
                            const renderedPoly = showPreview
                                ? (previewPolygon as LarvaePolygon)
                                : wp.polygon;
                            const selfIntersects =
                                isSelected && hasSelfIntersection(renderedPoly);
                            return (
                                <polygon
                                    key={wp.detection_id}
                                    ref={(node) =>
                                        setPolygonNodeRef(wp.detection_id, node)
                                    }
                                    data-polygon-id={wp.detection_id}
                                    points={polylineFor(renderedPoly)}
                                    fill="#00FFFF"
                                    fillOpacity={fillOpacity}
                                    stroke={
                                        selfIntersects
                                            ? 'var(--destructive)'
                                            : '#00FFFF'
                                    }
                                    strokeWidth={isSelected ? 2 : 1}
                                    vectorEffect="non-scaling-stroke"
                                    // While body-dragging, hide the main-SVG
                                    // copy; an overlay <svg> renders the
                                    // moving copy on its own GPU layer. The
                                    // node still receives pointer events
                                    // (capture is on it) but the browser
                                    // skips painting it.
                                    visibility={isBeingDragged ? 'hidden' : 'visible'}
                                    style={{
                                        cursor: isSelected
                                            ? polygonDragging
                                                ? 'grabbing'
                                                : 'grab'
                                            : 'pointer',
                                    }}
                                    onMouseEnter={() => {
                                        // Freeze hover state while a drag is
                                        // in progress — otherwise crossing
                                        // over another polygon fires
                                        // mouseenter → setHoverId → full
                                        // <svg> reconcile, which is the
                                        // dominant cost of cross-over jank.
                                        if (
                                            polygonDragRef.current ||
                                            vertexDragRef.current
                                        )
                                            return;
                                        setHoverId(wp.detection_id);
                                    }}
                                    onMouseLeave={() => {
                                        if (
                                            polygonDragRef.current ||
                                            vertexDragRef.current
                                        )
                                            return;
                                        setHoverId((cur) =>
                                            cur === wp.detection_id ? null : cur,
                                        );
                                    }}
                                    onPointerDown={(e) =>
                                        handlePolygonPointerDown(e, wp)
                                    }
                                    onPointerUp={(e) => finishPolygonPointer(e, wp)}
                                />
                            );
                        })}

                        {/* Vertex handles for the selected polygon only — small white squares with a thin dark border. */}
                        {polygons
                            .filter((p) => p.detection_id === selectedDetectionId)
                            .map((wp) =>
                                <g
                                    key={`handles:${wp.detection_id}`}
                                    ref={(node) =>
                                        setHandleGroupRef(wp.detection_id, node)
                                    }
                                    visibility={
                                        draggingPolygonId === wp.detection_id
                                            ? 'hidden'
                                            : 'visible'
                                    }
                                >
                                    {wp.polygon.map((v, i) => (
                                        <rect
                                            key={`${wp.detection_id}:${i}`}
                                            ref={(node) =>
                                                setHandleNodeRef(
                                                    wp.detection_id,
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
                                                handleVertexPointerDown(e, wp, i)
                                            }
                                            onContextMenu={(e) =>
                                                handleVertexContextMenu(e, wp, i)
                                            }
                                        />
                                    ))}
                                </g>,
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
                                    fill="none"
                                    stroke="var(--primary)"
                                    strokeWidth={1.5}
                                    strokeDasharray="4 3"
                                    vectorEffect="non-scaling-stroke"
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
                                            style={{
                                                cursor: isCloser ? 'pointer' : 'default',
                                            }}
                                            onClick={(e) => {
                                                if (!isCloser) return;
                                                e.stopPropagation();
                                                commitDraw();
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
                      currently being body-dragged (and its vertex handles)
                      on its own GPU compositing layer. The main SVG above
                      stays static during the drag; per-frame movement is
                      applied to this overlay element's CSS transform only,
                      which the compositor handles without re-rasterizing
                      either SVG's backing store. The ref is always set so
                      `setPolygonTranslatePreview` can mutate
                      `style.transform` immediately on threshold cross.
                    */}
                    <svg
                        ref={dragOverlayRef}
                        width="100%"
                        height="100%"
                        style={{
                            position: 'absolute',
                            inset: 0,
                            overflow: 'visible',
                            // Pointer events go to the captured polygon in
                            // the main SVG — the overlay is visual-only.
                            pointerEvents: 'none',
                            willChange: draggingPolygon ? 'transform' : 'auto',
                            visibility: draggingPolygon ? 'visible' : 'hidden',
                        }}
                        aria-hidden
                    >
                        {draggingPolygon && (
                            <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
                                <polygon
                                    points={polylineFor(draggingPolygon.polygon)}
                                    fill="#00FFFF"
                                    fillOpacity={0.45}
                                    stroke="#00FFFF"
                                    strokeWidth={2}
                                    vectorEffect="non-scaling-stroke"
                                />
                                {draggingPolygon.detection_id === selectedDetectionId && (
                                    <g>
                                        {draggingPolygon.polygon.map((v, i) => (
                                            <rect
                                                key={i}
                                                x={v[0] - handleR}
                                                y={v[1] - handleR}
                                                width={handleR * 2}
                                                height={handleR * 2}
                                                fill="white"
                                                stroke="#1f2937"
                                                strokeWidth={1}
                                                vectorEffect="non-scaling-stroke"
                                            />
                                        ))}
                                    </g>
                                )}
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
            <span className="text-muted-foreground">{label}</span>
            <span className="tabular-nums">
                {value == null ? '—' : value.toFixed(digits)}
            </span>
        </div>
    );
}
