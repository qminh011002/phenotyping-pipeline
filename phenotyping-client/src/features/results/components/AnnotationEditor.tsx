// AnnotationEditor — interactive SVG layer for selecting, moving, resizing,
// creating, and deleting bounding boxes.
//
// Pointer-event strategy:
// - In *idle* mode the SVG root is `pointerEvents: none` so empty-area clicks
//   pass through to OverlayImage's pan handler (the user can still pan around
//   while editing). Only individual boxes/handles capture pointer events.
// - In *draw* mode the SVG root is `pointerEvents: all` so the rubber-band can
//   start anywhere on the canvas. OverlayImage's pan is disabled by the parent
//   while draw mode is active.
// - During an active drag we keep a *transient* preview state (`liveBoxes`).
//   We DO NOT call `onCommit` per pointermove — that would push a history
//   entry per pixel. Commit happens once on pointerup.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { BBox } from "@/types/api";
import {
  applyResize,
  clampBox,
  enforceMinSize,
  getHandlePositions,
  HANDLE_CURSORS,
  normalizeBox,
  svgPoint,
  type HandlePos,
} from "../lib/bboxMath";

interface AnnotationEditorProps {
  /** Committed boxes (from history.present in the parent). */
  annotations: BBox[];
  /** Image dimensions in image-pixel space (matches viewBox). */
  width: number;
  height: number;
  /** Index of selected box (null = none). */
  selectedIndex: number | null;
  /** Confidence threshold — model-origin boxes below this are hidden. */
  confidenceThreshold: number;
  /** Current zoom scale of the parent transform — used to scale handles. */
  scale: number;
  /**
   * Editor mode.
   * - "drag": Drag tool — click a box to select, drag to move/resize; empty
   *   area drags pan the view; background click deselects.
   * - "draw": rubber-band a new box; pan disabled.
   */
  mode: "drag" | "draw";
  onSelect: (index: number | null) => void;
  /** Commit a finished operation (called once on pointerup). */
  onCommit: (boxes: BBox[]) => void;
}

// ── Drag state ────────────────────────────────────────────────────────────

type DragKind = "body" | "resize" | "draw";

interface DragState {
  kind: DragKind;
  /** Image coords at the moment the drag started. */
  startX: number;
  startY: number;
  /** Snapshot of all boxes at drag start. */
  startBoxes: BBox[];
  /** Element that captured the pointer (for releasePointerCapture). */
  capturer: SVGElement;
  pointerId: number;
  /** For body/resize: which box. */
  index?: number;
  /** For body/resize: original bbox at drag start. */
  origBox?: [number, number, number, number];
  /** For resize: which handle. */
  handle?: HandlePos;
  /** Did the pointer move enough to count as a drag? */
  moved: boolean;
}

const HANDLE_PX = 10; // CSS-pixel target size for handles
const CLICK_VS_DRAG_PX = 3; // image-px tolerance for "this was a click, not a drag"

// Stroke colors keep view + edit visually consistent.
const STROKE_MODEL = "#22c55e"; // green-500
const STROKE_USER = "#f59e0b"; // amber-500
const STROKE_SELECTED = "#3b82f6"; // blue-500
const FILL_SELECTED = "rgba(59,130,246,0.10)";

