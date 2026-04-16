// bboxMath.ts — Pure geometry helpers for the annotation editor.
// All operations work in image-native pixel coordinates.

import type { BBox } from "@/types/api";

// ── Constants ───────────────────────────────────────────────────────────────

/** Minimum width/height of any box in image pixels. Prevents zero-area artifacts. */
export const MIN_BOX_SIZE = 4;

// ── Types ─────────────────────────────────────────────────────────────────

/** Handle positions on a bbox: 4 corners + 4 edge midpoints. */
export type HandlePos =
  | "nw" | "n" | "ne"
  | "w"       | "e"
  | "sw" | "s" | "se";

/** Cursor style per handle position. */
export const HANDLE_CURSORS: Record<HandlePos, string> = {
  nw: "nw-resize",
  n:  "ns-resize",
  ne: "ne-resize",
  w:  "ew-resize",
  e:  "ew-resize",
  sw: "sw-resize",
  s:  "ns-resize",
  se: "se-resize",
};

/** Hit-test result for handle clicking. */
export interface HandleHit {
  type: "handle";
  pos: HandlePos;
}

/** Hit-test result for body (box interior) clicking. */
export interface BodyHit {
  type: "body";
  index: number;
}

/** Hit-test result for empty SVG area. */
export interface EmptyHit {
  type: "empty";
}

export type HitTestResult = HandleHit | BodyHit | EmptyHit;

// ── Coordinate helpers ─────────────────────────────────────────────────────

/** Normalize a box so x1 < x2 and y1 < y2. */
export function normalizeBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): [number, number, number, number] {
  return [
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2),
  ];
}

/** Clamp box coordinates within image bounds [0, W] × [0, H]. */
export function clampBox(
  bbox: [number, number, number, number],
  w: number,
  h: number,
): [number, number, number, number] {
  const [x1, y1, x2, y2] = bbox;
  return [
    Math.max(0, Math.min(w, x1)),
    Math.max(0, Math.min(h, y1)),
    Math.max(0, Math.min(w, x2)),
    Math.max(0, Math.min(h, y2)),
  ];
}

/** Enforce minimum box size. Returns undefined if box would be smaller than MIN_BOX_SIZE. */
export function enforceMinSize(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): [number, number, number, number] | undefined {
  const [nx1, ny1, nx2, ny2] = normalizeBox(x1, y1, x2, y2);
  const width = nx2 - nx1;
  const height = ny2 - ny1;
  if (width < MIN_BOX_SIZE || height < MIN_BOX_SIZE) return undefined;
  return [nx1, ny1, nx2, ny2];
}

/**
 * Clamp a box to at least MIN_BOX_SIZE in both dimensions, anchoring against the
 * given fixed corner so resize feels responsive (drag never just "stops").
 *
 * If shrinking past minimum, the moving edge stops at MIN_BOX_SIZE away from
 * the anchor. Used during live resize so the box never disappears.
 */
export function clampToMinSize(
  bbox: [number, number, number, number],
  anchorX: "left" | "right" | "none",
  anchorY: "top" | "bottom" | "none",
): [number, number, number, number] {
  let [x1, y1, x2, y2] = bbox;
  if (x2 - x1 < MIN_BOX_SIZE) {
    if (anchorX === "left") x2 = x1 + MIN_BOX_SIZE;
    else if (anchorX === "right") x1 = x2 - MIN_BOX_SIZE;
    else { const c = (x1 + x2) / 2; x1 = c - MIN_BOX_SIZE / 2; x2 = c + MIN_BOX_SIZE / 2; }
  }
  if (y2 - y1 < MIN_BOX_SIZE) {
    if (anchorY === "top") y2 = y1 + MIN_BOX_SIZE;
    else if (anchorY === "bottom") y1 = y2 - MIN_BOX_SIZE;
    else { const c = (y1 + y2) / 2; y1 = c - MIN_BOX_SIZE / 2; y2 = c + MIN_BOX_SIZE / 2; }
  }
  return [x1, y1, x2, y2];
}

// ── Handle geometry ────────────────────────────────────────────────────────

/** Returns the x/y position of each handle in image coordinates. */
export function getHandlePositions(
  bbox: [number, number, number, number],
): Record<HandlePos, { x: number; y: number }> {
  const [x1, y1, x2, y2] = bbox;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  return {
    nw: { x: x1, y: y1 },
    n:  { x: cx, y: y1 },
    ne: { x: x2, y: y1 },
    w:  { x: x1, y: cy },
    e:  { x: x2, y: cy },
    sw: { x: x1, y: y2 },
    s:  { x: cx, y: y2 },
    se: { x: x2, y: y2 },
  };
}

/** Convert a mouse event to an image-space point using the SVG getScreenCTM() trick. */
export function svgPoint(
  e: React.PointerEvent | MouseEvent,
  svgEl: SVGSVGElement,
): { x: number; y: number } {
  const pt = svgEl.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const inv = svgEl.getScreenCTM()?.inverse();
  if (!inv) return { x: pt.x, y: pt.y };
  const transformed = pt.matrixTransform(inv);
  return { x: transformed.x, y: transformed.y };
}

