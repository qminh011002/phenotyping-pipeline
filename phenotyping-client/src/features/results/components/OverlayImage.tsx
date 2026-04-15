// OverlayImage — image viewer with zoom (scroll wheel, +/- keys) and pan (click+drag).
// Fits any image size including large 6000x4000 microscopy images.

import { useState, useRef, useCallback, useEffect } from "react";
import { Maximize2, ZoomIn, ZoomOut, Move } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface OverlayImageProps {
  /** Absolute URL to the overlay PNG */
  src: string;
  /** Alt text (usually the filename) */
  alt?: string;
  className?: string;
}

interface Transform {
  scale: number;
  translateX: number;
  translateY: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const ZOOM_FACTOR = 1.15;

export function OverlayImage({ src, alt = "Overlay", className }: OverlayImageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({ scale: 1, translateX: 0, translateY: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  // Reset transform when src changes (new image navigated to)
  useEffect(() => {
    setTransform({ scale: 1, translateX: 0, translateY: 0 });
    setImageLoaded(false);
    setImageError(false);
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

  // React attaches onWheel as a passive listener, which forbids preventDefault.
  // Attach a native non-passive wheel listener so we can suppress page scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const pivotX = e.clientX - rect.left - rect.width / 2;
      const pivotY = e.clientY - rect.top - rect.height / 2;
      zoom(e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR, pivotX, pivotY);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zoom]);

  // ── Pan ────────────────────────────────────────────────────────────────────

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - transform.translateX, y: e.clientY - transform.translateY });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!isDragging) return;
    setTransform((prev) => ({
      ...prev,
      translateX: e.clientX - dragStart.x,
      translateY: e.clientY - dragStart.y,
    }));
  }

  function handleMouseUp() {
    setIsDragging(false);
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  const fitToScreen = useCallback(() => {
    setTransform({ scale: 1, translateX: 0, translateY: 0 });
  }, []);

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

  const imageTransform = `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})`;

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
        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Move className="h-3 w-3" />
          <span>{Math.round(transform.scale * 100)}%</span>
        </div>
      </div>

      {/* Image viewport */}
      <div
        ref={containerRef}
        className={cn(
          "relative flex-1 overflow-hidden bg-muted/20 cursor-grab select-none",
          isDragging
            ? "cursor-grabbing"
            : "transition-transform duration-100 ease-out",
        )}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {!imageLoaded && !imageError && (
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

        <img
          src={src}
          alt={alt}
          className={cn(
            "max-w-none select-none transition-opacity duration-200",
            imageLoaded ? "opacity-100" : "opacity-0",
            transform.scale > 1 ? "" : "h-full w-auto mx-auto my-auto",
          )}
          style={{
            transform: transform.scale > 1 ? imageTransform : undefined,
            transformOrigin: "center center",
            margin: transform.scale <= 1 ? "auto" : undefined,
          }}
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageError(true)}
          draggable={false}
        />
      </div>
    </div>
  );
}
