// OverlayImage — raw image viewer with zoom/pan and client-side bbox overlay.
// Draws annotations as SVG rectangles on top of the raw image. On hover of a
// box, dims the rest of the image (via SVG mask) so the hovered region pops.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CloudUpload, Minus, Plus } from "lucide-react";

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
  saveInProgress?: boolean;
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
const ZOOM_FACTOR = 1.15;
const WHEEL_ZOOM_SENSITIVITY = 0.0006;
const BOX_STROKE = "#00ff00";
const BOX_STROKE_WIDTH = 2;
const DIM_OPACITY_BASE = 0.5;
const DIM_OPACITY_HOVER = 0.8;

export function OverlayImage({
  src,
  alt = "Overlay",
  annotations = [],
  className,
  saveInProgress = false,
  panDisabled = false,
  dimEnabled = true,
  onBackgroundClick,
  editorSlot,
  onDimensions,
}: OverlayImageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const transformedDivRef = useRef<HTMLDivElement>(null);
  // Source of truth for current transform during interactions.
  // React state `transform` mirrors this, but via rAF to avoid per-event renders.
  const transformRef = useRef<Transform>({
    scale: 1,
    translateX: 0,
    translateY: 0,
  });
  const rafSyncRef = useRef<number | null>(null);
  const [transform, setTransform] = useState<Transform>({
    scale: 1,
    translateX: 0,
    translateY: 0,
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const [naturalDims, setNaturalDims] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [imageError, setImageError] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const maskId = useId();

  // Write transform directly to the DOM — bypasses React reconciliation.
  const applyTransformDOM = useCallback(() => {
    const el = transformedDivRef.current;
    if (!el) return;
    const t = transformRef.current;
    el.style.transform = `translate(${t.translateX}px, ${t.translateY}px) scale(${t.scale})`;
  }, []);

  // Coalesce React state syncs to one per frame so the scale readout +
  // editor's scale prop stay live without re-rendering on every event.
  const scheduleStateSync = useCallback(() => {
    if (rafSyncRef.current !== null) return;
    rafSyncRef.current = requestAnimationFrame(() => {
      rafSyncRef.current = null;
      setTransform({ ...transformRef.current });
    });
  }, []);

  const commitTransform = useCallback(
    (t: Transform) => {
      transformRef.current = t;
      setTransform(t);
      applyTransformDOM();
    },
    [applyTransformDOM],
  );

  useEffect(() => {
    return () => {
      if (rafSyncRef.current !== null) cancelAnimationFrame(rafSyncRef.current);
    };
  }, []);

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

    commitTransform({
      scale: computeFitScale(naturalDims.w, naturalDims.h),
      translateX: 0,
      translateY: 0,
    });
  }, [commitTransform, computeFitScale, naturalDims]);

  useEffect(() => {
    setNaturalDims(null);
    setImageError(false);
    setHoveredIdx(null);
    commitTransform({ scale: 1, translateX: 0, translateY: 0 });
  }, [commitTransform, src]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !naturalDims) return;

    const observer = new ResizeObserver(() => {
      commitTransform({
        scale: computeFitScale(naturalDims.w, naturalDims.h),
        translateX: 0,
        translateY: 0,
      });
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [commitTransform, computeFitScale, naturalDims]);

  // Imperative zoom: mutate ref + DOM directly, rAF-sync React state.
  const zoom = useCallback(
    (delta: number, pivotX: number, pivotY: number) => {
      const prev = transformRef.current;
      const nextScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, prev.scale * delta),
      );
      if (nextScale === prev.scale) return;
      const ratio = nextScale / prev.scale;
      transformRef.current = {
        scale: nextScale,
        translateX: pivotX - ratio * (pivotX - prev.translateX),
        translateY: pivotY - ratio * (pivotY - prev.translateY),
      };
      applyTransformDOM();
      scheduleStateSync();
    },
    [applyTransformDOM, scheduleStateSync],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const pivotX = e.clientX - rect.left - rect.width / 2;
      const pivotY = e.clientY - rect.top - rect.height / 2;
      const delta = Math.max(-120, Math.min(120, e.deltaY));
      zoom(Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY), pivotX, pivotY);
    };

    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zoom]);

  const downPosRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const isDraggingRef = useRef(false);

  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || panDisabled) return;

    downPosRef.current = { x: e.clientX, y: e.clientY };
    movedRef.current = false;
    isDraggingRef.current = true;
    setIsDragging(true);
    const t = transformRef.current;
    dragStartRef.current = {
      x: e.clientX - t.translateX,
      y: e.clientY - t.translateY,
    };
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!isDraggingRef.current) return;

    if (downPosRef.current && !movedRef.current) {
      const dx = e.clientX - downPosRef.current.x;
      const dy = e.clientY - downPosRef.current.y;
      if (Math.hypot(dx, dy) > 3) movedRef.current = true;
    }

    const prev = transformRef.current;
    transformRef.current = {
      ...prev,
      translateX: e.clientX - dragStartRef.current.x,
      translateY: e.clientY - dragStartRef.current.y,
    };
    applyTransformDOM();
    // No state sync during pan — translate doesn't affect any child props.
    // State gets committed once on pointerup.
  }

  function handlePointerUp() {
    if (isDraggingRef.current && !movedRef.current) onBackgroundClick?.();
    if (isDraggingRef.current && movedRef.current) {
      // Commit final translate to React state so scale-dependent consumers
      // (unlikely to care about translate, but keep state consistent).
      setTransform({ ...transformRef.current });
    }
    isDraggingRef.current = false;
    setIsDragging(false);
    downPosRef.current = null;
    movedRef.current = false;
  }

  function handleZoomIn() {
    zoom(ZOOM_FACTOR, 0, 0);
  }

  function handleZoomOut() {
    zoom(1 / ZOOM_FACTOR, 0, 0);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const inputFocused =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;
      if (inputFocused) return;

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        handleZoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        handleZoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        fitToScreen();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fitToScreen]);

  useEffect(() => {
    if (!src) return;

    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;

      setNaturalDims({ w, h });
      onDimensions?.(w, h);

      commitTransform({
        scale: computeFitScale(w, h),
        translateX: 0,
        translateY: 0,
      });
    };
    img.onerror = () => setImageError(true);
    img.src = src;
  }, [commitTransform, computeFitScale, onDimensions, src]);

  const hovered = hoveredIdx !== null ? annotations[hoveredIdx] : null;

  const transformStyle = naturalDims
    ? `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})`
    : undefined;

  return (
    <div className={cn("h-full", className)}>
      <div
        ref={containerRef}
        className={cn(
          "relative flex h-full items-center justify-center overflow-hidden bg-muted/20 select-none",
          isDragging
            ? "cursor-grabbing"
            : panDisabled
              ? "cursor-default"
              : "cursor-grab",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className="pointer-events-none absolute bottom-4 left-4 z-20">
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-[14px] border border-cyan-400/40 bg-slate-950/88 px-2 py-1.5 text-cyan-50 shadow-[0_14px_40px_rgba(0,0,0,0.32)] backdrop-blur-md">
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
              {Math.round(transform.scale * 100)}%
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

        {src && !naturalDims && !imageError && (
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

        {naturalDims && (
          <div
            ref={transformedDivRef}
            className="relative shrink-0"
            style={{
              width: naturalDims.w,
              height: naturalDims.h,
              transform: transformStyle,
              transformOrigin: "center center",
              willChange: "transform",
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

            {!editorSlot && (
              <svg
                width={naturalDims.w}
                height={naturalDims.h}
                viewBox={`0 0 ${naturalDims.w} ${naturalDims.h}`}
                preserveAspectRatio="none"
                className="absolute inset-0 pointer-events-none"
              >
                <defs>
                  <mask id={`${maskId}-base`}>
                    <rect
                      x={0}
                      y={0}
                      width={naturalDims.w}
                      height={naturalDims.h}
                      fill="white"
                    />
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
                  <mask id={`${maskId}-hover`}>
                    <rect
                      x={0}
                      y={0}
                      width={naturalDims.w}
                      height={naturalDims.h}
                      fill="white"
                    />
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
                      strokeWidth={
                        (isHovered ? BOX_STROKE_WIDTH * 2 : BOX_STROKE_WIDTH) /
                        Math.max(transform.scale, 0.001)
                      }
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
