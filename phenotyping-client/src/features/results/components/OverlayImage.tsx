// OverlayImage — raw image viewer with zoom/pan and client-side bbox overlay.
// Draws annotations as SVG rectangles on top of the raw image. On hover of a
// box, dims the rest of the image (via SVG mask) so the hovered region pops.

import { useState, useRef, useCallback, useEffect, useId } from "react";
import { Maximize2, ZoomIn, ZoomOut, Move } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { BBox } from "@/types/api";

interface OverlayImageProps {
  /** Absolute URL to the raw image */
  src: string;
  /** Alt text (usually the filename) */
  alt?: string;
  /** Bounding boxes to draw on top of the raw image */
  annotations?: BBox[];
  className?: string;
  /**
   * When true, disable panning so the editor can do drag gestures.
   * The parent ResultViewer controls this while in edit/draw mode.
   */
  panDisabled?: boolean;
  /**
   * When true, render the two-level dim overlay (default). When false, the
   * raw image is shown without any dim. Non-edit mode flips this off while the
   * user holds Ctrl so they can inspect the raw pixels.
   */
  dimEnabled?: boolean;
  /**
   * Fired when the user clicks the background (pointerdown → pointerup with
   * no drag). Used by the editor to deselect boxes on empty-area clicks.
   */
  onBackgroundClick?: () => void;
  /**
   * Render-prop for the editor layer. Receives the current zoom scale so the
   * editor can render scale-aware handles. Mounted inside the transformed div
   * so geometry stays pixel-aligned with the image.
   */
  editorSlot?: (ctx: { scale: number }) => React.ReactNode;
  /**
   * Called when the natural image dimensions are determined (after image loads).
   * The editor can use this to configure its own SVG viewBox to match the image.
   */
  onDimensions?: (width: number, height: number) => void;
}