// ── Hit testing ────────────────────────────────────────────────────────────

/** Hit radius in image pixels — must be large enough to tap on mobile/trackpad. */
const HIT_RADIUS = 8;

/**
 * Test whether a pointer position hits a resize handle.
 * Returns the handle position if hit, null otherwise.
 */
export function hitTestHandle(
  bbox: [number, number, number, number],
  px: number,
  py: number,
): HandlePos | null {
  const handles = getHandlePositions(bbox);
  for (const [pos, { x, y }] of Object.entries(handles) as [HandlePos, { x: number; y: number }][]) {
    if (Math.abs(x - px) <= HIT_RADIUS && Math.abs(y - py) <= HIT_RADIUS) {
      return pos;
    }
  }
  return null;
}

/**
 * Test whether a pointer position hits a box body (inside the rect, excluding handles).
 * Returns the box index if hit, null otherwise.
 */
export function hitTestBody(
  annotations: BBox[],
  px: number,
  py: number,
): number | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const [x1, y1, x2, y2] = annotations[i].bbox;
    // Check inside the rect (strictly inside, not on the border, to avoid conflict with handles)
    if (px > x1 && px < x2 && py > y1 && py < y2) {
      return i;
    }
  }
  return null;
}

/** Full hit test: handle → body → empty. */
export function hitTest(
  annotations: BBox[],
  selectedIndex: number,
  px: number,
  py: number,
): HitTestResult {
  if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < annotations.length) {
    const handle = hitTestHandle(annotations[selectedIndex].bbox, px, py);
    if (handle) return { type: "handle", pos: handle };
  }
  const bodyIdx = hitTestBody(annotations, px, py);
  if (bodyIdx !== null) return { type: "body", index: bodyIdx };
  return { type: "empty" };
}

// ── Resize math ────────────────────────────────────────────────────────────

/**
 * Apply a resize drag to a box.
 * Returns the new box coordinates or undefined if the result would be too small.
 *
 * @param bbox     Current box [x1, y1, x2, y2]
 * @param pos      Which handle is being dragged
 * @param dx       Delta in image pixels (current pointer - drag origin)
 * @param dy       Delta in image pixels
 * @param origX1   Original x1 at drag start (in image coords)
 * @param origY1   Original y1 at drag start
 * @param origX2   Original x2 at drag start
 * @param origY2   Original y2 at drag start
 * @param imgW     Image width (for clamping)
 * @param imgH     Image height (for clamping)
 */
export function applyResize(
  pos: HandlePos,
  dx: number,
  dy: number,
  origX1: number,
  origY1: number,
  origX2: number,
  origY2: number,
  imgW: number,
  imgH: number,
): [number, number, number, number] {
  let nx1 = origX1;
  let ny1 = origY1;
  let nx2 = origX2;
  let ny2 = origY2;

  // Track which edge is anchored so we can clamp against it on min-size.
  let anchorX: "left" | "right" | "none" = "none";
  let anchorY: "top" | "bottom" | "none" = "none";

  switch (pos) {
    case "nw": nx1 += dx; ny1 += dy; anchorX = "right"; anchorY = "bottom"; break;
    case "n":  ny1 += dy;            anchorY = "bottom";                    break;
    case "ne": nx2 += dx; ny1 += dy; anchorX = "left";  anchorY = "bottom"; break;
    case "w":  nx1 += dx;            anchorX = "right";                     break;
    case "e":  nx2 += dx;            anchorX = "left";                      break;
    case "sw": nx1 += dx; ny2 += dy; anchorX = "right"; anchorY = "top";    break;
    case "s":  ny2 += dy;            anchorY = "top";                       break;
    case "se": nx2 += dx; ny2 += dy; anchorX = "left";  anchorY = "top";    break;
  }

  const [a, b, c, d] = normalizeBox(nx1, ny1, nx2, ny2);
  const clamped = clampBox([a, b, c, d], imgW, imgH);
  return clampToMinSize(clamped, anchorX, anchorY);
}

// ── Deep equality ──────────────────────────────────────────────────────────

/** Fast deep-equal for BBox arrays (used to compute isDirty). */
export function boxesEqual(a: BBox[], b: BBox[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const aBox = a[i];
    const bBox = b[i];
    if (aBox.label !== bBox.label) return false;
    if (aBox.confidence !== bBox.confidence) return false;
    if (aBox.bbox[0] !== bBox.bbox[0] ||
        aBox.bbox[1] !== bBox.bbox[1] ||
        aBox.bbox[2] !== bBox.bbox[2] ||
        aBox.bbox[3] !== bBox.bbox[3]) return false;
    if (aBox.origin !== bBox.origin) return false;
    if (aBox.edited_at !== bBox.edited_at) return false;
  }
  return true;
}