export const AnnotationEditor = memo(function AnnotationEditor({
  annotations,
  width,
  height,
  selectedIndex,
  confidenceThreshold,
  scale,
  mode,
  onSelect,
  onCommit,
}: AnnotationEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  // rAF-coalesce pointermove: repeated events in the same frame collapse to one.
  const rafRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ clientX: number; clientY: number } | null>(null);
  /** Transient preview boxes during a drag; null = use props.annotations. */
  const [liveBoxes, setLiveBoxes] = useState<BBox[] | null>(null);
  const [rubberBand, setRubberBand] = useState<
    [number, number, number, number] | null
  >(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  /** Cursor position in image coords — used for the draw-mode crosshair. */
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  /** True while a body drag / resize / rubber-band is in flight (for dim). */
  const [dragging, setDragging] = useState(false);

  // The boxes the editor renders — preview during drag, otherwise committed.
  const renderBoxes = liveBoxes ?? annotations;

  // Reset transient state when the underlying annotations change.
  useEffect(() => {
    setLiveBoxes(null);
    setRubberBand(null);
    dragRef.current = null;
  }, [annotations]);

  // Cancel pending rAF on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const toImage = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      return svgPoint(e as unknown as React.PointerEvent, svg);
    },
    [],
  );

  const isVisible = useCallback(
    (b: BBox) => b.origin === "user" || b.confidence >= confidenceThreshold,
    [confidenceThreshold],
  );

  // Core move logic — runs inside rAF, takes raw clientX/Y.
  const processMove = useCallback(
    (clientX: number, clientY: number) => {
      const pt = toImage({ clientX, clientY });
      // Only update cursor state in draw mode (it drives the crosshair).
      // Outside draw, this was a wasted render on every pointermove.
      if (mode === "draw") setCursor(pt);

      const drag = dragRef.current;
      if (!drag) return;
      const { x, y } = pt;
      const dx = x - drag.startX;
      const dy = y - drag.startY;

      if (!drag.moved && Math.hypot(dx, dy) * scale > CLICK_VS_DRAG_PX) {
        drag.moved = true;
      }

      if (drag.kind === "draw") {
        setRubberBand([drag.startX, drag.startY, x, y]);
        return;
      }

      if (drag.kind === "body" && drag.index !== undefined && drag.origBox) {
        const [ox1, oy1, ox2, oy2] = drag.origBox;
        const moved = clampBox(
          [ox1 + dx, oy1 + dy, ox2 + dx, oy2 + dy],
          width,
          height,
        );
        const next = drag.startBoxes.slice();
        next[drag.index] = { ...next[drag.index], bbox: moved };
        setLiveBoxes(next);
        return;
      }

      if (
        drag.kind === "resize" &&
        drag.index !== undefined &&
        drag.origBox &&
        drag.handle
      ) {
        const resized = applyResize(
          drag.handle,
          dx,
          dy,
          drag.origBox[0],
          drag.origBox[1],
          drag.origBox[2],
          drag.origBox[3],
          width,
          height,
        );
        const next = drag.startBoxes.slice();
        next[drag.index] = {
          ...next[drag.index],
          bbox: resized,
          // Resizing a model box marks it as user-edited so it survives the
          // confidence filter and is preserved verbatim on save.
          origin: "user",
          edited_at: new Date().toISOString(),
        };
        setLiveBoxes(next);
        return;
      }
    },
    [height, mode, scale, toImage, width],
  );

  // Flush any pending rAF-coalesced move synchronously.
  const flushPendingMove = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const pending = pendingMoveRef.current;
    if (pending) {
      pendingMoveRef.current = null;
      processMove(pending.clientX, pending.clientY);
    }
  }, [processMove]);

  // ── Common pointer-up: applies to whatever drag is in flight ────────────

  const finishDrag = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Make sure the latest move position is applied before we read liveBoxes.
      flushPendingMove();
      try {
        if (drag.capturer.hasPointerCapture(drag.pointerId)) {
          drag.capturer.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // capturer may have been unmounted — fine.
      }
      dragRef.current = null;
      setRubberBand(null);
      setDragging(false);

      // Draw: commit only if the rubber-band reached min size
      if (drag.kind === "draw") {
        const { x, y } = toImage(e);
        const [nx1, ny1, nx2, ny2] = normalizeBox(drag.startX, drag.startY, x, y);
        const enforced = enforceMinSize(nx1, ny1, nx2, ny2);
        if (!enforced) return;
        const clamped = clampBox(enforced, width, height);
        const newBox: BBox = {
          label: "neonate_egg",
          bbox: clamped,
          confidence: 1.0,
          origin: "user",
          edited_at: new Date().toISOString(),
        };
        const next = [...annotations, newBox];
        onCommit(next);
        onSelect(next.length - 1);
        return;
      }

      // Resize: commit any change, even sub-pixel. Body: require actual drag
      // so a click that selects doesn't push a no-op history entry.
      if (drag.kind === "resize" && liveBoxes) {
        onCommit(liveBoxes);
      } else if (drag.kind === "body" && drag.moved && liveBoxes) {
        onCommit(liveBoxes);
      }
      setLiveBoxes(null);
    },
    [annotations, flushPendingMove, height, liveBoxes, onCommit, onSelect, toImage, width],
  );

  // ── Common pointer-move: rAF-coalesced dispatch ─────────────────────────

  const onMoveDuringDrag = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      // Extract coords now — React synthetic events can be recycled after return.
      pendingMoveRef.current = { clientX: e.clientX, clientY: e.clientY };
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const pending = pendingMoveRef.current;
        if (!pending) return;
        pendingMoveRef.current = null;
        processMove(pending.clientX, pending.clientY);
      });
    },
    [processMove],
  );

  // ── Per-element drag starters ───────────────────────────────────────────

  const startBoxDrag = useCallback(
    (e: React.PointerEvent<SVGRectElement>, index: number) => {
      if (e.button !== 0 || mode !== "drag") return;
      e.stopPropagation();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const { x, y } = toImage(e);
      onSelect(index);
      setDragging(true);
      dragRef.current = {
        kind: "body",
        startX: x,
        startY: y,
        startBoxes: annotations,
        capturer: target,
        pointerId: e.pointerId,
        index,
        origBox: [...annotations[index].bbox],
        moved: false,
      };
    },
    [annotations, mode, onSelect, toImage],
  );

  const startHandleDrag = useCallback(
    (e: React.PointerEvent<SVGElement>, handle: HandlePos) => {
      if (e.button !== 0 || selectedIndex === null || mode !== "drag") return;
      e.stopPropagation();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const { x, y } = toImage(e);
      setDragging(true);
      dragRef.current = {
        kind: "resize",
        startX: x,
        startY: y,
        startBoxes: annotations,
        capturer: target,
        pointerId: e.pointerId,
        index: selectedIndex,
        origBox: [...annotations[selectedIndex].bbox],
        handle,
        moved: false,
      };
    },
    [annotations, selectedIndex, mode, toImage],
  );

  const startDraw = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0 || mode !== "draw") return;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const { x, y } = toImage(e);
      setDragging(true);
      dragRef.current = {
        kind: "draw",
        startX: x,
        startY: y,
        startBoxes: annotations,
        capturer: target,
        pointerId: e.pointerId,
        moved: false,
      };
      setRubberBand([x, y, x, y]);
    },
    [annotations, mode, toImage],
  );

  // ── Render ───────────────────────────────────────────────────────────────

  const selected = selectedIndex !== null ? renderBoxes[selectedIndex] : null;
  const handleSize = HANDLE_PX / Math.max(scale, 0.001);
  const handleStrokeW = 1.5 / Math.max(scale, 0.001);
  // SVG root is pass-through in select/pan mode → empty clicks reach the pan
  // handler underneath. In draw mode it captures everything for the rubber-band.
  const rootPointerEvents = mode === "draw" ? "all" : "none";
  const cursorStyle = mode === "draw" ? "crosshair" : "default";
  // Dim is hidden during an active manipulation (drag/resize/draw) and in
  // draw mode so the user can see the raw image while placing a new box.
  const dimEnabled = mode !== "draw" && !dragging;
  const hoveredBox = hoverIdx !== null ? renderBoxes[hoverIdx] : null;

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="absolute inset-0"
      style={{
        pointerEvents: rootPointerEvents,
        cursor: cursorStyle,
        touchAction: "none",
      }}
      onPointerDown={mode === "draw" ? startDraw : undefined}
      onPointerMove={onMoveDuringDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      {/* Two-level dim overlay (level 1 always when enabled, level 2 on hover). */}
      {dimEnabled && (() => {
        const baseMaskId = `ae-mask-base-${width}-${height}`;
        const hoverMaskId = `ae-mask-hover-${width}-${height}`;
        return (
          <>
            <defs>
              <mask id={baseMaskId}>
                <rect x={0} y={0} width={width} height={height} fill="white" />
                {renderBoxes.map((b, i) => {
                  if (!isVisible(b)) return null;
                  const [x1, y1, x2, y2] = b.bbox;
                  return (
                    <rect
                      key={`mb-${i}`}
                      x={x1}
                      y={y1}
                      width={Math.max(0, x2 - x1)}
                      height={Math.max(0, y2 - y1)}
                      fill="black"
                    />
                  );
                })}
              </mask>
              <mask id={hoverMaskId}>
                <rect x={0} y={0} width={width} height={height} fill="white" />
                {hoveredBox && (
                  <rect
                    x={hoveredBox.bbox[0]}
                    y={hoveredBox.bbox[1]}
                    width={Math.max(0, hoveredBox.bbox[2] - hoveredBox.bbox[0])}
                    height={Math.max(0, hoveredBox.bbox[3] - hoveredBox.bbox[1])}
                    fill="black"
                  />
                )}
              </mask>
            </defs>
            <rect
              x={0}
              y={0}
              width={width}
              height={height}
              fill="black"
              opacity={0.5}
              mask={`url(#${baseMaskId})`}
              pointerEvents="none"
            />
            {hoveredBox && (
              <rect
                x={0}
                y={0}
                width={width}
                height={height}
                fill="black"
                opacity={0.35}
                mask={`url(#${hoverMaskId})`}
                pointerEvents="none"
              />
            )}
          </>
        );
      })()}

      {/* Draw-mode crosshair — dashed axes following the cursor */}
      {mode === "draw" && cursor && (
        <g pointerEvents="none">
          <line
            x1={0}
            y1={cursor.y}
            x2={width}
            y2={cursor.y}
            stroke="white"
            strokeWidth={1 / Math.max(scale, 0.001)}
            strokeDasharray={`${6 / Math.max(scale, 0.001)} ${4 / Math.max(scale, 0.001)}`}
            vectorEffect="non-scaling-stroke"
            opacity={0.8}
          />
          <line
            x1={cursor.x}
            y1={0}
            x2={cursor.x}
            y2={height}
            stroke="white"
            strokeWidth={1 / Math.max(scale, 0.001)}
            strokeDasharray={`${6 / Math.max(scale, 0.001)} ${4 / Math.max(scale, 0.001)}`}
            vectorEffect="non-scaling-stroke"
            opacity={0.8}
          />
        </g>
      )}

      {/* Boxes — each rect captures its own pointer events */}
      {renderBoxes.map((box, i) => {
        if (!isVisible(box)) return null;
        if (i === selectedIndex) return null; // drawn separately below
        const [x1, y1, x2, y2] = box.bbox;
        const w = Math.max(0, x2 - x1);
        const h = Math.max(0, y2 - y1);
        const stroke = box.origin === "user" ? STROKE_USER : STROKE_MODEL;
        const isHover = hoverIdx === i;
        return (
          <rect
            key={`box-${i}`}
            x={x1}
            y={y1}
            width={w}
            height={h}
            fill="transparent"
            stroke={stroke}
            strokeWidth={(isHover ? 2 : 1) / Math.max(scale, 0.001)}
            vectorEffect="non-scaling-stroke"
            opacity={isHover ? 1 : 0.9}
            onPointerDown={(e) => startBoxDrag(e, i)}
            onPointerMove={onMoveDuringDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onPointerEnter={() => setHoverIdx(i)}
            onPointerLeave={() =>
              setHoverIdx((p) => (p === i ? null : p))
            }
            style={{
              pointerEvents: mode === "drag" ? "all" : "none",
              cursor: mode === "draw" ? "crosshair" : "pointer",
            }}
          />
        );
      })}

      {/* Selected box + handles. Always rendered (even if confidence-filtered). */}
      {selected && (
        <SelectedBox
          box={selected}
          handleSize={handleSize}
          strokeW={handleStrokeW}
          scale={scale}
          mode={mode}
          onBodyPointerDown={(e) => {
            if (selectedIndex === null) return;
            startBoxDrag(e, selectedIndex);
          }}
          onHandlePointerDown={startHandleDrag}
          onMove={onMoveDuringDrag}
          onUp={finishDrag}
          onDelete={() => {
            if (selectedIndex === null) return;
            const next = annotations.filter((_, i) => i !== selectedIndex);
            onCommit(next);
            onSelect(null);
          }}
        />
      )}

      {/* Rubber-band rectangle */}
      {rubberBand && (() => {
        const [x1, y1, x2, y2] = normalizeBox(
          rubberBand[0], rubberBand[1], rubberBand[2], rubberBand[3],
        );
        return (
          <rect
            x={x1}
            y={y1}
            width={Math.max(0, x2 - x1)}
            height={Math.max(0, y2 - y1)}
            fill={FILL_SELECTED}
            stroke={STROKE_SELECTED}
            strokeWidth={1.5 / Math.max(scale, 0.001)}
            strokeDasharray={`${4 / Math.max(scale, 0.001)} ${3 / Math.max(scale, 0.001)}`}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        );
      })()}
    </svg>
  );
});