interface Transform {
  scale: number;
  translateX: number;
  translateY: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 20;
const ZOOM_FACTOR = 1.15; // used by +/- buttons and keyboard
const WHEEL_ZOOM_SENSITIVITY = 0.0015; // smaller = smoother
const BOX_STROKE = "#00ff00";
const BOX_STROKE_WIDTH = 1; // in image pixel units — matches backend overlay
const DIM_OPACITY_BASE = 0.5; // default — dim everything except boxes
const DIM_OPACITY_HOVER = 0.8; // hover — dim more, keep only hovered box bright

export function OverlayImage({
  src,
  alt = "Overlay",
  annotations = [],
  className,
  panDisabled = false,
  dimEnabled = true,
  onBackgroundClick,
  editorSlot,
  onDimensions,
}: OverlayImageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({ scale: 1, translateX: 0, translateY: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [naturalDims, setNaturalDims] = useState<{ w: number; h: number } | null>(null);
  const [imageError, setImageError] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const maskId = useId();

  // ── Fit-to-screen helpers ────────────────────────────────────────────────────

  const computeFitScale = useCallback((w: number, h: number): number => {
    const el = containerRef.current;
    if (!el) return 1;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (cw <= 0 || ch <= 0) return 1;
    return Math.min(cw / w, ch / h, 1);
  }, []);

  const fitToScreen = useCallback(() => {
    if (!naturalDims) return;
    const scale = computeFitScale(naturalDims.w, naturalDims.h);
    setTransform({ scale, translateX: 0, translateY: 0 });
  }, [naturalDims, computeFitScale]);

  // Reset state when src changes
  useEffect(() => {
    setNaturalDims(null);
    setImageError(false);
    setHoveredIdx(null);
    setTransform({ scale: 1, translateX: 0, translateY: 0 });
  }, [src]);

  // ── Zoom ──────────────────────────────────────────────────────────────────

  const zoom = useCallback((delta: number, pivotX: number, pivotY: number) => {
    setTransform((prev) => {
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * delta));
      const ratio = newScale / prev.scale;
      return {
        scale: newScale,
        translateX: pivotX - ratio * (pivotX - prev.translateX),
        translateY: pivotY - ratio * (pivotY - prev.translateY),
      };
    });
  }, []);

  // Non-passive wheel listener so we can prevent page scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const pivotX = e.clientX - rect.left - rect.width / 2;
      const pivotY = e.clientY - rect.top - rect.height / 2;
      // Continuous zoom factor via exp so trackpad gestures feel smooth.
      // Clamp extreme single-event deltas so a fast flick can't jump too far.
      const delta = Math.max(-120, Math.min(120, e.deltaY));
      zoom(Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY), pivotX, pivotY);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zoom]);

  // ── Pan (pointer events so editor stopPropagation blocks it) ──────────────
  // Track the initial pointer position so we can distinguish a click (no
  // movement → deselect boxes via onBackgroundClick) from a drag (pan).
  const downPosRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);

  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    if (panDisabled) return;
    downPosRef.current = { x: e.clientX, y: e.clientY };
    movedRef.current = false;
    setIsDragging(true);
    setDragStart({ x: e.clientX - transform.translateX, y: e.clientY - transform.translateY });
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!isDragging) return;
    if (downPosRef.current && !movedRef.current) {
      const dx = e.clientX - downPosRef.current.x;
      const dy = e.clientY - downPosRef.current.y;
      if (Math.hypot(dx, dy) > 3) movedRef.current = true;
    }
    setTransform((prev) => ({
      ...prev,
      translateX: e.clientX - dragStart.x,
      translateY: e.clientY - dragStart.y,
    }));
  }

  function handlePointerUp() {
    if (isDragging && !movedRef.current) onBackgroundClick?.();
    setIsDragging(false);
    downPosRef.current = null;
    movedRef.current = false;
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  function handleZoomIn() {
    zoom(ZOOM_FACTOR, 0, 0);
  }
  function handleZoomOut() {
    zoom(1 / ZOOM_FACTOR, 0, 0);
  }

  // ── Keyboard shortcuts (+/-/0) ─────────────────────────────────────────────

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "=" || e.key === "+") { e.preventDefault(); handleZoomIn(); }
      else if (e.key === "-") { e.preventDefault(); handleZoomOut(); }
      else if (e.key === "0") { e.preventDefault(); fitToScreen(); }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fitToScreen]);

  // ── Load raw image (off-DOM) to get natural dimensions ─────────────────────

  useEffect(() => {
    if (!src) return;
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      setNaturalDims({ w, h });
      onDimensions?.(w, h);
      // Compute fit scale using the *current* container size.
      const el = containerRef.current;
      let scale = 1;
      if (el) {
        const cw = el.clientWidth;
        const ch = el.clientHeight;
        if (cw > 0 && ch > 0) scale = Math.min(cw / w, ch / h, 1);
      }
      setTransform({ scale, translateX: 0, translateY: 0 });
    };
    img.onerror = () => setImageError(true);
    img.src = src;
  }, [src]);

  const hovered = hoveredIdx !== null ? annotations[hoveredIdx] : null;

  const transformStyle = naturalDims
    ? `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})`
    : undefined;

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Controls toolbar */}
      <div className="flex items-center gap-1 border-b px-3 py-2 bg-muted/30">
        <Button
          variant="ghost"
          size="icon"
          title="Fit to screen (0)"
          onClick={fitToScreen}
          className="h-7 w-7"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Zoom in (+)"
          onClick={handleZoomIn}
          className="h-7 w-7"
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Zoom out (-)"
          onClick={handleZoomOut}
          className="h-7 w-7"
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <div className="ml-3 text-xs text-muted-foreground tabular-nums">
          {annotations.length} box{annotations.length === 1 ? "" : "es"}
        </div>
        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Move className="h-3 w-3" />
          <span>{Math.round(transform.scale * 100)}%</span>
        </div>
      </div>

      {/* Image viewport */}
      <div
        ref={containerRef}
        className={cn(
          "relative flex-1 overflow-hidden bg-muted/20 select-none flex items-center justify-center",
          isDragging ? "cursor-grabbing" : panDisabled ? "cursor-default" : "cursor-grab",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {!src && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16l5-5 4 4 5-5 4 4M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
            </svg>
            <p className="text-sm">Raw image unavailable</p>
            <p className="max-w-xs text-center text-xs text-muted-foreground/70">
              Re-run the analysis so the uploaded file is available for display.
            </p>
          </div>
        )}

        {src && !naturalDims && !imageError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Skeleton className="h-full w-full" />
          </div>
        )}

        {imageError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm">Failed to load image</p>
            <p className="text-xs text-muted-foreground/60">{alt}</p>
          </div>
        )}

        {naturalDims && (
          <div
            className={cn(
              "relative shrink-0",
              isDragging ? "" : "transition-transform duration-100 ease-out",
            )}
            style={{
              width: naturalDims.w,
              height: naturalDims.h,
              transform: transformStyle,
              transformOrigin: "center center",
            }}
          >
            <img
              src={src}
              alt={alt}
              width={naturalDims.w}
              height={naturalDims.h}
              className="block max-w-none select-none"
              draggable={false}
            />

            {/* Read-only overlay (view mode). Hidden in edit mode — the editor
                renders its own boxes with selection handles. */}
            {!editorSlot && (
              <svg
                width={naturalDims.w}
                height={naturalDims.h}
                viewBox={`0 0 ${naturalDims.w} ${naturalDims.h}`}
                preserveAspectRatio="none"
                className="absolute inset-0 pointer-events-none"
              >
                <defs>
                  {/* Default mask — cuts out every visible box so the image
                      stays bright inside each bbox and dim everywhere else. */}
                  <mask id={`${maskId}-base`}>
                    <rect x={0} y={0} width={naturalDims.w} height={naturalDims.h} fill="white" />
                    {annotations.map((a, i) => (
                      <rect
                        key={`mbase-${i}`}
                        x={a.bbox[0]}
                        y={a.bbox[1]}
                        width={a.bbox[2] - a.bbox[0]}
                        height={a.bbox[3] - a.bbox[1]}
                        fill="black"
                      />
                    ))}
                  </mask>
                  {/* Hover mask — cuts out only the hovered box. Drawn on top
                      of the base overlay to add extra darkness to all other
                      regions (including the other boxes). */}
                  <mask id={`${maskId}-hover`}>
                    <rect x={0} y={0} width={naturalDims.w} height={naturalDims.h} fill="white" />
                    {hovered && (
                      <rect
                        x={hovered.bbox[0]}
                        y={hovered.bbox[1]}
                        width={hovered.bbox[2] - hovered.bbox[0]}
                        height={hovered.bbox[3] - hovered.bbox[1]}
                        fill="black"
                      />
                    )}
                  </mask>
                </defs>

                {dimEnabled && (
                  <>
                    {/* Level 1: always-on dim — everything except boxes */}
                    <rect
                      x={0}
                      y={0}
                      width={naturalDims.w}
                      height={naturalDims.h}
                      fill="black"
                      opacity={DIM_OPACITY_BASE}
                      mask={`url(#${maskId}-base)`}
                      pointerEvents="none"
                    />

                    {/* Level 2: hover dim — stacks on top, keeps only hovered
                        box bright, darkens everything else (including other boxes) */}
                    {hovered && (
                      <rect
                        x={0}
                        y={0}
                        width={naturalDims.w}
                        height={naturalDims.h}
                        fill="black"
                        opacity={DIM_OPACITY_HOVER - DIM_OPACITY_BASE}
                        mask={`url(#${maskId}-hover)`}
                        pointerEvents="none"
                      />
                    )}
                  </>
                )}

                {annotations.map((a, i) => {
                  const [x1, y1, x2, y2] = a.bbox;
                  const w = Math.max(0, x2 - x1);
                  const h = Math.max(0, y2 - y1);
                  const isHovered = hoveredIdx === i;
                  const stroke = a.origin === "user" ? "#f59e0b" : BOX_STROKE;
                  return (
                    <rect
                      key={`${i}-${x1}-${y1}`}
                      x={x1}
                      y={y1}
                      width={w}
                      height={h}
                      fill="transparent"
                      stroke={stroke}
                      strokeWidth={(isHovered ? BOX_STROKE_WIDTH * 2 : BOX_STROKE_WIDTH) / Math.max(transform.scale, 0.001)}
                      vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents: "all", cursor: "pointer" }}
                      onMouseEnter={() => setHoveredIdx(i)}
                      onMouseLeave={() =>
                        setHoveredIdx((prev) => (prev === i ? null : prev))
                      }
                    >
                      <title>{`${a.label} · ${(a.confidence * 100).toFixed(1)}%`}</title>
                    </rect>
                  );
                })}
              </svg>
            )}

            {editorSlot?.({ scale: transform.scale })}
          </div>
        )}
      </div>
    </div>
  );
}