// ── Selected box rendering ────────────────────────────────────────────────

interface SelectedBoxProps {
  box: BBox;
  handleSize: number;
  strokeW: number;
  scale: number;
  mode: "drag" | "draw";
  onBodyPointerDown: (e: React.PointerEvent<SVGRectElement>) => void;
  onHandlePointerDown: (
    e: React.PointerEvent<SVGElement>,
    handle: HandlePos,
  ) => void;
  onMove: (e: React.PointerEvent<SVGElement>) => void;
  onUp: (e: React.PointerEvent<SVGElement>) => void;
  onDelete: () => void;
}

function SelectedBox({
  box,
  handleSize,
  strokeW,
  scale,
  mode,
  onBodyPointerDown,
  onHandlePointerDown,
  onMove,
  onUp,
  onDelete,
}: SelectedBoxProps) {
  const [x1, y1, x2, y2] = box.bbox;
  const handles = getHandlePositions(box.bbox);
  return (
    <g>
      {/* Body — clickable for move/select */}
      <rect
        x={x1}
        y={y1}
        width={Math.max(0, x2 - x1)}
        height={Math.max(0, y2 - y1)}
        fill={FILL_SELECTED}
        stroke={STROKE_SELECTED}
        strokeWidth={2 * strokeW}
        vectorEffect="non-scaling-stroke"
        onPointerDown={onBodyPointerDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{
          pointerEvents: mode === "drag" ? "all" : "none",
          cursor: mode === "draw" ? "crosshair" : "move",
        }}
      />
      {/* 8 resize handles */}
      {(Object.entries(handles) as [HandlePos, { x: number; y: number }][]).map(
        ([pos, { x, y }]) => (
          <circle
            key={pos}
            cx={x}
            cy={y}
            r={handleSize / 2}
            fill="white"
            stroke={STROKE_SELECTED}
            strokeWidth={strokeW}
            vectorEffect="non-scaling-stroke"
            onPointerDown={(e) => onHandlePointerDown(e, pos)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            style={{
              cursor: HANDLE_CURSORS[pos],
              pointerEvents: mode === "drag" ? "all" : "none",
            }}
          />
        ),
      )}
      {/* Delete handle */}
      <DeleteHandle x={x1} y={y1} size={handleSize * 1.6} scale={scale} onClick={onDelete} />
    </g>
  );
}

function DeleteHandle({
  x,
  y,
  size,
  onClick,
}: {
  x: number;
  y: number;
  size: number;
  scale: number;
  onClick: () => void;
}) {
  const r = size / 2;
  const cx = x - r * 0.6;
  const cy = y - r * 0.6;
  return (
    <g
      style={{ cursor: "pointer", pointerEvents: "all" }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <circle cx={cx} cy={cy} r={r} fill="#ef4444" stroke="white" strokeWidth={r * 0.18} />
      <line
        x1={cx - r * 0.4}
        y1={cy - r * 0.4}
        x2={cx + r * 0.4}
        y2={cy + r * 0.4}
        stroke="white"
        strokeWidth={r * 0.22}
        strokeLinecap="round"
      />
      <line
        x1={cx + r * 0.4}
        y1={cy - r * 0.4}
        x2={cx - r * 0.4}
        y2={cy + r * 0.4}
        stroke="white"
        strokeWidth={r * 0.22}
        strokeLinecap="round"
      />
    </g>
  );
}
